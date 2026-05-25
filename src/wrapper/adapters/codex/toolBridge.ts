/**
 * Bridges host tools to Codex dynamicTools.
 *
 * Translation chain: the JSON Schema (single source) feeds DynamicToolSpec.inputSchema directly (Codex
 * consumes JSON Schema natively, with no Zod / TypeBox translation). The `item/tool/call` ServerRequest
 * is translated into a HostToolCallContext to invoke the host handler -> a DynamicToolCallResponse.
 * host-side Ajv validation acts as a backstop. A name-mapping hook is kept while the naming constraints
 * are not yet settled.
 */
import { Ajv, type ValidateFunction } from "ajv";

import type {
  AgentRole,
  HostTool,
  HostToolCallContext,
  HostToolCallResult,
  HostToolContentBlock,
  ProviderId,
  SessionHandle,
} from "../../types/index.js";
import { RuntimeErrorImpl, type RuntimeError } from "../../types/index.js";
import type {
  DynamicToolCallOutputContentItem,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec,
} from "./protocol.js";

const PROVIDER: ProviderId = "codex";

/**
 * Codex-side tool name mapping hook. Whether dynamicTools / the Responses API naming allows host
 * double-underscore names (`sh_x__y`) is not yet settled. The current default is the identity mapping
 * (uses the host's original name); if double-underscore names turn out to be rejected, a bidirectional
 * stable mapping table would be implemented here (the outward event stream / host handler still use the
 * host's original name; the mapping only applies between the adapter and the app-server).
 */
export function codexToolName(hostName: string): string {
  return hostName;
}

/** Codex-side name -> host original name (the inverse of the identity mapping; once a mapping table is introduced, looked up via the table). Fail-fast on a non-invertible / clashing mapping. */
export function hostToolNameFromCodex(codexName: string): string {
  return codexName;
}

interface CompiledTool {
  readonly tool: HostTool;
  readonly validate: ValidateFunction;
}

/**
 * Compile host tools into DynamicToolSpec[] + an internal handler table indexed by Codex-side name.
 * If any tool schema is not compilable -> throw schema_translation_failed (surfaced up to startSession).
 * A non-invertible / clashing name mapping -> throw invalid_request (no silent renaming).
 */
export function buildDynamicTools(tools: ReadonlyArray<HostTool>): {
  specs: DynamicToolSpec[];
  byCodexName: Map<string, CompiledTool>;
} {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const byCodexName = new Map<string, CompiledTool>();
  const specs: DynamicToolSpec[] = [];
  for (const t of tools) {
    let validate: ValidateFunction;
    try {
      validate = ajv.compile(t.inputSchema as object);
    } catch (err) {
      throw new RuntimeErrorImpl({
        kind: "permanent",
        subKind: "schema_translation_failed",
        providerId: PROVIDER,
        message: `host tool ${t.name} inputSchema not compilable by Ajv: ${(err as Error).message}`,
        diagnostics: { toolName: t.name },
      });
    }
    const codexName = codexToolName(t.name);
    if (byCodexName.has(codexName)) {
      throw new RuntimeErrorImpl({
        kind: "permanent",
        subKind: "invalid_request",
        providerId: PROVIDER,
        message: `codex tool name clash after mapping: ${codexName} (host tool ${t.name})`,
        diagnostics: { hostToolName: t.name, codexToolName: codexName },
      });
    }
    byCodexName.set(codexName, { tool: t, validate });
    specs.push({ name: codexName, description: t.description, inputSchema: t.inputSchema });
  }
  return { specs, byCodexName };
}

/** Callbacks the session provides to the tool bridge (surface runtime_error / get the current turn and signal / timeouts). */
export interface ToolBridgeHooks {
  readonly handle: SessionHandle;
  readonly role: AgentRole;
  readonly currentTurnId: () => string | undefined;
  /** The current turn's abort signal (propagated by abortTurn / close); falls back to the session signal when there is no inflight turn. */
  readonly effectiveSignal: () => AbortSignal;
  readonly onToolRuntimeError: (err: RuntimeError) => void;
  readonly logger: HostToolCallContext["logger"];
  readonly handlerTimeoutMs: number;
  readonly abortGraceMs: number;
}

/** Serialize content blocks into Codex DynamicToolCallOutputContentItems (structuredOutput does not go into content). */
function serializeContent(blocks: ReadonlyArray<HostToolContentBlock>): Array<DynamicToolCallOutputContentItem> {
  if (blocks.length === 0) return [{ type: "inputText", text: "" }];
  return blocks.map((b) => {
    if (b.type === "text") return { type: "inputText" as const, text: b.text };
    if (b.type === "json") return { type: "inputText" as const, text: JSON.stringify(b.value) };
    if (b.type === "image") return { type: "inputImage" as const, imageUrl: `data:${b.mediaType};base64,${b.data}` };
    return { type: "inputText" as const, text: `[resource ${b.uri}]` };
  });
}

/**
 * `item/tool/call` ServerRequest -> invoke the host handler -> DynamicToolCallResponse.
 * host-side validation backstop + ctx assembly (signal / turnId / agentRole / providerId="codex") + a
 * three-way race between abort/timeout/handler. All errors are surfaced via hooks.onToolRuntimeError
 * without aborting the session.
 */
export async function dispatchToolCall(
  params: DynamicToolCallParams,
  byCodexName: Map<string, CompiledTool>,
  hooks: ToolBridgeHooks,
): Promise<DynamicToolCallResponse> {
  const turnId = hooks.currentTurnId();
  const compiled = byCodexName.get(params.tool);
  const toolCallId = params.callId;

  if (compiled === undefined) {
    hooks.onToolRuntimeError(
      new RuntimeErrorImpl({
        kind: "permanent",
        subKind: "invalid_request",
        providerId: PROVIDER,
        sessionId: hooks.handle.id,
        ...(turnId !== undefined ? { turnId } : {}),
        toolUseId: toolCallId,
        message: `codex requested unknown host tool: ${params.tool}`,
        diagnostics: { codexToolName: params.tool },
      }),
    );
    return { contentItems: [{ type: "inputText", text: `unknown tool: ${params.tool}` }], success: false };
  }

  const { tool: hostTool, validate } = compiled;

  if (!validate(params.arguments)) {
    const detail = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    hooks.onToolRuntimeError(
      new RuntimeErrorImpl({
        kind: "permanent",
        subKind: "schema_validation_failed_host_side",
        providerId: PROVIDER,
        sessionId: hooks.handle.id,
        ...(turnId !== undefined ? { turnId } : {}),
        toolUseId: toolCallId,
        message: `host tool ${hostTool.name} input failed host-side validation: ${detail}`,
        diagnostics: { toolName: hostTool.name },
      }),
    );
    return { contentItems: [{ type: "inputText", text: `input validation failed: ${detail}` }], success: false };
  }

  // Compose the abort from the current turn / session signal and the per-call timeout.
  const callAbort = new AbortController();
  const upstreamSig = hooks.effectiveSignal();
  let aborted = upstreamSig.aborted;
  const onUpstreamAbort = (): void => {
    aborted = true;
    callAbort.abort();
  };
  if (upstreamSig.aborted) callAbort.abort();
  else upstreamSig.addEventListener("abort", onUpstreamAbort);

  const ctx: HostToolCallContext = {
    sessionHandle: hooks.handle,
    toolCallId,
    turnId,
    agentRole: hooks.role,
    providerId: PROVIDER,
    signal: callAbort.signal,
    logger: hooks.logger,
    // onUpdate is intentionally not wired (toolStreamingPartial=false)
  };

  const mkErr = (subKind: string, kind: "permanent" | "timeout", message: string, extra?: Record<string, unknown>): RuntimeError =>
    new RuntimeErrorImpl({
      kind,
      subKind,
      providerId: PROVIDER,
      sessionId: hooks.handle.id,
      ...(turnId !== undefined ? { turnId } : {}),
      toolUseId: toolCallId,
      message,
      diagnostics: { toolName: hostTool.name, ...(extra ?? {}) },
    });

  let timedOut = false;
  let handlerTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
    handlerTimer = setTimeout(() => {
      timedOut = true;
      hooks.onToolRuntimeError(mkErr("tool_handler_timeout", "timeout", `host tool ${hostTool.name} exceeded handlerTimeoutMs (${hooks.handlerTimeoutMs}ms)`));
      callAbort.abort();
      graceTimer = setTimeout(() => resolve({ kind: "timeout" }), hooks.abortGraceMs);
      graceTimer.unref?.(); // do not pin the event loop (consistent with the adapter's other timers; finally clears it, so behavior is unchanged).
    }, hooks.handlerTimeoutMs);
    handlerTimer.unref?.();
  });

  const handlerPromise = (async (): Promise<{ kind: "result"; result: HostToolCallResult } | { kind: "error"; err: unknown }> => {
    try {
      return { kind: "result", result: await hostTool.handler(params.arguments, ctx) };
    } catch (err) {
      return { kind: "error", err };
    }
  })();

  const isAbortError = (e: { name?: string; message?: string }): boolean =>
    e.name === "AbortError" || /\babort(ed)?\b/i.test(e.message ?? "");

  try {
    const outcome = await Promise.race([handlerPromise, timeoutPromise]);
    if (outcome.kind === "timeout") {
      hooks.onToolRuntimeError(mkErr("tool_handler_abort_grace_exceeded", "timeout", `host tool ${hostTool.name} ignored abort after timeout+grace`));
      return { contentItems: [{ type: "inputText", text: `host tool ${hostTool.name} timed out and did not respond to abort` }], success: false };
    }
    if (outcome.kind === "error") {
      const e = outcome.err as { name?: string; message?: string };
      if ((timedOut || aborted) && isAbortError(e)) {
        return { contentItems: [{ type: "inputText", text: `host tool ${hostTool.name} aborted` }], success: false };
      }
      hooks.onToolRuntimeError(mkErr("host_tool_handler_error", "permanent", e.message ?? "host tool handler error", { _hostToolException: { name: e.name, message: e.message } }));
      hooks.logger.debug(`host tool ${hostTool.name} handler threw`, { stack: (outcome.err as Error).stack });
      return { contentItems: [{ type: "inputText", text: `host tool handler error: ${e.message ?? "unknown"}` }], success: false };
    }
    if (timedOut || aborted) {
      hooks.onToolRuntimeError(mkErr("host_tool_handler_misbehaved", "permanent", `host tool ${hostTool.name} returned a normal result after abort/timeout (ignored signal)`));
    }
    return { contentItems: serializeContent(outcome.result.content), success: !outcome.result.isError };
  } finally {
    if (handlerTimer !== undefined) clearTimeout(handlerTimer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    upstreamSig.removeEventListener("abort", onUpstreamAbort);
  }
}
