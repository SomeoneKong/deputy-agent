/**
 * ClaudeRuntime -- the AgentRuntime implementation for the Claude provider.
 *
 * Implements only the public contract; Claude-private vocabulary stays inside
 * this adapter. One ClaudeSession per session (each holding its own Options /
 * queue / Query, so multiple sessions in one process do not interfere).
 */
import type {
  AgentRuntime,
  AgentRuntimeFactory,
  AgentRuntimeOptions,
  CloseOptions,
  CompactHint,
  CompactOutcome,
  ContextUsage,
  HostToolRegistry,
  InjectAck,
  InjectInput,
  IsolationSelfCheckResult,
  ProviderId,
  RuntimeCapabilities,
  SessionCloseResult,
  SessionEvent,
  SessionHandle,
  SessionRequest,
  SessionStatus,
  Unsubscribe,
} from "../../types/index.js";
import { RuntimeErrorImpl } from "../../types/index.js";
import { buildClaudeCapabilities } from "./capability.js";
import { resolveConfig, type ResolvedClaudeConfig } from "./config.js";
import { ClaudeSession } from "./session.js";

const PROVIDER: ProviderId = "claude";

class ClaudeRuntime implements AgentRuntime {
  readonly providerId: ProviderId = PROVIDER;
  readonly capabilities: RuntimeCapabilities;
  readonly #cfg: ResolvedClaudeConfig;
  readonly #registry: HostToolRegistry;
  readonly #sessions = new Map<string, ClaudeSession>();
  /** Close results for closed sessions (bounded LRU), for closeSession idempotency without retaining the whole ClaudeSession (avoids leaks). */
  readonly #closedResults = new Map<string, SessionCloseResult>();
  static readonly #CLOSED_CACHE_MAX = 256;

  constructor(options: AgentRuntimeOptions) {
    this.#cfg = resolveConfig(options.providerSpecific);
    this.#registry = options.toolRegistry;
    this.capabilities = buildClaudeCapabilities(this.#cfg.tsApiUnverified);
  }

  #retire(id: string, result: SessionCloseResult): void {
    this.#sessions.delete(id);
    this.#closedResults.set(id, result);
    if (this.#closedResults.size > ClaudeRuntime.#CLOSED_CACHE_MAX) {
      const oldest = this.#closedResults.keys().next().value;
      if (oldest !== undefined) this.#closedResults.delete(oldest);
    }
  }

  async startSession(req: SessionRequest): Promise<SessionHandle> {
    if (this.#sessions.has(req.sessionId)) {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: PROVIDER, message: `sessionId already in use: ${req.sessionId}` });
    }
    const session = new ClaudeSession(req, this.#cfg, this.#registry);
    this.#sessions.set(req.sessionId, session);
    try {
      await session.start();
    } catch (err) {
      this.#sessions.delete(req.sessionId);
      throw err;
    }
    return session.handle;
  }

  async inject(handle: SessionHandle, input: InjectInput): Promise<InjectAck> {
    return this.#must(handle).inject(input);
  }

  async abortTurn(handle: SessionHandle, reason?: string): Promise<void> {
    return this.#must(handle).abortTurn(reason);
  }

  async closeSession(handle: SessionHandle, options?: CloseOptions): Promise<SessionCloseResult> {
    const session = this.#sessions.get(handle.id);
    if (session === undefined) {
      // already retired (idempotent) -> return cached result; never existed -> unknown.
      const cached = this.#closedResults.get(handle.id);
      if (cached !== undefined) return cached;
      return { sessionId: handle.id, endedAt: Date.now(), reason: "unknown", stats: { turnCount: 0, toolCallCount: 0, errorCount: 0, tokens: { input: 0, output: 0, total: 0 } }, hadForcedKill: false };
    }
    const result = await session.close(options);
    this.#retire(handle.id, result); // remove from the active map after close to avoid leaks in a long-running host
    return result;
  }

  status(handle: SessionHandle): SessionStatus {
    const session = this.#sessions.get(handle.id);
    if (session !== undefined) return session.status;
    const cached = this.#closedResults.get(handle.id);
    return { state: "closed", reason: cached?.reason ?? "unknown" };
  }

  subscribe(handle: SessionHandle, listener: (event: SessionEvent) => void): Unsubscribe {
    const session = this.#sessions.get(handle.id);
    if (session === undefined) return () => {};
    return session.subscribe(listener);
  }

  async compact(handle: SessionHandle, hint?: CompactHint): Promise<CompactOutcome> {
    return this.#must(handle).compact(hint);
  }

  async contextUsage(handle: SessionHandle): Promise<ContextUsage> {
    return this.#must(handle).contextUsage();
  }

  // resumeSession is not implemented (sessionResume.* are all false).

  async isolationSelfCheck(handle: SessionHandle): Promise<IsolationSelfCheckResult> {
    return this.#must(handle).isolationSelfCheck();
  }

  #must(handle: SessionHandle): ClaudeSession {
    const session = this.#sessions.get(handle.id);
    if (session === undefined) {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: PROVIDER, sessionId: handle.id });
    }
    return session;
  }
}

export const claudeRuntimeFactory: AgentRuntimeFactory = {
  create(options: AgentRuntimeOptions): AgentRuntime {
    return new ClaudeRuntime(options);
  },
};
