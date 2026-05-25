/**
 * Stub AgentRuntime: a scriptable wrapper implementation for tests and closed-loop driving.
 *
 * It implements the full `AgentRuntime` contract (event normalization, stream JSONL persistence,
 * and host tool round-tripping). A scriptbook drives each turn's output (text / thinking / host
 * tool calls), letting subsystems run repeatable closed-loop tests without a real provider.
 *
 * It is not a real provider: `providerId` defaults to masquerading as "claude" (configurable to any
 * of the four) so audit branches can be reused. Real provider adapters live in `adapters/<provider>/`.
 *
 * By default a turn runs to completion synchronously inside `inject()` (emitting all events and
 * invoking host handlers) before resolving the ack, so callers never observe a concurrent streaming
 * state. This is sufficient for most closed-loop tests and does not weaken the contract (event
 * order, pairing, and persistence all hold). When a program sets `deferTurn`, the turn runs
 * asynchronously instead: inject emits synchronously up to turn_started and returns the ack
 * immediately, while the remaining steps and turn_ended emit on a later macrotask. This is used to
 * exercise the host orchestration layer's event-driven session lifecycle across ticks.
 */
import { jsonlIO } from "../../shared/jsonl.js";
import type {
  AgentRuntime,
  AgentRuntimeFactory,
  AgentRuntimeOptions,
  CloseOptions,
  CompactHint,
  CompactOutcome,
  ContextUsage,
  HostTool,
  HostToolCallContext,
  HostToolCallResult,
  HostToolContentBlock,
  HostToolRegistry,
  InjectAck,
  InjectInput,
  ProviderId,
  RuntimeCapabilities,
  SessionCloseResult,
  SessionEndReason,
  SessionEvent,
  SessionHandle,
  SessionRequest,
  SessionStatus,
  StopReason,
  TurnId,
  Unsubscribe,
} from "../types/index.js";
import { NotSupportedError, RuntimeErrorImpl } from "../types/index.js";

const ADAPTER_VERSION = "stub-0";
const REPLAY_BUFFER_MAX = 64;

// ---- scriptbook (orchestration interface) ----

export type StubTurnStep =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string }
  | { kind: "tool"; toolName: string; input: unknown; parentToolUseId?: string };

export interface StubTurnProgram {
  readonly steps: ReadonlyArray<StubTurnStep>;
  readonly stopReason?: StopReason;
  /**
   * Asynchronous turn mode (simulating a real adapter's long turn): `inject()` emits synchronously
   * up to `turn_started` and sets `streaming`, then returns the ack immediately; the remaining steps
   * and `turn_ended` run asynchronously on the next macrotask. Used to exercise the host
   * orchestration layer's event-driven session lifecycle across ticks. Defaults to false (the turn
   * runs to completion synchronously inside inject).
   */
  readonly deferTurn?: boolean;
  /**
   * A long turn that never ends naturally (simulating a stuck / no-progress worker): after emitting
   * its steps it does not emit `turn_ended`, and the session stays `streaming` until the host
   * interrupts it with `closeSession(forceAbort)`. Used to exercise the session-level watchdog
   * (no_progress / tool_loop). Only meaningful together with `deferTurn: true` (a synchronous turn
   * cannot be observed across ticks). Defaults to false.
   */
  readonly holdOpen?: boolean;
}

export interface StubScriptbook {
  /** Enqueue a program for the given session's next turn. */
  enqueue(sessionId: string, program: StubTurnProgram): void;
  /** Enqueue a default program (consumed in order when a session has no dedicated queue). */
  enqueueDefault(program: StubTurnProgram): void;
}

interface StubScriptbookInternal extends StubScriptbook {
  take(sessionId: string): StubTurnProgram | undefined;
}

export function createStubScriptbook(): StubScriptbook {
  const perSession = new Map<string, StubTurnProgram[]>();
  const defaults: StubTurnProgram[] = [];
  const book: StubScriptbookInternal = {
    enqueue(sessionId, program) {
      const q = perSession.get(sessionId) ?? [];
      q.push(program);
      perSession.set(sessionId, q);
    },
    enqueueDefault(program) {
      defaults.push(program);
    },
    take(sessionId) {
      const q = perSession.get(sessionId);
      if (q && q.length > 0) return q.shift();
      if (defaults.length > 0) return defaults.shift();
      return undefined;
    },
  };
  return book;
}

const FALLBACK_PROGRAM: StubTurnProgram = { steps: [{ kind: "text", text: "stub: no program enqueued" }] };

// ---- default capabilities (fully permissive, for closed-loop tests; overridable via config) ----

export const defaultStubCapabilities: RuntimeCapabilities = {
  inject: { requireIdle: true, steerIfStreaming: true, followUpIfStreaming: true, interruptThenInject: true },
  streamingDelta: false,
  contextUsage: { kind: "basic", supportsManualQuery: true, supportsPushSnapshot: true, fields: ["tokens"] },
  compact: { canTrigger: true, canObserveSummary: true, canCustomizeSummary: true, acceptsCustomInstructions: true },
  sessionResume: { fromProviderId: true, fromFile: true, forkAtEntry: true },
  toolEnforcement: { preflightHook: true, firstClassBlock: true, osSandboxWritableRoots: true, canDisableHighRiskBuiltins: true },
  toolStreamingPartial: false,
  providerBuiltinToolsControl: { canDisableAll: true, canAllowList: true },
  thinking: { supportedLevels: ["off", "low", "medium", "high"], supportsReasoningSummary: true },
  autoRetry: { hasAutoRetry: false, canDisable: true },
  isolationSelfCheck: true,
  jsonSchemaSubset: ["primitive_types", "enum", "const", "object", "array"],
};

export interface StubProviderConfig {
  readonly providerId?: ProviderId;
  readonly capabilities?: RuntimeCapabilities;
  readonly scriptbook?: StubScriptbook;
  readonly adapterVersion?: string;
  /**
   * Tokens returned by contextUsage() (drives the host watcher's compact trigger). Defaults to 0
   * (no trigger). After a successful compact it returns `contextUsageTokensAfterCompact` (default 0)
   * to simulate usage dropping back, so the next tick does not immediately re-trigger.
   */
  readonly contextUsageTokens?: number;
  readonly contextUsageTokensAfterCompact?: number;
  /** Make compact() return success=false (to drive the host's compact retry / giveup paths). Defaults to false. */
  readonly compactShouldFail?: boolean;
  /**
   * Make compact() return success=false with summary=undefined (simulating a provider with
   * `canObserveSummary=false`) while still applying the token drop (contextUsageTokensAfterCompact):
   * compaction did happen, only the summary is unobservable (unlike `compactShouldFail`, where
   * compaction did not happen at all). Drives the host's lenient compact closed-loop test. Defaults
   * to false.
   */
  readonly compactSummaryUnobservable?: boolean;
  /**
   * Make the first N startSession calls throw a transient RuntimeError (thrown before registration,
   * leaving no half-session) to drive the host's transient-retry tests. Counted globally and
   * consumed in call order. Defaults to 0 (no injected failures).
   */
  readonly transientStartFailures?: number;
  /**
   * Make the first N inject calls throw a transient RuntimeError (thrown before processing) to drive
   * the host's first-message inject retry tests. Counted globally and consumed in call order.
   * Defaults to 0.
   */
  readonly transientInjectFailures?: number;
  /**
   * Restrict transientStartFailures / transientInjectFailures to sessions of this role only (to
   * target injected failures at a specific agent, e.g. reviewer, without earlier meta/worker calls
   * consuming the budget). Defaults to undefined (not restricted by role).
   */
  readonly transientFailRole?: SessionRequest["role"];
  /**
   * Init-on-first-push mode (mirroring the claude adapter: startSession does not init immediately
   * but stays `initializing`; the first inject triggers session_started and the transition to idle
   * before handling that inject). Defaults to false, where startSession emits session_started and
   * transitions to idle immediately. Used to reproduce/regress the path where a long session at
   * startup is initialized by its first wake inject (e.g. Watcher): if the stub goes idle
   * immediately it masks the deadlock where the host's wake prefilter skips an initializing session
   * so the first inject is never sent.
   */
  readonly initOnFirstInject?: boolean;
}

// ---- internal session state ----

interface SessionState {
  readonly handle: SessionHandle;
  status: SessionStatus;
  seq: number;
  turnCounter: number;
  /**
   * Dedicated counter for inject requestIds. state.seq is incremented asynchronously inside
   * #doEmit, so if #nextInjectId read state.seq synchronously, two concurrent injects could read the
   * same seq before either's host_inject_requested is persisted, colliding requestIds. A dedicated
   * synchronously-incremented counter eliminates the collision.
   */
  injectCounter: number;
  toolCallCount: number;
  errorCount: number;
  started: boolean;
  closeResult: SessionCloseResult | undefined;
  /**
   * The close in-flight promise. close() sets this synchronously (before any await) so that
   * concurrent / re-entrant closes reuse the same promise/result, preventing two concurrent
   * closeSession calls from each emitting a session_ended.
   */
  closePromise: Promise<SessionCloseResult> | undefined;
  /**
   * Synchronous close-in-progress flag. close() sets it true before its first await so that
   * #sessionClosed reports "closed" even while close is still mid session_ended emit (before
   * closeResult is set), fencing off late injects.
   */
  closing: boolean;
  readonly listeners: Set<(e: SessionEvent) => void>;
  readonly replay: SessionEvent[];
  abort: AbortController | undefined;
  /** Context-tokens override after a successful compact (undefined = use the config default contextUsageTokens); simulates usage dropping back. */
  contextTokens: number | undefined;
  /**
   * Synchronous inject-lifecycle mutex (policy-independent): inject() sets it true before its first
   * await and resets it on turn completion / rejection / exception. In a real adapter a host tool
   * handler and the tick main loop can concurrently inject the same session; if idle were judged
   * solely by `status === "streaming"` (which is only set after several awaits), two concurrent
   * injects could both pass the idle check and insert a turn body inside the close window, emitting
   * turn_started/tool_result after session_ended (breaking event order). Claimed synchronously
   * before any await, this flag makes a concurrent inject under any policy reject per its own
   * semantics while streaming/injecting (require_idle -> rejected_busy; steer/follow_up/
   * interrupt_then_inject -> the stub uniformly applies backpressure as rejected_busy and does not
   * open a second concurrent turn). It is decoupled from require_idle so that the
   * steer/follow_up/interrupt policies do not leave a hole where two idle concurrent injects both
   * pass the check and enter the turn body.
   */
  injecting: boolean;
  /**
   * emit serialization chain: every #emit is queued onto a single promise chain so persisted seq is
   * monotonic and fanout order equals submission order, never reordered by concurrent awaits (inject
   * vs closeSession).
   */
  emitChain: Promise<void>;
  /**
   * session_ended hard-boundary fence: set true once the terminal session_ended is persisted;
   * subsequent ordinary events return immediately at the top of #doEmit, never entering replay,
   * fanout, or persistence (ordinary events after the terminal state are not delivered at all, so
   * the host cannot mis-update tool history / watchdog / turnEnded from late events and break event
   * ordering). Only session_ended itself is allowed through.
   */
  sessionEndedPersisted: boolean;
}

class StubRuntime implements AgentRuntime {
  readonly providerId: ProviderId;
  readonly capabilities: RuntimeCapabilities;
  readonly #registry: HostToolRegistry;
  readonly #scriptbook: StubScriptbookInternal;
  readonly #adapterVersion: string;
  readonly #contextUsageTokens: number;
  readonly #contextUsageTokensAfterCompact: number;
  readonly #compactShouldFail: boolean;
  readonly #compactSummaryUnobservable: boolean;
  #transientStartFailuresRemaining: number;
  #transientInjectFailuresRemaining: number;
  readonly #transientFailRole: SessionRequest["role"] | undefined;
  readonly #initOnFirstInject: boolean;
  readonly #sessions = new Map<string, SessionState>();

  constructor(options: AgentRuntimeOptions) {
    const cfg = (options.providerSpecific ?? {}) as StubProviderConfig;
    this.providerId = cfg.providerId ?? "claude";
    this.capabilities = cfg.capabilities ?? defaultStubCapabilities;
    this.#registry = options.toolRegistry;
    this.#scriptbook = (cfg.scriptbook ?? createStubScriptbook()) as StubScriptbookInternal;
    this.#adapterVersion = cfg.adapterVersion ?? ADAPTER_VERSION;
    this.#contextUsageTokens = cfg.contextUsageTokens ?? 0;
    this.#contextUsageTokensAfterCompact = cfg.contextUsageTokensAfterCompact ?? 0;
    this.#compactShouldFail = cfg.compactShouldFail ?? false;
    this.#compactSummaryUnobservable = cfg.compactSummaryUnobservable ?? false;
    this.#transientStartFailuresRemaining = cfg.transientStartFailures ?? 0;
    this.#transientInjectFailuresRemaining = cfg.transientInjectFailures ?? 0;
    this.#transientFailRole = cfg.transientFailRole;
    this.#initOnFirstInject = cfg.initOnFirstInject ?? false;
  }

  async startSession(req: SessionRequest): Promise<SessionHandle> {
    // Inject a transient start failure (thrown before registration, so no half-session is left; the host's retry absorbs it). When transientFailRole is set, only that role is affected.
    if (this.#transientStartFailuresRemaining > 0 && (this.#transientFailRole === undefined || req.role === this.#transientFailRole)) {
      this.#transientStartFailuresRemaining -= 1;
      throw new RuntimeErrorImpl({ kind: "transient", subKind: "network", providerId: this.providerId, message: "stub: injected transient start failure" });
    }
    if (this.#sessions.has(req.sessionId)) {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: this.providerId, message: `sessionId already in use: ${req.sessionId}` });
    }
    // Each tool name must be registered and its scope must include the current role.
    for (const name of req.toolNames) {
      const tool = this.#registry.get(name);
      if (tool === undefined) {
        throw new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: this.providerId, message: `tool not registered: ${name}` });
      }
      if (!tool.scope.includes(req.role)) {
        throw new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: this.providerId, message: `tool ${name} not in scope for role ${req.role}` });
      }
    }
    const handle: SessionHandle = {
      id: req.sessionId,
      providerSessionId: `stub-${req.sessionId}`,
      role: req.role,
      request: req,
    };
    const state: SessionState = {
      handle,
      status: { state: "initializing" },
      seq: 0,
      turnCounter: 0,
      injectCounter: 0,
      toolCallCount: 0,
      errorCount: 0,
      started: false,
      closeResult: undefined,
      closePromise: undefined,
      closing: false,
      listeners: new Set(),
      replay: [],
      abort: undefined,
      contextTokens: undefined,
      injecting: false,
      emitChain: Promise.resolve(),
      sessionEndedPersisted: false,
    };
    this.#sessions.set(req.sessionId, state);
    // initOnFirstInject mode: do not init here; stay `initializing` until the first inject triggers
    // session_started and the transition to idle. The default mode inits immediately.
    if (!this.#initOnFirstInject) {
      await this.#emitSessionStarted(state, req, handle);
    }
    return handle;
  }

  // Emit session_started and transition to idle (the first init). Called from startSession in immediate mode, or from the first inject's delivery path in initOnFirstInject mode.
  async #emitSessionStarted(state: SessionState, req: SessionRequest, handle: SessionHandle): Promise<void> {
    await this.#emit(state, {
      kind: "session_started",
      ...this.#common(state),
      role: req.role,
      providerSessionId: handle.providerSessionId,
      model: req.model,
      thinking: req.thinking,
      cwd: req.cwd,
    });
    state.started = true;
    state.status = { state: "idle" };
  }

  async inject(handle: SessionHandle, input: InjectInput): Promise<InjectAck> {
    const state = this.#mustSession(handle);
    // Inject a transient inject failure (thrown before processing; the host's first-message inject retry absorbs it). When transientFailRole is set, only that role is affected.
    if (this.#transientInjectFailuresRemaining > 0 && (this.#transientFailRole === undefined || state.handle.role === this.#transientFailRole)) {
      this.#transientInjectFailuresRemaining -= 1;
      throw new RuntimeErrorImpl({ kind: "transient", subKind: "network", providerId: this.providerId, message: "stub: injected transient inject failure" });
    }
    // Validate arguments up front: a missing marker or empty content -> invalid_request, without emitting host_inject_requested.
    if (input.marker === undefined || typeof input.marker.kind !== "string") {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: this.providerId, message: "inject marker missing", diagnostics: { reason: "invalid_marker" } });
    }
    if (input.content.length === 0) {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: this.providerId, message: "inject content empty" });
    }
    if (state.status.state === "closing" || state.status.state === "closed") {
      const requestId = this.#nextInjectId(state);
      await this.#emit(state, { kind: "host_inject_requested", ...this.#common(state), injectRequestId: requestId, marker: input.marker, content: input.content, policy: input.policy, requestedAt: Date.now() });
      await this.#emit(state, { kind: "inject_rejected", ...this.#common(state), injectRequestId: requestId, reason: "closed_session" });
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: this.providerId, sessionId: handle.id });
    }

    // Synchronously claim the inject-lifecycle mutex (policy-independent): check and claim before the
    // first await to serialize concurrent injects. If already streaming (the previous turn is still
    // running) or an inject is already in-flight (a concurrent second inject) -> immediate
    // rejected_busy (no turn body, no events inserted in the close window). Not limited to
    // require_idle: otherwise the steer_if_streaming / follow_up_if_streaming / interrupt_then_inject
    // policies leave a hole where two idle concurrent injects both pass the check and open a turn
    // body (emitting turn_started/tool_result after session_ended, breaking event order). The stub
    // does not implement turn-merge semantics, so under any policy a concurrent/streaming inject is
    // uniformly backpressured as rejected_busy (matching a real adapter: do not open a second
    // concurrent turn). Once claimed, any turn-completion / exception / close path resets it.
    if (state.status.state === "streaming" || state.injecting) {
      const requestId = this.#nextInjectId(state);
      await this.#emit(state, { kind: "host_inject_requested", ...this.#common(state), injectRequestId: requestId, marker: input.marker, content: input.content, policy: input.policy, requestedAt: Date.now() });
      await this.#emit(state, { kind: "inject_rejected", ...this.#common(state), injectRequestId: requestId, reason: "busy" });
      return { mode: "rejected_busy", reason: "session busy (streaming or inject in-flight)" };
    }
    state.injecting = true;

    // init-on-first-push (initOnFirstInject mode): reproduces the timing where init is triggered by
    // the first inject and the session stays `initializing` until then (the key semantics the
    // deadlock fix relies on), rather than matching a specific provider's event ordering. Here the
    // stub emits session_started before host_inject_requested / turn_started (the same shape as the
    // immediate mode). Event ordering is not a cross-provider hard contract. When the first inject
    // reaches this point it emits session_started and transitions to idle (init done) before
    // handling the inject; `injecting` is already claimed, so a concurrent second inject is rejected
    // by the busy prefilter above and never re-inits; later injects see started=true and skip.
    if (!state.started) {
      await this.#emitSessionStarted(state, state.handle.request, state.handle);
    }

    const requestId = this.#nextInjectId(state);
    await this.#emit(state, { kind: "host_inject_requested", ...this.#common(state), injectRequestId: requestId, marker: input.marker, content: input.content, policy: input.policy, requestedAt: Date.now() });
    // The `injecting` flag only blocks concurrent injects, not a concurrent closeSession(forceAbort):
    // in a real adapter the tick main loop / Meta turn handler can insert a close at any of inject's
    // pre-turn await points (writing session_ended and setting closed). After each pre-turn await,
    // re-check closing/closed: if closed, stop emitting subsequent ordinary events (inject_accepted /
    // delivered / turn_started after session_ended would be illegal late events that break ordering)
    // and settle as rejected immediately (releasing injecting).
    if (this.#sessionClosed(state)) return this.#injectAbortedByClose(state);

    await this.#emit(state, { kind: "inject_accepted", ...this.#common(state), injectRequestId: requestId, acceptedAs: "deliver_immediate" });
    if (this.#sessionClosed(state)) return this.#injectAbortedByClose(state);
    const turnId = this.#nextTurnId(state);
    await this.#emit(state, { kind: "inject_delivered", ...this.#common(state), injectRequestId: requestId, deliveryPath: "immediate", turnId });
    if (this.#sessionClosed(state)) return this.#injectAbortedByClose(state);

    // The turn prologue (turn_started + streaming) is always synchronous: the turn has begun during inject.
    const program = this.#scriptbook.take(state.handle.id) ?? FALLBACK_PROGRAM;
    const abort = new AbortController();
    state.abort = abort;
    state.status = { state: "streaming", turnId, turnStartedAt: Date.now(), toolInflightIds: [] };
    await this.#emit(state, {
      kind: "turn_started",
      ...this.#common(state),
      turnId,
      cause: { kind: "user_input", markerKind: input.marker.kind },
      startedAt: Date.now(),
    });
    if (this.#sessionClosed(state)) return this.#injectAbortedByClose(state);

    if (program.deferTurn === true) {
      // Run the rest of the turn body asynchronously (simulating a real adapter's long turn); inject returns the ack immediately and turn_ended emits on a later macrotask.
      setTimeout(() => void this.#runTurnBody(state, turnId, program, abort.signal).catch(() => { state.errorCount += 1; }), 0);
      return { mode: "delivered_immediate", turnId };
    }
    await this.#runTurnBody(state, turnId, program, abort.signal);
    return { mode: "delivered_immediate", turnId };
  }

  async abortTurn(handle: SessionHandle, _reason?: string): Promise<void> {
    const state = this.#mustSession(handle);
    if (state.status.state === "closing" || state.status.state === "closed") {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: this.providerId, sessionId: handle.id });
    }
    if (state.status.state === "streaming") {
      state.abort?.abort();
      const turnId = state.status.turnId;
      await this.#emit(state, { kind: "turn_ended", ...this.#common(state), turnId, stopReason: "aborted", usage: undefined, endedAt: Date.now() });
      state.status = { state: "idle", lastTurnEndedAt: Date.now() };
      state.injecting = false; // abort settled -> release the inject claim
    }
    // idle / initializing -> no-op
  }

  async closeSession(handle: SessionHandle, options?: CloseOptions): Promise<SessionCloseResult> {
    const state = this.#sessions.get(handle.id);
    if (state === undefined) {
      return { sessionId: handle.id, endedAt: Date.now(), reason: "unknown", stats: this.#zeroStats(), hadForcedKill: false };
    }
    // All concurrent / re-entrant closes reuse the same in-flight promise, so two concurrent
    // closeSession calls cannot both pass the idempotency check (closeResult is only set after
    // awaiting session_ended) and each emit a session_ended.
    if (state.closeResult !== undefined) return state.closeResult; // already done -> idempotent cached return
    if (state.closePromise !== undefined) return state.closePromise; // in progress -> reuse the same close
    state.closing = true; // set synchronously (before await): fences late injects (#sessionClosed reads this)
    state.closePromise = this.#doClose(state, handle, options);
    return state.closePromise;
  }

  async #doClose(state: SessionState, handle: SessionHandle, options?: CloseOptions): Promise<SessionCloseResult> {
    if (state.status.state === "streaming" && options?.forceAbort === true) {
      await this.abortTurn(handle, "close");
    }
    const reason: SessionEndReason = options?.reason ?? "host_close";
    state.injecting = false; // close settled -> release the inject claim (when a holdOpen turn is interrupted)
    state.status = { state: "closing", reason };
    await this.#emit(state, { kind: "session_ended", ...this.#common(state), reason, stats: this.#stats(state) });
    state.status = { state: "closed", reason };
    const result: SessionCloseResult = {
      sessionId: handle.id,
      endedAt: Date.now(),
      reason,
      stats: this.#stats(state),
      hadForcedKill: false,
    };
    state.closeResult = result;
    state.listeners.clear(); // clear listeners once in the terminal state
    return result;
  }

  status(handle: SessionHandle): SessionStatus {
    const state = this.#sessions.get(handle.id);
    if (state === undefined) return { state: "closed", reason: "unknown" };
    return state.status;
  }

  subscribe(handle: SessionHandle, listener: (event: SessionEvent) => void): Unsubscribe {
    const state = this.#sessions.get(handle.id);
    if (state === undefined) return () => {};
    state.listeners.add(listener);
    // Bounded replay: session_started (if already emitted) + a synthetic snapshot + the most recent N events.
    if (state.started) {
      const started = state.replay.find((e) => e.kind === "session_started");
      if (started) this.#safeCall(state, listener, started);
      this.#safeCall(state, listener, {
        kind: "synthetic_state_snapshot",
        ...this.#common(state),
        status: state.status,
        snapshotAt: Date.now(),
        _persistedToStream: false,
      });
      for (const e of state.replay.filter((e) => e.kind !== "session_started")) {
        this.#safeCall(state, listener, e);
      }
    }
    return () => state.listeners.delete(listener);
  }

  // ---- internal ----

  /**
   * After an inject pre-turn await, detect whether the session has been closed concurrently. Uses
   * `closeResult !== undefined` (the idempotent terminal marker set by a completed close, not
   * rewritten by this inject) or status closing/closed, the latter covering the window where close
   * is still mid session_ended emit (status="closing", closeResult not yet set). Status alone is not
   * enough: inject itself sets status to streaming, so closeResult is the more reliable "closed"
   * signal.
   */
  #sessionClosed(state: SessionState): boolean {
    // The synchronous `closing` flag covers the window where close has entered but session_ended is
    // still mid-emit (status may still be streaming / closeResult not yet set), layered on top of
    // status closing/closed and the closeResult terminal marker.
    return state.closing || state.closeResult !== undefined || state.status.state === "closing" || state.status.state === "closed";
  }

  /** Inject interrupted by a concurrent close: release the injecting claim and return a rejected ack (do not emit further ordinary turn events). */
  #injectAbortedByClose(state: SessionState): InjectAck {
    state.injecting = false;
    return { mode: "rejected_busy", reason: "session closed during inject" };
  }

  #mustSession(handle: SessionHandle): SessionState {
    const state = this.#sessions.get(handle.id);
    if (state === undefined) {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: this.providerId, sessionId: handle.id });
    }
    return state;
  }

  #common(state: SessionState): { receivedAt: number; sessionId: string; providerId: ProviderId } {
    return { receivedAt: Date.now(), sessionId: state.handle.id, providerId: this.providerId };
  }

  #nextTurnId(state: SessionState): TurnId {
    state.turnCounter += 1;
    return `${state.handle.id}-t${state.turnCounter}`;
  }

  #nextInjectId(state: SessionState): string {
    // Dedicated synchronous counter (like turnCounter in #nextTurnId); does not read the asynchronously-incremented state.seq.
    state.injectCounter += 1;
    return `${state.handle.id}-i${state.injectCounter}`;
  }

  #zeroStats(): SessionCloseResult["stats"] {
    return { turnCount: 0, toolCallCount: 0, errorCount: 0, tokens: { input: 0, output: 0 } };
  }

  #stats(state: SessionState): SessionCloseResult["stats"] {
    return { turnCount: state.turnCounter, toolCallCount: state.toolCallCount, errorCount: state.errorCount, tokens: { input: 0, output: 0 } };
  }

  async #runTurnBody(state: SessionState, turnId: TurnId, program: StubTurnProgram, signal: AbortSignal): Promise<void> {
    // On the deferred path the turn body may be closed before it runs: defensively skip (do not emit on a closed session).
    if (state.status.state === "closing" || state.status.state === "closed") {
      state.abort = undefined;
      state.injecting = false; // release the inject claim (the turn never actually ran)
      return;
    }
    let contentIndex = 0;
    for (const step of program.steps) {
      // Check `signal.aborted || closing/closed` at the top of the loop (symmetric with the late-event
      // discipline in #runToolStep). During a non-force close (no forceAbort, no aborted signal) the
      // status is already closing/closed; checking signal.aborted alone would let text/thinking
      // assistant_blocks keep emitting after session_ended (illegal late ordinary events). If closed,
      // stop emitting the remaining steps; the turn_ended emit below checks the same.
      if (signal.aborted || this.#sessionClosed(state)) break;
      if (step.kind === "text") {
        await this.#emit(state, { kind: "assistant_block", ...this.#common(state), turnId, contentIndex: contentIndex++, block: { type: "text", text: step.text } });
      } else if (step.kind === "thinking") {
        await this.#emit(state, { kind: "assistant_block", ...this.#common(state), turnId, contentIndex: contentIndex++, block: { type: "thinking", thinking: step.thinking } });
      } else {
        await this.#runToolStep(state, turnId, step.toolName, step.input, contentIndex++, signal, step.parentToolUseId);
      }
    }

    if (signal.aborted) {
      // abortTurn has already emitted turn_ended(aborted) and set idle.
      state.abort = undefined;
      state.injecting = false;
      return;
    }
    // Non-force close (status already closing/closed but signal not aborted): do not emit turn_ended
    // (session_ended is already written, so turn_ended would be a late ordinary event). Release the
    // inject claim and settle.
    if (this.#sessionClosed(state)) {
      state.abort = undefined;
      state.injecting = false;
      return;
    }
    if (program.holdOpen === true) {
      // A long turn that never ends naturally: stay streaming until the host interrupts with
      // closeSession(forceAbort) (watchdog test). The streaming state itself blocks require_idle
      // injects, so releasing the inject claim here does not relax backpressure.
      state.injecting = false;
      return;
    }
    await this.#emit(state, { kind: "turn_ended", ...this.#common(state), turnId, stopReason: program.stopReason ?? "stop", usage: undefined, endedAt: Date.now() });
    state.status = { state: "idle", lastTurnEndedAt: Date.now() };
    state.abort = undefined;
    state.injecting = false; // turn ended naturally -> release the inject claim
  }

  async #runToolStep(state: SessionState, turnId: TurnId, toolName: string, toolInput: unknown, contentIndex: number, signal: AbortSignal, parentToolUseId?: string): Promise<void> {
    const tool: HostTool | undefined = this.#registry.get(toolName);
    const toolUseId = `${turnId}-tool${state.toolCallCount + 1}`;
    const isHostTool = tool !== undefined;
    const parent = parentToolUseId !== undefined ? { parentToolUseId } : {}; // a tool call inside a subagent
    await this.#emit(state, { kind: "assistant_block", ...this.#common(state), turnId, contentIndex, block: { type: "tool_use", toolUseId, toolName, input: toolInput, isHostTool }, ...parent });
    await this.#emit(state, { kind: "tool_invoked", ...this.#common(state), turnId, toolUseId, toolName, input: toolInput, isHostTool, invokedAt: Date.now(), ...parent });
    state.toolCallCount += 1;

    // After emitting tool_invoked, and before any further emit or handler call, re-check for close: a
    // concurrent closeSession may have been inserted between tool_invoked and here (writing
    // session_ended and setting closed/closing). If closed, skip: (a) the late tool_result_recorded
    // for an unknown tool (this check must precede the tool===undefined branch); and (b) the host
    // tool handler side effects and tool_result. Consistent with the late-event discipline after the
    // handler returns and at the top of the runToolStep loop.
    if (signal.aborted || this.#sessionClosed(state)) return;

    if (tool === undefined) {
      state.errorCount += 1;
      await this.#emitToolResult(state, turnId, toolUseId, toolName, { content: [{ type: "text", text: `unknown tool: ${toolName}` }], isError: true }, parentToolUseId);
      return;
    }

    const ctx: HostToolCallContext = {
      sessionHandle: state.handle,
      toolCallId: toolUseId,
      turnId,
      agentRole: state.handle.role,
      providerId: this.providerId,
      signal,
      logger: { debug: () => {} },
    };
    // Known boundary: the fences above guard "closed before calling the handler" and "late emit after
    // the handler returns", but if a concurrent closeSession happens while the handler is executing,
    // the handler's own side effects (bus enqueue / stage write / harness files / agentControl) may
    // still commit after the session's terminal state. That is the host-tool layer's
    // abort-awareness responsibility: ctx.signal is passed in, and a handler that needs bounded
    // cancellation should honor it. The wrapper layer does not forcibly interrupt an in-flight
    // handler (there is no generally safe interruption point, and forcing a race would corrupt host state).
    let result: HostToolCallResult;
    try {
      result = await tool.handler(toolInput, ctx);
    } catch (err) {
      state.errorCount += 1;
      const e = err as { name?: string; message?: string; code?: string };
      const providerExtras: Record<string, unknown> = { _hostToolException: { name: e.name, message: e.message, code: e.code } };
      result = { content: [{ type: "text", text: `host tool handler threw: ${e.message ?? String(err)}` }], isError: true, providerExtras };
      // Handler threw during a force close / abort (force close itself often makes the handler
      // throw): check aborted / #sessionClosed first and skip emitting runtime_error (after
      // session_ended it would be a late event that breaks ordering, matching the normal return path
      // below). Still record errorCount and set an isError result (the handler's return value itself
      // is not emitted).
      if (signal.aborted || this.#sessionClosed(state)) return;
      await this.#emit(state, {
        kind: "runtime_error",
        ...this.#common(state),
        error: new RuntimeErrorImpl({ kind: "permanent", subKind: "host_tool_handler_error", providerId: this.providerId, sessionId: state.handle.id, turnId, toolUseId, message: e.message ?? "handler error" }),
        recoverable: true,
        continuingSession: true,
      });
    }
    // On a deferred turn, if closeSession(forceAbort) happened while awaiting the handler,
    // session_ended and the abort have already been emitted. After the handler returns, do not emit
    // ordinary turn events (tool_result_recorded after session_ended would be a late event that
    // breaks ordering).
    if (signal.aborted || this.#sessionClosed(state)) return;
    await this.#emitToolResult(state, turnId, toolUseId, toolName, { content: result.content as ReadonlyArray<HostToolContentBlock>, isError: result.isError, ...(result.providerExtras !== undefined ? { providerExtras: result.providerExtras } : {}) }, parentToolUseId);
  }

  async #emitToolResult(state: SessionState, turnId: TurnId, toolUseId: string, toolName: string, result: { content: ReadonlyArray<HostToolContentBlock>; isError: boolean; providerExtras?: Readonly<Record<string, unknown>> }, parentToolUseId?: string): Promise<void> {
    await this.#emit(state, { kind: "tool_result_recorded", ...this.#common(state), turnId, toolUseId, toolName, result, recordedAt: Date.now(), ...(parentToolUseId !== undefined ? { parentToolUseId } : {}) });
  }

  /**
   * emit serialization: every emit is queued onto the single state.emitChain promise chain, so
   * persisted seq is monotonic and fanout order equals submission order, never reordered at the
   * appendLine await point by concurrent awaits (inject's turn body emit vs closeSession's
   * session_ended emit). The returned promise resolves once this event is persisted and fanned out.
   */
  #emit(state: SessionState, event: SessionEvent): Promise<void> {
    const next = state.emitChain.then(() => this.#doEmit(state, event));
    // Swallow chain errors so one failure does not block subsequent emits (persistence failures are already counted inside #doEmit).
    state.emitChain = next.catch(() => {});
    return next;
  }

  async #doEmit(state: SessionState, event: SessionEvent): Promise<void> {
    // session_ended hard-boundary fence (placed before replay.push, fanout, and persistence): once
    // the terminal session_ended is persisted, subsequent ordinary events are not delivered at all,
    // never entering replay, fanout, or persistence. Otherwise late ordinary events would still be
    // pushed to replay and fanned out, and the host would mis-update tool history / watchdog /
    // turnEnded. Together with the emit chain: close's session_ended is queued first and sets the
    // fence, and inject's subsequent ordinary events reach here via the same chain and are fenced
    // off wholesale. session_ended itself is allowed through (the close in-flight promise guarantees
    // it is emitted exactly once).
    if (state.sessionEndedPersisted && event.kind !== "session_ended") return;

    // ring buffer (bounded replay).
    state.replay.push(event);
    if (state.replay.length > REPLAY_BUFFER_MAX + 4) state.replay.splice(0, state.replay.length - (REPLAY_BUFFER_MAX + 4));
    // Persist to the stream JSONL (a synthetic snapshot with _persistedToStream:false is not persisted, but this path never emits one).
    const persist = !("_persistedToStream" in event);
    if (persist) {
      state.seq += 1;
      try {
        await jsonlIO.appendLine(state.handle.request.streamPath, { ...event, _writer: { seq: state.seq, adapterVersion: this.#adapterVersion } });
        if (event.kind === "session_ended") state.sessionEndedPersisted = true;
      } catch {
        state.errorCount += 1; // stub: a persistence failure is only counted (a real adapter escalates)
      }
    }
    // fanout.
    for (const listener of state.listeners) this.#safeCall(state, listener, event);
  }

  #safeCall(state: SessionState, listener: (e: SessionEvent) => void, event: SessionEvent): void {
    try {
      listener(event);
    } catch {
      state.errorCount += 1; // a throwing listener does not propagate
    }
  }

  /**
   * Returns the current context tokens (injected via config). After a successful compact it returns
   * the dropped-back value (state.contextTokens). The stub does not model contextWindow / percent
   * (undefined); the capability declares fields:["tokens"].
   */
  async contextUsage(handle: SessionHandle): Promise<ContextUsage> {
    const state = this.#mustSession(handle);
    return {
      tokens: state.contextTokens ?? this.#contextUsageTokens,
      contextWindow: undefined,
      percent: undefined,
    };
  }

  /**
   * On success, drops subsequent contextUsage tokens to the dropped-back value (simulating
   * compaction releasing context) with success=true and a non-empty summary. With `compactShouldFail`
   * configured it returns success=false (to drive the host's retry / giveup tests). It does not
   * change the session status (still idle), so a subsequent role-reinject inject (require_idle) can
   * proceed immediately.
   */
  async compact(handle: SessionHandle, _hint?: CompactHint): Promise<CompactOutcome> {
    const state = this.#mustSession(handle);
    if (this.#compactShouldFail) {
      // Compaction did not happen at all: success=false + compact_not_performed, no token drop (both lenient and strict retry).
      return { success: false, failureKind: "compact_not_performed", summary: undefined, errorMessage: "stub: compact configured to fail" };
    }
    const tokensBefore = state.contextTokens ?? this.#contextUsageTokens;
    if (this.#compactSummaryUnobservable) {
      // Compaction happened (token drop) but the summary is unobservable (the lenient summary_unobservable terminal state of a canObserveSummary=false provider).
      state.contextTokens = this.#contextUsageTokensAfterCompact;
      return { success: false, failureKind: "summary_unobservable", summary: undefined, tokensBefore, tokensAfter: this.#contextUsageTokensAfterCompact, errorMessage: "stub: compact summary unobservable" };
    }
    state.contextTokens = this.#contextUsageTokensAfterCompact;
    return {
      success: true,
      summary: "stub compact summary",
      tokensBefore,
      tokensAfter: this.#contextUsageTokensAfterCompact,
    };
  }

  // The remaining optional methods (resumeSession / isolationSelfCheck) are not declared: the host checks capabilities; the real capabilities live in the real adapters.
}

export const stubRuntimeFactory: AgentRuntimeFactory = {
  create(options: AgentRuntimeOptions): AgentRuntime {
    return new StubRuntime(options);
  },
};
