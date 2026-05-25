/**
 * Session contract: lifecycle, turns, inject, status, close, and resume.
 */
import type { AgentRole, ProviderId, ProviderSessionId, SessionId, TurnId } from "./common.js";
import type { ThinkingLevel } from "./capability.js";
import type { IsolationProfile } from "./isolation.js";
import type { HostInjectMarker, SessionFinalStats } from "./events.js";

export interface ModelSelector {
  readonly provider: ProviderId;
  readonly modelId: string;
}

export interface ThinkingConfig {
  readonly level: ThinkingLevel;
  readonly summary: "off" | "summarized";
}

export type ProviderBuiltinToolsPolicy =
  | { mode: "disable_all" }
  | { mode: "allow_list"; names: ReadonlyArray<string> }
  | { mode: "passthrough" };

export interface HostToolCallTimeout {
  readonly handlerTimeoutMs?: number;
  readonly abortGraceMs?: number;
}

export interface SessionFeatureFlags {
  readonly autoCompact?: boolean;
  readonly autoRetry?: boolean;
  readonly providerBuiltinTools?: ProviderBuiltinToolsPolicy;
}

export interface SessionMetadata {
  readonly lifecycleHint?: "long" | "short";
  readonly expectedDurationMs?: number;
  readonly originHostTaskId?: string;
}

export interface PathGuardRule {
  readonly pattern: string;
  readonly mode: "deny" | "allow";
  readonly affectedTools: ReadonlyArray<string>;
  readonly denyReason?: string;
}

export interface SessionRequestPathGuards {
  readonly rules: ReadonlyArray<PathGuardRule>;
}

export interface SessionRequest {
  readonly role: AgentRole;
  readonly sessionId: SessionId;
  readonly cwd: string;
  readonly model: ModelSelector;
  readonly thinking?: ThinkingConfig;
  readonly systemPromptPath: string;
  readonly firstMessagePath?: string;
  readonly toolNames: ReadonlyArray<string>;
  readonly streamPath: string;
  readonly isolation: IsolationProfile;
  readonly pathGuards?: SessionRequestPathGuards;
  readonly featureFlags?: SessionFeatureFlags;
  readonly metadata?: SessionMetadata;
}

/**
 * A secret-stripped copy of SessionRequest. Since `AuthSource` carries only a secret reference and
 * never an inline secret, the snapshot has the same shape as the request; this alias expresses the
 * "snapshot for recovery / audit" intent.
 */
export type SessionRequestSnapshot = SessionRequest;

export interface SessionHandle {
  readonly id: SessionId;
  readonly providerSessionId: ProviderSessionId | undefined;
  readonly role: AgentRole;
  readonly request: SessionRequestSnapshot;
}

export type SessionStatus =
  | { state: "initializing" }
  | { state: "idle"; lastTurnEndedAt?: number }
  | { state: "streaming"; turnId: string; turnStartedAt: number; toolInflightIds: ReadonlyArray<string> }
  | { state: "closing"; reason: SessionEndReason }
  | { state: "closed"; reason: SessionEndReason };

export interface InjectInput {
  readonly content: ReadonlyArray<InjectContentBlock>;
  readonly marker: HostInjectMarker;
  readonly policy: InjectPolicy;
}

export type InjectContentBlock =
  | { type: "text"; text: string }
  | { type: "text"; textPath: string }
  | { type: "image"; data: string; mediaType: string }
  | { type: "image"; path: string; mediaType: string }
  | { type: "reference"; uri: string; description?: string };

export type InjectPolicy =
  | { kind: "require_idle" }
  | { kind: "steer_if_streaming" }
  | { kind: "follow_up_if_streaming" }
  | { kind: "interrupt_then_inject" };

export type InjectAck =
  | { mode: "delivered_immediate"; turnId: TurnId }
  | { mode: "queued_steering"; pendingPosition: number }
  | { mode: "queued_followup"; pendingPosition: number }
  | { mode: "delivered_after_interrupt"; turnId: TurnId }
  | { mode: "rejected_busy"; reason: string };

export interface CloseOptions {
  readonly forceAbort?: boolean;
  readonly idleTimeoutMs?: number;
  readonly reason?: SessionEndReason;
}

export type SessionEndReason =
  | "host_close"
  | "host_close_forced"
  | "worker_declared_done"
  | "worker_declared_deferred"
  | "session_natural_end"
  | "fatal_runtime_error"
  | "unknown";

export interface SessionCloseResult {
  readonly sessionId: SessionId;
  readonly endedAt: number;
  readonly reason: SessionEndReason;
  readonly stats: SessionFinalStats;
  readonly hadForcedKill: boolean;
}

export type SessionResumeTarget =
  | { kind: "from_file"; path: string }
  | { kind: "from_provider_id"; providerSessionId: string }
  | { kind: "fork_at_entry"; entryId: string };
