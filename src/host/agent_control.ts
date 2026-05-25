/**
 * Thin host-side entry for agent dispatch.
 *
 * The `sh_agent__start_worker / stop_worker / trigger_reviewer` tool handlers do not directly hold
 * the wrapper runtime / worker session handle / reviewer verdict buffer — those are in-memory state
 * of the host main loop (daemon orchestration layer). This module defines the `HostAgentControl`
 * contract: handlers are injected with it and call it to do three things ("set worker-start flag /
 * stop worker / trigger reviewer and block-wait"), leaving the physical session lifecycle to the
 * orchestration layer.
 *
 * Provides a default implementation `createHostAgentControl` that wraps existing primitives
 * (agent_sessions / main_loop / messaging bus / wrapper runtime):
 * - startWorker: only sets the start flag (async, starts the session next tick) and clears metaStopNoRestart
 * - stopWorker: soft-kills the current worker handle via wrapper closeSession; sets orchestration flags per restartAfter
 * - triggerReviewer: starts a short session + awaits session ended + takes the verdict from the
 *   verdict buffer into a reviewer_verdict envelope (missing → verdict_missing fallback; runtime
 *   failure → host_event)
 *
 * Handlers only do role/argument validation + call this contract; this module only does physical
 * orchestration, not LLM-protocol result wrapping.
 */
import type {
  AgentRole,
  AgentRuntime,
  SessionEvent,
  SessionHandle,
  SessionRequest,
} from "../wrapper/index.js";
import type { MessagingBus } from "../messaging/index.js";
import type { EnvelopeId } from "../shared/ids.js";
import type { ReviewerVerdictValue } from "../messaging/index.js";
import type { TaskCapsulePaths } from "../shared/paths.js";
import type { Stage } from "../shared/manifest.js";
import { manifestIO } from "../shared/manifest.js";
import type { ReviewerPhase } from "../prompts/index.js";
import { HostEventKind, HostToolCommonErrorKind, WatchdogKind } from "./errorKinds.js";
import {
  appendReviewerEndedIdempotent,
  appendSessionStarted,
  firstMessageInject,
  generateSessionId,
  isInjectDelivered,
  prompts,
  writeFirstMessage,
  writeSystemPrompt,
  type WorkerOrchestrationState,
} from "./agent_sessions.js";
import { enqueueHostEvent } from "./main_loop.js";
import { withTransientRetry, type RetryConfig, type RetryHooks } from "./retry.js";
import { eventsIO } from "./events.js";
import {
  DEFAULT_WATCHDOG_THRESHOLDS,
  type WatchdogThresholds,
} from "./watchdog.js";

// ---- reviewer verdict buffer (written by sh_reviewer__submit_verdict, read by triggerReviewer) ----

export interface ReviewerVerdictRecord {
  readonly verdict: ReviewerVerdictValue;
  readonly issues: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

/**
 * In-process reviewer verdict buffer. The `sh_reviewer__submit_verdict` handler within a reviewer
 * session writes it (key=reviewerSessionId); after the reviewer session exits, `triggerReviewer`
 * takes it out and turns it into an envelope. A repeated submit in the same session → last write
 * wins (fail-soft "change of mind").
 */
export class ReviewerVerdictBuffer {
  readonly #bySession = new Map<string, ReviewerVerdictRecord>();

  put(sessionId: string, record: ReviewerVerdictRecord): void {
    this.#bySession.set(sessionId, record);
  }

  take(sessionId: string): ReviewerVerdictRecord | undefined {
    const v = this.#bySession.get(sessionId);
    this.#bySession.delete(sessionId);
    return v;
  }
}

// ---- HostAgentControl contract (injected into tool handlers) ----

export interface StartWorkerOutcome {
  readonly ok: boolean;
  readonly errorKind: string | null;
  readonly errorMessage: string | null;
}

export interface StopWorkerOutcome {
  readonly ok: boolean;
  readonly errorKind: string | null;
  readonly errorMessage: string | null;
  readonly sessionId: string | null;
  readonly stopDispatched: boolean;
  readonly noop: boolean;
}

export type ReviewerEnvelopeKind = "reviewer_verdict" | "host_event";

export interface TriggerReviewerOutcome {
  readonly ok: boolean;
  readonly errorKind: string | null;
  readonly errorMessage: string | null;
  readonly sessionId: string | null;
  /** Verdict envelope was enqueued to the Meta inbox (false → a runtime failure went via host_event). */
  readonly verdictEnqueued: boolean;
  readonly envelopeKind: ReviewerEnvelopeKind | null;
}

export interface HostAgentControl {
  /** Whether there is currently an active worker session (race check). */
  hasActiveWorker(): boolean;
  /** Whether there is currently an active reviewer session (no concurrency allowed). */
  hasActiveReviewer(): boolean;
  /** Set the start flag (asynchronously starts the worker). */
  requestWorkerStart(reason: string): void;
  /** Stop the current worker (soft kill); set orchestration flags per restartAfter. */
  stopWorker(reason: string, restartAfter: boolean): Promise<StopWorkerOutcome>;
  /** Trigger a reviewer short session (block until exit); the verdict goes to the Meta inbox. */
  triggerReviewer(opts: {
    phase: ReviewerPhase;
    round: number;
    subject: string;
    additionalDirs?: ReadonlyArray<string>;
  }): Promise<TriggerReviewerOutcome>;
}

// ---- default implementation: wraps existing primitives ----

export interface HostAgentControlDeps {
  readonly paths: TaskCapsulePaths;
  readonly bus: MessagingBus;
  /**
   * Runtime for the reviewer role (used by triggerReviewer to start the reviewer session).
   * Worker physical close (stopWorker) resolves via `runtimeForRole` by the worker handle.role
   * (worker / reviewer may be different providers).
   */
  readonly runtime: AgentRuntime;
  /**
   * Resolve a runtime by role: stopWorker resolves the worker-provider runtime by the worker
   * handle.role to close it (not reusing the reviewer runtime, since the providers may differ).
   * When omitted → falls back to `runtime` (under the single-provider shorthand they are the same).
   */
  readonly runtimeForRole?: (role: AgentRole) => AgentRuntime;
  readonly orchestration: WorkerOrchestrationState;
  readonly verdictBuffer: ReviewerVerdictBuffer;
  /** Reviewer session request template (model / isolation / cwd / toolNames) — host startup config. */
  readonly reviewerSessionConfig: {
    readonly cwd: string;
    readonly model: SessionRequest["model"];
    readonly thinking?: SessionRequest["thinking"];
    readonly isolation: SessionRequest["isolation"];
    readonly toolNames: ReadonlyArray<string>;
  };
  /** Get the current active worker session handle (null if none); maintained by the orchestration layer. */
  getActiveWorkerHandle(): SessionHandle | null;
  /** Get the current active reviewer session handle (null if none); maintained by the orchestration layer. */
  getActiveReviewerHandle(): SessionHandle | null;
  /** The orchestration layer registers reviewer start / exit (concurrency guard + lifecycle tracking). */
  setActiveReviewerHandle(handle: SessionHandle | null): void;
  /** Injectable clock (fake clock for testing, default Date.now) — reviewer session-timeout watchdog timing. */
  readonly now?: () => number;
  /** watchdog threshold overrides (tests shrink reviewerSessionMs). */
  readonly watchdogThresholds?: Partial<WatchdogThresholds>;
  /** SDK-boundary transient retry config / hooks (for reviewer startSession + first inject, consistent with meta/worker/watcher). */
  readonly retryConfig?: Partial<RetryConfig>;
  readonly retryHooks?: RetryHooks;
}

class HostAgentControlImpl implements HostAgentControl {
  readonly #deps: HostAgentControlDeps;
  readonly #now: () => number;
  readonly #thresholds: WatchdogThresholds;

  constructor(deps: HostAgentControlDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#thresholds = { ...DEFAULT_WATCHDOG_THRESHOLDS, ...(deps.watchdogThresholds ?? {}) };
  }

  /**
   * SDK-boundary transient retry wrapper (same semantics as daemon withSdkRetry): only transient
   * RuntimeError is retried with backoff; permanent/protocol/timeout/cancelled is rethrown
   * immediately to the caller. Applied at the two one-shot, no-cross-tick-retry SDK calls (reviewer
   * startSession + first inject) so transient jitter isn't mistaken for a reviewer start/delivery failure.
   */
  #sdkRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const hooks: RetryHooks = {
      onRetry: (attempt, delayMs, err) => {
        console.warn(`[agent_control] transient SDK retry (${label}) attempt ${attempt} after ${delayMs}ms: ${err.subKind ?? err.kind}`);
      },
      ...(this.#deps.retryHooks ?? {}),
    };
    return withTransientRetry(fn, this.#deps.retryConfig ?? {}, hooks);
  }

  hasActiveWorker(): boolean {
    return this.#deps.getActiveWorkerHandle() !== null;
  }

  hasActiveReviewer(): boolean {
    return this.#deps.getActiveReviewerHandle() !== null;
  }

  requestWorkerStart(_reason: string): void {
    const o = this.#deps.orchestration;
    // Explicitly starting a worker (Meta start_worker / restartAfter=true) clears all
    // "awaiting Meta reaction" states (the clear condition: calling any worker-dispatch tool), so
    // reconcileWorker is no longer blocked by any await flag.
    o.workerCompletionPending = false;
    o.metaStopNoRestart = false;
    o.sessionEndPending = false;
    o.metaInterruptDefaultContinue = false;
    o.workerCompletionReminderSeq = 0; // clearing pending also clears reminderSeq (symmetric with the inbox-gate / finalize new round)
  }

  async stopWorker(reason: string, restartAfter: boolean): Promise<StopWorkerOutcome> {
    const handle = this.#deps.getActiveWorkerHandle();
    const o = this.#deps.orchestration;
    if (handle === null) {
      // race-noop (no active worker): still apply the restartAfter orchestration-state transition.
      // stopDispatched=false but noop=true → the wrapper sets wantWorkerStart (restartAfter=true) or
      // enters metaStopNoRestart (false), leaving no stall.
      // Regardless of restartAfter, calling stop_worker is "any worker-dispatch tool" → clear the other await flags.
      o.workerCompletionPending = false;
      o.sessionEndPending = false;
      o.metaInterruptDefaultContinue = false;
      o.metaStopNoRestart = !restartAfter;
      o.workerCompletionReminderSeq = 0;
      return { ok: true, errorKind: null, errorMessage: null, sessionId: null, stopDispatched: false, noop: true };
    }
    try {
      // Physical worker close uses the runtime resolved by the worker handle.role (distinct from the reviewer runtime).
      const workerRuntime = this.#deps.runtimeForRole?.(handle.role) ?? this.#deps.runtime;
      await workerRuntime.closeSession(handle, { forceAbort: true, reason: "host_close_forced" });
    } catch (err) {
      return {
        ok: false,
        errorKind: HostToolCommonErrorKind.hostInternal,
        errorMessage: `closeSession failed: ${(err as Error).message} (reason=${reason})`,
        sessionId: handle.id,
        stopDispatched: false,
        noop: false,
      };
    }
    // restartAfter=true (Meta authorizes restart: equivalent to a plain stop, does not enter
    // metaStopNoRestart) → clear metaStopNoRestart;
    // restartAfter=false → enter metaStopNoRestart (cleared when Meta calls any worker-dispatch tool again).
    // wantWorkerStart / sessionEndPending are set by the wrapper per restartAfter.
    // stop_worker is a worker-dispatch tool → clear the other await flags (workerCompletionPending /
    // metaInterruptDefaultContinue), avoiding a conflict between residual state from the prior
    // active/interrupt exit and this stop decision.
    o.workerCompletionPending = false;
    o.metaInterruptDefaultContinue = false;
    o.metaStopNoRestart = !restartAfter;
    o.workerCompletionReminderSeq = 0;
    return { ok: true, errorKind: null, errorMessage: null, sessionId: handle.id, stopDispatched: true, noop: false };
  }

  async triggerReviewer(opts: {
    phase: ReviewerPhase;
    round: number;
    subject: string;
    additionalDirs?: ReadonlyArray<string>;
  }): Promise<TriggerReviewerOutcome> {
    const { paths, bus, runtime, verdictBuffer } = this.#deps;
    const stage = await currentStage(paths);
    const sessionId = generateSessionId();

    // Reviewer ENDED uses an idempotent compare-and-append (dedup by session_id), exactly one
    // physical ENDED together with cleanupAndExit's host_shutdown fallback. Clear the active handle
    // only after it is durable (scanOk) (owner semantics):
    //  - scanOk=true → clear the handle (cleanup sees null and skips, no double write);
    //  - scanOk=false (events scan corrupt / IO failure, conservatively not written) → keep the
    //    handle so cleanupAndExit can retry the idempotent ENDED + surface. Reviewers have no
    //    recovery-synthesized fallback (recovery only synthesizes worker ENDED) and cannot rely on a
    //    restart to recover like workers, so scanOk=false must keep the owner context — clearing the
    //    handle then silently dropping the ENDED would reopen the invariant gap.
    // On the startSession-failure branch the handle is not yet set (clearing is a no-op): that path
    // has no live session, scanOk=false only surfaces.
    const commitReviewerEnded = async (exitReason: string): Promise<void> => {
      const ended = await appendReviewerEndedIdempotent(paths, { stage, sessionId, exitReason });
      if (ended.scanOk) {
        this.#deps.setActiveReviewerHandle(null);
      } else {
        await enqueueHostEvent(
          bus,
          HostEventKind.reviewerSessionFailed,
          `reviewer ENDED idempotent append scan failed (session ${sessionId}); active handle retained for cleanup backfill`,
          { reviewerSessionId: sessionId, reviewerPhase: opts.phase, reviewerRound: opts.round, endedScanFailed: true },
        ).catch(() => {});
      }
    };

    // 1. assemble + persist systemPrompt / firstMessage
    const systemPrompt = await prompts.reviewerSystem({});
    const firstMessage = await prompts.reviewerFirst({
      paths,
      phase: opts.phase,
      round: opts.round,
      subject: opts.subject,
      ...(opts.additionalDirs !== undefined ? { additionalDirs: opts.additionalDirs } : {}),
    });
    await writeSystemPrompt(paths, sessionId, systemPrompt);
    await writeFirstMessage(paths, sessionId, firstMessage);

    // 2. STARTED before startSession
    await appendSessionStarted(paths, stage, { role: "reviewer", sessionId, reason: `${opts.phase} round ${opts.round}` });

    // 3. startSession — on failure backfill the paired ENDED (host_internal_error); STARTED is already written
    const cfg = this.#deps.reviewerSessionConfig;
    let handle: SessionHandle;
    try {
      handle = await this.#sdkRetry("reviewer startSession", () =>
        runtime.startSession({
          role: "reviewer",
          sessionId,
          cwd: cfg.cwd,
          model: cfg.model,
          ...(cfg.thinking !== undefined ? { thinking: cfg.thinking } : {}),
          systemPromptPath: paths.agentPromptPath(sessionId),
          firstMessagePath: paths.agentFirstMsgPath(sessionId),
          toolNames: cfg.toolNames,
          streamPath: paths.reviewerStreamPath(opts.phase, opts.round),
          isolation: cfg.isolation,
          metadata: { lifecycleHint: "short" },
        }),
      );
    } catch (err) {
      await commitReviewerEnded("host_internal_error");
      return {
        ok: false,
        errorKind: "host_internal",
        errorMessage: `reviewer startSession failed: ${(err as Error).message}`,
        sessionId: null,
        verdictEnqueued: false,
        envelopeKind: null,
      };
    }

    this.#deps.setActiveReviewerHandle(handle);
    // 4. inject the first message → wait for the reviewer turn to end (event-driven) → closeSession.
    // Clearing the active handle is not in finally: only clear when the reviewer is definitely
    // physically closed (!closeFailed); on a real close failure → keep the handle so cleanupAndExit
    // can forceAbort, not letting a "closed" illusion miss a still-running reviewer.
    const drive = await this.#driveReviewerToEnd(handle, sessionId, paths);
    if (drive.closeFailed) {
      // Reviewer physical close failed (forceAbort also failed) → the reviewer may still be running.
      // surface + do not clear the active handle (left for cleanupAndExit to forceAbort + write the
      // host_shutdown ENDED to close the pairing) + do not write a "closed" ENDED (the STARTED's
      // paired ENDED is backfilled by cleanup, avoiding a false "closed" mark here).
      // Record host_event enqueue success/failure — on enqueue failure the caller's pull can't get
      // the envelope, so return envelopeKind=null (rather than falsely claiming "host_event") so the
      // upper tool result reflects reality.
      const hostEventEnqueued = await enqueueHostEvent(bus, HostEventKind.reviewerSessionFailed, drive.failure ?? `reviewer session ${sessionId} close failed (may still be running)`, {
        reviewerSessionId: sessionId,
        reviewerPhase: opts.phase,
        reviewerRound: opts.round,
        closeFailed: true,
      }).then(() => true, () => false);
      verdictBuffer.take(sessionId); // discard any late verdict
      return {
        ok: true,
        errorKind: null,
        errorMessage: null,
        sessionId,
        verdictEnqueued: false,
        envelopeKind: hostEventEnqueued ? "host_event" : null,
      };
    }
    // 5. reviewer session-timeout watchdog: if reviewerSessionMs elapses without ending →
    //    closeSession(forceAbort) was already done inside drive; here emit watchdog_triggered +
    //    host_event, producing no reviewer_verdict.
    // An enqueue / watchdog_triggered append failure does not block the reviewer ENDED — STARTED
    // must pair with an ENDED. Each enqueue's catch surfaces independently;
    // appendReviewerEndedIdempotent always runs (clear the active handle only after the ENDED is durable).
    if (drive.timedOut) {
      verdictBuffer.take(sessionId); // discard any late verdict (not enqueued)
      await eventsIO
        .append(paths, {
          type: "watchdog_triggered",
          stage,
          details: {
            watchdogKind: WatchdogKind.reviewerSessionTimeout,
            subject: `reviewer:${sessionId}`,
            reviewerPhase: opts.phase,
            reviewerRound: opts.round,
          },
        })
        .catch(() => {});
      const hostEventEnqueued = await enqueueHostEvent(
        bus,
        WatchdogKind.reviewerSessionTimeout,
        `reviewer session ${sessionId} (phase=${opts.phase} round=${opts.round}) exceeded ${this.#thresholds.reviewerSessionMs}ms without ending; closed by watchdog.`,
        { reviewerSessionId: sessionId, reviewerPhase: opts.phase, reviewerRound: opts.round },
      ).then(() => true, (err) => {
        console.warn(`[agent_control] reviewer timeout host_event enqueue failed: ${(err as Error).message}`);
        return false;
      });
      await commitReviewerEnded("watchdog_reviewer_session_timeout");
      return {
        ok: true,
        errorKind: null,
        errorMessage: null,
        sessionId,
        verdictEnqueued: false,
        // enqueue failure → envelopeKind=null (the caller's pull can't get this host_event).
        envelopeKind: hostEventEnqueued ? "host_event" : null,
      };
    }

    // 6. take the verdict + enqueue the envelope
    const record = verdictBuffer.take(sessionId);
    if (drive.failure !== null) {
      // Runtime failure (soft kill / wrapper failure) → host_event. An enqueue failure surfaces
      // independently and does not block the ENDED.
      const hostEventEnqueued = await enqueueHostEvent(bus, HostEventKind.reviewerSessionFailed, drive.failure, {
        reviewerSessionId: sessionId,
        reviewerPhase: opts.phase,
        reviewerRound: opts.round,
      }).then(() => true, (err) => {
        console.warn(`[agent_control] reviewer failure host_event enqueue failed: ${(err as Error).message}`);
        return false;
      });
      await commitReviewerEnded("reviewer_session_failed");
      return {
        ok: true,
        errorKind: null,
        errorMessage: null,
        sessionId,
        verdictEnqueued: false,
        // enqueue failure → envelopeKind=null (the caller's pull can't get this host_event).
        envelopeKind: hostEventEnqueued ? "host_event" : null,
      };
    }

    // Normal exit: with a verdict → reviewer_verdict; without → a verdict_missing fallback envelope
    // (still reviewer_verdict kind). A verdict enqueue failure surfaces independently and does not
    // block the ENDED — STARTED must pair with an ENDED; verdictEnqueued reports the actual result.
    let verdictEnqueued = true;
    // On verdict enqueue failure, fall back to a host_event; envelopeKind must report the fallback's
    // actual enqueue success/failure (consistent with the closeFailed / timedOut / drive.failure
    // branches above) — if the fallback also fails the caller's pull gets no envelope, so return
    // envelopeKind=null (rather than falsely claiming "host_event").
    let fallbackHostEventEnqueued = false;
    try {
      await this.#enqueueVerdict(sessionId, opts.phase, opts.round, record);
    } catch (err) {
      verdictEnqueued = false;
      fallbackHostEventEnqueued = await enqueueHostEvent(bus, HostEventKind.reviewerSessionFailed, `reviewer verdict enqueue failed: ${(err as Error).message}`, {
        reviewerSessionId: sessionId,
        reviewerPhase: opts.phase,
        reviewerRound: opts.round,
        verdictEnqueueFailed: true,
      }).then(() => true, (e) => {
        console.warn(`[agent_control] reviewer verdict enqueue-failure host_event also failed: ${(e as Error).message}`);
        return false;
      });
    }
    await commitReviewerEnded("natural_completion");
    return {
      ok: true,
      errorKind: null,
      errorMessage: null,
      sessionId,
      verdictEnqueued,
      envelopeKind: verdictEnqueued ? "reviewer_verdict" : fallbackHostEventEnqueued ? "host_event" : null,
    };
  }

  /**
   * Drive the reviewer first message → wait for the turn to end (event-driven) → closeSession.
   *
   * inject is fire-and-ack: with a real adapter the reviewer turn runs asynchronously and ends only
   * after submitting the verdict. So we must subscribe and wait for `turn_ended` / `session_ended`
   * before closing — otherwise closing right after inject returns would kill the reviewer before the
   * verdict (always verdict_missing). Under a stub synchronous turn, turn_ended is already emitted
   * inside inject and the wait promise resolves immediately.
   *
   * The wait has a reviewer session-timeout: if reviewerSessionMs elapses without ending →
   * closeSession(forceAbort) + return timedOut.
   *
   * `closeFailed`: physical closeSession threw (including the timeout branch's forceAbort close) →
   * the reviewer may still be running. The caller then does not write a "closed" ENDED + does not
   * clear the active handle, leaving cleanupAndExit to forceAbort + backfill the paired ENDED.
   */
  async #driveReviewerToEnd(
    handle: SessionHandle,
    sessionId: string,
    paths: TaskCapsulePaths,
  ): Promise<{ failure: string | null; timedOut: boolean; closeFailed: boolean }> {
    let failure: string | null = null;
    let turnDone = false;
    let onSettle: (() => void) | null = null;
    // permanent runtime_error → record failure and immediately wake the await (not relying on the
    // implicit "after fatal there is always a session_ended" contract, otherwise failure could be
    // swallowed by the timeout and misreported as timeout). turn_ended/session_ended → turn ended.
    const unsub = this.#deps.runtime.subscribe(handle, (e: SessionEvent) => {
      if (e.kind === "runtime_error" && e.error.kind !== "transient") {
        failure = e.error.message;
        turnDone = true;
        onSettle?.();
      } else if (e.kind === "turn_ended" || e.kind === "session_ended") {
        turnDone = true;
        onSettle?.();
      }
    });

    // inject + wait-for-turn-end are placed in the same reviewer session-timeout race (so a stuck
    // inject also triggers the timeout, rather than awaiting inject first then starting the timer,
    // which would let inject never time out). startedAt is taken before inject so inject's time counts.
    const startedAt = this.#now();
    let injectRejected = false;
    const injectAndWait = async (): Promise<void> => {
      const ack = await this.#sdkRetry("reviewer first inject", () => this.#deps.runtime.inject(handle, firstMessageInject(paths, sessionId)));
      if (!isInjectDelivered(ack)) {
        // ack=rejected_busy (reviewer is a short session but still fire-and-ack): close out as a
        // failure immediately, not waiting uselessly until the timeout.
        injectRejected = true;
        return;
      }
      if (turnDone) return; // stub synchronous turn: turn_ended already emitted inside inject
      await new Promise<void>((resolve) => {
        onSettle = resolve;
      });
    };

    let timedOut: boolean;
    try {
      timedOut = await this.#raceWithReviewerTimeout(injectAndWait, startedAt);
    } catch (err) {
      // inject threw → close out (natural end close) then return as a runtime failure. Resolve the
      // inner wait promise before nulling it, avoiding a closure-frame leak from a
      // `new Promise(resolve=>onSettle=resolve)` that never resolves.
      unsub();
      (onSettle as (() => void) | null)?.();
      onSettle = null;
      let closeFailed = false;
      await this.#deps.runtime
        .closeSession(handle, { reason: "session_natural_end" })
        .catch(() => {
          closeFailed = true; // physical close failed → the reviewer may still be running
        });
      return { failure: `reviewer session run failed: ${(err as Error).message}`, timedOut: false, closeFailed };
    }
    unsub();
    // As above: on the timeout / inject-reject path the inner await promise may still be pending
    // (onSettle was assigned but the turn didn't end); resolve then null to release the closure frame.
    (onSettle as (() => void) | null)?.();
    onSettle = null;

    if (injectRejected) {
      let closeFailed = false;
      await this.#deps.runtime.closeSession(handle, { reason: "session_natural_end" }).catch(() => {
        closeFailed = true;
      });
      return { failure: "reviewer first message inject rejected (session busy)", timedOut: false, closeFailed };
    }
    if (timedOut) {
      // Timeout (including a stuck inject) → forceAbort close. On a real close failure → the reviewer
      // may still be running → closeFailed=true (caller does not write a "closed" ENDED / does not
      // clear the handle, leaving cleanup as the fallback).
      let closeFailed = false;
      await this.#deps.runtime.closeSession(handle, { forceAbort: true, reason: "host_close" }).catch(() => {
        closeFailed = true;
      });
      return { failure: null, timedOut: true, closeFailed };
    }
    try {
      await this.#deps.runtime.closeSession(handle, { reason: "session_natural_end" });
    } catch (err) {
      // Natural close failed → the reviewer may still be running: mark closeFailed, caller keeps the handle for cleanup.
      return { failure: `reviewer session close failed: ${(err as Error).message}`, timedOut: false, closeFailed: true };
    }
    return { failure, timedOut: false, closeFailed: false };
  }

  /**
   * Race `work` (inject + wait for turn end) vs the reviewer session-timeout timer. Returns true on
   * timeout. If work throws → rethrow (caller handles it as an inject exception). Timing polls
   * periodically on the injected clock (a fake clock can be advanced to trigger the timeout).
   */
  async #raceWithReviewerTimeout(work: () => Promise<void>, startedAt: number): Promise<boolean> {
    const limitMs = this.#thresholds.reviewerSessionMs;
    let workDone = false;
    let workErr: unknown = undefined;
    const workPromise = work().then(
      () => {
        workDone = true;
      },
      (e) => {
        workDone = true;
        workErr = e;
      },
    );
    const timedOut = await new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (to: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearInterval(timer);
        resolve(to);
      };
      void workPromise.then(() => finish(false));
      timer = setInterval(() => {
        if (workDone) return finish(false);
        if (this.#now() - startedAt >= limitMs) return finish(true);
      }, this.#thresholds.watchdogTickMs);
      timer.unref?.();
    });
    if (!timedOut && workErr !== undefined) throw workErr;
    return timedOut;
  }

  async #enqueueVerdict(
    sessionId: string,
    phase: ReviewerPhase,
    round: number,
    record: ReviewerVerdictRecord | undefined,
  ): Promise<EnvelopeId> {
    const verdict: ReviewerVerdictValue = record?.verdict ?? null;
    const issues = record?.issues ?? [];
    const body =
      record === undefined
        ? `[verdict_missing] reviewer session ${sessionId} (phase=${phase} round=${round}) ended without submitting a verdict.`
        : `Reviewer verdict (phase=${phase} round=${round}): ${verdict ?? "null"}. ${issues.length} issue(s).`;
    return this.#deps.bus.enqueue({
      channel: "meta",
      kind: "reviewer_verdict",
      from: "host",
      body,
      extras: {
        reviewerPhase: phase,
        reviewerRound: round,
        verdict,
        issues: issues as ReadonlyArray<Readonly<Record<string, unknown>>>,
      },
    });
  }
}

async function currentStage(paths: TaskCapsulePaths): Promise<Stage> {
  try {
    return (await manifestIO.load(paths)).stage;
  } catch {
    return "running"; // fail-soft: the events.jsonl stage is only an audit field
  }
}

export function createHostAgentControl(deps: HostAgentControlDeps): HostAgentControl {
  return new HostAgentControlImpl(deps);
}
