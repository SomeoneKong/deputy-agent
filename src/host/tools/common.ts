/**
 * Common contracts for the host tool suite.
 *
 * - `HostToolResultBase`: the business-result top level (ok / errorKind / errorMessage + tool-specific fields).
 * - Business result -> wrapper `HostToolCallResult` mapping: content carries every field the LLM needs to decide,
 *   structuredOutput mirrors the full business object (host audit; not shown to the LLM).
 * - Role ACL second line of defense: the handler entry validates callerRole; a mismatch -> illegal_state.
 * - Defensive input-validation helpers (the handler casts and validates key fields itself).
 * - Tool deps injection container (paths / bus / agent control / verdict buffer / session id resolver).
 */
import type {
  AgentRole,
  HostToolCallContext,
  HostToolCallResult,
} from "../../wrapper/index.js";
import type { MessagingBus } from "../../messaging/index.js";
import type { TaskCapsulePaths } from "../../shared/paths.js";
import type { SessionId } from "../../shared/ids.js";
import { LockTimeoutError } from "../../shared/errors.js";
import { HostToolCommonErrorKind } from "../errorKinds.js";
import type { HostAgentControl, ReviewerVerdictBuffer } from "../agent_control.js";

/** Business-result top level. Tool-specific fields extend this via intersection types. */
export interface HostToolResultBase {
  readonly ok: boolean;
  readonly errorKind: string | null;
  readonly errorMessage: string | null;
}

/** Dependency injection container for tool handlers. */
export interface HostToolDeps {
  readonly paths: TaskCapsulePaths;
  readonly bus: MessagingBus;
  readonly agentControl: HostAgentControl;
  readonly verdictBuffer: ReviewerVerdictBuffer;
  /**
   * worker->meta envelope extras need workerSessionId + sessionSeq; SessionHandle only carries sessionId,
   * while sessionSeq is in-memory orchestration state. The orchestration layer injects this resolver to map a
   * worker sessionId to its sessionSeq (unknown -> 0 placeholder; the extras schema only requires an int).
   */
  readonly workerSessionSeqResolver: (sessionId: SessionId) => number;
}

/** The caller's sessionId (used as messaging by-label / verdict buffer key). */
export function callerSessionId(ctx: HostToolCallContext): SessionId {
  return ctx.sessionHandle.id as SessionId;
}

/** Successful business result. */
export function ok<T extends Record<string, unknown>>(extra: T): HostToolResultBase & T {
  return { ok: true, errorKind: null, errorMessage: null, ...extra };
}

/** Failed business result. */
export function fail(errorKind: string, errorMessage: string): HostToolResultBase {
  return { ok: false, errorKind, errorMessage };
}

/**
 * Map a business result to a wrapper HostToolCallResult.
 * content renders a human-readable text block (ok / errorKind / errorMessage + tool-specific fields);
 * structuredOutput mirrors the full object.
 */
export function toCallResult<T extends HostToolResultBase>(result: T): HostToolCallResult<T> {
  const lines: string[] = [];
  if (result.ok) {
    lines.push("ok: true");
  } else {
    lines.push("ok: false");
    lines.push(`errorKind: ${result.errorKind}`);
    lines.push(`errorMessage: ${result.errorMessage}`);
  }
  for (const [k, v] of Object.entries(result)) {
    if (k === "ok" || k === "errorKind" || k === "errorMessage") continue;
    lines.push(`${k}: ${renderValue(v)}`);
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: !result.ok,
    structuredOutput: result,
  };
}

function renderValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Role ACL second line of defense: callerRole not in the tool scope -> illegal_state.
 * A non-null return is a failure result that should be passed straight back.
 */
export function checkCallerRole(
  toolName: string,
  ctx: HostToolCallContext,
  allowed: ReadonlyArray<AgentRole>,
): HostToolResultBase | null {
  if (!allowed.includes(ctx.agentRole)) {
    return fail(HostToolCommonErrorKind.illegalState, `${toolName} not permitted for role ${ctx.agentRole}`);
  }
  return null;
}

/** Coerce handler input to an object (non-object -> invalid_argument result); returns the record or a failure result. */
export function asInputObject(
  toolName: string,
  input: unknown,
): { obj: Record<string, unknown> } | { fail: HostToolResultBase } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { fail: fail(HostToolCommonErrorKind.invalidArgument, `${toolName} input must be an object`) };
  }
  return { obj: input as Record<string, unknown> };
}

/** Non-blank string validation (handler-level trim guard). Blank -> invalid_argument. */
export function requireNonBlankString(
  field: string,
  value: unknown,
): { value: string } | { fail: HostToolResultBase } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      fail: fail(HostToolCommonErrorKind.invalidArgument, `field '${field}' must be a non-blank string`),
    };
  }
  return { value };
}

/**
 * Map a bus / IO exception to a tool errorKind.
 * LockTimeoutError -> concurrent_conflict; everything else (corrupted state / payload write failure / IO) -> host_internal.
 */
export function busErrorFail(action: string, err: unknown): HostToolResultBase {
  if (err instanceof LockTimeoutError) {
    return fail(HostToolCommonErrorKind.concurrentConflict, `${action}: lock wait timed out: ${(err as Error).message}`);
  }
  return fail(HostToolCommonErrorKind.hostInternal, `${action}: ${(err as Error).message}`);
}

/** Coerce to string[] (every item a string). Non-array / contains non-string -> invalid_argument. */
export function requireStringArray(
  field: string,
  value: unknown,
): { value: string[] } | { fail: HostToolResultBase } {
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) {
    return { fail: fail(HostToolCommonErrorKind.invalidArgument, `field '${field}' must be an array of strings`) };
  }
  return { value: value as string[] };
}
