/**
 * The top-level AgentRuntime interface: the stable surface the wrapper exposes to the host.
 * Each provider implements one.
 *
 * Optional members (compact / contextUsage / resumeSession / isolationSelfCheck) are present only
 * when the matching capability is true; the host must check the capability before calling them.
 */
import type { ProviderId, Unsubscribe } from "./common.js";
import type { CompactHint, CompactOutcome, RuntimeCapabilities } from "./capability.js";
import type { ContextUsage, SessionEvent } from "./events.js";
import type { IsolationSelfCheckResult } from "./isolation.js";
import type {
  CloseOptions,
  InjectAck,
  InjectInput,
  SessionCloseResult,
  SessionHandle,
  SessionRequest,
  SessionResumeTarget,
  SessionStatus,
} from "./session.js";

export interface AgentRuntime {
  readonly providerId: ProviderId;
  readonly capabilities: RuntimeCapabilities;

  startSession(req: SessionRequest): Promise<SessionHandle>;
  inject(handle: SessionHandle, input: InjectInput): Promise<InjectAck>;
  abortTurn(handle: SessionHandle, reason?: string): Promise<void>;
  closeSession(handle: SessionHandle, options?: CloseOptions): Promise<SessionCloseResult>;
  status(handle: SessionHandle): SessionStatus;
  subscribe(handle: SessionHandle, listener: (event: SessionEvent) => void): Unsubscribe;

  compact?(handle: SessionHandle, hint?: CompactHint): Promise<CompactOutcome>;
  contextUsage?(handle: SessionHandle): Promise<ContextUsage>;
  resumeSession?(handle: SessionHandle, target: SessionResumeTarget): Promise<void>;
  isolationSelfCheck?(handle: SessionHandle): Promise<IsolationSelfCheckResult>;
}
