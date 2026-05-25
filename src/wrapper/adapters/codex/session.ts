/**
 * CodexSession -- the state machine + single consumer for one Codex thread.
 *
 * Holds one thread (on the shared app-server subprocess); subscribes to that thread's JSON-RPC
 * notifications (routed in by CapsuleConnection by threadId), normalizes them -> writes the stream
 * JSONL (epoch fencing + escalation after 3 consecutive failures) + fans out to listeners. Lifecycle /
 * the three inject states / abort / close / compact / contextUsage / resume all land here.
 *
 * State machine: initializing -> idle -> streaming -> closing -> closed.
 */
import { jsonlIO } from "../../../shared/jsonl.js";
import type {
  CompactHint,
  CompactOutcome,
  ContextUsage,
  HostTool,
  HostToolRegistry,
  InjectAck,
  InjectContentBlock,
  InjectInput,
  IsolationSelfCheckResult,
  ProviderId,
  RuntimeError,
  SessionCloseResult,
  SessionEndReason,
  SessionEvent,
  SessionFinalStats,
  SessionHandle,
  SessionRequest,
  SessionResumeTarget,
  SessionStatus,
  TurnCause,
  TurnId,
  Unsubscribe,
  UsageSnapshotEvent,
} from "../../types/index.js";
import { NotSupportedError, RuntimeErrorImpl } from "../../types/index.js";
import { readFile } from "node:fs/promises";

import type { AppServerClient } from "./appServerClient.js";
import type { ResolvedCodexConfig } from "./config.js";
import { CODEX_THINKING_LEVELS } from "./config.js";
import { classifyCodexErrorInfo, classifyRpcError } from "./errors.js";
import {
  AUTOMATION_APPROVAL_POLICY,
  epochFenceOk,
  isolationConfig,
  isolationSelfCheck,
  sandboxPolicyOf,
  verifyIsolation,
} from "./isolation.js";
import {
  NOTIFICATION_METHODS,
  CLIENT_METHODS,
  type InitializeResponse,
  type ItemCompletedNotification,
  type ItemStartedNotification,
  type ThreadStartParams,
  type ThreadStartResponse,
  type ThreadResumeResponse,
  type TurnCompletedNotification,
  type TurnStartParams,
  type TurnStartResponse,
  type TurnStartedNotification,
  type ThreadTokenUsageUpdatedNotification,
  type UserInput,
  type JsonValue,
} from "./protocol.js";
import {
  normalizeAgentMessageDelta,
  normalizeError,
  normalizeItemCompleted,
  normalizeItemStarted,
  normalizeReasoningDelta,
  normalizeThreadCompacted,
  normalizeTokenUsage,
  normalizeTurnCompleted,
  normalizeTurnStarted,
  type NormalizeContext,
} from "./eventNormalize.js";
import { buildDynamicTools, dispatchToolCall, type ToolBridgeHooks } from "./toolBridge.js";

const PROVIDER: ProviderId = "codex";
const REPLAY_BUFFER_MAX = 64;
const STREAM_WRITE_FAIL_LIMIT = 3;

/** The session's access surface to the shared app-server subprocess (provided by the runtime). */
export interface CapsuleAccess {
  readonly client: AppServerClient;
  /** Register this session's threadId for notification routing (called once thread/start yields the threadId). */
  registerThread(threadId: string, session: CodexSession): void;
  /** Unbind threadId routing (on close). */
  unregisterThread(threadId: string): void;
  /** This session closed -> tell the runtime to check whether it was the last thread (if so, shut down the subprocess). */
  onThreadClosed(): void;
  /**
   * This capsule observed a successful turn (turn/completed) -> tell the runtime to reset the consecutive
   * crash count for this capsuleKey. Resetting is bound to a successful turn rather than startSession
   * success, so a crash-loop where "init succeeds but the first turn crashes" accumulates to permanent
   * instead of being masked by a spurious init-success signal.
   */
  onTurnSuccess(): void;
  /**
   * Force-kill path (cascade): triggered by this session (forceAbort failed / idle timeout / unsubscribe
   * failed) -> the capsule owner force-kills the app-server subprocess and cascade-finalizes all sibling
   * sessions in the same capsule (fatal_runtime_error). The initiator's own host_close_forced terminal
   * state is landed by the caller after this call (not finalized again here).
   */
  forceKillCapsule(initiator: CodexSession, err: RuntimeError): void;
}

export class CodexSession {
  handle: SessionHandle;
  readonly #req: SessionRequest;
  readonly #cfg: ResolvedCodexConfig;
  readonly #registry: HostToolRegistry;
  readonly #capsule: CapsuleAccess;

  #status: SessionStatus = { state: "initializing" };
  #threadId: string | undefined;
  #initResponse: InitializeResponse | undefined;
  #sentinelMarker: string | undefined;

  #seq = 0;
  #turnCounter = 0;
  #injectCounter = 0;
  #toolCallCount = 0;
  #errorCount = 0;
  #tokensInput = 0;
  #tokensOutput = 0;
  #streamWriteFails = 0;
  #latestContextUsage: ContextUsage | undefined;

  /** The Codex turnId of the current active turn (undefined when idle). */
  #currentTurnId: TurnId | undefined;
  #turnAbort: AbortController | undefined;
  #sessionAbort = new AbortController();
  /** The cause for the next turn (set from the marker on inject, consumed by turn/started). */
  #pendingTurnCause: TurnCause | undefined;
  /** A pending inject awaiting settlement (on turn/started arrival, emit inject_delivered + resolve the ack;
   *  on cancellation during close/crash/resume, reject -- never resolve to an empty turnId that would be
   *  mistaken for delivered). */
  #pendingInject:
    | { requestId: string; deliveryPath: "immediate" | "after_interrupt"; resolve: (turnId: string) => void; reject: (err: Error) => void }
    | undefined;
  /** Waiters for the current turn (abort / close awaiting turn/completed). */
  readonly #pendingTurns = new Set<() => void>();
  /** Monotonic content block index counter (item order). */
  #contentIndexCounter = 0;
  /** itemId -> toolName (recorded on a tool-type item/started, for item/completed to backfill). */
  readonly #toolNamesById = new Map<string, string>();
  /** The inflight toolUseIds of the current turn (the kill path emits synthetic tool_results for them). */
  readonly #inflightToolIds = new Set<string>();

  #closing = false;
  #finalized = false;
  #sessionEndedPersisted = false;
  #stuck = false;
  #closeResult: SessionCloseResult | undefined;
  #closePromise: Promise<SessionCloseResult> | undefined;

  #compactInflight = false;
  #compactResolver: ((o: CompactOutcome) => void) | undefined;

  readonly #listeners = new Set<(e: SessionEvent) => void>();
  readonly #replay: SessionEvent[] = [];
  readonly #createdEpoch: string | undefined;
  readonly #byCodexName;
  readonly #dynamicToolSpecs;

  constructor(req: SessionRequest, cfg: ResolvedCodexConfig, registry: HostToolRegistry, capsule: CapsuleAccess) {
    this.#req = req;
    this.#cfg = cfg;
    this.#registry = registry;
    this.#capsule = capsule;
    this.#createdEpoch = cfg.currentHostEpoch();
    const tools = this.#selectTools();
    const built = buildDynamicTools(tools);
    this.#byCodexName = built.byCodexName;
    this.#dynamicToolSpecs = built.specs;
    this.handle = {
      id: req.sessionId,
      providerSessionId: undefined, // undefined until thread/start yields the threadId
      role: req.role,
      request: req,
    };
  }

  get status(): SessionStatus {
    return this.#status;
  }

  // ---- startup ----

  async start(): Promise<void> {
    // 1. initialize handshake (the runtime has already initialized for the capsule's first session; here
    //    we use the runtime-cached init response for isolation verification. The runtime initializes when
    //    the capsule is created and passes the response in.
    if (this.#initResponse === undefined) {
      // The runtime initializes and calls setInitResponse in ensureCapsule; if unset, the runtime has not completed the handshake.
      throw new RuntimeErrorImpl({ kind: "transient", subKind: "provider_init_transient", providerId: PROVIDER, sessionId: this.handle.id, message: "capsule initialize response not available" });
    }
    // isolation fail-fast (codexHome comparison).
    verifyIsolation(this.#initResponse, this.#req.isolation);

    // 2. thread/start (with model / cwd / isolation params / dynamicTools declaration).
    const developerInstructions = await readFile(this.#req.systemPromptPath, "utf8");
    const params: ThreadStartParams = {
      model: this.#req.model.modelId,
      cwd: this.#req.cwd,
      approvalPolicy: AUTOMATION_APPROVAL_POLICY,
      sandbox: "workspace-write",
      config: isolationConfig(),
      developerInstructions,
      dynamicTools: this.#cfg.codexToolBridgeMode === "dynamicTools" ? this.#dynamicToolSpecs : null,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    };
    let res: ThreadStartResponse;
    try {
      res = await this.#capsule.client.request<ThreadStartResponse>(CLIENT_METHODS.threadStart, params as unknown as JsonValue);
    } catch (err) {
      throw classifyRpcError(err, "init", { sessionId: this.handle.id });
    }
    const threadId = res.thread.id;
    this.#threadId = threadId;
    this.handle = { ...this.handle, providerSessionId: threadId };
    this.#capsule.registerThread(threadId, this);

    // 3. Once the threadId is obtained, synthetically emit SessionStarted (before any turn/inject).
    await this.#emit({
      kind: "session_started",
      ...this.#common(),
      role: this.#req.role,
      providerSessionId: threadId,
      model: this.#req.model,
      thinking: this.#req.thinking,
      cwd: this.#req.cwd,
    });
    if (this.#status.state === "initializing") this.#status = { state: "idle" };
  }

  /** The runtime injects the init response after the capsule initialize completes (for isolation verification + self-check). */
  setInitResponse(init: InitializeResponse): void {
    this.#initResponse = init;
  }

  /** The runtime injects the marker after placeSentinel (for the self-check). */
  setSentinelMarker(marker: string): void {
    this.#sentinelMarker = marker;
  }

  #selectTools(): ReadonlyArray<HostTool> {
    const tools: HostTool[] = [];
    for (const name of this.#req.toolNames) {
      const tool = this.#registry.get(name);
      if (tool === undefined) {
        throw new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: PROVIDER, sessionId: this.#req.sessionId, message: `tool not registered: ${name}` });
      }
      if (!tool.scope.includes(this.#req.role)) {
        throw new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: PROVIDER, sessionId: this.#req.sessionId, message: `tool ${name} not in scope for role ${this.#req.role}` });
      }
      tools.push(tool);
    }
    return tools;
  }

  // ---- notification routing entry (routed in by CapsuleConnection by threadId) ----

  /** Notification serialization chain (single consumer): ensures turn/started -> item/started ->
   * item/completed -> turn/completed are processed strictly in arrival order, without interleaving at
   * the await yield points of each async handler (otherwise tool_invoked / inject_delivered would be out of order). */
  #notifyChain: Promise<void> = Promise.resolve();

  /** One JSON-RPC notification for this thread. Normalize -> emit (serialized via #notifyChain). */
  handleNotification(method: string, params: JsonValue): void {
    this.#notifyChain = this.#notifyChain.then(() => this.#handleNotificationAsync(method, params)).catch(() => {
      /* errors are already swallowed in the emit chain; this catch guards against unhandled rejection */
    });
  }

  async #handleNotificationAsync(method: string, params: JsonValue): Promise<void> {
    if (this.#status.state === "closed") return;
    const ctx = this.#normalizeCtx();
    switch (method) {
      case NOTIFICATION_METHODS.turnStarted: {
        const n = params as TurnStartedNotification;
        this.#currentTurnId = n.turn.id;
        this.#turnCounter += 1;
        this.#turnAbort = new AbortController();
        this.#contentIndexCounter = 0;
        this.#inflightToolIds.clear();
        if (this.#status.state !== "closing") {
          this.#status = { state: "streaming", turnId: n.turn.id, turnStartedAt: Date.now(), toolInflightIds: [] };
        }
        const cause: TurnCause = this.#pendingTurnCause ?? { kind: "unknown" };
        this.#pendingTurnCause = undefined;
        for (const ev of normalizeTurnStarted(n, ctx, cause)) await this.#emit(ev);
        // Settle the pending inject (the turn has actually started -> inject_delivered + resolve the ack).
        if (this.#pendingInject !== undefined) {
          const p = this.#pendingInject;
          this.#pendingInject = undefined;
          await this.#emit({ kind: "inject_delivered", ...this.#common(), injectRequestId: p.requestId, deliveryPath: p.deliveryPath, turnId: n.turn.id });
          p.resolve(n.turn.id);
        }
        return;
      }
      case NOTIFICATION_METHODS.turnCompleted: {
        const n = params as TurnCompletedNotification;
        for (const ev of normalizeTurnCompleted(n, ctx)) {
          if (ev.kind === "runtime_error") this.#errorCount += 1;
          await this.#emit(ev);
        }
        this.#onTurnEnded();
        return;
      }
      case NOTIFICATION_METHODS.itemStarted: {
        const n = params as ItemStartedNotification;
        for (const ev of normalizeItemStarted(n, ctx)) {
          if (ev.kind === "tool_invoked") {
            if (ev.isHostTool) this.#toolCallCount += 1;
            this.#inflightToolIds.add(ev.toolUseId);
            this.#syncInflightToStatus();
          }
          await this.#emit(ev);
        }
        return;
      }
      case NOTIFICATION_METHODS.itemCompleted: {
        const n = params as ItemCompletedNotification;
        for (const ev of normalizeItemCompleted(n, ctx)) {
          if (ev.kind === "tool_result_recorded") {
            this.#inflightToolIds.delete(ev.toolUseId);
            this.#syncInflightToStatus();
          }
          if (ev.kind === "runtime_error") this.#errorCount += 1;
          await this.#emit(ev);
        }
        return;
      }
      case NOTIFICATION_METHODS.agentMessageDelta: {
        for (const ev of normalizeAgentMessageDelta(params as never, ctx)) await this.#emit(ev);
        return;
      }
      case NOTIFICATION_METHODS.reasoningTextDelta:
      case NOTIFICATION_METHODS.reasoningSummaryTextDelta: {
        for (const ev of normalizeReasoningDelta(params as never, ctx)) await this.#emit(ev);
        return;
      }
      case NOTIFICATION_METHODS.tokenUsageUpdated: {
        const n = params as ThreadTokenUsageUpdatedNotification;
        for (const ev of normalizeTokenUsage(n, ctx)) {
          if (ev.kind === "usage_snapshot") this.#absorbUsage(ev);
          await this.#emit(ev);
        }
        return;
      }
      case NOTIFICATION_METHODS.threadCompacted: {
        for (const ev of normalizeThreadCompacted(params as never, ctx)) {
          if (ev.kind === "runtime_error") this.#errorCount += 1;
          await this.#emit(ev);
        }
        return;
      }
      case NOTIFICATION_METHODS.error: {
        for (const ev of normalizeError(params as never, ctx)) {
          if (ev.kind === "runtime_error") this.#errorCount += 1;
          await this.#emit(ev);
        }
        return;
      }
      default:
        // Unrecognized (including turn/diff/updated / fileChange delta, etc) -> record as provider_raw (not lost).
        await this.#emit({ kind: "provider_raw", ...this.#common(), providerEventType: method, raw: params });
        return;
    }
  }

  #absorbUsage(ev: UsageSnapshotEvent): void {
    if (ev.contextUsage !== undefined) this.#latestContextUsage = ev.contextUsage;
    // Accumulate tokens (approximated by the latest snapshot's total; session stats use the most recent total).
    this.#tokensInput = ev.tokens.input;
    this.#tokensOutput = ev.tokens.output;
  }

  #onTurnEnded(): void {
    this.#currentTurnId = undefined;
    this.#turnAbort = undefined;
    this.#toolNamesById.clear();
    this.#inflightToolIds.clear();
    // On the compact path, turn/completed does not necessarily return to idle (compact is a host-triggered non-turn operation; here we only return to idle when there is no compactInflight).
    if (this.#status.state !== "closing" && this.#status.state !== "closed") {
      this.#status = { state: "idle", lastTurnEndedAt: Date.now() };
    }
    this.#resolveAllPendingTurns();
    // A successful turn completed (turn/completed) -> tell the runtime to reset this capsule's consecutive crash count.
    this.#capsule.onTurnSuccess();
    // Manual compact path: compact_ended is emitted by item/completed(contextCompaction) or thread/compacted, which resolves the resolver.
  }

  #normalizeCtx(): NormalizeContext {
    return {
      sessionId: this.handle.id,
      turnId: this.#currentTurnId,
      now: () => Date.now(),
      recordToolName: (id, name) => this.#toolNamesById.set(id, name),
      resolveToolName: (id) => this.#toolNamesById.get(id) ?? "",
      nextContentIndex: () => this.#contentIndexCounter++,
    };
  }

  // ---- the three inject states ----

  #injecting = false;

  async inject(input: InjectInput): Promise<InjectAck> {
    const wasInjecting = this.#injecting;
    this.#injecting = true;
    try {
      return await this.#injectImpl(input, wasInjecting);
    } finally {
      if (!wasInjecting) this.#injecting = false;
    }
  }

  async #injectImpl(input: InjectInput, concurrentInjectInflight: boolean): Promise<InjectAck> {
    this.#validateInjectInput(input);
    const requestId = this.#nextInjectId();

    if (this.#closing || this.#status.state === "closing" || this.#status.state === "closed") {
      await this.#emitInjectRequested(requestId, input);
      await this.#emit({ kind: "inject_rejected", ...this.#common(), injectRequestId: requestId, reason: "closed_session" });
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: PROVIDER, sessionId: this.handle.id });
    }
    if (this.#stuck) {
      await this.#emitInjectRequested(requestId, input);
      await this.#emit({ kind: "inject_rejected", ...this.#common(), injectRequestId: requestId, reason: "busy", description: "session stuck after abort timeout; closeSession required" });
      throw new RuntimeErrorImpl({ kind: "timeout", subKind: "abort_completion_timeout", providerId: PROVIDER, sessionId: this.handle.id, message: "session stuck after abort timeout" });
    }

    await this.#emitInjectRequested(requestId, input);

    if (concurrentInjectInflight) {
      await this.#emit({ kind: "inject_rejected", ...this.#common(), injectRequestId: requestId, reason: "busy", description: "concurrent inject in-flight" });
      return { mode: "rejected_busy", reason: "session busy (concurrent inject in-flight)" };
    }

    const streaming = this.#status.state === "streaming";
    const policy = input.policy.kind;

    if (streaming) {
      if (policy === "require_idle") {
        await this.#emit({ kind: "inject_rejected", ...this.#common(), injectRequestId: requestId, reason: "busy" });
        return { mode: "rejected_busy", reason: "session busy (streaming)" };
      }
      if (policy === "follow_up_if_streaming") {
        // followUpIfStreaming=false: throw not_supported, do not degrade.
        await this.#emit({ kind: "inject_rejected", ...this.#common(), injectRequestId: requestId, reason: "not_supported_policy", description: "inject.followUpIfStreaming" });
        throw new NotSupportedError("inject.followUpIfStreaming", PROVIDER, "codex does not support follow_up_if_streaming");
      }
      if (policy === "steer_if_streaming") {
        // turn/steer: append input to the active turn.
        return this.#steer(requestId, input);
      }
      // interrupt_then_inject: turn/interrupt -> wait for turn/completed -> turn/start.
      const ok = await this.#interruptAndWait();
      if (!ok) {
        await this.#emit({ kind: "inject_rejected", ...this.#common(), injectRequestId: requestId, reason: "busy", description: "interrupt did not complete; session stuck" });
        throw new RuntimeErrorImpl({ kind: "timeout", subKind: "abort_completion_timeout", providerId: PROVIDER, sessionId: this.handle.id, message: "interrupt_then_inject: interrupt did not complete in time" });
      }
      return this.#startTurn(requestId, input, "deliver_after_interrupt", "after_interrupt");
    }

    // idle: start a new turn (turn/start).
    return this.#startTurn(requestId, input, "deliver_immediate", "immediate");
  }

  /** Start a new turn via turn/start. turn_started / inject_delivered are settled by notification routing (single consumer). */
  async #startTurn(
    requestId: string,
    input: InjectInput,
    acceptedAs: "deliver_immediate" | "deliver_after_interrupt",
    deliveryPath: "immediate" | "after_interrupt",
  ): Promise<InjectAck> {
    await this.#emit({ kind: "inject_accepted", ...this.#common(), injectRequestId: requestId, acceptedAs });
    let userInput: UserInput[];
    try {
      userInput = await this.#buildUserInput(input.content);
    } catch (err) {
      const re = err instanceof RuntimeErrorImpl ? err : new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: PROVIDER, sessionId: this.handle.id, message: `inject content build failed: ${(err as Error).message}` });
      await this.#emit({ kind: "inject_rejected", ...this.#common(), injectRequestId: requestId, reason: "invalid_marker", description: re.message });
      throw re;
    }
    if (this.#threadId === undefined) {
      await this.#emit({ kind: "inject_rejected", ...this.#common(), injectRequestId: requestId, reason: "closed_session", description: "thread not started" });
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: PROVIDER, sessionId: this.handle.id });
    }

    // Set the pending turn cause (consumed by turn/started) + the pending inject (turn/started settles inject_delivered).
    this.#pendingTurnCause = { kind: "user_input", markerKind: input.marker.kind };
    const ackPromise = new Promise<string>((resolve, reject) => {
      this.#pendingInject = { requestId, deliveryPath, resolve, reject };
    });
    // Guard against the "unhandled rejection" window: if close/resume rejects ackPromise while the
    // turn/start request is still awaited and the await below has not yet attached, attach a no-op catch
    // placeholder first (the real rejection is still caught and handled by the await ackPromise below).
    ackPromise.catch(() => {});

    const params: TurnStartParams = {
      threadId: this.#threadId,
      input: userInput,
      sandboxPolicy: sandboxPolicyOf(this.#req.isolation),
      ...this.#thinkingTurnOverrides(),
    };
    try {
      await this.#capsule.client.request<TurnStartResponse>(CLIENT_METHODS.turnStart, params as unknown as JsonValue);
    } catch (err) {
      this.#pendingInject = undefined;
      this.#pendingTurnCause = undefined;
      const re = classifyRpcError(err, "turn", { sessionId: this.handle.id });
      this.#emitRuntimeErrorEvent(re, re.kind === "transient", true);
      await this.#emit({ kind: "inject_rejected", ...this.#common(), injectRequestId: requestId, reason: "busy", description: re.message });
      throw re;
    }
    // The turn/start RPC was accepted by the server, but if close/crash/resume happens before the
    // turn/started notification arrives -> ackPromise rejects. Never return an empty turnId as delivered
    // (the host would wrongly markRead); throw closed_session so the host's startTurn catches it as rejected/closed.
    let turnId: string;
    try {
      turnId = await ackPromise;
    } catch (err) {
      throw err instanceof RuntimeErrorImpl
        ? err
        : new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: PROVIDER, sessionId: this.handle.id, message: `inject cancelled before delivery: ${(err as Error).message}` });
    }
    return acceptedAs === "deliver_after_interrupt" ? { mode: "delivered_after_interrupt", turnId } : { mode: "delivered_immediate", turnId };
  }

  /** turn/steer: append input to the active turn. */
  async #steer(requestId: string, input: InjectInput): Promise<InjectAck> {
    await this.#emit({ kind: "inject_accepted", ...this.#common(), injectRequestId: requestId, acceptedAs: "queue_steering" });
    const turnId = this.#currentTurnId;
    if (turnId === undefined || this.#threadId === undefined) {
      await this.#emit({ kind: "inject_rejected", ...this.#common(), injectRequestId: requestId, reason: "busy", description: "no active turn to steer" });
      return { mode: "rejected_busy", reason: "no active turn to steer" };
    }
    let userInput: UserInput[];
    try {
      userInput = await this.#buildUserInput(input.content);
    } catch (err) {
      const re = err instanceof RuntimeErrorImpl ? err : new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: PROVIDER, sessionId: this.handle.id, message: `inject content build failed: ${(err as Error).message}` });
      await this.#emit({ kind: "inject_rejected", ...this.#common(), injectRequestId: requestId, reason: "invalid_marker", description: re.message });
      throw re;
    }
    try {
      await this.#capsule.client.request(CLIENT_METHODS.turnSteer, { threadId: this.#threadId, input: userInput, expectedTurnId: turnId } as unknown as JsonValue);
    } catch (err) {
      const re = classifyRpcError(err, "turn", { sessionId: this.handle.id, turnId });
      this.#emitRuntimeErrorEvent(re, re.kind === "transient", true);
      await this.#emit({ kind: "inject_rejected", ...this.#common(), injectRequestId: requestId, reason: "busy", description: re.message });
      throw re;
    }
    // steer was successfully queued into the current turn (terminal state from_queue_steering).
    await this.#emit({ kind: "inject_delivered", ...this.#common(), injectRequestId: requestId, deliveryPath: "from_queue_steering", turnId });
    return { mode: "queued_steering", pendingPosition: 0 };
  }

  #thinkingTurnOverrides(): Partial<TurnStartParams> {
    const thinking = this.#req.thinking;
    if (thinking === undefined || thinking.level === "off") return {};
    this.#assertThinkingLevelSupported(thinking.level);
    const effort = this.#cfg.effortMap[thinking.level];
    return {
      ...(effort !== undefined ? { effort } : {}),
      summary: thinking.summary === "summarized" ? "concise" : "none",
    };
  }

  #assertThinkingLevelSupported(level: string): void {
    if (!(CODEX_THINKING_LEVELS as ReadonlyArray<string>).includes(level)) {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "not_supported", providerId: PROVIDER, sessionId: this.handle.id, message: `thinking level ${level} not supported`, diagnostics: { capabilityPath: "thinking.supportedLevels", level } });
    }
  }

  #validateInjectInput(input: InjectInput): void {
    if (input.marker === undefined || typeof input.marker.kind !== "string") {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: PROVIDER, sessionId: this.handle.id, message: "inject marker missing", diagnostics: { reason: "invalid_marker" } });
    }
    if (input.content.length === 0) {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: PROVIDER, sessionId: this.handle.id, message: "inject content empty" });
    }
  }

  async #buildUserInput(content: ReadonlyArray<InjectContentBlock>): Promise<UserInput[]> {
    const out: UserInput[] = [];
    for (const block of content) {
      if (block.type === "text") {
        const text = "text" in block ? block.text : await readFile(block.textPath, "utf8");
        out.push({ type: "text", text, text_elements: [] });
      } else if (block.type === "reference") {
        out.push({ type: "text", text: `[reference: ${block.uri}${block.description !== undefined ? ` — ${block.description}` : ""}]`, text_elements: [] });
      } else {
        // image: a path goes via localImage; inline data goes via a data: URL.
        if ("path" in block) out.push({ type: "localImage", path: block.path });
        else out.push({ type: "image", url: `data:${block.mediaType};base64,${block.data}` });
      }
    }
    return out;
  }

  async #emitInjectRequested(requestId: string, input: InjectInput): Promise<void> {
    await this.#emit({ kind: "host_inject_requested", ...this.#common(), injectRequestId: requestId, marker: input.marker, content: input.content, policy: input.policy, requestedAt: Date.now() });
  }

  // ---- abortTurn ----

  async abortTurn(_reason?: string): Promise<void> {
    if (this.#closing || this.#status.state === "closing" || this.#status.state === "closed") {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: PROVIDER, sessionId: this.handle.id });
    }
    if (this.#stuck) {
      throw new RuntimeErrorImpl({ kind: "timeout", subKind: "abort_completion_timeout", providerId: PROVIDER, sessionId: this.handle.id, message: "session stuck after abort timeout; closeSession required" });
    }
    if (this.#status.state === "initializing") return;
    if (this.#status.state !== "streaming") return;
    const ok = await this.#interruptAndWait();
    if (!ok) {
      throw new RuntimeErrorImpl({ kind: "timeout", subKind: "abort_completion_timeout", providerId: PROVIDER, sessionId: this.handle.id, message: "interrupt did not complete in time; session stuck (closeSession required)" });
    }
  }

  /** turn/interrupt the current turn + cooperatively cancel inflight host tool handlers, then wait for turn/completed. */
  async #interruptAndWait(): Promise<boolean> {
    const turnId = this.#currentTurnId;
    this.#turnAbort?.abort();
    if (this.#threadId !== undefined && turnId !== undefined) {
      try {
        await this.#capsule.client.request(CLIENT_METHODS.turnInterrupt, { threadId: this.#threadId, turnId } as unknown as JsonValue);
      } catch (err) {
        // The turn/interrupt call failed -> transient/abort_failed_retryable.
        this.#emitRuntimeErrorEvent(new RuntimeErrorImpl({ kind: "transient", subKind: "abort_failed_retryable", providerId: PROVIDER, sessionId: this.handle.id, turnId, message: `turn/interrupt failed: ${(err as Error).message}` }), true, true);
      }
    }
    const ended = await this.#waitTurnEnd(this.#cfg.abortCompletionTimeoutMs);
    if (!ended) {
      this.#stuck = true;
      this.#emitRuntimeErrorEvent(new RuntimeErrorImpl({ kind: "timeout", subKind: "abort_completion_timeout", providerId: PROVIDER, sessionId: this.handle.id, ...(turnId !== undefined ? { turnId } : {}), message: "interrupt did not complete in time; session stuck (closeSession required)" }), false, true);
      return false;
    }
    return true;
  }

  #waitTurnEnd(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (this.#currentTurnId === undefined) {
        resolve(true);
        return;
      }
      let settled = false;
      const onEnd = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#pendingTurns.delete(onEnd);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#pendingTurns.delete(onEnd);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      this.#pendingTurns.add(onEnd);
    });
  }

  #resolveAllPendingTurns(): void {
    const waiters = [...this.#pendingTurns];
    this.#pendingTurns.clear();
    for (const w of waiters) w();
  }

  // ---- closeSession ----

  async close(options?: { forceAbort?: boolean; idleTimeoutMs?: number; reason?: SessionEndReason }): Promise<SessionCloseResult> {
    if (this.#closeResult !== undefined) return this.#closeResult;
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = this.#doClose(options);
    return this.#closePromise;
  }

  async #doClose(options?: { forceAbort?: boolean; idleTimeoutMs?: number; reason?: SessionEndReason }): Promise<SessionCloseResult> {
    const reason: SessionEndReason = options?.reason ?? "host_close";
    let hadForcedKill = this.#stuck;

    if (!hadForcedKill && this.#status.state === "streaming") {
      if (options?.forceAbort === true) {
        try {
          const ok = await this.#interruptAndWait();
          if (!ok) hadForcedKill = true;
        } catch {
          hadForcedKill = true;
        }
      } else {
        const idleMs = options?.idleTimeoutMs ?? this.#cfg.closeIdleTimeoutMs;
        const idle = await this.#waitTurnEnd(idleMs);
        if (!idle) hadForcedKill = true;
      }
    }

    this.#status = { state: "closing", reason };

    // graceful: thread/unsubscribe (stop consuming this thread's notifications). On failure -> escalate to forced kill.
    if (!hadForcedKill && this.#threadId !== undefined) {
      try {
        await this.#capsule.client.request(CLIENT_METHODS.threadUnsubscribe, { threadId: this.#threadId } as unknown as JsonValue);
      } catch {
        hadForcedKill = true;
      }
    }
    if (this.#threadId !== undefined) this.#capsule.unregisterThread(this.#threadId);
    if (hadForcedKill && !this.#sessionAbort.signal.aborted) this.#sessionAbort.abort();

    if (hadForcedKill) {
      // Force-kill path: escalate to the capsule owner -- force-kill the app-server subprocess + cascade-finalize
      // all sibling sessions in the same capsule (fatal_runtime_error). This session then finalizes itself as host_close_forced.
      const err = new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: PROVIDER, sessionId: this.handle.id, message: "sibling session force-closed; app-server killed (cascade)" });
      this.#capsule.forceKillCapsule(this, err);
    }

    const result = await this.#finalizeEnded(hadForcedKill ? "host_close_forced" : reason, hadForcedKill);
    // graceful cleanup: tell the runtime to check whether this was the last thread (if so, and the capsule is no longer needed -> shut down the subprocess).
    // A forced kill has already shut down the capsule via forceKillCapsule, so onThreadClosed is not needed.
    if (!hadForcedKill) this.#capsule.onThreadClosed();
    return result;
  }

  /** Passively dies along with a sibling session kill / subprocess crash (cascade): emit synthetic pairings + session_ended(fatal). */
  async cascadeClose(reason: SessionEndReason, err: RuntimeError): Promise<SessionCloseResult> {
    if (this.#closeResult !== undefined) return this.#closeResult;
    if (this.#finalized) {
      await this.#emitChain.catch(() => {});
      return this.#closeResult ?? { sessionId: this.handle.id, endedAt: Date.now(), reason, stats: this.#stats(), hadForcedKill: true };
    }
    this.#closing = true;
    this.#emitRuntimeErrorEvent(err, err.kind === "transient", false);
    this.#status = { state: "closing", reason };
    if (!this.#sessionAbort.signal.aborted) this.#sessionAbort.abort();
    if (this.#threadId !== undefined) this.#capsule.unregisterThread(this.#threadId);
    return this.#finalizeEnded(reason, true);
  }

  async #finalizeEnded(reason: SessionEndReason, hadForcedKill: boolean): Promise<SessionCloseResult> {
    if (this.#closeResult !== undefined) return this.#closeResult;
    if (this.#finalized) {
      await this.#emitChain.catch(() => {});
      return this.#closeResult ?? { sessionId: this.handle.id, endedAt: Date.now(), reason, stats: this.#stats(), hadForcedKill };
    }
    this.#finalized = true;
    // kill path: emit synthetic pairings for any still-inflight turn / tools.
    if (this.#currentTurnId !== undefined) {
      const turnId = this.#currentTurnId;
      for (const toolUseId of this.#inflightToolIds) {
        await this.#emit({
          kind: "tool_result_recorded",
          ...this.#common(),
          turnId,
          toolUseId,
          toolName: this.#toolNamesById.get(toolUseId) ?? "unknown",
          result: { content: [{ type: "text", text: "<cancelled by session kill>" }], isError: true, providerExtras: { _killCancelled: true } },
          recordedAt: Date.now(),
        });
      }
      this.#inflightToolIds.clear();
      this.#currentTurnId = undefined;
      this.#turnAbort = undefined;
      this.#toolNamesById.clear();
      // The turn was involuntarily aborted -> aborted.
      await this.#emit({ kind: "turn_ended", ...this.#common(), turnId, stopReason: "aborted", usage: undefined, endedAt: Date.now() });
      this.#resolveAllPendingTurns();
    }
    // An unsettled pending inject (queued / awaiting turn/started) -> record a cancel + reject (never resolve an empty turnId as delivered).
    if (this.#pendingInject !== undefined) {
      const p = this.#pendingInject;
      this.#pendingInject = undefined;
      await this.#emit({ kind: "inject_cancelled", ...this.#common(), injectRequestId: p.requestId, reason: hadForcedKill ? "session_killed" : "session_closed", recoveryHint: "host_should_reissue" });
      p.reject(new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: PROVIDER, sessionId: this.handle.id, message: "inject cancelled by session close" }));
    }
    const stats = this.#stats();
    await this.#emit({ kind: "session_ended", ...this.#common(), reason, stats });
    this.#status = { state: "closed", reason };
    const result: SessionCloseResult = { sessionId: this.handle.id, endedAt: Date.now(), reason, stats, hadForcedKill };
    this.#closeResult = result;
    this.#listeners.clear();
    return result;
  }

  // ---- compact ----

  async compact(hint?: CompactHint): Promise<CompactOutcome> {
    // acceptsCustomInstructions=false (thread/compact/start has no instructions field) -> fail-fast at the
    // entry if the caller passes customInstructions, rather than silently dropping it.
    if (hint?.customInstructions !== undefined) {
      throw new NotSupportedError("compact.acceptsCustomInstructions", PROVIDER, "codex thread/compact/start does not accept customInstructions (no instructions field in the protocol)");
    }
    if (this.#closing || this.#status.state === "closing" || this.#status.state === "closed") {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: PROVIDER, sessionId: this.handle.id });
    }
    if (this.#compactInflight) {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: PROVIDER, sessionId: this.handle.id, message: "compact already in progress" });
    }
    if (this.#threadId === undefined) {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: PROVIDER, sessionId: this.handle.id });
    }
    this.#compactInflight = true;
    await this.#emit({ kind: "compact_started", ...this.#common(), reason: "manual_host", tokensBefore: this.#latestContextUsage?.tokens });

    return new Promise<CompactOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: CompactOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#compactResolver = undefined;
        this.#compactInflight = false;
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        // Timeout -> the compaction never happened (compact_not_performed): emit a paired
        // compact_ended(success:false) + a transient io error (not compact_summary_missing -- that only
        // represents "compaction happened but the summary is unobservable").
        void this.#emit({ kind: "compact_ended", ...this.#common(), success: false, summary: undefined, firstKeptEntryId: undefined, tokensAfter: undefined, errorMessage: "compact timed out", willRetryTurn: false });
        this.#emitRuntimeErrorEvent(new RuntimeErrorImpl({ kind: "transient", subKind: "io_transient", providerId: PROVIDER, sessionId: this.handle.id, message: "manual compact timed out before completion" }), true, true);
        finish({ success: false, failureKind: "compact_not_performed", summary: undefined, errorMessage: "compact timed out" });
      }, this.#cfg.compactTimeoutMs);
      timer.unref?.();
      this.#compactResolver = finish;
      // The compact request only passes { threadId } (thread/compact/start has no instructions field; acceptsCustomInstructions=false).
      void this.#capsule.client.request(CLIENT_METHODS.threadCompactStart, { threadId: this.#threadId } as unknown as JsonValue).catch((err) => {
        // RPC reject -> the compaction never happened (compact_not_performed). Emit a paired compact_ended(success:false)
        // (consistent with the timeout path -> every compact_started has a paired compact_ended, leaving no unclosed compact in stream/audit) + record a runtime_error.
        const re = classifyRpcError(err, "turn", { sessionId: this.handle.id });
        void this.#emit({ kind: "compact_ended", ...this.#common(), success: false, summary: undefined, firstKeptEntryId: undefined, tokensAfter: undefined, errorMessage: re.message, willRetryTurn: false });
        this.#emitRuntimeErrorEvent(re, re.kind === "transient", true);
        finish({ success: false, failureKind: "compact_not_performed", summary: undefined, errorMessage: re.message });
      });
    });
  }

  // ---- contextUsage (supportsManualQuery) ----

  async contextUsage(): Promise<ContextUsage> {
    if (this.#status.state === "closed") {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: PROVIDER, sessionId: this.handle.id });
    }
    return this.#latestContextUsage ?? { tokens: undefined, contextWindow: undefined, percent: undefined };
  }

  // ---- resumeSession ----

  async resume(target: SessionResumeTarget): Promise<void> {
    if (target.kind !== "from_provider_id") {
      throw new NotSupportedError(`sessionResume.${target.kind === "from_file" ? "fromFile" : "forkAtEntry"}`, PROVIDER, `codex resume target ${target.kind} not supported`);
    }
    const previous = this.#threadId;
    let res: ThreadResumeResponse;
    try {
      res = await this.#capsule.client.request<ThreadResumeResponse>(CLIENT_METHODS.threadResume, { threadId: target.providerSessionId, cwd: this.#req.cwd } as unknown as JsonValue);
    } catch (err) {
      throw classifyRpcError(err, "init", { sessionId: this.handle.id });
    }
    // An undelivered queued inject on the replaced thread -> InjectDropped + reject (do not return an empty turnId as delivered).
    if (this.#pendingInject !== undefined) {
      const p = this.#pendingInject;
      this.#pendingInject = undefined;
      await this.#emit({ kind: "inject_dropped", ...this.#common(), injectRequestId: p.requestId, reason: "provider_drop_on_resume", recoveryHint: "host_should_reissue" });
      p.reject(new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: PROVIDER, sessionId: this.handle.id, message: "inject dropped on resume" }));
    }
    const newThreadId = res.thread.id;
    if (previous !== undefined && previous !== newThreadId) this.#capsule.unregisterThread(previous);
    this.#threadId = newThreadId;
    this.handle = { ...this.handle, providerSessionId: newThreadId };
    this.#capsule.registerThread(newThreadId, this);
    await this.#emit({ kind: "session_resumed", ...this.#common(), previousProviderSessionId: previous, providerSessionId: newThreadId, resumeTarget: target });
  }

  // ---- isolation self-check ----

  isolationSelfCheck(): IsolationSelfCheckResult {
    return isolationSelfCheck(this.#initResponse, this.#req.isolation, this.#sentinelMarker);
  }

  // ---- subscribe ----

  subscribe(listener: (e: SessionEvent) => void): Unsubscribe {
    this.#listeners.add(listener);
    const started = this.#replay.find((e) => e.kind === "session_started");
    if (started) this.#safeCall(listener, started);
    this.#safeCall(listener, { kind: "synthetic_state_snapshot", ...this.#common(), status: this.#status, snapshotAt: Date.now(), _persistedToStream: false });
    for (const e of this.#replay) {
      if (e.kind !== "session_started") this.#safeCall(listener, e);
    }
    return () => this.#listeners.delete(listener);
  }

  // ---- internal emit / persistence / fanout ----

  #common(): { receivedAt: number; sessionId: string; providerId: ProviderId } {
    return { receivedAt: Date.now(), sessionId: this.handle.id, providerId: PROVIDER };
  }

  #syncInflightToStatus(): void {
    if (this.#status.state === "streaming") {
      this.#status = { ...this.#status, toolInflightIds: [...this.#inflightToolIds] };
    }
  }

  #nextInjectId(): string {
    this.#injectCounter += 1;
    return `${this.handle.id}-i${this.#injectCounter}`;
  }

  #stats(): SessionFinalStats {
    return {
      turnCount: this.#turnCounter,
      toolCallCount: this.#toolCallCount,
      errorCount: this.#errorCount,
      tokens: { input: this.#tokensInput, output: this.#tokensOutput, total: this.#tokensInput + this.#tokensOutput },
    };
  }

  #emitRuntimeErrorEvent(error: RuntimeError, recoverable: boolean, continuingSession: boolean): void {
    this.#errorCount += 1;
    void this.#emit({ kind: "runtime_error", ...this.#common(), error, recoverable, continuingSession });
  }

  // tool bridge hooks (used by dispatchToolCall).
  toolBridgeHooks(): ToolBridgeHooks {
    return {
      handle: this.handle,
      role: this.#req.role,
      currentTurnId: () => this.#currentTurnId,
      effectiveSignal: () => this.#turnAbort?.signal ?? this.#sessionAbort.signal,
      onToolRuntimeError: (err) => this.#emitRuntimeErrorEvent(err, err.kind === "transient", true),
      logger: { debug: () => {} },
      handlerTimeoutMs: this.#cfg.handlerTimeoutMs,
      abortGraceMs: this.#cfg.abortGraceMs,
    };
  }

  /** A routed-in item/tool/call server-request -> invoke the host handler. */
  async dispatchTool(params: import("./protocol.js").DynamicToolCallParams): Promise<import("./protocol.js").DynamicToolCallResponse> {
    return dispatchToolCall(params, this.#byCodexName, this.toolBridgeHooks());
  }

  #emitChain: Promise<void> = Promise.resolve();

  #emit(event: SessionEvent): Promise<void> {
    const next = this.#emitChain.then(() => this.#doEmit(event));
    this.#emitChain = next.catch(() => {});
    return next;
  }

  async #doEmit(event: SessionEvent): Promise<void> {
    this.#replay.push(event);
    if (this.#replay.length > REPLAY_BUFFER_MAX + 8) this.#replay.splice(0, this.#replay.length - (REPLAY_BUFFER_MAX + 8));

    const persist = !("_persistedToStream" in event) && !(this.#sessionEndedPersisted && event.kind !== "session_ended");

    if (persist) {
      if (epochFenceOk(this.#createdEpoch, this.#cfg.currentHostEpoch())) {
        this.#seq += 1;
        try {
          await jsonlIO.appendLine(this.#req.streamPath, { ...event, _writer: { seq: this.#seq, adapterVersion: this.#cfg.adapterVersion } });
          this.#streamWriteFails = 0;
          if (event.kind === "session_ended") this.#sessionEndedPersisted = true;
        } catch {
          this.#streamWriteFails += 1;
          if (this.#streamWriteFails >= STREAM_WRITE_FAIL_LIMIT) {
            this.#emitRuntimeErrorEventNoWrite(new RuntimeErrorImpl({ kind: "permanent", subKind: "stream_persistent_write_failed", providerId: PROVIDER, sessionId: this.handle.id, message: "stream JSONL write failed 3x" }));
            void this.close({ reason: "fatal_runtime_error", forceAbort: true });
          }
        }
      }
    }

    for (const listener of this.#listeners) this.#safeCall(listener, event);

    // compact_ended resolves the compact() promise (manual path). This path is only hit when the provider's
    // compaction has happened (contextCompaction item / thread/compacted) -- success:false then means
    // "compaction happened but the summary is unobservable" (summary_unobservable); the success:false from
    // a timeout / RPC reject is settled directly in their own finish() (compact_not_performed), not here.
    if (event.kind === "compact_ended" && this.#compactResolver !== undefined) {
      const r = this.#compactResolver;
      this.#compactResolver = undefined;
      r({
        success: event.success,
        summary: event.summary,
        ...(event.success ? {} : { failureKind: "summary_unobservable" as const }),
        ...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
      });
    }
  }

  #emitRuntimeErrorEventNoWrite(error: RuntimeError): void {
    this.#errorCount += 1;
    const event: SessionEvent = { kind: "runtime_error", ...this.#common(), error, recoverable: false, continuingSession: false };
    for (const listener of this.#listeners) this.#safeCall(listener, event);
  }

  #safeCall(listener: (e: SessionEvent) => void, event: SessionEvent): void {
    try {
      listener(event);
    } catch {
      /* a listener throwing does not propagate */
    }
  }
}
