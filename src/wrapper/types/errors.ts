/**
 * The wrapper's RuntimeError model: five top-level kinds plus a subKind.
 *
 * This is the wrapper's own error model, distinct from the shared DeputyError types; the host
 * main loop consumes it.
 */
import type { ProviderId, SessionId, TurnId } from "./common.js";

export type RuntimeErrorKind = "transient" | "permanent" | "timeout" | "cancelled" | "protocol";

export type TransientSubKind =
  | "network"
  | "rate_limit"
  | "upstream_5xx"
  | "upstream_overloaded"
  | "io_transient"
  | "abort_failed_retryable"
  | "provider_init_transient";

export type PermanentSubKind =
  | "auth_invalid"
  | "auth_missing"
  | "quota_exhausted"
  | "max_turns_exhausted"
  | "structured_output_retries_exhausted"
  | "model_unavailable"
  | "invalid_request"
  | "duplicate_tool_name"
  | "tool_name_clash"
  | "schema_translation_failed"
  | "schema_validation_failed_host_side"
  | "not_supported"
  | "isolation_violation_user_settings_loaded"
  | "isolation_violation_user_hooks_loaded"
  | "isolation_violation_context_files_walked_up"
  | "isolation_violation_unsupported_sandbox"
  | "isolation_violation_auth_leak"
  | "isolation_violation_env_conflict"
  | "isolation_violation_rules_loaded"
  | "io_permanent"
  | "stream_persistent_write_failed"
  | "provider_init_permanent"
  | "closed_session"
  | "session_replaced"
  | "abort_unsupported"
  | "host_tool_handler_error"
  | "host_tool_handler_misbehaved"
  | "adapter_internal_error";

export type TimeoutSubKind =
  | "tool_handler_timeout"
  | "tool_handler_abort_grace_exceeded"
  | "session_init_timeout"
  | "close_idle_timeout"
  | "abort_completion_timeout";

export type CancelledSubKind =
  | "host_abort_turn"
  | "host_close_session"
  | "host_force_kill"
  | "upstream_session_replaced";

export type ProtocolSubKind =
  | "schema_mismatch"
  | "ordering_violation"
  | "missing_required_event"
  | "unexpected_event"
  | "tool_result_missing"
  | "compact_summary_missing"
  | "provider_session_id_missing";

/** subKind is an open string; the union above is the documented set of known labels. */
export type RuntimeErrorSubKind =
  | TransientSubKind
  | PermanentSubKind
  | TimeoutSubKind
  | CancelledSubKind
  | ProtocolSubKind
  | (string & {});

export interface RuntimeError extends Error {
  readonly kind: RuntimeErrorKind;
  readonly subKind: string;
  readonly providerId: ProviderId;
  readonly sessionId?: SessionId;
  readonly turnId?: TurnId;
  readonly toolUseId?: string;
  readonly upstreamErrorBrief?: string;
  readonly diagnostics?: Readonly<Record<string, unknown>>;
}

export interface RuntimeErrorInit {
  readonly kind: RuntimeErrorKind;
  readonly subKind: RuntimeErrorSubKind;
  readonly providerId: ProviderId;
  readonly message?: string;
  readonly sessionId?: SessionId;
  readonly turnId?: TurnId;
  readonly toolUseId?: string;
  readonly upstreamErrorBrief?: string;
  readonly diagnostics?: Readonly<Record<string, unknown>>;
}

/** Concrete RuntimeError implementation for adapters to throw. */
export class RuntimeErrorImpl extends Error implements RuntimeError {
  readonly kind: RuntimeErrorKind;
  readonly subKind: string;
  readonly providerId: ProviderId;
  readonly sessionId?: SessionId;
  readonly turnId?: TurnId;
  readonly toolUseId?: string;
  readonly upstreamErrorBrief?: string;
  readonly diagnostics?: Readonly<Record<string, unknown>>;

  constructor(init: RuntimeErrorInit) {
    super(init.message ?? `${init.kind}/${init.subKind}`);
    this.name = "RuntimeError";
    this.kind = init.kind;
    this.subKind = init.subKind;
    this.providerId = init.providerId;
    if (init.sessionId !== undefined) this.sessionId = init.sessionId;
    if (init.turnId !== undefined) this.turnId = init.turnId;
    if (init.toolUseId !== undefined) this.toolUseId = init.toolUseId;
    if (init.upstreamErrorBrief !== undefined) this.upstreamErrorBrief = init.upstreamErrorBrief;
    if (init.diagnostics !== undefined) this.diagnostics = init.diagnostics;
  }
}

/** Thrown when a requested capability is not supported. */
export class NotSupportedError extends RuntimeErrorImpl {
  readonly capabilityPath: string;
  constructor(capabilityPath: string, providerId: ProviderId, message?: string) {
    super({
      kind: "permanent",
      subKind: "not_supported",
      providerId,
      message: message ?? `capability ${capabilityPath} not supported by provider ${providerId}`,
      diagnostics: { capabilityPath },
    });
    this.name = "NotSupportedError";
    this.capabilityPath = capabilityPath;
  }
}

export function isRuntimeError(err: unknown): err is RuntimeError {
  return (
    err instanceof Error &&
    typeof (err as Partial<RuntimeError>).kind === "string" &&
    typeof (err as Partial<RuntimeError>).subKind === "string" &&
    typeof (err as Partial<RuntimeError>).providerId === "string"
  );
}
