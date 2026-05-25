/**
 * Normalizes Codex ServerNotifications into common SessionEvents.
 *
 * Pure functions: input is (method, params) plus a normalization context (common fields + turnId
 * resolution + tool-name reverse mapping + turn cause); output is SessionEvent[]. Persistence and
 * fanout are done by the single session consumer.
 *
 * Mapping: thread/started->SessionStarted (emitted synthetically by the session, not here);
 * turn/started->TurnStarted; turn/completed->TurnEnded (status mapped);
 * item/started(tool)->AssistantBlock{ToolUse}+ToolInvoked (paired);
 * item/completed(tool)->ToolResultRecorded; item/completed(agentMessage)->AssistantBlock{Text};
 * item/completed(reasoning)->AssistantBlock{Thinking}; agentMessage/reasoning delta->AssistantDelta;
 * tokenUsage/updated->UsageSnapshot; contextCompaction item / thread/compacted->CompactEnded
 * (summary unobservable -> success:false + compact_summary_missing); error->RuntimeError;
 * fileChange/diff->ProviderRaw; unrecognized->ProviderRaw.
 */
import type {
  ContextUsage,
  ProviderId,
  SessionEvent,
  StopReason,
  TokenUsage,
  TurnCause,
  TurnUsage,
} from "../../types/index.js";
import { RuntimeErrorImpl } from "../../types/index.js";
import { classifyCodexErrorInfo } from "./errors.js";
import { hostToolNameFromCodex } from "./toolBridge.js";
import {
  NOTIFICATION_METHODS,
  type AgentMessageDeltaNotification,
  type ContextCompactedNotification,
  type ErrorNotification,
  type ItemCompletedNotification,
  type ItemStartedNotification,
  type ReasoningSummaryTextDeltaNotification,
  type ReasoningTextDeltaNotification,
  type ThreadItem,
  type ThreadTokenUsageUpdatedNotification,
  type TurnCompletedNotification,
  type TurnStartedNotification,
  type TurnStatus,
} from "./protocol.js";

const PROVIDER: ProviderId = "codex";

/** Context injected by the session: common fields + current turnId + tool-name reverse mapping. */
export interface NormalizeContext {
  readonly sessionId: string;
  readonly turnId: string | undefined;
  readonly now: () => number;
  /** Record itemId -> toolName (set on a tool-type item/started) so item/completed can backfill toolName. */
  readonly recordToolName?: (itemId: string, toolName: string) => void;
  readonly resolveToolName?: (itemId: string) => string;
  /** Content block index counter (item order; the session maintains it monotonically increasing). */
  readonly nextContentIndex: () => number;
}

function common(ctx: NormalizeContext): { receivedAt: number; sessionId: string; providerId: ProviderId } {
  return { receivedAt: ctx.now(), sessionId: ctx.sessionId, providerId: PROVIDER };
}

/** TurnStatus -> common StopReason. */
export function mapTurnStatus(status: TurnStatus): StopReason {
  switch (status) {
    case "completed":
      return "stop";
    case "interrupted":
      return "aborted";
    case "failed":
      return "error";
    case "inProgress":
      return "unknown";
    default:
      return "unknown";
  }
}

/** ThreadTokenUsage -> common TokenUsage (uses the total breakdown). */
function mapTokens(usage: ThreadTokenUsageUpdatedNotification["tokenUsage"]): TokenUsage {
  const t = usage.total;
  return {
    input: t.inputTokens,
    output: t.outputTokens,
    cacheRead: t.cachedInputTokens,
    thinking: t.reasoningOutputTokens,
    total: t.totalTokens,
  };
}

function mapContextUsage(usage: ThreadTokenUsageUpdatedNotification["tokenUsage"]): ContextUsage {
  const total = usage.total.totalTokens;
  const window = usage.modelContextWindow;
  return {
    tokens: total,
    contextWindow: window ?? undefined,
    percent: window !== null && window > 0 ? total / window : undefined,
  };
}

/** Whether this is a tool-type item (dynamicTool / mcpTool / commandExecution) -> paired on started, result flows back on completed. */
function toolItemInfo(item: ThreadItem): { toolUseId: string; toolName: string; input: unknown; isHostTool: boolean } | undefined {
  if (item.type === "dynamicToolCall") {
    return { toolUseId: item.id, toolName: hostToolNameFromCodex(item.tool), input: item.arguments, isHostTool: true };
  }
  if (item.type === "mcpToolCall") {
    // Host tool from the capsule MCP server -> host; others -> non-host (conservatively treated as non-host; host-registration detection on the mcp path is not implemented, defaults to false).
    return { toolUseId: item.id, toolName: item.tool, input: item.arguments, isHostTool: false };
  }
  if (item.type === "commandExecution") {
    return { toolUseId: item.id, toolName: "shell", input: { command: item.command, cwd: item.cwd }, isHostTool: false };
  }
  return undefined;
}

/** item/started -> for tool-type items, emit AssistantBlock{ToolUse} + ToolInvoked as a pair; other item/started -> no events (produced on completed). */
export function normalizeItemStarted(n: ItemStartedNotification, ctx: NormalizeContext): SessionEvent[] {
  const turnId = ctx.turnId ?? "unknown-turn";
  const tool = toolItemInfo(n.item);
  if (tool === undefined) return [];
  ctx.recordToolName?.(tool.toolUseId, tool.toolName);
  const contentIndex = ctx.nextContentIndex();
  return [
    {
      kind: "assistant_block",
      ...common(ctx),
      turnId,
      contentIndex,
      block: { type: "tool_use", toolUseId: tool.toolUseId, toolName: tool.toolName, input: tool.input, isHostTool: tool.isHostTool },
    },
    {
      kind: "tool_invoked",
      ...common(ctx),
      turnId,
      toolUseId: tool.toolUseId,
      toolName: tool.toolName,
      input: tool.input,
      isHostTool: tool.isHostTool,
      invokedAt: ctx.now(),
    },
  ];
}

/**
 * item/completed -> dispatched by item type:
 * tool -> ToolResultRecorded; agentMessage -> AssistantBlock{Text}; reasoning -> AssistantBlock{Thinking};
 * contextCompaction -> CompactEnded (summary unobservable -> success:false + compact_summary_missing);
 * fileChange / others -> ProviderRaw.
 */
export function normalizeItemCompleted(n: ItemCompletedNotification, ctx: NormalizeContext): SessionEvent[] {
  const turnId = ctx.turnId ?? "unknown-turn";
  const item = n.item;
  const tool = toolItemInfo(item);
  if (tool !== undefined) {
    const { text, isError } = toolResultText(item);
    // Keep the toolName consistent with what started recorded (resolveToolName): on started/completed
    // drift, the started record wins; with no record (the rare case where completed precedes started),
    // fall back to the name on the completed item.
    const recorded = ctx.resolveToolName?.(tool.toolUseId);
    const toolName = recorded !== undefined && recorded.length > 0 ? recorded : tool.toolName;
    return [
      {
        kind: "tool_result_recorded",
        ...common(ctx),
        turnId,
        toolUseId: tool.toolUseId,
        toolName,
        result: { content: [{ type: "text", text }], isError },
        recordedAt: ctx.now(),
      },
    ];
  }
  if (item.type === "agentMessage") {
    return [{ kind: "assistant_block", ...common(ctx), turnId, contentIndex: ctx.nextContentIndex(), block: { type: "text", text: item.text } }];
  }
  if (item.type === "reasoning") {
    // The provider-private signature is not propagated; concatenate summary + content into the thinking text.
    const thinking = [...item.summary, ...item.content].join("\n");
    return [{ kind: "assistant_block", ...common(ctx), turnId, contentIndex: ctx.nextContentIndex(), block: { type: "thinking", thinking } }];
  }
  if (item.type === "contextCompaction") {
    return compactEndedEvents(ctx);
  }
  // fileChange / webSearch / plan / userMessage / others -> provider_raw (not disguised as a host tool result).
  return [{ kind: "provider_raw", ...common(ctx), providerEventType: `item/completed:${item.type}`, raw: item }];
}

/** Result text + isError for a completed tool item (from dynamicToolCall.contentItems / commandExecution.aggregatedOutput, etc). */
function toolResultText(item: ThreadItem): { text: string; isError: boolean } {
  if (item.type === "dynamicToolCall") {
    const ok = item.success !== false && item.status !== "failed";
    const text = (item.contentItems ?? [])
      .map((c) => (c.type === "inputText" ? c.text : `[image ${c.imageUrl}]`))
      .join("\n");
    return { text, isError: !ok };
  }
  if (item.type === "commandExecution") {
    // A non-completed terminal state (declined / failed / interrupted, etc) or a non-zero exitCode -> error (do not feed a declined/failed command to the LLM/audit as a successful tool result).
    return { text: item.aggregatedOutput ?? "", isError: item.status !== "completed" || (item.exitCode !== null && item.exitCode !== 0) };
  }
  if (item.type === "mcpToolCall") {
    const isError = item.error !== null || item.status === "failed";
    return { text: item.result !== null ? JSON.stringify(item.result) : item.error !== null ? JSON.stringify(item.error) : "", isError };
  }
  return { text: "", isError: false };
}

/** contextCompaction item / thread/compacted -> CompactEnded (summary unobservable -> success:false + RuntimeError). */
export function compactEndedEvents(ctx: NormalizeContext): SessionEvent[] {
  // canObserveSummary=false: the Codex contextCompaction item does not expose a stable summary field
  // -> emit success:false + compact_summary_missing (do not silently emit success with an empty summary).
  return [
    {
      kind: "compact_ended",
      ...common(ctx),
      success: false,
      summary: undefined,
      firstKeptEntryId: undefined,
      tokensAfter: undefined,
      errorMessage: "summary unavailable from provider",
      willRetryTurn: false,
    },
    {
      kind: "runtime_error",
      ...common(ctx),
      error: new RuntimeErrorImpl({
        kind: "protocol",
        subKind: "compact_summary_missing",
        providerId: PROVIDER,
        sessionId: ctx.sessionId,
        message: "codex contextCompaction provided no observable summary",
      }),
      recoverable: true,
      continuingSession: true,
    },
  ];
}

/** turn/started -> TurnStarted (cause is passed in by the session based on the inject marker). */
export function normalizeTurnStarted(n: TurnStartedNotification, ctx: NormalizeContext, cause: TurnCause): SessionEvent[] {
  return [{ kind: "turn_started", ...common(ctx), turnId: n.turn.id, cause, startedAt: ctx.now() }];
}

/** turn/completed -> TurnEnded (status mapped; on failure, codexErrorInfo is carried into a RuntimeError). */
export function normalizeTurnCompleted(n: TurnCompletedNotification, ctx: NormalizeContext): SessionEvent[] {
  const turnId = n.turn.id;
  const stopReason = mapTurnStatus(n.turn.status);
  const usage: TurnUsage | undefined = undefined; // usage is carried by thread/tokenUsage/updated (UsageSnapshot).
  const out: SessionEvent[] = [{ kind: "turn_ended", ...common(ctx), turnId, stopReason, usage, endedAt: ctx.now() }];
  if (n.turn.status === "failed" && n.turn.error !== null) {
    const re = classifyCodexErrorInfo(n.turn.error.codexErrorInfo, n.turn.error.message, { sessionId: ctx.sessionId, turnId });
    out.push({ kind: "runtime_error", ...common(ctx), error: re, recoverable: re.kind === "transient", continuingSession: true });
  }
  return out;
}

/** item/agentMessage/delta -> AssistantDelta (text_delta). */
export function normalizeAgentMessageDelta(n: AgentMessageDeltaNotification, ctx: NormalizeContext): SessionEvent[] {
  const turnId = ctx.turnId ?? "unknown-turn";
  return [{ kind: "assistant_delta", ...common(ctx), turnId, contentIndex: 0, delta: { type: "text_delta", delta: n.delta } }];
}

/** item/reasoning/textDelta + summaryTextDelta -> AssistantDelta (thinking_delta). */
export function normalizeReasoningDelta(
  n: ReasoningTextDeltaNotification | ReasoningSummaryTextDeltaNotification,
  ctx: NormalizeContext,
): SessionEvent[] {
  const turnId = ctx.turnId ?? "unknown-turn";
  // The main reasoning delta uses contentIndex; the summary delta uses summaryIndex (the two sequences use different field names; see protocol.ts).
  const contentIndex = "contentIndex" in n ? n.contentIndex : n.summaryIndex;
  return [{ kind: "assistant_delta", ...common(ctx), turnId, contentIndex, delta: { type: "thinking_delta", delta: n.delta } }];
}

/** thread/tokenUsage/updated -> UsageSnapshot (source thread_event) + contextUsage. */
export function normalizeTokenUsage(n: ThreadTokenUsageUpdatedNotification, ctx: NormalizeContext): SessionEvent[] {
  const tokens = mapTokens(n.tokenUsage);
  return [{ kind: "usage_snapshot", ...common(ctx), source: "thread_event", tokens, contextUsage: mapContextUsage(n.tokenUsage) }];
}

/** thread/compacted (deprecated alias) -> CompactEnded (handled like the contextCompaction item). */
export function normalizeThreadCompacted(_n: ContextCompactedNotification, ctx: NormalizeContext): SessionEvent[] {
  return compactEndedEvents(ctx);
}

/** error notification -> RuntimeError (classified; retained by the session for the host to decide). */
export function normalizeError(n: ErrorNotification, ctx: NormalizeContext): SessionEvent[] {
  const re = classifyCodexErrorInfo(n.error.codexErrorInfo, n.error.message, { sessionId: ctx.sessionId, ...(ctx.turnId !== undefined ? { turnId: ctx.turnId } : {}) });
  return [{ kind: "runtime_error", ...common(ctx), error: re, recoverable: re.kind === "transient" || n.willRetry, continuingSession: true }];
}

/** Expose the current token usage snapshot to the session's contextUsage() (returns the latest value synchronously). */
export function tokenUsageToContextUsage(n: ThreadTokenUsageUpdatedNotification): ContextUsage {
  return mapContextUsage(n.tokenUsage);
}

export { NOTIFICATION_METHODS };
