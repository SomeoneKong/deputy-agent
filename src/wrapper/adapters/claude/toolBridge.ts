/**
 * Maps host tools to a Claude in-process MCP server. The namespace is fixed to
 * `sh`, and allowedTools = `mcp__sh__<name>`.
 *
 * Translation chain: JSON Schema (single source) -> Zod shape (for `tool()`, the
 * tool definition the model sees) + Ajv host-side validation (the authoritative
 * check, covering constraints outside the schemaTranslate subset). The handler
 * wrapper converts the Claude tool ctx into the public HostToolCallContext
 * (signal / turnId / agentRole / logger; onUpdate is undefined since
 * toolStreamingPartial=false) and provides abort + timeout.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
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
import { jsonSchemaToZodShape } from "./schemaTranslate.js";

const PROVIDER: ProviderId = "claude";
export const MCP_NAMESPACE = "sh";

export function mcpToolName(name: string): string {
  return `mcp__${MCP_NAMESPACE}__${name}`;
}

/** A tool name with the `mcp__sh__` prefix is a host tool (the isHostTool check). */
export function isHostToolName(toolName: string): boolean {
  return toolName.startsWith(`mcp__${MCP_NAMESPACE}__`);
}

/** MCP CallToolResult shape (matches the SDK `tool()` handler return; includes an index signature to remain compatible with the MCP types). */
export interface CallToolResultLike {
  readonly content: Array<{ type: "text"; text: string }>;
  readonly isError?: boolean;
  readonly [x: string]: unknown;
}

/** Compiles a host tool's Ajv validator (exported so unit tests can reuse invokeHostTool). */
export function compileValidator(inputSchema: object): ValidateFunction {
  return new Ajv({ allErrors: true, strict: false }).compile(inputSchema);
}

/** Callbacks the session provides to the tool bridge: used to surface runtime_error for validation failures / handler exceptions. */
export interface ToolBridgeHooks {
  readonly handle: SessionHandle;
  readonly role: AgentRole;
  /** Current inflight turnId (maintained by the adapter; read at tool-call time). */
  readonly currentTurnId: () => string | undefined;
  /**
   * The current turn's abort signal (aborted by abortTurn to cooperatively cancel an inflight handler);
   * falls back to the session signal (close/kill abort) when there is no inflight turn.
   */
  readonly effectiveSignal: () => AbortSignal;
  /** Validation failure / handler exception / timeout / misbehavior -> emit runtime_error. The session is not aborted. */
  readonly onToolRuntimeError: (err: RuntimeError) => void;
  readonly logger: HostToolCallContext["logger"];
  readonly handlerTimeoutMs: number;
  readonly abortGraceMs: number;
}

interface CompiledTool {
  readonly tool: HostTool;
  readonly validate: ValidateFunction;
}

/** Serializes content blocks into MCP text content (structuredOutput does not go into content). */
function serializeContent(blocks: ReadonlyArray<HostToolContentBlock>): Array<{ type: "text"; text: string }> {
  if (blocks.length === 0) return [{ type: "text", text: "" }];
  return blocks.map((b) => {
    if (b.type === "text") return { type: "text" as const, text: b.text };
    if (b.type === "json") return { type: "text" as const, text: JSON.stringify(b.value) };
    if (b.type === "image") return { type: "text" as const, text: `[image ${b.mediaType}]` };
    return { type: "text" as const, text: `[resource ${b.uri}]` };
  });
}

/**
 * Builds the in-process MCP server + allowedTools list. `toolNames` has already been validated (registration + scope) during startSession.
 * If any tool schema fails to translate -> throws schema_translation_failed (surfaced up to startSession).
 */
export function buildMcpServer(
  tools: ReadonlyArray<HostTool>,
  hooks: ToolBridgeHooks,
): { server: McpSdkServerConfigWithInstance; allowedTools: ReadonlyArray<string> } {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const compiled: CompiledTool[] = tools.map((t) => {
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
    return { tool: t, validate };
  });

  const sdkTools = compiled.map(({ tool: hostTool, validate }) => {
    const shape = jsonSchemaToZodShape(hostTool.inputSchema, hostTool.name);
    return tool(
      hostTool.name,
      hostTool.description,
      shape,
      async (args): Promise<CallToolResultLike> => {
        return invokeHostTool(hostTool, validate, args, hooks);
      },
    );
  });

  const server = createSdkMcpServer({ name: MCP_NAMESPACE, tools: sdkTools });
  const allowedTools = tools.map((t) => mcpToolName(t.name));
  return { server, allowedTools };
}

/**
 * Invokes a host tool (host-side validation + ctx assembly + abort/timeout). Exported so unit tests can directly verify the round trip and the validation-failure path
 * (without going through the live SDK; the SDK will not call back into a fake MCP handler).
 */
export async function invokeHostTool(
  hostTool: HostTool,
  validate: ValidateFunction,
  args: unknown,
  hooks: ToolBridgeHooks,
): Promise<CallToolResultLike> {
  const turnId = hooks.currentTurnId();
  const toolCallId = `${hooks.handle.id}-${hostTool.name}-${Date.now()}`;

  // host-side validation backstop. On failure -> isError result + runtime_error (the session is not aborted).
  if (!validate(args)) {
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
    return { content: [{ type: "text", text: `input validation failed: ${detail}` }], isError: true };
  }

  // Combine the current turn / session signal with the per-call timeout into one abort.
  // A single upstream listener propagates to callAbort and sets the aborted flag (removed in finally to avoid accumulating listeners on a long-lived session signal).
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

  // Three-way race between handler / timeout / abort-grace.
  // - handlerTimeoutMs elapses -> abort signal (asks the handler to cooperatively wind down) + start the abortGrace timer;
  // - if the handler still has not returned after abortGraceMs -> tool_handler_abort_grace_exceeded (kill path; the host closes as a backstop);
  // - if the handler returns normally after receiving the abort (including abortTurn propagation) -> host_tool_handler_misbehaved.
  let timedOut = false;
  let handlerTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
    handlerTimer = setTimeout(() => {
      // At the timeout point: emit tool_handler_timeout first, then abort the signal to ask the handler to cooperatively wind down.
      timedOut = true;
      hooks.onToolRuntimeError(mkErr("tool_handler_timeout", "timeout", `host tool ${hostTool.name} exceeded handlerTimeoutMs (${hooks.handlerTimeoutMs}ms)`));
      callAbort.abort();
      // if the handler still has not returned after abortGraceMs -> escalate abort_grace_exceeded (kill path).
      graceTimer = setTimeout(() => resolve({ kind: "timeout" }), hooks.abortGraceMs);
    }, hooks.handlerTimeoutMs);
  });

  const handlerPromise = (async (): Promise<{ kind: "result"; result: HostToolCallResult } | { kind: "error"; err: unknown }> => {
    try {
      return { kind: "result", result: await hostTool.handler(args, ctx) };
    } catch (err) {
      return { kind: "error", err };
    }
  })();

  const isAbortError = (e: { name?: string; message?: string }): boolean =>
    e.name === "AbortError" || /\babort(ed)?\b/i.test(e.message ?? "");

  try {
    const outcome = await Promise.race([handlerPromise, timeoutPromise]);
    if (outcome.kind === "timeout") {
      // still no return after grace -> do not return a normal result (the host falls back to close/kill based on the runtime_error).
      hooks.onToolRuntimeError(mkErr("tool_handler_abort_grace_exceeded", "timeout", `host tool ${hostTool.name} ignored abort after timeout+grace`));
      return { content: [{ type: "text", text: `host tool ${hostTool.name} timed out and did not respond to abort` }], isError: true };
    }
    if (outcome.kind === "error") {
      const e = outcome.err as { name?: string; message?: string };
      // Cooperative cancellation: the handler observed ctx.signal (propagated by
      // abortTurn/close or triggered by timeout) and threw AbortError -> this is
      // normal cooperative cancellation, not a host_tool_handler_error (timeout
      // already emitted tool_handler_timeout separately).
      if ((timedOut || aborted) && isAbortError(e)) {
        return { content: [{ type: "text", text: `host tool ${hostTool.name} aborted` }], isError: true };
      }
      // the handler itself threw -> isError result (no stack) + runtime_error.
      hooks.onToolRuntimeError(mkErr("host_tool_handler_error", "permanent", e.message ?? "host tool handler error", { _hostToolException: { name: e.name, message: e.message } }));
      hooks.logger.debug(`host tool ${hostTool.name} handler threw`, { stack: (outcome.err as Error).stack });
      return { content: [{ type: "text", text: `host tool handler error: ${e.message ?? "unknown"}` }], isError: true };
    }
    // normal return: if a timeout or abort (abortTurn propagation) occurred in the meantime but the handler still returned normally -> misbehaved.
    if (timedOut || aborted) {
      hooks.onToolRuntimeError(mkErr("host_tool_handler_misbehaved", "permanent", `host tool ${hostTool.name} returned a normal result after abort/timeout (ignored signal)`));
    }
    return { content: serializeContent(outcome.result.content), isError: outcome.result.isError };
  } finally {
    if (handlerTimer !== undefined) clearTimeout(handlerTimer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    upstreamSig.removeEventListener("abort", onUpstreamAbort);
  }
}
