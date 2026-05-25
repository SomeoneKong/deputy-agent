/**
 * WindowDispatcher: splits a worker stream into time windows and dispatches worker_stream_window
 * envelopes.
 *
 * A lightweight in-host scheduler with a per-worker-session in-memory OffsetTracker. On a fixed
 * time window (default 180s, measured from worker session start, monotonic) it collects the
 * stream increment, preprocesses it, renders the body, enqueues it to the Watcher inbox via
 * bus.enqueue, and appends a worker_stream_window_dispatched event to events.jsonl.
 *
 * Responsibility boundary: it only enqueues the envelope and writes the dispatched event; it does
 * not perform the physical inject (inject belongs to the wake cursor path). Empty windows are not
 * dispatched. enqueue / read IO failures are fail-soft with no retry; content is not lost, only
 * delayed by one window.
 *
 * Concurrency: dispatchWindow is serialized per tracker to avoid duplicate envelopes or
 * double-reading the offset.
 */
import { relative } from "node:path";

import type { MessagingBus } from "../../messaging/index.js";
import type { SessionId } from "../../shared/ids.js";
import type { Stage } from "../../shared/manifest.js";
import { manifestIO } from "../../shared/manifest.js";
import type { TaskCapsulePaths } from "../../shared/paths.js";
import type { Iso8601Us } from "../../shared/timeUtils.js";
import { iso8601UsFromMs, iso8601UsToMs, nowIso8601Us } from "../../shared/timeUtils.js";
import type { Lang } from "../../prompts/index.js";
import { AgentBehaviorErrorKind } from "../errorKinds.js";
import type { EventsIO } from "../events.js";

import type { OffsetTracker } from "./offsetTracker.js";
import { readStreamIncrement } from "./offsetTracker.js";
import { isEmptyWindow, preprocessEvents, renderWindowBody } from "./preprocess.js";

export const DEFAULT_WINDOW_SECONDS = 180;

/** Argument for worker session lifecycle callbacks (onWorkerSessionStarted / Ended / discardOnSetupFailure). */
export interface WorkerSessionInfo {
  readonly workerSessionId: SessionId;
  readonly workerSessionSeq: number;
}

export interface WindowDispatcherDeps {
  readonly bus: MessagingBus;
  readonly paths: TaskCapsulePaths;
  readonly events: EventsIO;
  readonly windowSeconds: number;
  readonly watcherLang: Lang;
  /** Monotonic-seconds clock injection (for tests); defaults to a process.hrtime-derived clock. */
  readonly now?: () => number;
}

export interface WindowDispatcher {
  onWorkerSessionStarted(info: WorkerSessionInfo): void;
  tick(nowMono?: number): Promise<void>;
  onWorkerSessionEnded(info: WorkerSessionInfo, nowMono?: number): Promise<void>;
  discardOnSetupFailure(info: WorkerSessionInfo): void;
}

/** Monotonic seconds derived from process.hrtime (system clock adjustments do not affect window logic). */
function defaultNowMono(): number {
  return Number(process.hrtime.bigint() / 1_000n) / 1_000_000;
}

/** Task-capsule-relative path (forward slashes), used in envelope extras / body header. */
function toRelativeStreamPath(taskRoot: string, abs: string): string {
  return relative(taskRoot, abs).split("\\").join("/");
}

class WindowDispatcherImpl implements WindowDispatcher {
  private readonly deps: WindowDispatcherDeps;
  private readonly nowMono: () => number;
  private readonly trackers = new Map<SessionId, OffsetTracker>();
  /** Per-tracker serialization lock: sessionId -> the previous dispatch chain's promise. */
  private readonly chains = new Map<SessionId, Promise<void>>();

  constructor(deps: WindowDispatcherDeps) {
    // windowSeconds must be a finite positive number: with <=0 / NaN / Infinity, nextWindowDueMono
    // never advances (or goes backward), so the tick / final catch-up while loop
    // (`mono >= t.nextWindowDueMono`) never exits and the host hot-loops. Fail fast at construction.
    if (!Number.isFinite(deps.windowSeconds) || deps.windowSeconds <= 0) {
      throw new Error(`WindowDispatcher: windowSeconds must be a finite positive number, got ${deps.windowSeconds}`);
    }
    this.deps = deps;
    this.nowMono = deps.now ?? defaultNowMono;
  }

  onWorkerSessionStarted(info: WorkerSessionInfo): void {
    const mono = this.nowMono();
    const wall = nowIso8601Us();
    const abs = this.deps.paths.workerStreamPath(info.workerSessionSeq, info.workerSessionId);
    const streamPath = toRelativeStreamPath(this.deps.paths.taskRoot, abs);
    this.trackers.set(info.workerSessionId, {
      workerSessionId: info.workerSessionId,
      workerSessionSeq: info.workerSessionSeq,
      streamPath,
      streamAbsPath: abs,
      startedAtMono: mono,
      startedAtWall: wall,
      startedAtWallMs: iso8601UsToMs(wall),
      nextWindowDueMono: mono + this.deps.windowSeconds,
      lastStreamOffset: 0,
      pendingWindowStartWall: null,
    });
  }

  async tick(nowMono?: number): Promise<void> {
    const mono = nowMono ?? this.nowMono();
    // Snapshot the current tracker list (dispatch awaits, so avoid mutation during iteration when a session ends).
    const sessions = [...this.trackers.keys()];
    for (const sid of sessions) {
      await this.serialize(sid, async () => {
        // while loop to catch up all due windows.
        let t = this.trackers.get(sid);
        while (t !== undefined && mono >= t.nextWindowDueMono) {
          await this.dispatchWindow(t, false);
          t = this.trackers.get(sid);
        }
      });
    }
  }

  async onWorkerSessionEnded(info: WorkerSessionInfo, nowMono?: number): Promise<void> {
    const sid = info.workerSessionId;
    const t = this.trackers.get(sid);
    if (t === undefined) return;
    const mono = nowMono ?? this.nowMono();
    // Remove from the table first so later ticks no longer pick it up, then acquire the lock to let any in-flight dispatch finish.
    this.trackers.delete(sid);
    await this.serialize(sid, async () => {
      // Catch up the backlog of normal windows (isFinal=false) first, then dispatch the final window (isFinal=true).
      while (mono >= t.nextWindowDueMono) {
        await this.dispatchWindow(t, false);
      }
      await this.dispatchWindow(t, true);
    });
    this.chains.delete(sid);
  }

  discardOnSetupFailure(info: WorkerSessionInfo): void {
    // Only release the tracker; do not dispatch or write an event.
    this.trackers.delete(info.workerSessionId);
    this.chains.delete(info.workerSessionId);
  }

  /** Run fn serialized on the same tracker (per-tracker async chain). */
  private async serialize(sid: SessionId, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(sid) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(sid, next.then(() => undefined, () => undefined));
    await next;
  }

  /**
   * Evaluate one window: read increment, preprocess, skip if empty / render + enqueue, then write
   * the dispatched event and advance state. Four outcomes: dispatched normally, skipped empty,
   * enqueue failed, read IO failed.
   */
  private async dispatchWindow(t: OffsetTracker, isFinal: boolean): Promise<void> {
    const windowSeconds = this.deps.windowSeconds;
    // Window index n: this window's nominal range is derived from startedAtWall plus an offset.
    // Number of windows already due = (nextWindowDueMono - startedAtMono) / windowSeconds (equals 1 for the first window, n=1).
    const n = Math.round((t.nextWindowDueMono - t.startedAtMono) / windowSeconds);
    const nominalStartMs = t.startedAtWallMs + (n - 1) * windowSeconds * 1000;
    const nominalEndMs = isFinal ? iso8601UsToMs(nowIso8601Us()) : t.startedAtWallMs + n * windowSeconds * 1000;

    // ---- Read increment ----
    let read;
    try {
      read = await readStreamIncrement(t.streamAbsPath, t.lastStreamOffset, t.streamPath);
    } catch (err) {
      // Read IO failure fail-soft: advance nextWindowDueMono, do not advance offset, set pendingWindowStartWall.
      console.warn(`watcher window read IO failed ${t.streamPath}: ${(err as Error).message}`);
      const windowStart = t.pendingWindowStartWall ?? iso8601UsFromMs(nominalStartMs);
      const windowEnd = iso8601UsFromMs(nominalEndMs);
      t.nextWindowDueMono += windowSeconds;
      if (t.pendingWindowStartWall === null) t.pendingWindowStartWall = iso8601UsFromMs(nominalStartMs);
      await this.writeDispatchedEvent(t, windowStart, windowEnd, { readFailed: true });
      // For the final window the tracker is already deleted, so the failed tail of the stream is
      // permanently lost with no retry. Surface a host_event so Meta knows the Watcher final
      // window is degraded. Normal-window failures retry on the next window and are not surfaced (avoid noise).
      if (isFinal) await this.surfaceFinalWindowDegraded(t, "read_io_failed", (err as Error).message);
      return;
    }

    const windowStart = t.pendingWindowStartWall ?? iso8601UsFromMs(nominalStartMs);
    // windowEnd = max(nominal end point, last record receivedAt).
    const lastRecvMs = read.lastReceivedAt;
    const windowEnd = iso8601UsFromMs(
      lastRecvMs !== undefined && lastRecvMs > nominalEndMs ? lastRecvMs : nominalEndMs,
    );

    const processed = preprocessEvents(read.events, { watcherLang: this.deps.watcherLang });

    // ---- Skip empty window: still advance offset + nextWindowDueMono + reset pending ----
    if (isEmptyWindow(processed)) {
      t.lastStreamOffset = read.newOffset;
      t.nextWindowDueMono += windowSeconds;
      t.pendingWindowStartWall = null;
      await this.writeDispatchedEvent(t, windowStart, windowEnd, { skipped: true });
      return;
    }

    // ---- Render body + enqueue ----
    const { bodyMd, truncated } = renderWindowBody(processed, {
      windowStart,
      windowEnd,
      workerSessionId: t.workerSessionId,
      workerSessionSeq: t.workerSessionSeq,
      streamPath: t.streamPath,
      startedAtWallMs: t.startedAtWallMs,
      watcherLang: this.deps.watcherLang,
    });

    let envId: string;
    try {
      envId = await this.deps.bus.enqueue({
        channel: "watcher",
        kind: "worker_stream_window",
        from: "host",
        body: bodyMd,
        extras: {
          windowStart,
          windowEnd,
          workerSessionId: t.workerSessionId,
          streamPath: t.streamPath,
        },
      });
    } catch (err) {
      // enqueue failure fail-soft: advance nextWindowDueMono, do not advance offset, set pendingWindowStartWall.
      console.warn(`watcher window enqueue failed ${t.streamPath}: ${(err as Error).message}`);
      t.nextWindowDueMono += windowSeconds;
      if (t.pendingWindowStartWall === null) t.pendingWindowStartWall = iso8601UsFromMs(nominalStartMs);
      await this.writeDispatchedEvent(t, windowStart, windowEnd, { enqueueFailed: true });
      // Final-window failure permanently loses the tail segment, so surface it.
      if (isFinal) await this.surfaceFinalWindowDegraded(t, "enqueue_failed", (err as Error).message);
      return;
    }

    // Dispatch succeeded: advance offset + nextWindowDueMono + reset pending.
    t.lastStreamOffset = read.newOffset;
    t.nextWindowDueMono += windowSeconds;
    t.pendingWindowStartWall = null;
    await this.writeDispatchedEvent(t, windowStart, windowEnd, { envId, truncated });
  }

  /**
   * On final-window failure, enqueue a host_event(watcher_final_window_degraded) into the Meta
   * inbox: the tracker is already deleted, so the tail of the stream is permanently lost with no
   * retry. This lets Meta know the Watcher final window is degraded (and judge Watcher observation
   * completeness accordingly). Fail-soft.
   */
  private async surfaceFinalWindowDegraded(t: OffsetTracker, reason: string, message: string): Promise<void> {
    try {
      await this.deps.bus.enqueue({
        channel: "meta",
        kind: "host_event",
        from: "host",
        body: `watcher final window degraded for worker session ${t.workerSessionId} (seq ${t.workerSessionSeq}): ${reason} — ${message}`,
        extras: {
          eventKind: AgentBehaviorErrorKind.watcherFinalWindowDegraded,
          details: { workerSessionId: t.workerSessionId, sessionSeq: t.workerSessionSeq, reason },
        },
      });
    } catch (err) {
      console.warn(`watcher final window degraded surface failed ${t.streamPath}: ${(err as Error).message}`);
    }
  }

  /** Write a worker_stream_window_dispatched event; on write failure only log (fail-soft). */
  private async writeDispatchedEvent(
    t: OffsetTracker,
    windowStart: Iso8601Us,
    windowEnd: Iso8601Us,
    extra: { envId?: string; skipped?: boolean; enqueueFailed?: boolean; readFailed?: boolean; truncated?: boolean },
  ): Promise<void> {
    const stage = await this.currentStage();
    const details: Record<string, unknown> = {
      workerSessionId: t.workerSessionId,
      sessionSeq: t.workerSessionSeq,
      windowStart,
      windowEnd,
    };
    if (extra.envId !== undefined) details["envId"] = extra.envId;
    if (extra.skipped !== undefined) details["skipped"] = extra.skipped;
    if (extra.enqueueFailed !== undefined) details["enqueueFailed"] = extra.enqueueFailed;
    if (extra.readFailed !== undefined) details["readFailed"] = extra.readFailed;
    if (extra.truncated !== undefined) details["truncated"] = extra.truncated;
    try {
      await this.deps.events.append(this.deps.paths, {
        type: "worker_stream_window_dispatched",
        stage,
        details,
      });
    } catch (err) {
      console.warn(`watcher dispatched event append failed ${t.streamPath}: ${(err as Error).message}`);
    }
  }

  /** Read stage from the manifest; on read failure fall back to "unknown". */
  private async currentStage(): Promise<Stage> {
    try {
      return (await manifestIO.load(this.deps.paths)).stage;
    } catch {
      return "unknown" as Stage;
    }
  }
}

export function createWindowDispatcher(deps: WindowDispatcherDeps): WindowDispatcher {
  return new WindowDispatcherImpl(deps);
}
