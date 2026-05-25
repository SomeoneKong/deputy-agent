/**
 * Startup recovery sequence.
 *
 * Order:
 *  1. host.pid.lock (handled by main_loop; this module assumes it is already held)
 *  2. load manifest (read failure → throw ManifestReadFatal, caller exit code 2)
 *  3. terminal-stage check (caller dispatch decides exit)
 *  4. events.jsonl corruption detection: truncate a partial last line; quarantine a corrupt middle
 *     line + new empty events + eventsJsonlCorrupted=true
 *  5. messaging recoverAfterCrash
 *  6. agent_prompts orphan cleanup (skipped here — prompts do not reuse sessionId so no cleanup;
 *     interface slot retained)
 *  7. half-completed scenario repair (worker_crash_on_host_restart / synthesized degraded
 *     worker_session_end)
 *  8. start sessions by stage (handled by main_loop; this module returns the plan)
 *  9. append host_started + host_recovery
 *
 * fail-soft: on any step failure, append host_recovery_failed + best-effort host_event, without
 * blocking startup.
 */
import { readFile } from "node:fs/promises";

import {
  compareOrderKey,
  createMessagingBus,
  envelopeOrderKey,
  recoverAfterCrash,
  type EnvelopeState,
  type MessagingBus,
} from "../messaging/index.js";
import { manifestIO, type Manifest } from "../shared/manifest.js";
import type { EnvelopeId } from "../shared/ids.js";
import { jsonlIO } from "../shared/jsonl.js";
import { withLock } from "../shared/locks.js";
import type { TaskCapsulePaths } from "../shared/paths.js";
import type { Iso8601Us } from "../shared/timeUtils.js";
import { CorruptJsonlError, ManifestSchemaMismatch, ManifestYamlParseError } from "../shared/errors.js";
import { eventsIO } from "./events.js";
import { HostEventKind, HostOrchestrationErrorKind } from "./errorKinds.js";
import { isTerminal } from "./stage_machine.js";
import { isActiveExit, type WorkerExitReason } from "./agent_sessions.js";

/** Fatal manifest read / parse / schema error → host exit code 2. */
export class ManifestReadFatal extends Error {
  readonly exitCode = 2;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ManifestReadFatal";
  }
}

/**
 * Recovered active-exit worker_session_end context: returned by repairHalfCompletedWorker, used by
 * daemon to restore the in-memory WorkerCompletionPending + backfill workerSessionId/Seq (for
 * firstStart gating + the next worker's prevSessionId + workerSessionSeqResolver).
 *
 * Two sources (the "not yet handled by Meta dispatch" criterion):
 *  - **synthesized**: a worker active-exit signal is in the inbox but has no corresponding
 *    worker_session_end → this recovery synthesizes the envelope.
 *  - **durable but Meta has not finished dispatch arbitration**: the worker_session_end was
 *    previously enqueued successfully, but the host restarted before Meta called
 *    start_worker/stop_worker/advance/send_to_worker → events.jsonl has no later worker STARTED (no
 *    restart-continuation trace) + stage is still running → treated as "not handled by Meta
 *    dispatch", restore the WCP continuation, preventing reconcileWorker from mistaking
 *    workerSessionId=null as firstStart and auto-starting a new worker that bypasses Meta
 *    arbitration. read=false is not a necessary condition (read=true only means wake markRead
 *    succeeded, not that Meta has arbitrated).
 *
 * Only active-exit kinds (natural / declare / watchdog) are returned (passive crash / meta_interrupt
 * / meta_stop do not enter WCP, consistent with finalizeWorker).
 */
export interface SynthesizedWorkerEnd {
  readonly endEnvId: EnvelopeId;
  readonly workerSessionId: string;
  readonly sessionSeq: number;
  readonly exitReason: WorkerExitReason;
}

/**
 * Crash recovery context: events.jsonl shows a worker STARTED with no paired ENDED (the host
 * crashed while the worker was running). Recovery has already backfilled the paired ENDED + enqueued
 * worker_session_end(sdk_crash) + host_event(worker_crash_on_host_restart); daemon uses this to
 * backfill workerSessionId/Seq + enter sessionEndPending (awaiting Meta), so reconcileWorker does
 * not treat workerSessionId=null as firstStart and self-restart (the host does not self-restart on
 * abnormal exits) and does not hot-loop. Passive abnormal exits do not enter WCP / have no reminder
 * (consistent with finalizeWorker's crash path).
 *
 * `waitState` distinguishes the waiting state restored from the real exitReason —
 * `sessionEndPending` (crash: sdk/subprocess) / `metaInterruptDefaultContinue` (meta_interrupt) /
 * `metaStopNoRestart` (meta_stop). These non-crash waitStates are used only when events already has
 * a durable worker_session_end (any exitReason) but the STARTED has no paired ENDED (the host
 * crashed between enqueue end and appendSessionEnded), without re-synthesizing worker_session_end
 * (only backfilling the paired ENDED); a pure crash (no durable end at all) still uses
 * sessionEndPending + synthesizes an sdk_crash end.
 */
export type CrashPendingWaitState = "sessionEndPending" | "metaInterruptDefaultContinue" | "metaStopNoRestart";

export interface CrashPendingWorker {
  readonly workerSessionId: string;
  readonly sessionSeq: number;
  readonly exitReason: WorkerExitReason;
  readonly waitState: CrashPendingWaitState;
}

export interface RecoveryResult {
  readonly manifest: Manifest;
  readonly bus: MessagingBus;
  /** events.jsonl had a corrupt middle line and was quarantined (affects WCP rebuild + conservative crash-detection degrade). */
  readonly eventsJsonlCorrupted: boolean;
  /** Whether this startup is fresh or recovery. */
  readonly mode: "fresh" | "recovery";
  /** Quarantined file paths (events / messaging state). */
  readonly quarantined: ReadonlyArray<string>;
  /** terminal / paused: start no sessions, dispatch directly. */
  readonly terminal: boolean;
  /** Synthesized / durable-but-unarbitrated active-exit worker_session_end; daemon uses it to restore WCP pending. Null if none. */
  readonly synthesizedWorkerEnd: SynthesizedWorkerEnd | null;
  /** Crash (worker STARTED with no ENDED) recovery context; daemon backfills last worker + enters sessionEndPending. Null if none. */
  readonly crashPending: CrashPendingWorker | null;
}

/** Whether events.jsonl has ever been written (has content) — used to decide fresh vs recovery. */
async function eventsHasContent(paths: TaskCapsulePaths): Promise<boolean> {
  const summaries = await eventsIO.readRecentSummaries(paths, 1);
  return summaries.length > 0;
}

/**
 * step 4: events.jsonl corruption detection (holds events.jsonl.lock — truncatePartialTail requires
 * the caller to hold the lock, and the quarantine rename must be serialized against a possibly
 * concurrent CLI append). Returns { corrupted, quarantinePath }.
 * Partial last line → truncate (not counted as corrupted); corrupt middle line → quarantine + set
 * corrupted=true.
 */
async function detectEventsCorruption(
  paths: TaskCapsulePaths,
): Promise<{ corrupted: boolean; quarantinePath: string | null }> {
  return withLock(paths.eventsLock, async () => {
    // First truncate a partial last line (so a partial line doesn't solidify into a corrupt middle line)
    try {
      await eventsIO.truncatePartialTail(paths);
    } catch {
      // truncate failure is fail-soft
    }
    // fold to detect a corrupt middle line (a corrupt middle line in readLines throws CorruptJsonlError)
    const corrupt = await foldDetectsCorruption(paths);
    if (!corrupt) return { corrupted: false, quarantinePath: null };
    try {
      const dest = await eventsIO.quarantine(paths);
      return { corrupted: true, quarantinePath: dest };
    } catch {
      // quarantine failure: events_jsonl_quarantine_failed (stderr), still mark corrupted
      console.error(`[recovery] events.jsonl quarantine failed (${HostOrchestrationErrorKind.eventsJsonlQuarantineFailed})`);
      return { corrupted: true, quarantinePath: null };
    }
  });
}

async function foldDetectsCorruption(paths: TaskCapsulePaths): Promise<boolean> {
  try {
    for await (const _ of jsonlIO.readLines(paths.eventsPath)) {
      void _;
    }
    return false;
  } catch (err) {
    return err instanceof CorruptJsonlError;
  }
}

/**
 * Startup recovery main flow (physical execution of steps 2-9; step 1 host.pid.lock + step 8
 * session startup belong to main_loop).
 */
export async function runStartupRecovery(paths: TaskCapsulePaths): Promise<RecoveryResult> {
  // step 2: load manifest (fatal → exit code 2)
  let manifest: Manifest;
  try {
    manifest = await manifestIO.load(paths);
  } catch (err) {
    if (err instanceof ManifestYamlParseError || err instanceof ManifestSchemaMismatch) {
      throw new ManifestReadFatal(`manifest unreadable: ${err.message}`, { cause: err });
    }
    throw new ManifestReadFatal(`manifest load failed: ${(err as Error).message}`, { cause: err });
  }

  const quarantined: string[] = [];
  const terminal = isTerminal(manifest.stage) || manifest.stage === "paused";
  const bus = createMessagingBus(paths);

  // step 4: events.jsonl corruption detection (before any append / messaging recovery / mode
  // decision, ensuring later appends land on a clean file, and that corrupted events count as
  // recovery evidence — otherwise readRecentSummaries' fail-soft empty return would misjudge fresh)
  const { corrupted: eventsJsonlCorrupted, quarantinePath } = await detectEventsCorruption(paths);
  if (quarantinePath !== null) quarantined.push(quarantinePath);

  // fresh: the host enters the task for the first time (stage still initial submitted and
  // events.jsonl has neither content nor corruption); otherwise recovery. Decided jointly by three
  // signals (stage / has content / was corrupted) — any corruption counts as non-fresh (fail-safe
  // biased to recovery, preserving host_recovery audit).
  const hadEventsBefore = await eventsHasContent(paths);
  const mode: "fresh" | "recovery" =
    manifest.stage === "submitted" && !hadEventsBefore && !eventsJsonlCorrupted ? "fresh" : "recovery";

  // terminal: do no session-startup recovery; still append host_started (mode reflects reality)
  if (terminal) {
    await safeAppend(paths, {
      type: "host_started",
      stage: manifest.stage,
      details: { pid: process.pid, mode },
    });
    return { manifest, bus, eventsJsonlCorrupted, mode, quarantined, terminal: true, synthesizedWorkerEnd: null, crashPending: null };
  }

  // step 5: messaging recovery
  let messagingRecoverFailed = false;
  try {
    const report = await recoverAfterCrash(paths);
    if (report.stateQuarantined && report.quarantinePath !== null) quarantined.push(report.quarantinePath);
  } catch (err) {
    messagingRecoverFailed = true;
    // (a) append host_recovery_failed to events.jsonl; (b) best-effort Meta host_event (enqueue may also fail → fail-soft)
    await safeAppend(paths, {
      type: "host_recovery_failed",
      stage: manifest.stage,
      details: {
        step: "messaging_recover",
        errorKind: HostOrchestrationErrorKind.hostRecoveryFailed,
        message: (err as Error).message,
      },
    });
    await safeEnqueueHostEvent(bus, HostOrchestrationErrorKind.hostRecoveryFailed, {
      step: "messaging_recover",
      message: (err as Error).message,
    });
  }

  // step 4 follow-up: if events was corrupted → emit host_event(events_jsonl_corrupted) (an
  // independent signal, not swallowed by a messaging-recover failure; safeEnqueueHostEvent is
  // itself fail-soft on enqueue failure)
  if (eventsJsonlCorrupted) {
    await safeEnqueueHostEvent(bus, HostEventKind.eventsJsonlCorrupted, {
      quarantinePath: quarantinePath ?? "",
    });
  }

  // step 7: half-completed scenario repair. Uniformly fail-soft (bus.fold may throw under rare IO
  // races → does not block startup).
  let synthesizedWorkerEnd: SynthesizedWorkerEnd | null = null;
  let crashPending: CrashPendingWorker | null = null;
  try {
    const repair = await repairHalfCompletedWorker(paths, bus, manifest, eventsJsonlCorrupted);
    synthesizedWorkerEnd = repair.synthesizedWorkerEnd;
    crashPending = repair.crashPending;
  } catch (err) {
    console.error(`[recovery] repairHalfCompletedWorker failed (fail-soft, startup continues): ${(err as Error).message}`);
  }

  // step 9: append host_started(recovery) + host_recovery (fresh only host_started(fresh))
  if (mode === "fresh") {
    await safeAppend(paths, { type: "host_started", stage: manifest.stage, details: { pid: process.pid, mode: "fresh" } });
  } else {
    await safeAppend(paths, { type: "host_started", stage: manifest.stage, details: { pid: process.pid, mode: "recovery" } });
    const summary =
      `recovery: stage=${manifest.stage}` +
      (eventsJsonlCorrupted ? " events_jsonl_quarantined" : "") +
      (messagingRecoverFailed ? " messaging_recover_failed" : "");
    await safeAppend(paths, {
      type: "host_recovery",
      stage: manifest.stage,
      details: { summary, quarantined: [...quarantined] },
    });
  }

  return { manifest, bus, eventsJsonlCorrupted, mode, quarantined, terminal: false, synthesizedWorkerEnd, crashPending };
}

interface SignalCandidate {
  readonly envId: EnvelopeId;
  readonly key: readonly [Iso8601Us, number];
  readonly exitReason: WorkerExitReason;
  readonly workerSessionId: string;
  readonly sessionSeq: number;
}

/**
 * Half-completed scenario repair.
 * Only probed when stage=running (other in-progress stages have no worker).
 *
 * A single fold (for performance + consistency) collects:
 *  - the latest worker active-exit signal (worker_completion_claim or
 *    worker_escalation(exitIntent="declare_deferred"), reading the escalation payload to filter
 *    exitIntent; a continue escalation is not an exit signal)
 *  - the latest worker_session_end's sessionSeq (to match per session rather than by global
 *    existence, avoiding being masked by an older session's end)
 *
 * Synthesized case (messaging is reliable, independent of events corruption): the latest active-exit
 *   signal's sessionSeq > the latest worker_session_end sessionSeq (or no end) → synthesize a
 *   degraded worker_session_end + host_event.
 * Crash case: when there is no newer active-exit signal and events is reliable → probe for an
 *   unmatched worker by pairing events STARTED/ENDED sessionSeq; if events is unreliable
 *   (eventsJsonlCorrupted) → degrade to "no active-exit signal means emit worker_crash
 *   (evidenceDegraded)" (not masked by any historical worker_session_end).
 */
interface RepairResult {
  readonly synthesizedWorkerEnd: SynthesizedWorkerEnd | null;
  readonly crashPending: CrashPendingWorker | null;
}

const NO_REPAIR: RepairResult = { synthesizedWorkerEnd: null, crashPending: null };

async function repairHalfCompletedWorker(
  paths: TaskCapsulePaths,
  bus: MessagingBus,
  manifest: Manifest,
  eventsJsonlCorrupted: boolean,
): Promise<RepairResult> {
  if (manifest.stage !== "running") return NO_REPAIR;

  const snap = await bus.fold();
  // The latest active-exit signal (claim counts directly; escalation requires reading the payload to filter declare_deferred)
  const latestSignal = await findLatestActiveSignal(paths, snap);
  // Full context of the latest worker_session_end (envId / seq / read / exitReason / workerSessionId)
  const latestEnd = await findLatestSessionEnd(paths, snap);
  const latestEndSeq = latestEnd?.sessionSeq ?? null;
  // The max worker STARTED sessionSeq in events.jsonl (probe whether there is a later worker start after that end = a restart trace)
  const latestStartedSeq = await foldMaxWorkerStartedSeq(paths);

  // Synthesized case (messaging reliable, unaffected by events corruption): the latest active-exit
  // signal's session has no corresponding worker_session_end → synthesize. If synthesis succeeds and
  // it is an active-exit kind (claim=declare_done / escalation=declare_deferred always hold) → return
  // it for daemon to restore WCP pending; on enqueue failure → null (do not restore WCP, but still
  // emit the worker_crash host_event so Meta knows).
  if (latestSignal !== null && (latestEndSeq === null || latestSignal.sessionSeq > latestEndSeq)) {
    let endEnvId: EnvelopeId | null = null;
    try {
      endEnvId = await bus.enqueue({
        channel: "meta",
        kind: "worker_session_end",
        from: "host",
        body: `[synthesized on host restart] worker session ended without explicit worker_session_end; reconstructed from latest worker signal.`,
        extras: {
          workerSessionId: latestSignal.workerSessionId,
          sessionSeq: latestSignal.sessionSeq,
          exitReason: latestSignal.exitReason,
          doneCriteriaOutcome: null,
        },
      });
    } catch {
      // fail-soft
    }
    await safeEnqueueHostEvent(bus, HostEventKind.workerCrashOnHostRestart, { reconstructed: true });
    // After synthesizing worker_session_end, backfill the paired ENDED — otherwise the original
    // worker STARTED has no ENDED and findUnmatchedWorkerStarted repeatedly misreports
    // worker_crash_on_host_restart on the next startup. Backfill when events is uncorrupted and this
    // sessionSeq has no ENDED yet (using the synthesized exitReason). Skipped when events is corrupted
    // (cannot reliably probe an existing ENDED, avoiding a duplicate write).
    if (!eventsJsonlCorrupted) {
      await maybeAppendPairedWorkerEnded(paths, latestSignal.workerSessionId, latestSignal.sessionSeq, latestSignal.exitReason);
    }
    if (endEnvId !== null && isActiveExit(latestSignal.exitReason)) {
      return {
        synthesizedWorkerEnd: {
          endEnvId,
          workerSessionId: latestSignal.workerSessionId,
          sessionSeq: latestSignal.sessionSeq,
          exitReason: latestSignal.exitReason,
        },
        crashPending: null,
      };
    }
    return NO_REPAIR;
  }

  // Durable worker_session_end that Meta has not finished arbitrating — the host restarted after
  // worker_session_end was successfully enqueued but before Meta called
  // start_worker/stop_worker/advance/send_to_worker.
  // read=false is not a necessary condition: read=true only means host wake markRead succeeded (Meta
  // received the wake inject), not that Meta finished dispatch arbitration — a host restart after
  // markRead but before Meta called any dispatch tool also needs the waiting state restored,
  // otherwise for an active-exit, synthesizedWorkerEnd=null → reconcileWorker firstStart auto-starts
  // a worker that bypasses Meta arbitration.
  // The observable criterion for "Meta has not finished arbitrating": stage is still running
  // (guarded at this function's entry) AND events.jsonl has no later worker STARTED with sessionSeq >
  // that end seq (Meta already starting a new worker = an arbitration trace; a stage advance leaving
  // running also makes this function return null early).
  // Extended to all exitReasons: previously only active-exit took this branch and the rest
  // (sdk_crash/subprocess_crash/meta_interrupt/meta_stop) fell into the crash synthesis below →
  // findUnmatchedWorkerStarted would re-synthesize the same worker as sdk_crash, rewriting the real
  // reason + duplicating the end. Now the waiting state is restored per the real exitReason
  // (active-exit→WCP; meta_interrupt→default-continue; meta_stop→metaStopNoRestart;
  // crash→sessionEndPending), only backfilling the paired ENDED, without re-synthesizing worker_session_end.
  if (latestEnd !== null && (latestStartedSeq === null || latestStartedSeq <= latestEnd.sessionSeq)) {
    // Backfill the paired ENDED (idempotent, zero-risk) — closes the microsecond-scale tail
    // misreport from "a crash between enqueue worker_session_end and appendSessionEnded" (otherwise
    // the original worker STARTED has no ENDED and the next startup re-processes it as a crash).
    // Skipped when events is corrupted (cannot reliably probe an existing ENDED, avoiding a duplicate
    // write). Uses the real exitReason.
    if (!eventsJsonlCorrupted) {
      await maybeAppendPairedWorkerEnded(paths, latestEnd.workerSessionId, latestEnd.sessionSeq, latestEnd.exitReason);
    }
    if (isActiveExit(latestEnd.exitReason)) {
      // active-exit (natural / declare / watchdog) → WCP continuation + backfill last worker sessionId/seq.
      return {
        synthesizedWorkerEnd: {
          endEnvId: latestEnd.envId,
          workerSessionId: latestEnd.workerSessionId,
          sessionSeq: latestEnd.sessionSeq,
          exitReason: latestEnd.exitReason,
        },
        crashPending: null,
      };
    }
    // Non-active-exit durable end (crash / meta_interrupt / meta_stop) → restore the waiting state per the real exitReason (no re-synthesized end).
    return {
      synthesizedWorkerEnd: null,
      crashPending: {
        workerSessionId: latestEnd.workerSessionId,
        sessionSeq: latestEnd.sessionSeq,
        exitReason: latestEnd.exitReason,
        waitState: waitStateForExitReason(latestEnd.exitReason),
      },
    };
  }

  // Crash case: no newer active-exit signal
  if (eventsJsonlCorrupted) {
    // events-unreliable degrade: no active-exit signal means emit worker_crash (evidenceDegraded),
    // not masked by historical worker_session_end. When events is corrupted, the unmatched STARTED's
    // sessionId/seq cannot be reliably obtained → do not backfill crashPending (Meta decides per
    // host_event; this degraded state has no active-worker evidence, so a firstStart new worker is harmless).
    if (latestSignal === null) {
      await safeEnqueueHostEvent(bus, HostEventKind.workerCrashOnHostRestart, { evidenceDegraded: true });
    }
    return NO_REPAIR;
  }
  // events reliable: probe for an unmatched worker by pairing events STARTED/ENDED sessionSeq (not
  // masked by any historical worker_session_end). A worker STARTED with no ENDED = the host crashed
  // while the worker was running. The host does not self-restart — must backfill crashPending so
  // daemon enters sessionEndPending to block the firstStart hot-loop, and backfill the paired ENDED +
  // enqueue worker_session_end(sdk_crash) (a post-startup abnormal exit goes through
  // worker_session_end) + host_event so Meta arbitrates continuation. exitReason is sdk_crash
  // (recovery cannot distinguish subprocess/sdk, consistent with finalizeWorker's close-throw fallback).
  const crashed = await findUnmatchedWorkerStarted(paths);
  if (crashed === null) return NO_REPAIR;

  // Before synthesizing sdk_crash, check whether this sessionSeq already has a durable
  // worker_session_end (any exitReason). The branch above only looks at the latest end (latestEnd);
  // when an older session has a durable end but a later worker STARTED followed (latestStartedSeq >
  // latestEnd.sessionSeq), it doesn't enter that branch → findUnmatchedWorkerStarted picks the
  // max-seq unmatched STARTED; if it itself already has a durable end (host crashed between enqueue
  // end and appendSessionEnded) → re-synthesizing sdk_crash would rewrite the real exit reason +
  // duplicate worker_session_end. Fix: if that seq already has a durable end → only idempotently
  // backfill the paired ENDED (real exitReason) + restore the waiting state per the real exitReason
  // (unifying with the latest-end branch as "any durable end takes priority over crash synthesis"),
  // without re-synthesizing.
  const durableEndForCrashed = await findSessionEndForSeq(paths, snap, crashed.sessionSeq);
  if (durableEndForCrashed !== null) {
    await maybeAppendPairedWorkerEnded(paths, durableEndForCrashed.workerSessionId, durableEndForCrashed.sessionSeq, durableEndForCrashed.exitReason);
    if (isActiveExit(durableEndForCrashed.exitReason)) {
      return {
        synthesizedWorkerEnd: {
          endEnvId: durableEndForCrashed.envId,
          workerSessionId: durableEndForCrashed.workerSessionId,
          sessionSeq: durableEndForCrashed.sessionSeq,
          exitReason: durableEndForCrashed.exitReason,
        },
        crashPending: null,
      };
    }
    return {
      synthesizedWorkerEnd: null,
      crashPending: {
        workerSessionId: durableEndForCrashed.workerSessionId,
        sessionSeq: durableEndForCrashed.sessionSeq,
        exitReason: durableEndForCrashed.exitReason,
        waitState: waitStateForExitReason(durableEndForCrashed.exitReason),
      },
    };
  }

  const crashExitReason: WorkerExitReason = "sdk_crash";
  await maybeAppendPairedWorkerEnded(paths, crashed.workerSessionId, crashed.sessionSeq, crashExitReason);
  let crashEndEnqueued = false;
  try {
    await bus.enqueue({
      channel: "meta",
      kind: "worker_session_end",
      from: "host",
      body: `[synthesized on host restart] worker session ${crashed.workerSessionId} (seq ${crashed.sessionSeq}) crashed with host (no paired worker_session_end); reconstructed as ${crashExitReason}.`,
      extras: {
        workerSessionId: crashed.workerSessionId,
        sessionSeq: crashed.sessionSeq,
        exitReason: crashExitReason,
        doneCriteriaOutcome: null,
      },
    });
    crashEndEnqueued = true;
  } catch {
    // fail-soft: on enqueue failure → Meta is informed only via host_event; still backfill crashPending into sessionEndPending to block firstStart.
  }
  await safeEnqueueHostEvent(bus, HostEventKind.workerCrashOnHostRestart, {
    workerSessionId: crashed.workerSessionId,
    sessionSeq: crashed.sessionSeq,
    workerSessionEndEnqueued: crashEndEnqueued,
  });
  return {
    synthesizedWorkerEnd: null,
    crashPending: { workerSessionId: crashed.workerSessionId, sessionSeq: crashed.sessionSeq, exitReason: crashExitReason, waitState: "sessionEndPending" },
  };
}

/**
 * Backfill the paired worker agent_session_ended: reuses the shared idempotent compare-and-append
 * helper (scan+append under the lock: writes only if this sessionSeq has no worker ENDED yet, skips
 * if it does; fail-soft skip on scan corruption). Shares the same physical invariant as
 * finalizeWorker / stopWorker / cleanupAndExit (exactly one worker ENDED).
 */
async function maybeAppendPairedWorkerEnded(
  paths: TaskCapsulePaths,
  workerSessionId: string,
  sessionSeq: number,
  exitReason: WorkerExitReason,
): Promise<void> {
  try {
    await eventsIO.appendWorkerEndedIdempotent(paths, { stage: "running", sessionId: workerSessionId, sessionSeq, exitReason });
  } catch (err) {
    console.error(`[recovery] paired worker ENDED idempotent append failed: ${(err as Error).message}`);
  }
}

/** Max sessionSeq of role=worker agent_session_started in events.jsonl (probe whether a later worker started after an end). Null if none. */
async function foldMaxWorkerStartedSeq(paths: TaskCapsulePaths): Promise<number | null> {
  let max: number | null = null;
  try {
    for await (const obj of jsonlIO.readLines(paths.eventsPath)) {
      const ev = obj as Record<string, unknown>;
      if (ev["type"] !== "agent_session_started") continue;
      const d = ev["details"];
      if (typeof d !== "object" || d === null) continue;
      const dd = d as Record<string, unknown>;
      if (dd["role"] !== "worker") continue;
      const seq = dd["session_seq"]; // events.jsonl details are physically snake_case
      if (typeof seq === "number" && Number.isInteger(seq) && (max === null || seq > max)) max = seq;
    }
  } catch {
    return max;
  }
  return max;
}

/** Find the latest active-exit signal (claim or declare_deferred escalation) from a single fold snapshot. */
async function findLatestActiveSignal(
  paths: TaskCapsulePaths,
  snap: ReadonlyMap<EnvelopeId, EnvelopeState>,
): Promise<SignalCandidate | null> {
  let best: SignalCandidate | null = null;
  for (const s of snap.values()) {
    if (s.failed) continue;
    if (s.kind !== "worker_completion_claim" && s.kind !== "worker_escalation") continue;
    const key = envelopeOrderKey(s);
    if (best !== null && compareOrderKey(key, best.key) <= 0) continue;
    const extras = await readSignalPayloadExtras(paths, s.envId as EnvelopeId);
    if (extras === null) continue;
    if (s.kind === "worker_escalation" && extras.exitIntent !== "declare_deferred") continue; // continue is not an exit signal
    best = {
      envId: s.envId as EnvelopeId,
      key,
      exitReason: s.kind === "worker_completion_claim" ? "declare_done" : "declare_deferred",
      workerSessionId: extras.workerSessionId,
      sessionSeq: extras.sessionSeq,
    };
  }
  return best;
}

interface SessionEndContext {
  readonly envId: EnvelopeId;
  readonly sessionSeq: number;
  readonly exitReason: WorkerExitReason;
  readonly workerSessionId: string;
}

/** Full set of worker_session_end exitReasons (payload string validation). host_internal_error/host_shutdown are not enqueued so not in this set. */
const WORKER_END_EXIT_REASONS: ReadonlySet<string> = new Set<WorkerExitReason>([
  "natural_completion",
  "declare_deferred",
  "declare_done",
  "meta_interrupt",
  "meta_stop",
  "watchdog_worker_no_progress",
  "watchdog_worker_tool_loop",
  "sdk_crash",
  "subprocess_crash",
]);

/**
 * Find the latest worker_session_end (by composite key) from a fold snapshot, returning its full
 * context (envId / seq / exitReason / workerSessionId, reading the payload). Missing payload fields /
 * read failure → null.
 */
async function findLatestSessionEnd(
  paths: TaskCapsulePaths,
  snap: ReadonlyMap<EnvelopeId, EnvelopeState>,
): Promise<SessionEndContext | null> {
  let best: EnvelopeState | null = null;
  let bestKey: readonly [Iso8601Us, number] | null = null;
  for (const s of snap.values()) {
    if (s.kind !== "worker_session_end" || s.failed) continue;
    const key = envelopeOrderKey(s);
    if (bestKey === null || compareOrderKey(key, bestKey) > 0) {
      bestKey = key;
      best = s;
    }
  }
  if (best === null) return null;
  return readSessionEndContext(paths, best.envId as EnvelopeId);
}

/**
 * Find the durable worker_session_end (any exitReason) for a given sessionSeq from a fold snapshot.
 * If multiple share the seq (rare), take the latest by composite key. None / missing payload fields /
 * read failure → null.
 */
async function findSessionEndForSeq(
  paths: TaskCapsulePaths,
  snap: ReadonlyMap<EnvelopeId, EnvelopeState>,
  sessionSeq: number,
): Promise<SessionEndContext | null> {
  let best: SessionEndContext | null = null;
  let bestKey: readonly [Iso8601Us, number] | null = null;
  for (const s of snap.values()) {
    if (s.kind !== "worker_session_end" || s.failed) continue;
    const ctx = await readSessionEndContext(paths, s.envId as EnvelopeId);
    if (ctx === null || ctx.sessionSeq !== sessionSeq) continue;
    const key = envelopeOrderKey(s);
    if (bestKey === null || compareOrderKey(key, bestKey) > 0) {
      bestKey = key;
      best = ctx;
    }
  }
  return best;
}

/** Read a single worker_session_end envelope's payload extras → SessionEndContext. Missing fields / invalid exitReason / read failure → null. */
async function readSessionEndContext(paths: TaskCapsulePaths, envId: EnvelopeId): Promise<SessionEndContext | null> {
  try {
    const raw = JSON.parse(await readFile(paths.payloadJson(envId), "utf8")) as {
      extras?: { session_seq?: unknown; exit_reason?: unknown; worker_session_id?: unknown };
    };
    const seq = raw.extras?.session_seq;
    const exitReason = raw.extras?.exit_reason;
    const wsid = raw.extras?.worker_session_id;
    if (typeof seq !== "number" || typeof exitReason !== "string" || !WORKER_END_EXIT_REASONS.has(exitReason)) return null;
    if (typeof wsid !== "string") return null;
    return { envId, sessionSeq: seq, exitReason: exitReason as WorkerExitReason, workerSessionId: wsid };
  } catch {
    return null;
  }
}

/**
 * Non-active-exit durable end → restore the corresponding daemon waiting state per the real exitReason.
 *
 * Known gap (meta_stop's restartAfter is not persisted): a worker_session_end's durable extras are
 * fixed by the messaging schema to {workerSessionId, sessionSeq, exitReason, doneCriteriaOutcome},
 * with no restartAfter. So in the rare window where the host crashes after meta_stop + restartAfter=true
 * but before Meta dispatches a new worker, recovery uniformly restores metaStopNoRestart — losing the
 * restart authorization, requiring Meta to call start_worker / send_to_worker again after restart to
 * continue (the inbox gate still applies, so it does not stall forever).
 */
function waitStateForExitReason(exitReason: WorkerExitReason): CrashPendingWaitState {
  if (exitReason === "meta_interrupt") return "metaInterruptDefaultContinue";
  if (exitReason === "meta_stop") return "metaStopNoRestart";
  return "sessionEndPending"; // sdk_crash / subprocess_crash
}

/** Read an active-signal envelope's payload extras (without pull, avoiding a mark-read side effect). Read failure → null. */
async function readSignalPayloadExtras(
  paths: TaskCapsulePaths,
  envId: EnvelopeId,
): Promise<{ workerSessionId: string; sessionSeq: number; exitIntent: string | null } | null> {
  try {
    const raw = JSON.parse(await readFile(paths.payloadJson(envId), "utf8")) as {
      extras?: { worker_session_id?: unknown; session_seq?: unknown; exit_intent?: unknown };
    };
    const wsid = raw.extras?.worker_session_id;
    const seq = raw.extras?.session_seq;
    if (typeof wsid !== "string" || typeof seq !== "number") return null;
    const exitIntent = typeof raw.extras?.exit_intent === "string" ? (raw.extras.exit_intent as string) : null;
    return { workerSessionId: wsid, sessionSeq: seq, exitIntent };
  } catch {
    return null;
  }
}

/** Crash-detection hit context: the unmatched STARTED's worker sessionId + sessionSeq. */
interface UnmatchedWorkerStarted {
  readonly workerSessionId: string;
  readonly sessionSeq: number;
}

/**
 * A role=worker STARTED in events.jsonl with no ENDED for its sessionSeq (crash detection). Returns
 * the max-seq unmatched STARTED context (sessionId + seq); null if none. daemon uses it to backfill
 * workerSessionId/Seq + enter sessionEndPending, not firstStart self-restart.
 */
async function findUnmatchedWorkerStarted(paths: TaskCapsulePaths): Promise<UnmatchedWorkerStarted | null> {
  const startedById = new Map<number, string>(); // seq → sessionId (last-wins; normally one per seq)
  const ended = new Set<number>();
  try {
    for await (const obj of jsonlIO.readLines(paths.eventsPath)) {
      const ev = obj as Record<string, unknown>;
      const t = ev["type"];
      if (t !== "agent_session_started" && t !== "agent_session_ended") continue;
      const d = ev["details"];
      if (typeof d !== "object" || d === null) continue;
      const dd = d as Record<string, unknown>;
      if (dd["role"] !== "worker") continue;
      const seq = dd["session_seq"]; // events.jsonl details are physically snake_case
      if (typeof seq !== "number") continue;
      if (t === "agent_session_started") {
        const sid = dd["session_id"];
        if (typeof sid === "string") startedById.set(seq, sid);
      } else ended.add(seq);
    }
  } catch {
    return null;
  }
  let best: UnmatchedWorkerStarted | null = null;
  for (const [seq, sid] of startedById) {
    if (ended.has(seq)) continue;
    if (best === null || seq > best.sessionSeq) best = { workerSessionId: sid, sessionSeq: seq };
  }
  return best;
}

async function safeAppend(paths: TaskCapsulePaths, ev: Parameters<typeof eventsIO.append>[1]): Promise<void> {
  try {
    await eventsIO.append(paths, ev);
  } catch (err) {
    console.error(`[recovery] events append failed: ${(err as Error).message}`);
  }
}

async function safeEnqueueHostEvent(
  bus: MessagingBus,
  eventKind: string,
  details: Readonly<Record<string, unknown>>,
): Promise<void> {
  try {
    await bus.enqueue({
      channel: "meta",
      kind: "host_event",
      from: "host",
      body: `[host_event] ${eventKind}`,
      extras: { eventKind, details },
    });
  } catch {
    // fail-soft
  }
}
