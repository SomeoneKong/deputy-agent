/**
 * ClaudeSession -- the internal state machine and single subscriber for one Claude session.
 *
 * Holds a pushable queue (streaming input mode) + a Query handle; a background
 * subscriber consumes the SDKMessage stream with `for await`, normalizes it,
 * writes to the stream JSONL (with epoch fencing + escalation after 3
 * consecutive failures), and fans out to listeners. Lifecycle / the three inject
 * states / abort / close / compact / contextUsage all live here.
 */
import { readFile } from "node:fs/promises";

import type { Options, Query, SDKMessage, SDKSystemMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { jsonlIO } from "../../../shared/jsonl.js";
import type {
  CompactHint,
  CompactOutcome,
  CompactReason,
  ContextUsage,
  HostTool,
  HostToolRegistry,
  InjectAck,
  InjectContentBlock,
  InjectInput,
  ProviderId,
  RuntimeError,
  SessionCloseResult,
  SessionEndReason,
  SessionEvent,
  SessionFinalStats,
  SessionHandle,
  SessionRequest,
  SessionStatus,
  TurnId,
  Unsubscribe,
} from "../../types/index.js";
import { RuntimeErrorImpl } from "../../types/index.js";
import { CLAUDE_THINKING_LEVELS, type ResolvedClaudeConfig } from "./config.js";
import { classifySdkError } from "./errors.js";
import { buildHooks, type CompactCallbacks } from "./hooks.js";
import { epochFenceOk, isolationOptions, isolationSelfCheck, verifyIsolation } from "./isolation.js";
import { normalizeMessage, type NormalizeContext } from "./eventNormalize.js";
import { createPushableQueue, type PushableQueue } from "./pushableQueue.js";
import { buildMcpServer, type ToolBridgeHooks } from "./toolBridge.js";

const PROVIDER: ProviderId = "claude";
const REPLAY_BUFFER_MAX = 64;
const STREAM_WRITE_FAIL_LIMIT = 3;


export class ClaudeSession {
  readonly handle: SessionHandle;
  readonly #req: SessionRequest;
  readonly #cfg: ResolvedClaudeConfig;
  readonly #registry: HostToolRegistry;

  #status: SessionStatus = { state: "initializing" };
  #query: Query | undefined;
  #queue: PushableQueue | undefined;
  #subscriberDone: Promise<void> | undefined;
  #sessionAbort = new AbortController();

  #seq = 0;
  #turnCounter = 0;
  #injectCounter = 0;
  #toolCallCount = 0;
  #errorCount = 0;
  #turnTokensInput = 0;
  #turnTokensOutput = 0;
  // Per-subagent (agentId) token count, taken as the max across all
  // subagent_stopped events for that agentId. The max defends against two SDK
  // anomalies: the same subagent emitting multiple task_notification events
  // (repeated terminal states -> max does not double-count, preventing
  // overcounting) + emitting missing/partial usage first then full usage (a later
  // larger value -> max takes the full one, preventing undercounting). The
  // session-terminal subagentTokens = sum of per-agentId maxes.
  readonly #subagentTokensByAgent = new Map<string, number>();
  #streamWriteFails = 0;

  #currentTurnId: TurnId | undefined;
  /** The current turn's AbortController (aborted by abortTurn to propagate to an inflight tool handler; distinct from the session-level #sessionAbort). */
  #turnAbort: AbortController | undefined;
  /**
   * The set of resolve callbacks for all waiters on the current turn. When the
   * turn ends (#onTurnEnded / #finalizeEnded synth), all are resolved at once and
   * the set is cleared. Each callback is that waiter's resolve(true) (and clears
   * its own timeout timer). Multiple waiters are supported; all resolve on turn
   * end / fatal finalize; a single waiter's timeout only removes itself.
   */
  readonly #pendingTurns = new Set<() => void>();
  #initMessage: SDKSystemMessage | undefined;
  #initResolved = false;
  #initError: RuntimeError | undefined;
  /**
   * init timeout guard. In streaming-input mode the SDK emits `system init` only
   * after the first input push, so startSession must not block waiting on init
   * before inject (that would deadlock: the host injects only after startSession
   * returns). This timer is armed at the first input push in #deliver (not at
   * startSession -- a watcher session may be driven by a wake-inject many ticks
   * later, and arming too early would falsely report session_init_timeout). If
   * init does not settle within sessionInitTimeoutMs -> session_init_timeout
   * (teardown + resolveInit false + finalizeEnded), surfaced to the host via
   * session_ended. Cleared as soon as init settles (success or failure).
   */
  #initTimer: ReturnType<typeof setTimeout> | undefined;
  #closeResult: SessionCloseResult | undefined;
  /** Set synchronously at the close entry (before any await) to block a re-entrant close (e.g. an auto-close triggered by a write failure) from emitting session_ended twice. */
  #closing = false;
  /** Synchronous placeholder to block #finalizeEnded re-entrancy from emitting the terminal session_ended twice. */
  #finalized = false;
  /** Once session_ended is persisted, later events are no longer persisted (session_ended is a hard boundary). */
  #sessionEndedPersisted = false;
  /** Abort timeout (interrupt did not complete within the bound) -> the session is stuck and refuses further inject/abort until close. */
  #stuck = false;
  /**
   * Synchronous occupancy flag for the inject lifecycle (a policy-agnostic
   * lifecycle mutex): inject() sets it true synchronously before the first await
   * and resets it in finally. In the real adapter, a host tool handler and the
   * tick main loop can inject the same session concurrently; if idle were judged
   * solely by `status==="streaming"` (a state set only after several awaits in
   * #deliver), two concurrent idle injects could both pass the idle check and
   * each open a turn. This flag is occupied synchronously before any await so the
   * second concurrent inject is back-pressured as streaming/busy
   * (require_idle -> rejected_busy) until the first releases it.
   */
  #injecting = false;
  #compactInflight = false;
  #lastCompactHookSeenAt: number | undefined;
  #pendingCompact: { reason: CompactReason; tokensBefore?: number; tokensAfter?: number } | undefined;
  /** Tokens from the most recent compact_boundary (may arrive before the PreCompact hook; used to backfill onCompactStarted/CompactEnded). */
  #lastBoundaryTokens: { before?: number; after?: number } | undefined;
  /**
   * An unsettled SDK auto-retry (retry_started has been emitted, awaiting the next
   * progress / error to settle retry_ended). The Claude SDK emits only api_retry
   * (start) with no explicit end signal, so end is synthesized at the "next
   * result (turn boundary)" or the "next retry_started (continued retry)".
   */
  #pendingRetry: { attempt: number } | undefined;
  /**
   * The set of inflight toolUseIds in the current turn (used to add synthetic
   * tool_result on the kill path). Kept privately rather than in #status -- close()
   * sets #status to closing before #finalizeEnded, so it cannot rely on streaming
   * status.toolInflightIds; the public status is synced from this set.
   */
  // toolUseId -> parentToolUseId (undefined when not a subagent). The kill path backfills subagent attribution when adding a synthetic tool_result_recorded.
  readonly #inflightToolIds = new Map<string, string | undefined>();

  readonly #listeners = new Set<(e: SessionEvent) => void>();
  readonly #replay: SessionEvent[] = [];
  /** toolUseId -> toolName, used to backfill toolName for user-role tool_result (recorded on assistant tool_use). */
  readonly #toolNamesById = new Map<string, string>();
  /** content block index -> toolUseId, used to associate streaming input_json_delta (recorded on content_block_start). */
  readonly #blockToolUseByIndex = new Map<number, string>();
  /** Host epoch snapshot at session creation (host-death fencing). */
  readonly #createdEpoch: string | undefined;

  constructor(req: SessionRequest, cfg: ResolvedClaudeConfig, registry: HostToolRegistry) {
    this.#req = req;
    this.#cfg = cfg;
    this.#registry = registry;
    this.#createdEpoch = cfg.currentHostEpoch();
    this.handle = {
      id: req.sessionId,
      providerSessionId: req.sessionId, // the host-pregenerated id is reused as the provider session id
      role: req.role,
      request: req,
    };
  }

  get status(): SessionStatus {
    return this.#status;
  }

  // ---- startup ----

  async start(): Promise<void> {
    const tools = this.#selectTools();
    const toolHooks: ToolBridgeHooks = {
      handle: this.handle,
      role: this.#req.role,
      currentTurnId: () => this.#currentTurnId,
      // prefer the current turn signal (abortTurn propagation), fall back to the session signal (close/kill).
      effectiveSignal: () => this.#turnAbort?.signal ?? this.#sessionAbort.signal,
      onToolRuntimeError: (err) => this.#emitToolRuntimeError(err),
      logger: { debug: () => {} },
      handlerTimeoutMs: this.#cfg.handlerTimeoutMs,
      abortGraceMs: this.#cfg.abortGraceMs,
    };
    const { server, allowedTools } = buildMcpServer(tools, toolHooks);

    const compactCbs: CompactCallbacks = {
      onCompactStarted: (reason, tokensBefore) => {
        // keep tokens already captured by compact_boundary (ordering is not guaranteed, boundary may arrive first); do not overwrite.
        const before = tokensBefore ?? this.#pendingCompact?.tokensBefore ?? this.#lastBoundaryTokens?.before;
        const after = this.#pendingCompact?.tokensAfter ?? this.#lastBoundaryTokens?.after;
        this.#pendingCompact = { reason, ...(before !== undefined ? { tokensBefore: before } : {}), ...(after !== undefined ? { tokensAfter: after } : {}) };
        void this.#emit({ kind: "compact_started", ...this.#common(), reason, tokensBefore: before });
      },
      onCompactSummary: (success, summary, errorMessage) => {
        void this.#emit({
          kind: "compact_ended",
          ...this.#common(),
          success,
          summary,
          firstKeptEntryId: undefined,
          tokensAfter: this.#pendingCompact?.tokensAfter,
          errorMessage,
          willRetryTurn: false,
        });
        if (!success) {
          this.#emitRuntimeErrorEvent(
            new RuntimeErrorImpl({
              kind: "protocol",
              subKind: "compact_summary_missing",
              providerId: PROVIDER,
              sessionId: this.handle.id,
              message: errorMessage ?? "compact summary missing",
            }),
            true,
            true,
          );
        }
        this.#pendingCompact = undefined;
        this.#lastBoundaryTokens = undefined;
      },
      markCompactHookSeen: () => {
        this.#lastCompactHookSeenAt = Date.now();
      },
    };

    const options = await this.#buildOptions(server, allowedTools, compactCbs);
    this.#queue = createPushableQueue();

    try {
      this.#query = this.#cfg.queryFn({ prompt: this.#queue.iterable, options });
    } catch (err) {
      throw classifySdkError(err, "init", { sessionId: this.handle.id });
    }

    // start the single subscriber.
    this.#subscriberDone = this.#runSubscriber(this.#query);

    // Do not block waiting on init (the streaming-input SDK emits init only after
    // the first input push -- see the #initTimer comment): startSession returns
    // immediately (status stays initializing); the first inject's push triggers
    // init, and when the subscriber reaches init it verifies isolation + emits
    // session_started + resolveInit. The timeout guard is armed at the first push
    // in #deliver (a backstop for "init never arrives after push").
  }

  /** init timeout guard: armed after the first input push (a backstop for "init never arrives after push", i.e. a broken SDK startup). */
  #armInitTimer(): void {
    this.#initTimer = setTimeout(() => {
      void (async () => {
        if (this.#initResolved) return;
        const e = new RuntimeErrorImpl({ kind: "timeout", subKind: "session_init_timeout", providerId: PROVIDER, sessionId: this.handle.id, message: "session init timed out" });
        // emit runtime_error first (aligned with the isolation-violation /
        // subscriber-catch fatal paths): the stream carries subKind=session_init_timeout
        // for audit, and #emitRuntimeErrorEvent increments errorCount (otherwise
        // the terminal stats.errorCount=0 would contradict "a fatal init error occurred").
        this.#emitRuntimeErrorEvent(e, false, false);
        void this.#teardownAfterInitFailure();
        this.#resolveInit(false, e);
        // init failure still surfaces a terminal session_ended (#finalizeEnded also synth-closes the turn left open by the first push).
        await this.#finalizeEnded("fatal_runtime_error", true);
      })().catch(() => {
        /* fire-and-forget setTimeout callback: swallow exceptions so they do not escape */
      });
    }, this.#cfg.sessionInitTimeoutMs);
    this.#initTimer.unref?.();
  }

  #selectTools(): ReadonlyArray<HostTool> {
    const tools: HostTool[] = [];
    for (const name of this.#req.toolNames) {
      const tool = this.#registry.get(name);
      if (tool === undefined) {
        throw new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: PROVIDER, message: `tool not registered: ${name}`, sessionId: this.handle.id });
      }
      if (!tool.scope.includes(this.#req.role)) {
        throw new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: PROVIDER, message: `tool ${name} not in scope for role ${this.#req.role}`, sessionId: this.handle.id });
      }
      tools.push(tool);
    }
    return tools;
  }

  async #buildOptions(
    server: ReturnType<typeof buildMcpServer>["server"],
    allowedTools: ReadonlyArray<string>,
    compactCbs: CompactCallbacks,
  ): Promise<Options> {
    const rolePrompt = await readFile(this.#req.systemPromptPath, "utf8");
    const iso = isolationOptions(this.#req.isolation);
    const hooks = buildHooks(this.#req.pathGuards?.rules ?? [], compactCbs, this.#req.cwd);

    const options: Options = {
      ...iso,
      cwd: this.#req.cwd,
      model: this.#req.model.modelId,
      // Append the role prompt after the claude_code preset system prompt rather
      // than replacing it with a bare string -- replacing would lose the
      // claude_code base (working directory / tools / coding-agent conventions etc.).
      // systemPrompt is passed via an SDK stdin control message (not CLI argv), so
      // there is no Windows command-line length limit.
      systemPrompt: { type: "preset", preset: "claude_code", append: rolePrompt },
      mcpServers: { [server.name]: server },
      allowedTools: [...allowedTools],
      hooks,
      includePartialMessages: true,
      // Also forward subagent-internal text/thinking back into the main stream
      // (by default only tool_use/tool_result are forwarded) -- carrying
      // parent_tool_use_id so the observability layer can render the subagent's
      // full internal transcript by attribution.
      forwardSubagentText: true,
      sessionId: this.#req.sessionId,
      persistSession: false,
      abortController: this.#sessionAbort,
    };

    // thinking / effort mapping.
    const thinking = this.#req.thinking;
    if (thinking !== undefined && thinking.level !== "off") {
      this.#assertThinkingLevelSupported(thinking.level);
      options.thinking = thinking.summary === "summarized" ? { type: "adaptive", display: "summarized" } : { type: "adaptive", display: "omitted" };
      const effort = this.#cfg.effortMap[thinking.level];
      if (effort !== undefined) options.effort = effort;
    } else if (thinking !== undefined && thinking.level === "off") {
      options.thinking = { type: "disabled" };
    }

    this.#applyFeatureFlags(options);
    return options;
  }

  /**
   * Applies featureFlags. providerBuiltinTools controls the SDK `tools` base set,
   * orthogonal to allowedTools (the MCP tool whitelist):
   * - passthrough (default): keep the built-in tool preset (so the path-guard PreToolUse has something to match).
   * - disable_all: `tools: []` disables all built-in tools (only host MCP remains).
   * - allow_list: `tools: names` exposes only the listed built-in tools.
   * The TS SDK disable channel for autoRetry / autoCompact is unverified -- when
   * the host explicitly requests disabling, fail fast with not_supported (do not
   * silently swallow); otherwise the SDK default is used.
   */
  #applyFeatureFlags(options: Options): void {
    const flags = this.#req.featureFlags;
    const policy = flags?.providerBuiltinTools ?? { mode: "passthrough" as const };
    if (policy.mode === "disable_all") {
      options.tools = [];
    } else if (policy.mode === "allow_list") {
      options.tools = [...policy.names];
    } else {
      options.tools = { type: "preset", preset: "claude_code" };
    }
    if (flags?.autoRetry === false) {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "not_supported", providerId: PROVIDER, sessionId: this.handle.id, message: "disabling Claude SDK auto-retry is not supported yet (TS SDK channel unverified)", diagnostics: { capabilityPath: "autoRetry.canDisable" } });
    }
    if (flags?.autoCompact === false) {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "not_supported", providerId: PROVIDER, sessionId: this.handle.id, message: "disabling Claude SDK auto-compact is not supported yet (TS SDK channel unverified)", diagnostics: { capabilityPath: "compact.autoCompact" } });
    }
  }

  #assertThinkingLevelSupported(level: string): void {
    if (!(CLAUDE_THINKING_LEVELS as ReadonlyArray<string>).includes(level)) {
      throw new RuntimeErrorImpl({
        kind: "permanent",
        subKind: "not_supported",
        providerId: PROVIDER,
        sessionId: this.handle.id,
        message: `thinking level ${level} not supported by model ${this.#req.model.modelId}`,
        diagnostics: { capabilityPath: "thinking.supportedLevels", level },
      });
    }
  }

  /** On init failure (isolation violation / subscriber exception / timeout) -> close query+queue so the half-started session stops consuming. */
  async #teardownAfterInitFailure(): Promise<void> {
    try {
      this.#queue?.close();
      this.#query?.close();
    } catch {
      /* best-effort */
    }
    if (!this.#sessionAbort.signal.aborted) this.#sessionAbort.abort();
  }

  // ---- single subscriber ----

  async #runSubscriber(q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        await this.#handleMessage(msg);
      }
    } catch (err) {
      // subscriber exception (including subprocess crash). The iteration ending because closeSession actively closed the query is not an exception.
      if (this.#closing || this.#status.state === "closing" || this.#status.state === "closed") return;
      const re = classifySdkError(err, "init", { sessionId: this.handle.id, diagnostics: { providerSubprocessExit: true } });
      this.#emitRuntimeErrorEvent(re, re.kind === "transient", false);
      this.#resolveInit(false, re); // if not yet ready, surface the exception as the init-failure reason
      // teardown (close queue/query + abort the session signal), consistent with the init-timeout / isolation fatal paths:
      // release queue resources + propagate abort to any in-flight tool handler. The query iteration already threw so the query is likely dead; close is idempotent and harmless.
      void this.#teardownAfterInitFailure();
      await this.#finalizeEnded("fatal_runtime_error", false);
    }
  }

  async #handleMessage(msg: SDKMessage): Promise<void> {
    // closed/closing fence: SDK messages arriving after close are no longer written to the normal event stream (session_ended is a hard boundary).
    if (this.#status.state === "closed") return;
    if (this.#status.state === "closing" && !(msg.type === "system" && msg.subtype === "init")) {
      // during closing, only allow turn wind-down (result -> onTurnEnded releases the close wait); other late events are dropped.
      if (msg.type === "result") {
        const ctx = this.#normalizeCtx();
        for (const ev of normalizeMessage(msg, ctx, this.#req.model.modelId)) {
          if (ev.kind === "turn_ended") this.#onTurnEnded(ev.usage?.tokens.input ?? 0, ev.usage?.tokens.output ?? 0);
        }
      }
      return;
    }

    // init system message: session_started + isolation verification.
    if (msg.type === "system" && msg.subtype === "init") {
      this.#initMessage = msg;
      try {
        verifyIsolation(msg, this.#req.isolation);
      } catch (err) {
        const re = err as RuntimeError;
        this.#emitRuntimeErrorEvent(re, false, false);
        void this.#teardownAfterInitFailure();
        this.#resolveInit(false, re);
        // init failure still surfaces a terminal session_ended (otherwise the first push already emitted turn_started, leaving a hanging turn the host would only discover via an outer watchdog). #finalized idempotency keeps it safe even if the subscriber catch also finalizes; the hanging open turn is synth-closed by #finalizeEnded.
        await this.#finalizeEnded("fatal_runtime_error", true);
        return;
      }
      await this.#emit({
        kind: "session_started",
        ...this.#common(),
        role: this.#req.role,
        providerSessionId: this.handle.providerSessionId,
        model: this.#req.model,
        thinking: this.#req.thinking,
        cwd: this.#req.cwd,
      });
      // Flip to idle only when initializing; if init arrives while the first turn
      // is in progress (the first inject already pushed, triggering this init, and
      // status is already streaming), do not reset status to idle (that would clear
      // the in-progress first turn). For the streaming-input SDK, init arrives with
      // the first input, by which point #deliver has set streaming + emitted
      // turn_started (session_started arriving slightly after turn_started reflects this real ordering).
      if (this.#status.state === "initializing") this.#status = { state: "idle" };
      this.#resolveInit(true);
      return;
    }

    // session_state_changed idle -> a weakly-consistent mirror aid.
    if (msg.type === "system" && msg.subtype === "session_state_changed") {
      return; // ResultMessage is authoritative for turn boundaries; status is not changed here
    }

    // compact_boundary: carries token counts. May arrive before the PreCompact hook (ordering not guaranteed) -> stored in fields, read by onCompactStarted / CompactEnded to backfill tokensBefore/After. The boundary is still kept as a provider_raw record (main path below).
    if (msg.type === "system" && msg.subtype === "compact_boundary") {
      const meta = msg.compact_metadata;
      this.#lastBoundaryTokens = { before: meta.pre_tokens, ...(typeof meta.post_tokens === "number" ? { after: meta.post_tokens } : {}) };
      if (this.#pendingCompact !== undefined) {
        this.#pendingCompact = { ...this.#pendingCompact, tokensBefore: meta.pre_tokens, ...(typeof meta.post_tokens === "number" ? { tokensAfter: meta.post_tokens } : {}) };
      }
    }

    // The `/compact` ResultMessage during a manual compact is not a user turn --
    // suppress its turn_ended/usage_snapshot to avoid writing an orphan
    // turn_ended{unknown-turn} (no paired turn_started, polluting the turn count).
    const suppressTurnEvents = msg.type === "result" && this.#compactInflight && this.#currentTurnId === undefined;

    const ctx = this.#normalizeCtx();
    const events = normalizeMessage(msg, ctx, this.#req.model.modelId);
    for (const ev of events) {
      if (suppressTurnEvents && (ev.kind === "turn_ended" || ev.kind === "usage_snapshot")) continue;
      // State updates to the inflight set / pending retry must happen before emit:
      // otherwise a subscriber receiving tool_invoked sees a stale
      // status.toolInflightIds; more importantly, if a listener triggers close
      // during the tool_invoked emit, #finalizeEnded would miss the synthetic
      // tool_result because #inflightToolIds does not yet contain that tool
      // (breaking the kill-pairing guarantee).
      if (ev.kind === "tool_invoked") {
        if (ev.isHostTool) this.#toolCallCount += 1;
        this.#inflightToolIds.set(ev.toolUseId, ev.parentToolUseId);
        this.#syncInflightToStatus();
      } else if (ev.kind === "tool_result_recorded") {
        this.#inflightToolIds.delete(ev.toolUseId);
        this.#syncInflightToStatus();
      } else if (ev.kind === "retry_started") {
        // consecutive retries: before a new retry_started, settle the previous unsettled retry (the previous one did not succeed -> continued retry, success=false).
        if (this.#pendingRetry !== undefined) {
          await this.#emitRetryEnded(this.#pendingRetry.attempt, false, "superseded by subsequent retry");
        }
        this.#pendingRetry = { attempt: ev.attempt };
      } else if (ev.kind === "subagent_stopped") {
        // aggregate subagent terminal tokens into session usage (so subagent cost is not invisible). Take the max per agentId (see the field comment).
        const cur = ev.usage?.totalTokens ?? 0;
        const prev = this.#subagentTokensByAgent.get(ev.agentId) ?? 0;
        if (cur > prev || !this.#subagentTokensByAgent.has(ev.agentId)) {
          this.#subagentTokensByAgent.set(ev.agentId, Math.max(prev, cur));
        }
      }
      await this.#emit(ev);
      if (ev.kind === "turn_ended") this.#onTurnEnded(ev.usage?.tokens.input ?? 0, ev.usage?.tokens.output ?? 0);
    }
    // a result is a turn boundary -> settle the pending retry (success taken from the result subtype; synthesizes retry_ended for Claude).
    if (msg.type === "result" && this.#pendingRetry !== undefined) {
      const ok = msg.subtype === "success";
      await this.#emitRetryEnded(this.#pendingRetry.attempt, ok, ok ? undefined : (msg.subtype ?? "error"));
    }

    // A communication / upstream error ending in an error-result -> promote to
    // runtime_error; the session is not closed, returning to idle so the host
    // decides. LLM-behavior cases (max_tokens / refusal / aborted) stay as
    // turn_ended only and are not promoted.
    const llmBehaviorStop = msg.type === "result" && (msg.stop_reason === "aborted" || msg.stop_reason === "max_tokens" || msg.stop_reason === "refusal");
    if (msg.type === "result" && msg.subtype !== "success" && !llmBehaviorStop && !suppressTurnEvents) {
      const re = this.#classifyResultError(msg.subtype, msg.errors ?? []);
      this.#emitRuntimeErrorEvent(re, re.kind === "transient", true);
    }
  }

  /**
   * Maps an error-subtype ResultMessage to a RuntimeError. Limit-reached cases
   * (max_turns / max_budget / structured_output_retries) are terminal and would
   * re-hit the limit on retry -> classified as permanent so fail-open does not
   * mislabel them transient (the host then terminates the long task rather than
   * spinning on retries). Other error_during_execution cases go through text keyword classification.
   */
  #classifyResultError(subtype: string, errors: ReadonlyArray<string>): RuntimeError {
    const brief = errors.join("; ") || subtype;
    switch (subtype) {
      case "error_max_budget_usd":
        return new RuntimeErrorImpl({ kind: "permanent", subKind: "quota_exhausted", providerId: PROVIDER, sessionId: this.handle.id, message: `max budget reached: ${brief}`, upstreamErrorBrief: brief.slice(0, 200), diagnostics: { resultSubtype: subtype } });
      case "error_max_turns":
        return new RuntimeErrorImpl({ kind: "permanent", subKind: "max_turns_exhausted", providerId: PROVIDER, sessionId: this.handle.id, message: `max turns reached: ${brief}`, upstreamErrorBrief: brief.slice(0, 200), diagnostics: { resultSubtype: subtype } });
      case "error_max_structured_output_retries":
        return new RuntimeErrorImpl({ kind: "permanent", subKind: "structured_output_retries_exhausted", providerId: PROVIDER, sessionId: this.handle.id, message: `structured output retries reached: ${brief}`, upstreamErrorBrief: brief.slice(0, 200), diagnostics: { resultSubtype: subtype } });
      default:
        return classifySdkError(Object.assign(new Error(brief), { name: subtype }), "turn", { sessionId: this.handle.id, diagnostics: { resultSubtype: subtype } });
    }
  }

  #normalizeCtx(): NormalizeContext {
    return {
      sessionId: this.handle.id,
      turnId: this.#currentTurnId,
      now: () => Date.now(),
      recordToolName: (id, name) => this.#toolNamesById.set(id, name),
      resolveToolName: (id) => this.#toolNamesById.get(id) ?? "",
      recordBlockToolUse: (index, id) => this.#blockToolUseByIndex.set(index, id),
      resolveBlockToolUse: (index) => this.#blockToolUseByIndex.get(index),
    };
  }

  #onTurnEnded(input: number, output: number): void {
    this.#turnTokensInput += input;
    this.#turnTokensOutput += output;
    this.#currentTurnId = undefined;
    this.#turnAbort = undefined;
    // clear this turn's toolUseId->name / blockIndex->toolUseId maps to avoid unbounded growth over a long session.
    this.#toolNamesById.clear();
    this.#blockToolUseByIndex.clear();
    this.#inflightToolIds.clear(); // normal turn wind-down -> no inflight tools left
    // if turn wind-down arrives during closing, do not pull status back to idle (keep the closing terminal flow progressing).
    if (this.#status.state !== "closing" && this.#status.state !== "closed") {
      this.#status = { state: "idle", lastTurnEndedAt: Date.now() };
    }
    this.#resolveAllPendingTurns();
  }

  #resolveInit(ok: boolean, err?: RuntimeError): void {
    if (this.#initResolved) return;
    this.#initResolved = true;
    if (this.#initTimer !== undefined) {
      clearTimeout(this.#initTimer);
      this.#initTimer = undefined;
    }
    if (!ok && err !== undefined) this.#initError = err;
  }

  // ---- the three inject states ----

  async inject(input: InjectInput): Promise<InjectAck> {
    // Occupy the inject lifecycle mutex synchronously (before any await) before
    // entering the body; the finally reset covers all return/throw paths and
    // prevents two concurrent idle injects from both passing #deliver's idle
    // check. Busy detection reads #injecting inside the body (see the streaming branch).
    const wasInjecting = this.#injecting;
    this.#injecting = true;
    try {
      return await this.#injectImpl(input, wasInjecting);
    } finally {
      // owner-only release: only the occupier that flipped false->true (the owner)
      // releases the mutex. A rejected concurrent inject (wasInjecting=true) is not
      // the owner and must not clear the flag -- otherwise it would clear a mutex
      // the owner still holds, and a later inject would wrongly judge the session
      // idle and deliver again -> concurrent double-opened turn.
      if (!wasInjecting) this.#injecting = false;
    }
  }

  async #injectImpl(input: InjectInput, concurrentInjectInflight: boolean): Promise<InjectAck> {
    this.#validateInjectInput(input);
    const requestId = this.#nextInjectId();

    if (this.#closing || this.#status.state === "closing" || this.#status.state === "closed") {
      await this.#emit({ kind: "host_inject_requested", ...this.#common(), injectRequestId: requestId, marker: input.marker, content: input.content, policy: input.policy, requestedAt: Date.now() });
      await this.#emit({ kind: "inject_rejected", ...this.#common(), injectRequestId: requestId, reason: "closed_session" });
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: PROVIDER, sessionId: this.handle.id });
    }
    if (this.#stuck) {
      // a session left stuck by an abort timeout: refuse further inject; the host should fall back to closeSession.
      await this.#emit({ kind: "host_inject_requested", ...this.#common(), injectRequestId: requestId, marker: input.marker, content: input.content, policy: input.policy, requestedAt: Date.now() });
      await this.#emit({ kind: "inject_rejected", ...this.#common(), injectRequestId: requestId, reason: "busy", description: "session stuck after abort timeout; closeSession required" });
      throw new RuntimeErrorImpl({ kind: "timeout", subKind: "abort_completion_timeout", providerId: PROVIDER, sessionId: this.handle.id, message: "session stuck after abort timeout" });
    }

    // init already settled and failed (e.g. isolation violation / timeout) -> reject (do not deliver to a broken session).
    if (this.#initResolved && this.#initError !== undefined) {
      await this.#emit({ kind: "host_inject_requested", ...this.#common(), injectRequestId: requestId, marker: input.marker, content: input.content, policy: input.policy, requestedAt: Date.now() });
      await this.#emit({ kind: "inject_rejected", ...this.#common(), injectRequestId: requestId, reason: "closed_session" });
      throw this.#initError;
    }
    // status==="initializing" (init not settled): do not pre-wait on init (the
    // streaming-input SDK deadlock reason) -- go straight to #deliver, whose push
    // triggers the SDK to emit init (the subscriber verifies isolation +
    // session_started + resolveInit); "init never arrives after push" is backstopped by #initTimer.

    await this.#emit({ kind: "host_inject_requested", ...this.#common(), injectRequestId: requestId, marker: input.marker, content: input.content, policy: input.policy, requestedAt: Date.now() });

    // Another inject has synchronously occupied the mutex but not yet set
    // streaming (concurrentInjectInflight) -> back-pressure-reject all policies:
    // this must not be merged into the streaming branch -- otherwise a later
    // interrupt_then_inject would go through #interruptAndWait (and #waitTurnEnd
    // resolves immediately while the first inject has not yet set #currentTurnId)
    // -> still double-opening a turn. Rejecting all four states
    // (require_idle/steer/follow_up/interrupt) at the top eliminates concurrent double-deliver.
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
      if (policy === "steer_if_streaming" || policy === "follow_up_if_streaming") {
        const capabilityPath = policy === "steer_if_streaming" ? "inject.steerIfStreaming" : "inject.followUpIfStreaming";
        await this.#emit({ kind: "inject_rejected", ...this.#common(), injectRequestId: requestId, reason: "not_supported_policy", description: capabilityPath });
        throw new RuntimeErrorImpl({ kind: "permanent", subKind: "not_supported", providerId: PROVIDER, sessionId: this.handle.id, message: `Claude does not support ${capabilityPath}`, diagnostics: { capabilityPath } });
      }
      // interrupt_then_inject: interrupt -> wait for turn_ended -> query a new turn. Interrupt timeout -> stuck, refuse to deliver.
      const ok = await this.#interruptAndWait();
      if (!ok) {
        await this.#emit({ kind: "inject_rejected", ...this.#common(), injectRequestId: requestId, reason: "busy", description: "interrupt did not complete; session stuck" });
        throw new RuntimeErrorImpl({ kind: "timeout", subKind: "abort_completion_timeout", providerId: PROVIDER, sessionId: this.handle.id, message: "interrupt_then_inject: interrupt did not complete in time" });
      }
      return this.#deliver(requestId, input, "deliver_after_interrupt", "after_interrupt");
    }

    // idle: all policies degrade to immediate delivery.
    return this.#deliver(requestId, input, "deliver_immediate", "immediate");
  }

  async #deliver(
    requestId: string,
    input: InjectInput,
    acceptedAs: "deliver_immediate" | "deliver_after_interrupt",
    deliveryPath: "immediate" | "after_interrupt",
  ): Promise<InjectAck> {
    await this.#emit({ kind: "inject_accepted", ...this.#common(), injectRequestId: requestId, acceptedAs });

    // Build the user message first and confirm the queue can deliver (content
    // build failure / queue closed -> do not falsely report "delivered"); only
    // after passing these checks emit inject_delivered / turn_started, then push
    // last (push after emit, so turn_started precedes any assistant_block the
    // subscriber later produces from this message -- turn pairing).
    let userMsg: SDKUserMessage;
    try {
      userMsg = await this.#buildUserMessage(input.content);
    } catch (err) {
      const re = err instanceof RuntimeErrorImpl ? err : new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: PROVIDER, sessionId: this.handle.id, message: `inject content build failed: ${(err as Error).message}` });
      await this.#emit({ kind: "inject_rejected", ...this.#common(), injectRequestId: requestId, reason: "invalid_marker", description: re.message });
      throw re;
    }
    if (this.#queue === undefined || this.#queue.closed) {
      await this.#emit({ kind: "inject_rejected", ...this.#common(), injectRequestId: requestId, reason: "closed_session", description: "input queue closed" });
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: PROVIDER, sessionId: this.handle.id });
    }

    const turnId = this.#nextTurnId();
    this.#currentTurnId = turnId;
    this.#turnAbort = new AbortController();
    this.#inflightToolIds.clear(); // new turn start: clear any residue from the previous turn (normally already cleared; defensive)
    this.#status = { state: "streaming", turnId, turnStartedAt: Date.now(), toolInflightIds: [] };

    // Claude does not echo back the injected user message; the marker chain is first-class.
    await this.#emit({ kind: "inject_delivered", ...this.#common(), injectRequestId: requestId, deliveryPath, turnId });
    await this.#emit({ kind: "turn_started", ...this.#common(), turnId, cause: { kind: "user_input", markerKind: input.marker.kind }, startedAt: Date.now() });

    // push after the turn_started emit (turn_started must precede any
    // assistant_block this message produces). Note there are two emit awaits
    // (inject_delivered / turn_started) between the queue-open precheck (#queue.closed
    // above) and this push -- a concurrent close / stream-write-failure auto-close
    // can close the queue in that window and cause the push to fail.
    // The first input push triggers the SDK to emit init -- only now arm the init timeout guard (once, when init is unsettled and not yet armed).
    if (!this.#initResolved && this.#initTimer === undefined) this.#armInitTimer();
    if (this.#queue.push(userMsg) === false) {
      // push failed = the message did not actually reach the SDK -> must not
      // return delivered (the host would wrongly think it was delivered and wait
      // forever). emit runtime_error + wind down the session (#finalizeEnded
      // synth-closes this turn + session_ended; #finalized idempotency prevents
      // double-emit) + throw closed_session. #emitRuntimeErrorEvent increments
      // #errorCount (consistent with terminal stats, so a fatal runtime_error is
      // never emitted with errorCount=0).
      this.#emitRuntimeErrorEvent(new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: PROVIDER, sessionId: this.handle.id, turnId, message: "input queue closed between check and push" }), false, false);
      await this.#finalizeEnded("fatal_runtime_error", true);
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: PROVIDER, sessionId: this.handle.id, turnId, message: "input queue closed before push; inject not delivered" });
    }

    return acceptedAs === "deliver_after_interrupt" ? { mode: "delivered_after_interrupt", turnId } : { mode: "delivered_immediate", turnId };
  }

  #validateInjectInput(input: InjectInput): void {
    if (input.marker === undefined || typeof input.marker.kind !== "string") {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: PROVIDER, sessionId: this.handle.id, message: "inject marker missing", diagnostics: { reason: "invalid_marker" } });
    }
    if (input.content.length === 0) {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: PROVIDER, sessionId: this.handle.id, message: "inject content empty" });
    }
  }

  async #buildUserMessage(content: ReadonlyArray<InjectContentBlock>): Promise<SDKUserMessage> {
    // images pass through to the LLM as real image content blocks (not silently
    // downgraded to placeholder text); text/reference go through the text channel
    // (a reference is a pointer, so converting it to text is acceptable).
    const parts: Array<Record<string, unknown>> = [];
    for (const block of content) {
      if (block.type === "text") {
        const text = "text" in block ? block.text : await readFile(block.textPath, "utf8");
        parts.push({ type: "text", text });
      } else if (block.type === "reference") {
        parts.push({ type: "text", text: `[reference: ${block.uri}${block.description !== undefined ? ` — ${block.description}` : ""}]` });
      } else {
        const data = "data" in block ? block.data : (await readFile(block.path)).toString("base64");
        parts.push({ type: "image", source: { type: "base64", media_type: block.mediaType, data } });
      }
    }
    return {
      type: "user",
      message: { role: "user", content: parts },
      parent_tool_use_id: null,
      session_id: this.handle.id,
    } as unknown as SDKUserMessage;
  }

  // ---- abortTurn ----

  async abortTurn(_reason?: string): Promise<void> {
    if (this.#closing || this.#status.state === "closing" || this.#status.state === "closed") {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: PROVIDER, sessionId: this.handle.id });
    }
    if (this.#stuck) {
      // left stuck by an abort timeout -> refuse further abort (same as inject; the host should fall back to closeSession).
      throw new RuntimeErrorImpl({ kind: "timeout", subKind: "abort_completion_timeout", providerId: PROVIDER, sessionId: this.handle.id, message: "session stuck after abort timeout; closeSession required" });
    }
    if (this.#status.state === "initializing") return; // no inject yet -> no turn to abort (the first push triggers init + turn)
    if (this.#status.state !== "streaming") return; // idle -> no-op
    const ok = await this.#interruptAndWait();
    if (!ok) {
      throw new RuntimeErrorImpl({ kind: "timeout", subKind: "abort_completion_timeout", providerId: PROVIDER, sessionId: this.handle.id, message: "interrupt did not complete in time; session stuck (closeSession required)" });
    }
  }

  /** Interrupt the current turn and wait for it to wind down. Returns true=ended, false=timed out (the session is marked stuck). */
  async #interruptAndWait(): Promise<boolean> {
    const turnId = this.#currentTurnId;
    // abort the current turn's signal first, to cooperatively cancel an inflight host tool handler.
    this.#turnAbort?.abort();
    try {
      await this.#query?.interrupt();
    } catch (err) {
      this.#emitRuntimeErrorEvent(classifySdkError(err, "turn", { sessionId: this.handle.id, ...(turnId !== undefined ? { turnId } : {}) }), true, true);
    }
    // wait for the SDK to signal turn end (ResultMessage -> onTurnEnded), up to abortCompletionTimeoutMs.
    const ended = await this.#waitTurnEnd(this.#cfg.abortCompletionTimeoutMs);
    if (!ended) {
      // timeout: the old turn may still be running and a late ResultMessage would
      // be mismatched to the new turn -> mark stuck, refuse further inject/abort,
      // and let the host fall back to closeSession. Do not locally fabricate a
      // turn_ended to set idle (would falsely report it ended).
      this.#stuck = true;
      this.#emitRuntimeErrorEvent(new RuntimeErrorImpl({ kind: "timeout", subKind: "abort_completion_timeout", providerId: PROVIDER, sessionId: this.handle.id, ...(turnId !== undefined ? { turnId } : {}), message: "interrupt did not complete in time; session stuck (closeSession required)" }), false, true);
      return false;
    }
    return true;
  }

  /**
   * Wait for the current turn to end (ResultMessage -> onTurnEnded clears currentTurnId and resolves).
   * No inflight turn (currentTurnId already cleared) -> immediately true. Based on
   * currentTurnId rather than status, so the close path (status=closing) can still
   * wait for a streaming turn to wind down.
   */
  #waitTurnEnd(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (this.#currentTurnId === undefined) {
        resolve(true);
        return;
      }
      // multi-waiter safe: each waiter is added independently, all resolve(true) on turn end; its own timeout only removes itself.
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
      this.#pendingTurns.add(onEnd);
    });
  }

  /** On turn end / fatal finalize, resolve(true) all current-turn waiters at once (clear the set; each callback clears its own timer). */
  #resolveAllPendingTurns(): void {
    const waiters = [...this.#pendingTurns];
    this.#pendingTurns.clear();
    for (const w of waiters) w();
  }

  // ---- closeSession ----

  /**
   * All concurrent / re-entrant closes (host calling repeatedly, an auto-close
   * triggered by a write failure) reuse the same in-flight promise, eliminating
   * double finalizeEnded / double session_ended.
   */
  async close(options?: { forceAbort?: boolean; idleTimeoutMs?: number; reason?: SessionEndReason }): Promise<SessionCloseResult> {
    if (this.#closeResult !== undefined) return this.#closeResult; // already done -> idempotent cached return
    if (this.#closePromise !== undefined) return this.#closePromise; // in progress -> reuse the same close
    this.#closing = true; // set synchronously (fence late #handleMessage events / inject)
    // clear the init timeout guard at the close entry: otherwise, with init
    // unsettled, the timer could fatal-finalize first during the #waitTurnEnd
    // graceful wait window and hijack the explicit close's session_ended.reason
    // into fatal_runtime_error (#finalized keeps session_ended to exactly one, but
    // the reason label would be stolen). Clearing at entry gives the close's reason deterministic priority.
    if (this.#initTimer !== undefined) {
      clearTimeout(this.#initTimer);
      this.#initTimer = undefined;
    }
    this.#closePromise = this.#doClose(options);
    return this.#closePromise;
  }

  #closePromise: Promise<SessionCloseResult> | undefined;

  async #doClose(options?: { forceAbort?: boolean; idleTimeoutMs?: number; reason?: SessionEndReason }): Promise<SessionCloseResult> {
    const reason: SessionEndReason = options?.reason ?? "host_close";
    let hadForcedKill = this.#stuck; // left stuck by an abort timeout -> go straight to the kill path

    // Before entering the closing fence, let an in-flight turn wind down normally
    // (status stays streaming so turn_ended/usage_snapshot are normalized and
    // persisted, not swallowed by the closing fence, preserving the turn-pairing
    // contract). #closing was already set synchronously in close() to block new
    // injects; here we just wait for the current turn to end.
    if (!hadForcedKill && this.#status.state === "streaming") {
      if (options?.forceAbort === true) {
        // forceAbort: internal interrupt (not via the public abortTurn -- that would throw closed_session because #closing is already set).
        try {
          const ok = await this.#interruptAndWait();
          if (!ok) hadForcedKill = true;
        } catch {
          hadForcedKill = true;
        }
      } else {
        // graceful: wait for the current turn to end naturally (up to idleTimeoutMs); events are persisted normally during the wait.
        const idleMs = options?.idleTimeoutMs ?? this.#cfg.closeIdleTimeoutMs;
        const idle = await this.#waitTurnEnd(idleMs);
        if (!idle) hadForcedKill = true;
      }
    }

    this.#status = { state: "closing", reason };
    // Waiting for turn wind-down already completed before entering closing
    // (graceful #waitTurnEnd / forceAbort #interruptAndWait above); if it did not
    // wind down, hadForcedKill is set and the synthetic turn_ended is backstopped by #finalizeEnded on the kill path.

    // cancel subscriber + exit the SDK client (query.close ends the subscriber's for-await iteration).
    try {
      this.#queue?.close();
      this.#query?.close(); // exit the SDK / force-kill the CLI subprocess
      if (hadForcedKill) this.#sessionAbort.abort();
    } catch {
      hadForcedKill = true;
    }
    // backstop: propagate abort to an inflight tool handler.
    if (!this.#sessionAbort.signal.aborted) this.#sessionAbort.abort();

    // wait for the subscriber to converge (grace), ensuring no late normal events are persisted after session_ended.
    if (this.#subscriberDone !== undefined) {
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, this.#cfg.abortGraceMs);
        graceTimer.unref?.(); // do not let this backstop timer keep the process alive (the subscriber usually converges first)
      });
      await Promise.race([this.#subscriberDone.catch(() => {}), grace]);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    }

    return this.#finalizeEnded(hadForcedKill ? "host_close_forced" : reason, hadForcedKill);
  }

  async #finalizeEnded(reason: SessionEndReason, hadForcedKill: boolean): Promise<SessionCloseResult> {
    if (this.#closeResult !== undefined) return this.#closeResult;
    // synchronous placeholder: block finalize re-entrancy (e.g. a session_ended
    // write failure re-triggering close -> finalize), avoiding double-emit of
    // session_ended (the unique terminal event). If finalize is already underway
    // but #closeResult is not yet settled, wait for the chain to converge before returning.
    if (this.#finalized) {
      await this.#emitChain.catch(() => {});
      return this.#closeResult ?? { sessionId: this.handle.id, endedAt: Date.now(), reason, stats: this.#stats(), hadForcedKill };
    }
    this.#finalized = true;
    // close happened before init settled -> clear the init timeout guard (no longer needed; the timer is unref'd, but this avoids a late callback).
    if (this.#initTimer !== undefined) {
      clearTimeout(this.#initTimer);
      this.#initTimer = undefined;
    }
    // If a turn is still un-wound at session end (kill path / the first turn left
    // by an init failure) -> always add a synthetic turn_ended to wind it down. If
    // a real turn_ended already landed, #onTurnEnded already cleared #currentTurnId
    // -> no duplicate is added here.
    if (this.#currentTurnId !== undefined) {
      const turnId = this.#currentTurnId;
      // kill path: add a synthetic tool_result_recorded to pair each still-inflight tool, looking up its name before #toolNamesById is cleared.
      // backfill parentToolUseId: if the inflight tool came from a subagent, the synthetic result must preserve attribution (otherwise it would be misattributed to the main agent by Web/audit).
      for (const [toolUseId, parentToolUseId] of this.#inflightToolIds) {
        await this.#emit({
          kind: "tool_result_recorded",
          ...this.#common(),
          turnId,
          toolUseId,
          toolName: this.#toolNamesById.get(toolUseId) ?? "unknown",
          result: { content: [{ type: "text", text: "<cancelled by session kill>" }], isError: true, providerExtras: { _killCancelled: true } },
          recordedAt: Date.now(),
          ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
        });
      }
      this.#inflightToolIds.clear();
      this.#currentTurnId = undefined;
      this.#turnAbort = undefined;
      this.#toolNamesById.clear();
      this.#blockToolUseByIndex.clear();
      await this.#emit({ kind: "turn_ended", ...this.#common(), turnId, stopReason: "aborted", usage: undefined, endedAt: Date.now() });
      // converge all waiters (consistent with #onTurnEnded): resolve every
      // #waitTurnEnd waiter on the current turn so concurrent abortTurn/close waits
      // return immediately rather than waiting out the timeout (fatal finalize racing graceful close/abort).
      this.#resolveAllPendingTurns();
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
    if (this.#closing || this.#status.state === "closing" || this.#status.state === "closed") {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: PROVIDER, sessionId: this.handle.id });
    }
    if (this.#compactInflight) {
      // reject a concurrent compact (avoid overwriting #compactResolver / crosstalk with auto-compact).
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: PROVIDER, sessionId: this.handle.id, message: "compact already in progress" });
    }
    this.#compactInflight = true;
    // manual /compact slash command (hint.customInstructions as the instructions).
    const instr = hint?.customInstructions !== undefined ? ` ${hint.customInstructions}` : "";
    const cmd: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: `/compact${instr}` },
      parent_tool_use_id: null,
      session_id: this.handle.id,
    } as SDKUserMessage;

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
        // timeout: add a synthetic compact_started/ended(success:false) + protocol error, so it does not vanish from the audit.
        if (this.#pendingCompact === undefined) {
          void this.#emit({ kind: "compact_started", ...this.#common(), reason: "manual_host", tokensBefore: undefined });
        }
        void this.#emit({ kind: "compact_ended", ...this.#common(), success: false, summary: undefined, firstKeptEntryId: undefined, tokensAfter: undefined, errorMessage: "compact timed out", willRetryTurn: false });
        this.#emitRuntimeErrorEvent(new RuntimeErrorImpl({ kind: "protocol", subKind: "compact_summary_missing", providerId: PROVIDER, sessionId: this.handle.id, message: "manual compact timed out without summary" }), true, true);
        this.#pendingCompact = undefined;
        finish({ success: false, summary: undefined, errorMessage: "compact timed out" });
      }, this.#cfg.compactTimeoutMs);
      this.#compactResolver = finish;
      if (this.#queue === undefined || this.#queue.push(cmd) === false) {
        finish({ success: false, summary: undefined, errorMessage: "input queue closed" });
      }
    });
  }

  #compactResolver: ((o: CompactOutcome) => void) | undefined;

  // ---- contextUsage (supportsManualQuery) ----

  async contextUsage(): Promise<ContextUsage> {
    if (this.#query === undefined) {
      return { tokens: undefined, contextWindow: undefined, percent: undefined };
    }
    try {
      const r = await this.#query.getContextUsage();
      const categories: Record<string, number> = {};
      for (const c of r.categories) categories[c.name] = c.tokens;
      return { tokens: r.totalTokens, contextWindow: r.maxTokens, percent: r.percentage, categories };
    } catch (err) {
      throw classifySdkError(err, "turn", { sessionId: this.handle.id });
    }
  }

  // ---- isolation self-check ----

  isolationSelfCheck(): ReturnType<typeof isolationSelfCheck> {
    return isolationSelfCheck(this.#initMessage, this.#req.isolation);
  }

  // ---- subscribe (callback fanout + bounded replay) ----

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

  /** Sync #inflightToolIds into the public streaming status.toolInflightIds (uphold the SessionStatus contract). */
  #syncInflightToStatus(): void {
    if (this.#status.state === "streaming") {
      this.#status = { ...this.#status, toolInflightIds: [...this.#inflightToolIds.keys()] };
    }
  }

  /** Settle the pending retry: emit retry_ended and clear #pendingRetry. */
  async #emitRetryEnded(attempt: number, success: boolean, finalErrorBrief?: string): Promise<void> {
    this.#pendingRetry = undefined;
    await this.#emit({
      kind: "retry_ended",
      ...this.#common(),
      success,
      attempt,
      ...(finalErrorBrief !== undefined ? { finalErrorBrief } : {}),
    });
  }

  #nextTurnId(): TurnId {
    this.#turnCounter += 1;
    return `${this.handle.id}-t${this.#turnCounter}`;
  }

  #nextInjectId(): string {
    this.#injectCounter += 1;
    return `${this.handle.id}-i${this.#injectCounter}`;
  }

  #stats(): SessionFinalStats {
    let subagentTokens = 0;
    for (const t of this.#subagentTokensByAgent.values()) subagentTokens += t;
    return {
      turnCount: this.#turnCounter,
      toolCallCount: this.#toolCallCount,
      errorCount: this.#errorCount,
      tokens: { input: this.#turnTokensInput, output: this.#turnTokensOutput, total: this.#turnTokensInput + this.#turnTokensOutput },
      ...(subagentTokens > 0 ? { subagentTokens } : {}),
    };
  }

  #emitToolRuntimeError(err: RuntimeError): void {
    this.#emitRuntimeErrorEvent(err, true, true);
  }

  #emitRuntimeErrorEvent(error: RuntimeError, recoverable: boolean, continuingSession: boolean): void {
    this.#errorCount += 1;
    void this.#emit({ kind: "runtime_error", ...this.#common(), error, recoverable, continuingSession });
  }

  #emitChain: Promise<void> = Promise.resolve();

  /**
   * Serialize emits: all emits (including fire-and-forget `void #emit(...)` calls)
   * queue onto the same promise chain, guaranteeing a monotonic persistence seq
   * and that fanout order matches submission order (not reordered by concurrent awaits).
   */
  #emit(event: SessionEvent): Promise<void> {
    const next = this.#emitChain.then(() => this.#doEmit(event));
    // swallow errors on the chain so one failure does not block subsequent emits (persistence failures are handled inside #doEmit).
    this.#emitChain = next.catch(() => {});
    return next;
  }

  async #doEmit(event: SessionEvent): Promise<void> {
    // ring buffer (bounded replay).
    this.#replay.push(event);
    if (this.#replay.length > REPLAY_BUFFER_MAX + 8) this.#replay.splice(0, this.#replay.length - (REPLAY_BUFFER_MAX + 8));

    // session_ended hard boundary: once the terminal event is persisted, any late
    // event (e.g. a concurrent inject's host_inject_requested) is no longer
    // persisted; fanout still happens (listeners are usually already cleared by then, harmless).
    const persist = !("_persistedToStream" in event) && !(this.#sessionEndedPersisted && event.kind !== "session_ended");

    // persist to the stream JSONL (a synthetic snapshot with _persistedToStream:false is not persisted; this path does not emit it).
    if (persist) {
      // host-death epoch fencing: compare the epoch snapshotted at session creation against "now"; reject the write on mismatch.
      if (epochFenceOk(this.#createdEpoch, this.#cfg.currentHostEpoch())) {
        this.#seq += 1;
        try {
          await jsonlIO.appendLine(this.#req.streamPath, { ...event, _writer: { seq: this.#seq, adapterVersion: this.#cfg.adapterVersion } });
          this.#streamWriteFails = 0;
          if (event.kind === "session_ended") this.#sessionEndedPersisted = true;
        } catch {
          this.#streamWriteFails += 1;
          if (this.#streamWriteFails >= STREAM_WRITE_FAIL_LIMIT) {
            // 3 consecutive failures -> permanent + automatic closeSession.
            this.#emitRuntimeErrorEventNoWrite(new RuntimeErrorImpl({ kind: "permanent", subKind: "stream_persistent_write_failed", providerId: PROVIDER, sessionId: this.handle.id, message: "stream JSONL write failed 3x" }));
            void this.close({ reason: "fatal_runtime_error", forceAbort: true });
          }
        }
      }
    }

    // fanout.
    for (const listener of this.#listeners) this.#safeCall(listener, event);

    // compact_ended resolves the compact() promise (manual path) -- after fanout, to ensure listeners have received the event.
    if (event.kind === "compact_ended" && this.#compactResolver !== undefined) {
      const r = this.#compactResolver;
      this.#compactResolver = undefined;
      r({ success: event.success, summary: event.summary, ...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}) });
    }
  }

  /** runtime_error fanout on the persistence-failure path (does not attempt to persist again, to avoid recursive failure). */
  #emitRuntimeErrorEventNoWrite(error: RuntimeError): void {
    this.#errorCount += 1;
    const event: SessionEvent = { kind: "runtime_error", ...this.#common(), error, recoverable: false, continuingSession: false };
    for (const listener of this.#listeners) this.#safeCall(listener, event);
  }

  #safeCall(listener: (e: SessionEvent) => void, event: SessionEvent): void {
    try {
      listener(event);
    } catch {
      // a listener throwing does not propagate
    }
  }
}
