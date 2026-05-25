/**
 * Single source of truth for errorKind string literals — written by the host orchestration
 * layer into manifest.lastError / host_event.extras.eventKind / events.jsonl details / tool results.
 *
 * Field names are camelCase, string values snake_case. Grouped into string literal unions by
 * source domain rather than by write site. New values go into the corresponding union plus the
 * constant in this file.
 *
 * The wrapper `(kind, subKind)` → `SdkErrorKind` coarsening map gives the host a fixed audit
 * vocabulary; unmatched values fall to `sdk_unknown` (handled as transient/permanent per
 * RuntimeErrorKind) or `sdk_protocol`.
 */
import type { RuntimeError, RuntimeErrorKind } from "../wrapper/types/errors.js";

// ---- common host tool error kinds ----

export type HostToolCommonErrorKind =
  | "invalid_argument"
  | "illegal_state"
  | "target_not_found"
  | "concurrent_conflict"
  | "host_internal";

export const HostToolCommonErrorKind = {
  invalidArgument: "invalid_argument",
  illegalState: "illegal_state",
  targetNotFound: "target_not_found",
  concurrentConflict: "concurrent_conflict",
  hostInternal: "host_internal",
} as const satisfies Record<string, HostToolCommonErrorKind>;

// ---- host orchestration error kinds ----

export type HostOrchestrationErrorKind =
  | "host_single_instance_conflict"
  | "isolation_assertion_failed"
  | "host_recovery_failed"
  | "meta_permanent_failure"
  | "meta_start_threshold_exceeded"
  | "meta_recovery_inject_failed"
  | "worker_crash_on_host_restart"
  | "worker_completion_pending_degraded"
  | "wake_inject_mark_read_failed"
  | "agent_session_start_failed"
  | "register_host_tools_failed"
  | "reviewer_verdict_missing"
  | "reviewer_session_failed"
  | "events_jsonl_corrupted"
  | "events_jsonl_quarantine_failed"
  | "reviewer_required";

export const HostOrchestrationErrorKind = {
  hostSingleInstanceConflict: "host_single_instance_conflict",
  isolationAssertionFailed: "isolation_assertion_failed",
  hostRecoveryFailed: "host_recovery_failed",
  metaPermanentFailure: "meta_permanent_failure",
  metaStartThresholdExceeded: "meta_start_threshold_exceeded",
  metaRecoveryInjectFailed: "meta_recovery_inject_failed",
  workerCrashOnHostRestart: "worker_crash_on_host_restart",
  workerCompletionPendingDegraded: "worker_completion_pending_degraded",
  wakeInjectMarkReadFailed: "wake_inject_mark_read_failed",
  agentSessionStartFailed: "agent_session_start_failed",
  registerHostToolsFailed: "register_host_tools_failed",
  reviewerVerdictMissing: "reviewer_verdict_missing",
  reviewerSessionFailed: "reviewer_session_failed",
  eventsJsonlCorrupted: "events_jsonl_corrupted",
  eventsJsonlQuarantineFailed: "events_jsonl_quarantine_failed",
  reviewerRequired: "reviewer_required",
} as const satisfies Record<string, HostOrchestrationErrorKind>;

// ---- SDK / runtime error kinds ----

export type SdkErrorKind =
  | "sdk_transient_network"
  | "sdk_transient_rate_limit"
  | "sdk_transient_5xx"
  | "sdk_transient_timeout"
  | "sdk_permanent_auth"
  | "sdk_permanent_quota"
  | "sdk_permanent_cli_missing"
  | "sdk_permanent_config_error"
  | "sdk_protocol"
  | "sdk_unknown"
  | "watcher_compact_failed";

export const SdkErrorKind = {
  transientNetwork: "sdk_transient_network",
  transientRateLimit: "sdk_transient_rate_limit",
  transient5xx: "sdk_transient_5xx",
  transientTimeout: "sdk_transient_timeout",
  permanentAuth: "sdk_permanent_auth",
  permanentQuota: "sdk_permanent_quota",
  permanentCliMissing: "sdk_permanent_cli_missing",
  permanentConfigError: "sdk_permanent_config_error",
  protocol: "sdk_protocol",
  unknown: "sdk_unknown",
  watcherCompactFailed: "watcher_compact_failed",
} as const satisfies Record<string, SdkErrorKind>;

// ---- watchdog error kinds ----

export type WatchdogKind =
  | "watchdog_worker_no_progress"
  | "watchdog_worker_tool_loop"
  | "watchdog_host_tool_call_timeout"
  | "watchdog_sdk_api_timeout"
  | "watchdog_reviewer_session_timeout"
  | "watchdog_meta_push_timeout";

export const WatchdogKind = {
  workerNoProgress: "watchdog_worker_no_progress",
  workerToolLoop: "watchdog_worker_tool_loop",
  hostToolCallTimeout: "watchdog_host_tool_call_timeout",
  sdkApiTimeout: "watchdog_sdk_api_timeout",
  reviewerSessionTimeout: "watchdog_reviewer_session_timeout",
  metaPushTimeout: "watchdog_meta_push_timeout",
} as const satisfies Record<string, WatchdogKind>;

/** Only watchdog labels scoped to a Worker session map into `WorkerExitReason`. */
export const WORKER_WATCHDOG_KINDS: ReadonlySet<WatchdogKind> = new Set<WatchdogKind>([
  WatchdogKind.workerNoProgress,
  WatchdogKind.workerToolLoop,
]);

// ---- Worker / agent behavior error kinds (host_event diagnostic + fail-soft labels) ----

export type AgentBehaviorErrorKind =
  | "worker_sdk_crash"
  | "worker_subprocess_crash"
  | "host_internal_error"
  | "worker_interrupt_softkill_failed"
  | "worker_stop_softkill_failed"
  | "worker_inject_failed"
  | "watcher_permanent_failure"
  | "watcher_final_window_degraded";

export const AgentBehaviorErrorKind = {
  workerSdkCrash: "worker_sdk_crash",
  workerSubprocessCrash: "worker_subprocess_crash",
  hostInternalError: "host_internal_error",
  workerInterruptSoftkillFailed: "worker_interrupt_softkill_failed",
  workerStopSoftkillFailed: "worker_stop_softkill_failed",
  workerInjectFailed: "worker_inject_failed",
  watcherPermanentFailure: "watcher_permanent_failure",
  watcherFinalWindowDegraded: "watcher_final_window_degraded",
} as const satisfies Record<string, AgentBehaviorErrorKind>;

// ---- messaging health events (subset of eventKind written by host) ----

export const MessagingEventKind = {
  stateCorrupted: "messaging_state_corrupted",
  payloadCorrupted: "messaging_payload_corrupted",
  markReadDegraded: "messaging_mark_read_degraded",
} as const;

// ---- tool return errorKind (not enqueued as an envelope) ----

export const ToolReturnErrorKind = {
  invalidReviewerPhase: "invalid_reviewer_phase",
} as const;

// ---- host_event eventKind (orchestration-layer signals) ----

export const HostEventKind = {
  eventsJsonlCorrupted: HostOrchestrationErrorKind.eventsJsonlCorrupted,
  workerCrashOnHostRestart: HostOrchestrationErrorKind.workerCrashOnHostRestart,
  workerCompletionPendingDegraded: HostOrchestrationErrorKind.workerCompletionPendingDegraded,
  workerCompletionReminder: "worker_completion_reminder",
  metaProgressReminder: "meta_progress_reminder",
  agentSessionStartFailed: HostOrchestrationErrorKind.agentSessionStartFailed,
  watcherPermanentFailure: AgentBehaviorErrorKind.watcherPermanentFailure,
  reviewerSessionFailed: HostOrchestrationErrorKind.reviewerSessionFailed,
  wakeInjectMarkReadFailed: HostOrchestrationErrorKind.wakeInjectMarkReadFailed,
  messagingMarkReadDegraded: MessagingEventKind.markReadDegraded,
  watcherCompactFailed: SdkErrorKind.watcherCompactFailed,
  sdkProtocol: SdkErrorKind.protocol,
} as const;

// ---- wrapper (kind, subKind) → SdkErrorKind coarsening map ----

const SUBKIND_MAP: Readonly<Record<string, SdkErrorKind>> = {
  // transient
  network: SdkErrorKind.transientNetwork,
  rate_limit: SdkErrorKind.transientRateLimit,
  upstream_overloaded: SdkErrorKind.transientRateLimit,
  upstream_5xx: SdkErrorKind.transient5xx,
  // permanent
  auth_invalid: SdkErrorKind.permanentAuth,
  auth_missing: SdkErrorKind.permanentAuth,
  quota_exhausted: SdkErrorKind.permanentQuota,
  model_unavailable: SdkErrorKind.permanentConfigError,
  invalid_request: SdkErrorKind.permanentConfigError,
  not_supported: SdkErrorKind.permanentConfigError,
};

const ISOLATION_VIOLATION_PREFIX = "isolation_violation_";

/**
 * Coarsen the wrapper's open `(kind, subKind)` into the host's fixed audit vocabulary.
 * - protocol kind → `sdk_protocol` (no retry, surfaced)
 * - `provider_init_permanent` with upstreamErrorBrief indicating a missing CLI → `sdk_permanent_cli_missing`
 * - `isolation_violation_*` → `sdk_permanent_config_error`
 * - matched in SUBKIND_MAP → the mapped value
 * - unmatched → `sdk_unknown` (caller still handles transient/permanent per `RuntimeErrorKind`)
 */
export function mapSdkErrorKind(kind: RuntimeErrorKind, subKind: string, upstreamErrorBrief?: string): SdkErrorKind {
  if (kind === "protocol") return SdkErrorKind.protocol;
  if (subKind === "provider_init_permanent") {
    // Only treat explicit "not found / does not exist" phrases as a missing CLI (avoid the
    // word "cli" / "command" matching too broadly)
    if (
      upstreamErrorBrief !== undefined &&
      /(not found|no such file|enoent|is not recognized|command not found|cannot find)/i.test(upstreamErrorBrief)
    ) {
      return SdkErrorKind.permanentCliMissing;
    }
    // Not CLI-missing: unlisted subKinds fail open to sdk_unknown (handled per kind), keeping
    // config_error semantics clean
    return SdkErrorKind.unknown;
  }
  if (subKind.startsWith(ISOLATION_VIOLATION_PREFIX)) return SdkErrorKind.permanentConfigError;
  return SUBKIND_MAP[subKind] ?? SdkErrorKind.unknown;
}

/**
 * Convenience wrapper: derive the host audit SdkErrorKind from a `RuntimeError`.
 * SDK API timeouts injected by the host watchdog (diagnostics.watchdogKind ===
 * watchdog_sdk_api_timeout, with placeholder subKind io_transient) bypass SUBKIND_MAP and map
 * directly to `sdk_transient_timeout`.
 */
export function sdkErrorKindFromRuntimeError(err: RuntimeError): SdkErrorKind {
  if (err.diagnostics?.["watchdogKind"] === WatchdogKind.sdkApiTimeout) {
    return SdkErrorKind.transientTimeout;
  }
  return mapSdkErrorKind(err.kind, err.subKind, err.upstreamErrorBrief);
}
