/**
 * Normalizes SDKMessage into public SessionEvent (block mapping + turn boundaries).
 *
 * Pure functions: take an SDKMessage plus a normalization context (providing
 * turnId and common-field fillers) and return SessionEvent[]. Persistence and
 * fanout are done by the session's single subscriber. The session maintains
 * turnId for turn boundaries; this module only reads it.
 *
 * ThinkingBlock drops the signature (provider-private). isHostTool is determined
 * by the `mcp__sh__` tool-name prefix.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";

import type {
  ProviderId,
  SessionEvent,
  StopReason,
  SubagentUsage,
  TokenUsage,
  TurnUsage,
} from "../../types/index.js";
import { isHostToolName } from "./toolBridge.js";

const PROVIDER: ProviderId = "claude";

/** Context injected by the session: provides common fields + current turnId + tool name resolution. */
export interface NormalizeContext {
  readonly sessionId: string;
  /** Current turn (from query to ResultMessage). undefined when there is no turn (should not occur on the normal block path). */
  readonly turnId: string | undefined;
  readonly now: () => number;
  /** Records toolUseId -> toolName (filled on assistant tool_use), so a later user-role tool_result can backfill toolName. */
  readonly recordToolName?: (toolUseId: string, toolName: string) => void;
  /** Resolves the toolName for a toolUseId (used on tool_result; returns "" if unknown). */
  readonly resolveToolName?: (toolUseId: string) => string;
  /** Records content block index -> toolUseId (filled on stream content_block_start), so input_json_delta can be associated. */
  readonly recordBlockToolUse?: (index: number, toolUseId: string) => void;
  /** Resolves the toolUseId for a content block index (used on input_json_delta; returns undefined if unknown). */
  readonly resolveBlockToolUse?: (index: number) => string | undefined;
}

function common(ctx: NormalizeContext): { receivedAt: number; sessionId: string; providerId: ProviderId } {
  return { receivedAt: ctx.now(), sessionId: ctx.sessionId, providerId: PROVIDER };
}

/** Claude beta stop_reason -> public StopReason. */
export function mapStopReason(raw: string | null): StopReason {
  switch (raw) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    case "stop_sequence":
      return "stop";
    case "refusal":
      return "error";
    case "aborted":
      return "aborted";
    case "pause_turn":
      return "unknown";
    default:
      return "unknown";
  }
}

interface BetaUsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function mapTokens(usage: BetaUsageLike | undefined): TokenUsage {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens;
  const cacheWrite = usage?.cache_creation_input_tokens;
  return {
    input,
    output,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    total: input + output,
  };
}

/**
 * Maps an assistant message's content blocks to AssistantBlockEvent[] (plus a ToolInvokedEvent for tool_use).
 * A non-empty `parentToolUseId` means the message originated inside a subagent
 * (from the SDK top-level parent_tool_use_id); it is propagated to each event so
 * the observability layer can attribute it.
 */
function normalizeAssistantContent(message: BetaMessage, ctx: NormalizeContext, parentToolUseId?: string): SessionEvent[] {
  const out: SessionEvent[] = [];
  const turnId = ctx.turnId ?? "unknown-turn";
  const parent = parentToolUseId !== undefined ? { parentToolUseId } : {};
  let idx = 0;
  for (const block of message.content) {
    const contentIndex = idx++;
    if (block.type === "text") {
      out.push({ kind: "assistant_block", ...common(ctx), turnId, contentIndex, block: { type: "text", text: block.text }, ...parent });
    } else if (block.type === "thinking") {
      // drop the signature.
      out.push({
        kind: "assistant_block",
        ...common(ctx),
        turnId,
        contentIndex,
        block: { type: "thinking", thinking: block.thinking },
        ...parent,
      });
    } else if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
      const b = block as { id: string; name: string; input: unknown };
      const isHostTool = isHostToolName(b.name);
      ctx.recordToolName?.(b.id, b.name);
      out.push({
        kind: "assistant_block",
        ...common(ctx),
        turnId,
        contentIndex,
        block: { type: "tool_use", toolUseId: b.id, toolName: b.name, input: b.input, isHostTool },
        ...parent,
      });
      out.push({
        kind: "tool_invoked",
        ...common(ctx),
        turnId,
        toolUseId: b.id,
        toolName: b.name,
        input: b.input,
        isHostTool,
        invokedAt: ctx.now(),
        ...parent,
      });
    } else {
      // unrecognized block -> ProviderRawEvent (not dropped).
      out.push({
        kind: "provider_raw",
        ...common(ctx),
        providerEventType: `assistant_block:${(block as { type?: string }).type ?? "unknown"}`,
        raw: block,
      });
    }
  }
  return out;
}

/**
 * Maps tool_result blocks inside a user message to ToolResultRecordedEvent[].
 * A non-empty `parentToolUseId` means the tool result originated inside a subagent (attribution).
 */
function normalizeUserContent(message: { content: unknown }, ctx: NormalizeContext, parentToolUseId?: string): SessionEvent[] {
  const out: SessionEvent[] = [];
  const turnId = ctx.turnId ?? "unknown-turn";
  const parent = parentToolUseId !== undefined ? { parentToolUseId } : {};
  const content = message.content;
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
    if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
      const textBlocks = Array.isArray(b.content)
        ? (b.content as Array<{ type?: string; text?: string }>)
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => ({ type: "text" as const, text: c.text as string }))
        : typeof b.content === "string"
          ? [{ type: "text" as const, text: b.content }]
          : [];
      out.push({
        kind: "tool_result_recorded",
        ...common(ctx),
        turnId,
        toolUseId: b.tool_use_id,
        toolName: ctx.resolveToolName?.(b.tool_use_id) ?? "",
        result: { content: textBlocks, isError: b.is_error === true },
        recordedAt: ctx.now(),
        ...parent,
      });
    }
  }
  return out;
}

/** Non-empty string check (attribution keys and parent chains require non-empty; an empty string is treated the same as missing). */
function isNonEmptyStr(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

/** Reads the top-level `parent_tool_use_id` of an SDK assistant/user message (a non-empty string attributes the message to a subagent). Other shapes -> undefined. */
function parentToolUseIdOf(msg: SDKMessage): string | undefined {
  const p = (msg as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  return isNonEmptyStr(p) ? p : undefined;
}

/**
 * Normalizes a single SDKMessage. Returns SessionEvent[] (possibly empty, e.g. for pure control messages).
 * TurnEnded / UsageSnapshot for a ResultMessage are produced here; turn_started is emitted by the session on inject.
 */
export function normalizeMessage(msg: SDKMessage, ctx: NormalizeContext, modelId: string): SessionEvent[] {
  switch (msg.type) {
    case "assistant":
      // A non-null SDK top-level parent_tool_use_id means this assistant message originated inside a subagent (inlined into the main stream, including text/thinking once forwardSubagentText is enabled).
      return normalizeAssistantContent(msg.message, ctx, parentToolUseIdOf(msg));

    case "user":
      return normalizeUserContent(msg.message as { content: unknown }, ctx, parentToolUseIdOf(msg));

    case "result": {
      const turnId = ctx.turnId ?? "unknown-turn";
      const tokens = mapTokens(msg.usage as BetaUsageLike | undefined);
      // error subtype: stop_reason "aborted" -> aborted (host abort/interrupt path), otherwise error.
      const stopReason: StopReason =
        msg.subtype === "success" ? mapStopReason(msg.stop_reason) : msg.stop_reason === "aborted" ? "aborted" : "error";
      const usage: TurnUsage = { tokens, modelId, ...(typeof msg.total_cost_usd === "number" ? { cost: msg.total_cost_usd } : {}) };
      const out: SessionEvent[] = [
        { kind: "turn_ended", ...common(ctx), turnId, stopReason, usage, endedAt: ctx.now() },
        {
          kind: "usage_snapshot",
          ...common(ctx),
          source: "turn_ended",
          tokens,
          ...(typeof msg.total_cost_usd === "number" ? { cost: msg.total_cost_usd } : {}),
        },
      ];
      return out;
    }

    case "stream_event": {
      // partial message stream -> AssistantDeltaEvent (streamingDelta=true). For fine-grained UI / audit only.
      const turnId = ctx.turnId ?? "unknown-turn";
      // subagent partials also carry a top-level parent_tool_use_id; propagated for audit attribution (deltas are hidden by default, UI does not depend on them).
      const parentId = parentToolUseIdOf(msg);
      const parent = parentId !== undefined ? { parentToolUseId: parentId } : {};
      const ev = msg.event as {
        type?: string;
        delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
        index?: number;
        content_block?: { type?: string; id?: string };
      };
      const contentIndex = typeof ev.index === "number" ? ev.index : 0;
      // content_block_start records index -> toolUseId for later input_json_delta association (tool_use block).
      if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use" && typeof ev.content_block.id === "string" && typeof ev.index === "number") {
        ctx.recordBlockToolUse?.(ev.index, ev.content_block.id);
        return [];
      }
      if (ev.type === "content_block_delta" && ev.delta !== undefined) {
        if (ev.delta.type === "text_delta" && typeof ev.delta.text === "string") {
          return [{ kind: "assistant_delta", ...common(ctx), turnId, contentIndex, delta: { type: "text_delta", delta: ev.delta.text }, ...parent }];
        }
        if (ev.delta.type === "thinking_delta" && typeof ev.delta.thinking === "string") {
          return [{ kind: "assistant_delta", ...common(ctx), turnId, contentIndex, delta: { type: "thinking_delta", delta: ev.delta.thinking }, ...parent }];
        }
        if (ev.delta.type === "input_json_delta" && typeof ev.delta.partial_json === "string") {
          const toolUseId = ctx.resolveBlockToolUse?.(contentIndex);
          if (toolUseId === undefined || toolUseId === "") {
            // toolUseId unavailable -> do not produce an incomplete public delta; fall back to provider_raw (not dropped).
            return [{ kind: "provider_raw", ...common(ctx), providerEventType: "input_json_delta_unassociated", raw: msg }];
          }
          return [{ kind: "assistant_delta", ...common(ctx), turnId, contentIndex, delta: { type: "tool_use_input_delta", toolUseId, deltaJson: ev.delta.partial_json }, ...parent }];
        }
      }
      return []; // other stream_events (message_start/stop etc.) are not normalized
    }

    case "system":
      // system subtypes dispatched by subtype. init is handled separately by the session (session_started + isolation verification).
      return normalizeSystem(msg, ctx);

    default:
      return [{ kind: "provider_raw", ...common(ctx), providerEventType: `sdk:${(msg as { type?: string }).type ?? "unknown"}`, raw: msg }];
  }
}

/** Normalizes a system message (subtypes include api_retry / compact_boundary / status / init). */
function normalizeSystem(msg: Extract<SDKMessage, { type: "system" }>, ctx: NormalizeContext): SessionEvent[] {
  switch (msg.subtype) {
    case "api_retry":
      // SDK built-in retry (autoRetry.hasAutoRetry=true).
      return [
        {
          kind: "retry_started",
          ...common(ctx),
          attempt: msg.attempt,
          maxAttempts: msg.max_retries,
          delayMs: msg.retry_delay_ms,
          upstreamErrorBrief: `${msg.error}${msg.error_status !== null ? ` (${msg.error_status})` : ""}`,
        },
      ];
    case "compact_boundary":
      // The PreCompact/PostCompact hooks already handle compact events; the boundary message is kept only as a raw record (token counts live here).
      return [{ kind: "provider_raw", ...common(ctx), providerEventType: "compact_boundary", raw: msg }];
    case "task_started": {
      // subagent (spawned by the Task/Agent tool) lifecycle. task_* fields are not in the SDK public types -> cast.
      const m = msg as unknown as { task_id?: string; tool_use_id?: string; subagent_type?: string; description?: string };
      // Missing attribution key (task_id / tool_use_id) -> do not fabricate an empty-key public event (would pollute UI nesting / watchdog / audit); fall back to provider_raw.
      if (!isNonEmptyStr(m.task_id) || !isNonEmptyStr(m.tool_use_id)) return rawSystem(msg, ctx);
      return [
        {
          kind: "subagent_started",
          ...common(ctx),
          agentId: m.task_id,
          parentToolUseId: m.tool_use_id,
          ...(typeof m.subagent_type === "string" ? { subagentType: m.subagent_type } : {}),
          ...(typeof m.description === "string" ? { description: m.description } : {}),
        },
      ];
    }
    case "task_progress": {
      const m = msg as unknown as { task_id?: string; tool_use_id?: string; usage?: SubagentUsageRaw; last_tool_name?: string };
      if (!isNonEmptyStr(m.task_id) || !isNonEmptyStr(m.tool_use_id)) return rawSystem(msg, ctx);
      const usage = normSubagentUsage(m.usage);
      return [
        {
          kind: "subagent_progress",
          ...common(ctx),
          agentId: m.task_id,
          parentToolUseId: m.tool_use_id,
          ...(usage !== undefined ? { usage } : {}),
          ...(typeof m.last_tool_name === "string" ? { lastToolName: m.last_tool_name } : {}),
        },
      ];
    }
    case "task_notification": {
      const m = msg as unknown as { task_id?: string; tool_use_id?: string; status?: string; usage?: SubagentUsageRaw; summary?: string };
      if (!isNonEmptyStr(m.task_id) || !isNonEmptyStr(m.tool_use_id)) return rawSystem(msg, ctx);
      const usage = normSubagentUsage(m.usage);
      return [
        {
          kind: "subagent_stopped",
          ...common(ctx),
          agentId: m.task_id,
          parentToolUseId: m.tool_use_id,
          // Missing status: do not assume "completed"; neutralize to "unknown".
          status: typeof m.status === "string" ? m.status : "unknown",
          ...(usage !== undefined ? { usage } : {}),
          ...(typeof m.summary === "string" ? { summary: m.summary } : {}),
        },
      ];
    }
    default:
      return rawSystem(msg, ctx);
  }
}

/** Fallback for a system message -> provider_raw record (unrecognized subtype / missing subagent attribution key). */
function rawSystem(msg: Extract<SDKMessage, { type: "system" }>, ctx: NormalizeContext): SessionEvent[] {
  return [{ kind: "provider_raw", ...common(ctx), providerEventType: `system:${msg.subtype}`, raw: msg }];
}

interface SubagentUsageRaw {
  total_tokens?: number;
  tool_uses?: number;
  duration_ms?: number;
}

/** SDK subagent usage (snake_case) -> public SubagentUsage (camelCase); undefined if no fields present. */
function normSubagentUsage(u: SubagentUsageRaw | undefined): SubagentUsage | undefined {
  if (u === undefined) return undefined;
  const out: { totalTokens?: number; toolUses?: number; durationMs?: number } = {
    ...(typeof u.total_tokens === "number" ? { totalTokens: u.total_tokens } : {}),
    ...(typeof u.tool_uses === "number" ? { toolUses: u.tool_uses } : {}),
    ...(typeof u.duration_ms === "number" ? { durationMs: u.duration_ms } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}
