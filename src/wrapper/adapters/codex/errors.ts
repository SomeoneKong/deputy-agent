/**
 * Maps Codex errors to the common RuntimeError categories, plus subprocess-exit diagnostics.
 *
 * `CodexErrorInfo` (carried by a turn failure / error notification) is mapped to the categories;
 * subprocess exit / signal / broken stdio sets diagnostics.providerSubprocessExit:true, from which
 * the host derives subprocess_crash.
 */
import type { ProviderId } from "../../types/index.js";
import { RuntimeErrorImpl, type RuntimeError, type RuntimeErrorKind, type RuntimeErrorSubKind } from "../../types/index.js";
import type { CodexErrorInfo } from "./protocol.js";

const PROVIDER: ProviderId = "codex";

interface ClassifyFields {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly diagnostics?: Readonly<Record<string, unknown>>;
}

function make(
  kind: RuntimeErrorKind,
  subKind: RuntimeErrorSubKind,
  message: string,
  brief: string | undefined,
  fields: ClassifyFields,
): RuntimeError {
  return new RuntimeErrorImpl({
    kind,
    subKind,
    providerId: PROVIDER,
    message,
    ...(brief !== undefined ? { upstreamErrorBrief: brief.slice(0, 200) } : {}),
    ...(fields.sessionId !== undefined ? { sessionId: fields.sessionId } : {}),
    ...(fields.turnId !== undefined ? { turnId: fields.turnId } : {}),
    ...(fields.diagnostics !== undefined ? { diagnostics: fields.diagnostics } : {}),
  });
}

/** Extract the tag from a CodexErrorInfo (string variant used directly; object variant uses its key). */
function codexErrorTag(info: CodexErrorInfo | null | undefined): string | undefined {
  if (info === undefined || info === null) return undefined;
  if (typeof info === "string") return info;
  const keys = Object.keys(info);
  return keys[0];
}

/**
 * Map a CodexErrorInfo (turn failure / error notification) to the common categories.
 * Limit-reached / auth errors -> permanent; upstream 5xx / network / overload -> transient
 * (the host manages retries / relies on SDK auto-retry).
 */
export function classifyCodexErrorInfo(
  info: CodexErrorInfo | null | undefined,
  message: string,
  fields: ClassifyFields = {},
): RuntimeError {
  const tag = codexErrorTag(info);
  const brief = `${message}${tag !== undefined ? ` (${tag})` : ""}`;
  switch (tag) {
    case "usageLimitExceeded":
      return make("permanent", "quota_exhausted", `codex usage limit: ${message}`, brief, fields);
    case "contextWindowExceeded":
      // Context overflow: at the limit, a retry would hit it again -> permanent (the host should compact / terminate instead of spinning on retries).
      return make("permanent", "max_turns_exhausted", `codex context window exceeded: ${message}`, brief, fields);
    case "unauthorized":
      return make("permanent", "auth_invalid", `codex unauthorized: ${message}`, brief, fields);
    case "badRequest":
      return make("permanent", "invalid_request", `codex bad request: ${message}`, brief, fields);
    case "cyberPolicy":
      return make("permanent", "invalid_request", `codex content policy: ${message}`, brief, fields);
    case "serverOverloaded":
      return make("transient", "upstream_overloaded", `codex server overloaded: ${message}`, brief, fields);
    case "internalServerError":
      return make("transient", "upstream_5xx", `codex internal server error: ${message}`, brief, fields);
    case "httpConnectionFailed":
    case "responseStreamConnectionFailed":
    case "responseStreamDisconnected":
      return make("transient", "network", `codex connection failed: ${message}`, brief, fields);
    case "responseTooManyFailedAttempts":
      return make("transient", "upstream_5xx", `codex too many failed attempts: ${message}`, brief, fields);
    case "sandboxError":
      return make("permanent", "isolation_violation_unsupported_sandbox", `codex sandbox error: ${message}`, brief, fields);
    case "threadRollbackFailed":
      return make("permanent", "adapter_internal_error", `codex thread rollback failed: ${message}`, brief, fields);
    case "activeTurnNotSteerable":
      return make("permanent", "invalid_request", `codex active turn not steerable: ${message}`, brief, fields);
    default:
      // Unknown / "other" -> fail-open transient (not silently swallowed; still surfaced).
      return make("transient", "io_transient", `unclassified codex error: ${message}`, brief, fields);
  }
}

/**
 * Subprocess exit / signal / broken stdio -> RuntimeError.
 * `consecutive` distinguishes the first occurrence (provider_init_transient) from repeated ones (provider_init_permanent).
 * diagnostics always includes providerSubprocessExit:true.
 */
export function subprocessExitError(
  consecutive: boolean,
  fields: ClassifyFields & { exitCode?: number | null; signal?: NodeJS.Signals | null } = {},
): RuntimeError {
  const diagnostics: Record<string, unknown> = {
    ...(fields.diagnostics ?? {}),
    providerSubprocessExit: true,
    ...(typeof fields.exitCode === "number" ? { exitCode: fields.exitCode } : {}),
    ...(typeof fields.signal === "string" ? { signal: fields.signal } : {}),
  };
  const kind: RuntimeErrorKind = consecutive ? "permanent" : "transient";
  const subKind: RuntimeErrorSubKind = consecutive ? "provider_init_permanent" : "provider_init_transient";
  return new RuntimeErrorImpl({
    kind,
    subKind,
    providerId: PROVIDER,
    message: `codex app-server subprocess exited (code=${fields.exitCode ?? "null"} signal=${fields.signal ?? "null"})`,
    ...(fields.sessionId !== undefined ? { sessionId: fields.sessionId } : {}),
    diagnostics,
  });
}

/** JSON-RPC-layer / spawn-layer errors (during startup) -> RuntimeError. */
export function classifyRpcError(err: unknown, phase: "init" | "turn", fields: ClassifyFields = {}): RuntimeError {
  if (err instanceof RuntimeErrorImpl) return err;
  const e = err as { name?: string; message?: string; code?: string };
  const brief = e.message ?? String(err);
  const text = `${brief} ${e.name ?? ""} ${e.code ?? ""}`.toLowerCase();
  // spawn ENOENT: the codex executable is missing -> structural, permanent.
  if (text.includes("enoent") || text.includes("command not found")) {
    return make("permanent", "provider_init_permanent", `codex binary not found: ${brief}`, brief, fields);
  }
  const sub: RuntimeErrorSubKind = phase === "init" ? "provider_init_transient" : "io_transient";
  return make("transient", sub, `codex rpc error (treated as transient): ${brief}`, brief, fields);
}

export { PROVIDER as CODEX_PROVIDER };
