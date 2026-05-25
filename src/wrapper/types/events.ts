/**
 * The normalized SessionEvent type family plus the host inject marker.
 *
 * Every event extends SessionEventCommon (carrying receivedAt / sessionId / providerId).
 * The adapter is the sole consumer of the SDK's native event stream: it normalizes events into
 * SessionEvent, persists them to the stream JSONL, and fans them out to listeners.
 */
import type { AgentRole, EnvelopeId, ProviderId, ProviderSessionId, SessionId, TurnId } from "./common.js";
import type {
  InjectContentBlock,
  InjectPolicy,
  ModelSelector,
  SessionEndReason,
  SessionResumeTarget,
  SessionStatus,
  ThinkingConfig,
} from "./session.js";
import type { RuntimeError } from "./errors.js";
import type { HostToolContentBlock } from "./tool_bridge.js";

export interface SessionEventCommon {
  readonly receivedAt: number;
  readonly sessionId: SessionId;
  readonly providerId: ProviderId;
}

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly thinking?: number;
  readonly total?: number;
}

export interface TurnUsage {
  readonly tokens: TokenUsage;
  readonly cost?: number;
  readonly modelId: string;
}

export interface SessionFinalStats {
  readonly turnCount: number;
  readonly toolCallCount: number;
  readonly errorCount: number;
  readonly tokens: TokenUsage;
  /** Cumulative tokens for subagents (derived from Task/Agent tool calls), tracked separately from the main session tokens. */
  readonly subagentTokens?: number;
  readonly cost?: number;
}

export interface ContextUsage {
  readonly tokens: number | undefined;
  readonly contextWindow: number | undefined;
  readonly percent: number | undefined;
  readonly categories?: Readonly<Record<string, number>>;
}

// ---- host inject marker ----

export type InjectRequestId = string;

export type HostInjectKind =
  | "first_message"
  | "wake_inject"
  | "compact_role_reinject"
  | "feedback_to_worker";

export interface HostInjectMarker {
  readonly kind: HostInjectKind;
  readonly envelopeIds: ReadonlyArray<EnvelopeId>;
  readonly humanNote?: string;
}

// ---- session lifecycle ----

export interface SessionStartedEvent extends SessionEventCommon {
  readonly kind: "session_started";
  readonly role: AgentRole;
  readonly providerSessionId: ProviderSessionId | undefined;
  readonly model: ModelSelector;
  readonly thinking: ThinkingConfig | undefined;
  readonly cwd: string;
}

export interface SessionResumedEvent extends SessionEventCommon {
  readonly kind: "session_resumed";
  readonly previousProviderSessionId: ProviderSessionId | undefined;
  readonly providerSessionId: ProviderSessionId;
  readonly resumeTarget: SessionResumeTarget;
}

export interface SessionEndedEvent extends SessionEventCommon {
  readonly kind: "session_ended";
  readonly reason: SessionEndReason;
  readonly stats: SessionFinalStats;
}

// ---- turn boundaries ----

export type TurnCause =
  | { kind: "user_input"; markerKind: HostInjectKind }
  | { kind: "auto_retry"; attempt: number }
  | { kind: "compact_retry" }
  | { kind: "unknown" };

export interface TurnStartedEvent extends SessionEventCommon {
  readonly kind: "turn_started";
  readonly turnId: TurnId;
  readonly cause: TurnCause;
  readonly startedAt: number;
}

export type StopReason = "stop" | "max_tokens" | "tool_use" | "aborted" | "error" | "compact" | "unknown";

export interface TurnEndedEvent extends SessionEventCommon {
  readonly kind: "turn_ended";
  readonly turnId: TurnId;
  readonly stopReason: StopReason;
  readonly usage: TurnUsage | undefined;
  readonly endedAt: number;
}

// ---- assistant output ----

export interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface ThinkingBlock {
  readonly type: "thinking";
  readonly thinking: string;
}

export interface ToolUseBlock {
  readonly type: "tool_use";
  readonly toolUseId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly isHostTool: boolean;
}

export type AssistantBlock = TextBlock | ThinkingBlock | ToolUseBlock;

export interface AssistantBlockEvent extends SessionEventCommon {
  readonly kind: "assistant_block";
  readonly turnId: TurnId;
  readonly contentIndex: number;
  readonly block: AssistantBlock;
  /** When set, this block originates inside a subagent (the value is the id of the Task/Agent tool call that spawned it); empty for the main agent's own output. */
  readonly parentToolUseId?: string;
}

export type AssistantDelta =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_use_input_delta"; toolUseId: string; deltaJson: string };

export interface AssistantDeltaEvent extends SessionEventCommon {
  readonly kind: "assistant_delta";
  readonly turnId: TurnId;
  readonly contentIndex: number;
  readonly delta: AssistantDelta;
  /** When set, this partial originates inside a subagent (the value is the parent Task/Agent tool call id); empty for the main agent. Deltas are hidden by default; this field supports audit attribution. */
  readonly parentToolUseId?: string;
}

// ---- tool calls ----

export interface ToolResultBlock {
  readonly content: ReadonlyArray<HostToolContentBlock>;
  readonly isError: boolean;
  readonly providerExtras?: Readonly<Record<string, unknown>>;
}

export interface ToolInvokedEvent extends SessionEventCommon {
  readonly kind: "tool_invoked";
  readonly turnId: TurnId;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly isHostTool: boolean;
  readonly invokedAt: number;
  /** When set, this is a tool call inside a subagent (the value is the id of the Task/Agent tool call that spawned it); empty for the main agent's own calls. */
  readonly parentToolUseId?: string;
}

export interface ToolResultRecordedEvent extends SessionEventCommon {
  readonly kind: "tool_result_recorded";
  readonly turnId: TurnId;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly result: ToolResultBlock;
  readonly recordedAt: number;
  /** When set, this is a tool result inside a subagent (the value is the id of the Task/Agent tool call that spawned it); empty for the main agent's own results. */
  readonly parentToolUseId?: string;
}

// ---- compact ----

export type CompactReason = "manual_host" | "auto_threshold" | "auto_overflow" | "unknown";

export interface CompactStartedEvent extends SessionEventCommon {
  readonly kind: "compact_started";
  readonly reason: CompactReason;
  readonly tokensBefore: number | undefined;
}

export interface CompactEndedEvent extends SessionEventCommon {
  readonly kind: "compact_ended";
  readonly success: boolean;
  readonly summary: string | undefined;
  readonly firstKeptEntryId: string | undefined;
  readonly tokensAfter: number | undefined;
  readonly errorMessage: string | undefined;
  readonly willRetryTurn: boolean;
}

// ---- retry / usage ----

export interface RetryStartedEvent extends SessionEventCommon {
  readonly kind: "retry_started";
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly upstreamErrorBrief: string;
}

export interface RetryEndedEvent extends SessionEventCommon {
  readonly kind: "retry_ended";
  readonly success: boolean;
  readonly attempt: number;
  readonly finalErrorBrief?: string;
}

// ---- subagent lifecycle events (subagents derived from Task/Agent tool calls) ----

/** A subagent's cumulative usage up to a point in time (populated when the provider supplies it). */
export interface SubagentUsage {
  readonly totalTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
}

export interface SubagentStartedEvent extends SessionEventCommon {
  readonly kind: "subagent_started";
  readonly agentId: string;
  readonly parentToolUseId: string;
  readonly subagentType?: string;
  readonly description?: string;
}

export interface SubagentProgressEvent extends SessionEventCommon {
  readonly kind: "subagent_progress";
  readonly agentId: string;
  readonly parentToolUseId: string;
  readonly usage?: SubagentUsage;
  readonly lastToolName?: string;
}

export interface SubagentStoppedEvent extends SessionEventCommon {
  readonly kind: "subagent_stopped";
  readonly agentId: string;
  readonly parentToolUseId: string;
  readonly status: "completed" | "failed" | (string & {});
  readonly usage?: SubagentUsage;
  readonly summary?: string;
}

export interface UsageSnapshotEvent extends SessionEventCommon {
  readonly kind: "usage_snapshot";
  readonly source: "turn_ended" | "thread_event" | "session_stats" | "manual_query";
  readonly tokens: TokenUsage;
  readonly contextUsage?: ContextUsage;
  readonly cost?: number;
}

// ---- host inject events ----

export interface HostInjectRequestedEvent extends SessionEventCommon {
  readonly kind: "host_inject_requested";
  readonly injectRequestId: InjectRequestId;
  readonly marker: HostInjectMarker;
  readonly content: ReadonlyArray<InjectContentBlock>;
  readonly policy: InjectPolicy;
  readonly requestedAt: number;
}

export interface InjectAcceptedEvent extends SessionEventCommon {
  readonly kind: "inject_accepted";
  readonly injectRequestId: InjectRequestId;
  readonly acceptedAs: "deliver_immediate" | "deliver_after_interrupt" | "queue_steering" | "queue_follow_up";
}

export interface InjectRejectedEvent extends SessionEventCommon {
  readonly kind: "inject_rejected";
  readonly injectRequestId: InjectRequestId;
  readonly reason: "busy" | "not_supported_policy" | "invalid_marker" | "closed_session" | (string & {});
  readonly description?: string;
}

export interface InjectQueuedEvent extends SessionEventCommon {
  readonly kind: "inject_queued";
  readonly injectRequestId: InjectRequestId;
  readonly queueKind: "steering" | "follow_up";
  readonly queuePosition: number;
}

export interface InjectDeliveredEvent extends SessionEventCommon {
  readonly kind: "inject_delivered";
  readonly injectRequestId: InjectRequestId;
  readonly deliveryPath: "immediate" | "after_interrupt" | "from_queue_steering" | "from_queue_follow_up";
  readonly turnId: TurnId;
}

export interface InjectCancelledEvent extends SessionEventCommon {
  readonly kind: "inject_cancelled";
  readonly injectRequestId: InjectRequestId;
  readonly reason: "session_closed" | "session_killed" | "host_abort" | "user_replaced_queue" | (string & {});
  readonly recoveryHint?: "host_should_reissue" | "audit_only_no_recovery";
}

export interface InjectDroppedEvent extends SessionEventCommon {
  readonly kind: "inject_dropped";
  readonly injectRequestId: InjectRequestId;
  readonly reason: "provider_drop_on_resume" | "provider_drop_on_compact" | (string & {});
  readonly recoveryHint?: "host_should_reissue" | "audit_only_no_recovery";
}

// ---- error / synthetic / raw ----

export interface RuntimeErrorEvent extends SessionEventCommon {
  readonly kind: "runtime_error";
  readonly error: RuntimeError;
  readonly recoverable: boolean;
  readonly continuingSession: boolean;
}

export interface SyntheticStateSnapshotEvent extends SessionEventCommon {
  readonly kind: "synthetic_state_snapshot";
  readonly status: SessionStatus;
  readonly snapshotAt: number;
  readonly _persistedToStream: false;
}

export interface ProviderRawEvent extends SessionEventCommon {
  readonly kind: "provider_raw";
  readonly providerEventType: string;
  readonly raw: unknown;
}

export type SessionEvent =
  | SessionStartedEvent
  | SessionResumedEvent
  | SyntheticStateSnapshotEvent
  | HostInjectRequestedEvent
  | InjectAcceptedEvent
  | InjectRejectedEvent
  | InjectQueuedEvent
  | InjectDeliveredEvent
  | InjectCancelledEvent
  | InjectDroppedEvent
  | TurnStartedEvent
  | TurnEndedEvent
  | AssistantBlockEvent
  | AssistantDeltaEvent
  | ToolInvokedEvent
  | ToolResultRecordedEvent
  | CompactStartedEvent
  | CompactEndedEvent
  | RetryStartedEvent
  | RetryEndedEvent
  | SubagentStartedEvent
  | SubagentProgressEvent
  | SubagentStoppedEvent
  | UsageSnapshotEvent
  | SessionEndedEvent
  | RuntimeErrorEvent
  | ProviderRawEvent;

/** Schema of each stream JSONL line: a SessionEvent plus writer metadata. */
export type StreamJsonlLine = SessionEvent & {
  readonly _writer: {
    readonly seq: number;
    readonly adapterVersion: string;
  };
};
