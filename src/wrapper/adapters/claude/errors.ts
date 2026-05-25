/**
 * Maps Claude SDK / Node exceptions to the public RuntimeError categories.
 *
 * Permanent takes precedence over transient: a mixed auth+rate message is
 * classified as permanent/auth to avoid pointless retries. No keyword match and
 * not a known structural permanent error -> treated as transient/io_transient (fail-open).
 */
import type { ProviderId } from "../../types/index.js";
import { RuntimeErrorImpl, type RuntimeError, type RuntimeErrorKind, type RuntimeErrorSubKind } from "../../types/index.js";

const PROVIDER: ProviderId = "claude";

const PERMANENT_AUTH = [
  "authentication",
  "auth_failed",
  "auth failed",
  "401",
  "403",
  "unauthorized",
  "invalid_api_key",
  "invalid api key",
  "not logged in",
  "not_logged_in",
] as const;
const PERMANENT_QUOTA = ["billing", "quota_exceeded", "quota exceeded", "subscription"] as const;
const PERMANENT_CONFIG = [
  "invalid_request",
  "invalid request",
  "model_not_found",
  "model not found",
  "permission denied",
  "permission_denied",
] as const;

const TRANSIENT_RATE_LIMIT = ["rate limit", "rate_limit", "ratelimit", "429", "overloaded", "temporarily unavailable"] as const;
const TRANSIENT_5XX = ["502", "503", "504", "service unavailable", "gateway timeout", "internal error", "internal server error"] as const;
const TRANSIENT_NETWORK = [
  "unable to connect",
  "connection refused",
  "connection reset",
  "connection error",
  "network",
  "remote disconnect",
  "bad gateway",
  "econnrefused",
  "econnreset",
  "enotfound",
  "dns",
  "ssl",
  "tls",
] as const;
const TRANSIENT_TIMEOUT = ["timed out", "timeout"] as const;

const CLI_MISSING = ["command not found", "claude code executable", "cli not found", "enoent"] as const;

function match(text: string, keywords: ReadonlyArray<string>): boolean {
  return keywords.some((kw) => text.includes(kw));
}

interface ClassifyFields {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly diagnostics?: Readonly<Record<string, unknown>>;
}

function make(
  kind: RuntimeErrorKind,
  subKind: RuntimeErrorSubKind,
  message: string,
  brief: string,
  fields: ClassifyFields,
): RuntimeError {
  return new RuntimeErrorImpl({
    kind,
    subKind,
    providerId: PROVIDER,
    message,
    upstreamErrorBrief: brief.slice(0, 200),
    ...(fields.sessionId !== undefined ? { sessionId: fields.sessionId } : {}),
    ...(fields.turnId !== undefined ? { turnId: fields.turnId } : {}),
    ...(fields.diagnostics !== undefined ? { diagnostics: fields.diagnostics } : {}),
  });
}

/**
 * Classifies any Claude SDK / Node exception into the public categories.
 * `phase` affects the subKind chosen for transient/permanent errors in the init phase.
 */
export function classifySdkError(
  err: unknown,
  phase: "init" | "turn",
  fields: ClassifyFields = {},
): RuntimeError {
  if (err instanceof RuntimeErrorImpl) return err; // already a public error, pass through unchanged
  const e = err as { name?: string; message?: string };
  const brief = e.message ?? String(err);
  const text = `${brief} ${e.name ?? ""}`.toLowerCase();

  // Structural permanent: CLI missing (no text carries auth/quota, checked separately up front).
  if (match(text, CLI_MISSING)) {
    return make("permanent", "provider_init_permanent", `claude CLI not found: ${brief}`, brief, fields);
  }

  // permanent-first (avoid misclassifying mixed messages).
  if (match(text, PERMANENT_AUTH)) {
    const sub = text.includes("not logged in") || text.includes("not_logged_in") ? "auth_missing" : "auth_invalid";
    return make("permanent", sub, `SDK auth error: ${brief}`, brief, fields);
  }
  if (match(text, PERMANENT_QUOTA)) {
    return make("permanent", "quota_exhausted", `SDK quota/billing error: ${brief}`, brief, fields);
  }
  if (match(text, PERMANENT_CONFIG)) {
    return make("permanent", "invalid_request", `SDK config error: ${brief}`, brief, fields);
  }

  // transient keywords.
  if (match(text, TRANSIENT_RATE_LIMIT)) {
    return make("transient", "rate_limit", `SDK rate limit: ${brief}`, brief, fields);
  }
  if (match(text, TRANSIENT_5XX)) {
    return make("transient", "upstream_5xx", `SDK 5xx: ${brief}`, brief, fields);
  }
  if (match(text, TRANSIENT_NETWORK)) {
    return make("transient", "network", `SDK network error: ${brief}`, brief, fields);
  }
  if (match(text, TRANSIENT_TIMEOUT)) {
    // phase distinction: init timeout -> session_init_timeout; turn timeout -> transient/io_transient (host manages turn-level timeouts).
    if (phase === "init") return make("timeout", "session_init_timeout", `SDK timeout: ${brief}`, brief, fields);
    return make("transient", "io_transient", `SDK timeout: ${brief}`, brief, fields);
  }

  // fail-open: no match -> transient (provider_init_transient in the init phase, io_transient in the turn phase).
  const sub = phase === "init" ? "provider_init_transient" : "io_transient";
  return make("transient", sub, `unclassified SDK exception (treated as transient): ${brief}`, brief, fields);
}
