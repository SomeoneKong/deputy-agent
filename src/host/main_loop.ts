/**
 * Host main loop + wake-cursor fallback wakeup + worker-exit reminder + single-instance lock.
 *
 * This module provides independently testable core mechanisms:
 * - acquireSingleInstanceLock (non-blocking host.pid.lock + stale detection)
 * - WakeCursor (lastInjectEnvId / injectDoneUnmarked / K=3 self-amplification guard)
 * - foldUnreadForWake: unread envelopes after the cursor (ascending by (createdAt, stateSeq),
 *   filtering injectDoneUnmarked)
 * - per-Meta-turn-idle reminder (one-to-one cadence, no cap)
 *
 * The tick main loop dispatches by stage; the full daemon loop is driven by the CLI subsystem.
 */
import { readFile } from "node:fs/promises";

import type { Channel, Envelope, MessagingBus } from "../messaging/index.js";
import { atomicWriter } from "../shared/atomic.js";
import type { EnvelopeId } from "../shared/ids.js";
import { fileLock, type LockHandle } from "../shared/locks.js";
import type { Stage } from "../shared/manifest.js";
import type { TaskCapsulePaths } from "../shared/paths.js";
import { nowIso8601Us } from "../shared/timeUtils.js";
import { HostEventKind } from "./errorKinds.js";
import type { WorkerExitReason } from "./agent_sessions.js";
import { isInProgress, isTerminal } from "./stage_machine.js";

// ---- single-instance lock ----

export interface SingleInstanceResult {
  readonly acquired: boolean;
  readonly handle: LockHandle | null;
  /** When acquired=false: whether the old host is still alive. */
  readonly otherAlive: boolean;
  readonly otherPid: number | null;
}

interface HostPidMeta {
  readonly pid: number;
  readonly startedAt: string;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0: existence probe only
    return true;
  } catch (err) {
    // EPERM = exists but no permission (treat as alive); ESRCH = does not exist
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Acquire the single-instance lock. On success, overwrite host.pid. On failure, read the old pid
 * and check liveness: if alive, acquired=false otherAlive=true; if dead, the lock implementation
 * already released the stale lock, so retry once.
 */
export async function acquireSingleInstanceLock(paths: TaskCapsulePaths): Promise<SingleInstanceResult> {
  let handle = await fileLock.tryAcquireNonblocking(paths.hostPidLock);
  if (handle === null) {
    // read the old pid and check liveness
    let otherPid: number | null = null;
    try {
      const meta = JSON.parse(await readFile(paths.hostPid, "utf8")) as Partial<HostPidMeta>;
      if (typeof meta.pid === "number") otherPid = meta.pid;
    } catch {
      otherPid = null;
    }
    if (otherPid !== null && isPidAlive(otherPid)) {
      return { acquired: false, handle: null, otherAlive: true, otherPid };
    }
    // old pid is dead: the advisory lock was released by the OS when the old process exited; retry once
    handle = await fileLock.tryAcquireNonblocking(paths.hostPidLock);
    if (handle === null) {
      return { acquired: false, handle: null, otherAlive: false, otherPid };
    }
  }
  await atomicWriter.writeText(
    paths.hostPid,
    JSON.stringify({ pid: process.pid, startedAt: nowIso8601Us() } satisfies HostPidMeta),
  );
  return { acquired: true, handle, otherAlive: false, otherPid: null };
}

// ---- wake cursor ----

export const MARK_READ_FAIL_THRESHOLD_K = 3;

export class WakeCursor {
  /** Latest envId for the most recent enqueue-triggered inject (not persisted). */
  #lastInjectEnvId: EnvelopeId | null = null;
  /** Set of envIds where inject succeeded but markRead failed (prevents duplicate inject). */
  readonly #injectDoneUnmarked = new Set<EnvelopeId>();
  /** Consecutive markRead failure count (K=3 guard). */
  #markReadFailStreak = 0;
  /** envIds of failure batches already notified via wake_inject_mark_read_failed (dedup). */
  readonly #notifiedFailedEnvIds = new Set<EnvelopeId>();
  /** Switched to messaging_mark_read_degraded (pauses new host_events of this kind). */
  #degraded = false;

  /**
   * Startup init: the cursor takes the current latest read=true envelope id in the inbox
   * (fresh / all unread → null).
   *
   * Meta / Watcher restarts reuse the same WakeCursor instance (held by DaemonState; ensureMetaOnline /
   * ensureWatcherOnline re-initialize it each time a long session starts). Must also clear all
   * per-session hidden state (injectDoneUnmarked / markRead failure streak / notified / degraded) —
   * otherwise unread envelopes left by the previous session's markRead failures keep being filtered
   * by foldUnreadForWake, and the new session never receives them.
   */
  initFromLatestRead(latestReadEnvId: EnvelopeId | null): void {
    this.#lastInjectEnvId = latestReadEnvId;
    this.#injectDoneUnmarked.clear();
    this.#markReadFailStreak = 0;
    this.#notifiedFailedEnvIds.clear();
    this.#degraded = false;
  }

  get lastInjectEnvId(): EnvelopeId | null {
    return this.#lastInjectEnvId;
  }

  isInjectDoneUnmarked(envId: EnvelopeId): boolean {
    return this.#injectDoneUnmarked.has(envId);
  }

  get degraded(): boolean {
    return this.#degraded;
  }

  /** inject succeeded + markRead succeeded → advance cursor + clear failure count. */
  onInjectAndMarkSuccess(latestEnvId: EnvelopeId | null, markedEnvIds: ReadonlyArray<EnvelopeId>): void {
    if (latestEnvId !== null) this.#lastInjectEnvId = latestEnvId;
    for (const e of markedEnvIds) this.#injectDoneUnmarked.delete(e);
    this.#markReadFailStreak = 0;
    this.#degraded = false;
    this.#notifiedFailedEnvIds.clear();
  }

  /**
   * inject succeeded but markRead failed: record injectDoneUnmarked (prevents duplicate inject);
   * the cursor does not advance; count the failure streak. Returns the host_event eventKind to
   * emit (first batch wake_inject_mark_read_failed; past K switches to degraded; null if already
   * notified / degraded).
   */
  onMarkReadFailure(failedEnvIds: ReadonlyArray<EnvelopeId>): { eventKind: string | null; newEnvIds: ReadonlyArray<EnvelopeId> } {
    for (const e of failedEnvIds) this.#injectDoneUnmarked.add(e);
    this.#markReadFailStreak += 1;

    if (this.#markReadFailStreak > MARK_READ_FAIL_THRESHOLD_K) {
      if (!this.#degraded) {
        this.#degraded = true;
        return { eventKind: HostEventKind.messagingMarkReadDegraded, newEnvIds: failedEnvIds };
      }
      return { eventKind: null, newEnvIds: [] };
    }
    // Dedup within the same failure batch: only emit if there are not-yet-notified envIds
    const newEnvIds = failedEnvIds.filter((e) => !this.#notifiedFailedEnvIds.has(e));
    if (newEnvIds.length === 0) return { eventKind: null, newEnvIds: [] };
    for (const e of newEnvIds) this.#notifiedFailedEnvIds.add(e);
    return { eventKind: HostEventKind.wakeInjectMarkReadFailed, newEnvIds };
  }
}

/**
 * Fold unread envelopes after the cursor: peekUnread → filter out injectDoneUnmarked → already
 * sorted by the bus (peekUnread returns ascending). Filtering relies mainly on read state
 * (peekUnread only returns read=false).
 */
export async function foldUnreadForWake(
  bus: MessagingBus,
  channel: Channel,
  cursor: WakeCursor,
): Promise<ReadonlyArray<Envelope>> {
  const unread = await bus.peekUnread(channel);
  return unread.filter((e) => !cursor.isInjectDoneUnmarked(e.envId as EnvelopeId));
}

// ---- worker-exit reminder ----

export interface ReminderEnvelopeInput {
  readonly workerSessionId: string;
  readonly sessionSeq: number;
  readonly exitReason: WorkerExitReason;
  readonly workerSessionEndEnvId: EnvelopeId;
  readonly relatedWorkerSignalEnvId: EnvelopeId | null;
  readonly reminderSeq: number;
}

/**
 * Enqueue a worker_completion_reminder (reusing the host_event kind).
 * The first (reminderSeq=1) includes the envelope reference; the Nth is simplified. No cap
 * (permanent Meta failure is handled by the force-failed path).
 */
export async function enqueueWorkerCompletionReminder(
  bus: MessagingBus,
  input: ReminderEnvelopeInput,
): Promise<EnvelopeId> {
  const body =
    input.reminderSeq === 1
      ? `[reminder] Worker session ${input.workerSessionId} (seq ${input.sessionSeq}) exited (${input.exitReason}). ` +
        `Please decide next action (advance stage / start worker / stop / send instruction). ` +
        `See worker_session_end envelope ${input.workerSessionEndEnvId}.`
      : `[reminder #${input.reminderSeq}] Still awaiting Meta decision for worker session ${input.workerSessionId} (seq ${input.sessionSeq}). ` +
        `See worker_session_end envelope ${input.workerSessionEndEnvId}.`;
  return bus.enqueue({
    channel: "meta",
    kind: "host_event",
    from: "host",
    body,
    extras: {
      eventKind: HostEventKind.workerCompletionReminder,
      details: {
        workerSessionId: input.workerSessionId,
        sessionSeq: input.sessionSeq,
        exitReason: input.exitReason,
        workerSessionEndEnvId: input.workerSessionEndEnvId,
        relatedWorkerSignalEnvId: input.relatedWorkerSignalEnvId,
        reminderSeq: input.reminderSeq,
      },
    },
  });
}

/**
 * Enqueue a generic host_event envelope (watchdog / agent_session_start_failed / etc.).
 */
export async function enqueueHostEvent(
  bus: MessagingBus,
  eventKind: string,
  body: string,
  details: Readonly<Record<string, unknown>> = {},
): Promise<EnvelopeId> {
  return bus.enqueue({
    channel: "meta",
    kind: "host_event",
    from: "host",
    body,
    extras: { eventKind, details },
  });
}

// ---- tick model: stage-routed dispatch ----

/**
 * Describes what a tick should do. The daemon loop (in the CLI subsystem) calls `dispatchByStage`
 * per manifest state, then orchestrates concrete actions per the returned `TickAction` (start
 * Meta / Worker / Watcher, wake, exit, etc.). Dispatch never returns a self-initiated "restart
 * worker" action; worker continuation / termination always goes through Meta arbitration
 * (worker_session_end + reminder) and is not in the dispatch table.
 */
export type TickAction =
  | { readonly kind: "cleanup_and_exit"; readonly stage: Stage } // terminal / paused
  | { readonly kind: "ensure_meta_then_clarifying" } // submitted: transition to clarifying + start Meta long session
  | { readonly kind: "ensure_meta" } // clarifying / bootstrapping: keep Meta long session online
  | { readonly kind: "ensure_running_agents" } // running: keep Meta + Watcher, start Worker on conditions, dispatch worker_stream_window
  | { readonly kind: "await_user" }; // awaiting_user: conditionally online / caller decides exit by inbox read=false set

/**
 * Pure function: returns the tick intent based solely on stage. Concrete actions (session
 * start/stop / wake / exit code) are executed by the daemon orchestration layer — this function
 * touches no IO, for easy unit testing.
 */
export function dispatchByStage(stage: Stage): TickAction {
  if (isTerminal(stage) || stage === "paused") return { kind: "cleanup_and_exit", stage };
  switch (stage) {
    case "submitted":
      return { kind: "ensure_meta_then_clarifying" };
    case "clarifying":
    case "bootstrapping":
      return { kind: "ensure_meta" };
    case "running":
      return { kind: "ensure_running_agents" };
    case "awaiting_user":
      return { kind: "await_user" };
    default:
      // Unreachable (isInProgress / terminal above cover the full set); satisfies noImplicitReturns
      // and guards against future new stages
      return isInProgress(stage) ? { kind: "ensure_meta" } : { kind: "cleanup_and_exit", stage };
  }
}
