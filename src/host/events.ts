/**
 * Orchestration-level event stream in control/events.jsonl.
 *
 * - Full event type set + common fields
 * - `eventSeq` is allocated as fold-max+1 inside `events.jsonl.lock` (independent sequence space)
 * - Physical JSON is snake_case (`event_seq` / `triggered_by` etc.), camelCase at the TS layer;
 *   conversion is self-contained inside the writer
 * - recovery: `truncatePartialTail` (partial last line) + `quarantine` (corrupt middle line)
 *
 * `details` keys are recursively converted to snake_case on append (see `detailsToSnake`); TS-layer
 * callers pass camelCase (fromStage / triggeredBy / sessionSeq etc.).
 */
import { jsonlIO } from "../shared/jsonl.js";
import { withLock } from "../shared/locks.js";
import type { Stage } from "../shared/manifest.js";
import type { TaskCapsulePaths } from "../shared/paths.js";
import { nowIso8601Us, type Iso8601Us } from "../shared/timeUtils.js";

export type HostEventType =
  | "host_started"
  | "host_recovery"
  | "host_recovery_failed"
  | "host_stopping"
  | "stage_transition"
  | "agent_session_started"
  | "agent_session_ended"
  | "watchdog_triggered"
  | "reviewer_triggered"
  | "worker_stream_window_dispatched"
  | "user_cli_action"
  | "harness_changed"
  | "message_to_user"
  | "watcher_compact_triggered"
  | "watcher_compact_role_reinjected"
  | "watcher_compact_failed"
  | "prompt_lang_fallback";

export interface HostEventCommon {
  readonly type: HostEventType;
  readonly ts: Iso8601Us;
  readonly stage: Stage;
  readonly eventSeq: number;
  readonly details: Readonly<Record<string, unknown>>;
}

/** append input: ts / eventSeq are allocated by the writer while holding the lock. */
export type HostEventInput = Omit<HostEventCommon, "ts" | "eventSeq">;

export interface AppendEndedIdempotentResult {
  /** Whether an ENDED was actually written this call (false = an ENDED for the same session already exists, skipped). */
  readonly appended: boolean;
  /** Whether the events.jsonl scan succeeded (false = read corruption / IO failure, conservatively not written). */
  readonly scanOk: boolean;
}

export interface EventsIO {
  append(paths: TaskCapsulePaths, event: HostEventInput): Promise<void>;
  /**
   * Idempotent compare-and-append of the worker `agent_session_ended` (the physical invariant
   * "exactly one ENDED per STARTED"). Within the same events.jsonl.lock hold, first scans whether
   * this sessionSeq already has a worker `agent_session_ended`, skipping if so, appending if not.
   * Scan+append under the lock guarantees exactly one physical worker ENDED across all closeout
   * entries (finalizeWorker / stopWorker / cleanupAndExit / recovery) in any ordering, without
   * relying on any in-memory flag timing. On scan read corruption / IO failure, conservatively
   * skips the write (scanOk=false), leaving recovery's idempotent backfill as the fallback.
   */
  appendWorkerEndedIdempotent(
    paths: TaskCapsulePaths,
    args: { stage: Stage; sessionId: string; sessionSeq: number; exitReason: string },
  ): Promise<AppendEndedIdempotentResult>;
  /**
   * Idempotent compare-and-append of the reviewer `agent_session_ended` (same physical invariant as
   * worker, keyed on role=reviewer + session_id). triggerReviewer's own ENDED (natural/timeout/failed/
   * host_internal) and cleanupAndExit's fallback (host_shutdown) all use this helper; the scan under
   * the lock guarantees exactly one physical reviewer ENDED in any ordering. This lets triggerReviewer
   * clear the active handle only after the ENDED is durably persisted (owner semantics), closing the
   * gap where cleanup could not back up the pairing during the await window between "clear handle" and
   * "persist ENDED". Reviewers have no sessionSeq, so dedup is keyed on session_id.
   */
  appendReviewerEndedIdempotent(
    paths: TaskCapsulePaths,
    args: { stage: Stage; sessionId: string; exitReason: string },
  ): Promise<AppendEndedIdempotentResult>;
  readRecentSummaries(paths: TaskCapsulePaths, limit?: number): Promise<ReadonlyArray<string>>;
  /** recovery: truncate a partial-write last line; returns whether it truncated. */
  truncatePartialTail(paths: TaskCapsulePaths): Promise<boolean>;
  /** recovery: corrupt middle line → rename to events.jsonl.corrupt.<ts>, returns the new path. */
  quarantine(paths: TaskCapsulePaths): Promise<string>;
}

const DEFAULT_SUMMARY_LIMIT = 5;

/** camelCase → snake_case (single key). */
function camelToSnakeKey(k: string): string {
  return k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

/**
 * Recursively convert details keys to snake_case (physical JSON snake_case discipline).
 * details are host-produced structured fields (fromStage / triggeredBy / sessionSeq / watchdogKind
 * etc.); nested object keys are converted too, and array elements that are objects recurse as well.
 * Primitive values (string / number / bool / null) are kept as-is.
 */
function detailsToSnake(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(detailsToSnake);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[camelToSnakeKey(k)] = detailsToSnake(v);
    }
    return out;
  }
  return value;
}

/** Shorten a summary value: JSON-truncate objects / arrays to ~60 chars, avoiding String(obj) producing [object Object]. */
function briefValue(v: unknown): string {
  if (v === null || typeof v !== "object") return String(v);
  const s = JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

/** Under the lock, fold events.jsonl for the current max eventSeq; jsonlIO skips a partial last line, a corrupt middle line throws CorruptJsonlError. */
async function foldMaxEventSeq(path: string): Promise<number> {
  let max = 0;
  for await (const obj of jsonlIO.readLines(path)) {
    const ev = obj as Record<string, unknown>;
    const seq = ev["event_seq"];
    if (typeof seq === "number" && Number.isInteger(seq) && seq > max) max = seq;
  }
  return max;
}

/**
 * Append one event. eventSeq is allocated as fold-max+1 inside events.jsonl.lock (independent
 * sequence space). A corrupt middle line makes foldMaxEventSeq throw CorruptJsonlError (recovery
 * already quarantined first; the normal path won't hit it; the caller's safeAppend is the fail-soft
 * fallback). Physical JSON: top-level event_seq + recursively snake_cased details.
 */
async function append(paths: TaskCapsulePaths, event: HostEventInput): Promise<void> {
  await withLock(paths.eventsLock, async () => {
    const max = await foldMaxEventSeq(paths.eventsPath);
    const eventSeq = max + 1;
    const ts = nowIso8601Us();
    await jsonlIO.appendLine(paths.eventsPath, {
      type: event.type,
      ts,
      stage: event.stage,
      event_seq: eventSeq,
      details: detailsToSnake(event.details),
    });
  });
}

/**
 * Shared core for the idempotent ENDED compare-and-append (scan+append under the lock). While
 * holding events.jsonl.lock, folds once:
 *  - uses `match` to detect an existing `agent_session_ended` for the same session (yes → skip, appended=false)
 *  - also captures max eventSeq (consistent with append, avoiding a second fold)
 * A corrupt middle line / IO failure → conservatively skips the write (scanOk=false), with recovery /
 * other closeout entries' idempotent backfill as the fallback (never blind-writing on corrupt events
 * to avoid duplication). Worker (dedup by session_seq) and reviewer (dedup by session_id) share this
 * core, differing only in the match predicate and written details.
 */
async function appendEndedIdempotentCore(
  paths: TaskCapsulePaths,
  args: { stage: Stage; match: (d: Record<string, unknown>) => boolean; details: Record<string, unknown> },
): Promise<AppendEndedIdempotentResult> {
  return withLock(paths.eventsLock, async () => {
    let max = 0;
    let alreadyEnded = false;
    try {
      for await (const obj of jsonlIO.readLines(paths.eventsPath)) {
        const ev = obj as Record<string, unknown>;
        const seq = ev["event_seq"];
        if (typeof seq === "number" && Number.isInteger(seq) && seq > max) max = seq;
        if (ev["type"] !== "agent_session_ended") continue;
        const d = ev["details"];
        if (typeof d !== "object" || d === null) continue;
        if (args.match(d as Record<string, unknown>)) alreadyEnded = true;
      }
    } catch {
      return { appended: false, scanOk: false }; // corruption / IO failure: conservatively skip the write
    }
    if (alreadyEnded) return { appended: false, scanOk: true };
    const eventSeq = max + 1;
    const ts = nowIso8601Us();
    await jsonlIO.appendLine(paths.eventsPath, {
      type: "agent_session_ended",
      ts,
      stage: args.stage,
      event_seq: eventSeq,
      details: detailsToSnake(args.details),
    });
    return { appended: true, scanOk: true };
  });
}

/** Worker ENDED idempotent compare-and-append (dedup by session_seq). */
async function appendWorkerEndedIdempotent(
  paths: TaskCapsulePaths,
  args: { stage: Stage; sessionId: string; sessionSeq: number; exitReason: string },
): Promise<AppendEndedIdempotentResult> {
  return appendEndedIdempotentCore(paths, {
    stage: args.stage,
    match: (d) => d["role"] === "worker" && d["session_seq"] === args.sessionSeq,
    details: { role: "worker", sessionId: args.sessionId, sessionSeq: args.sessionSeq, exitReason: args.exitReason },
  });
}

/** Reviewer ENDED idempotent compare-and-append (dedup by session_id; reviewer has no sessionSeq). */
async function appendReviewerEndedIdempotent(
  paths: TaskCapsulePaths,
  args: { stage: Stage; sessionId: string; exitReason: string },
): Promise<AppendEndedIdempotentResult> {
  return appendEndedIdempotentCore(paths, {
    stage: args.stage,
    match: (d) => d["role"] === "reviewer" && d["session_id"] === args.sessionId,
    details: { role: "reviewer", sessionId: args.sessionId, exitReason: args.exitReason },
  });
}

async function readRecentSummaries(
  paths: TaskCapsulePaths,
  limit = DEFAULT_SUMMARY_LIMIT,
): Promise<ReadonlyArray<string>> {
  const all: Array<Record<string, unknown>> = [];
  try {
    for await (const obj of jsonlIO.readLines(paths.eventsPath)) {
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        all.push(obj as Record<string, unknown>);
      }
    }
  } catch {
    return []; // fail-soft: a corrupt summary does not block
  }
  const tail = limit > 0 ? all.slice(-limit) : all;
  const out: string[] = [];
  for (const ev of tail) {
    const ts = String(ev["ts"] ?? "");
    const type = String(ev["type"] ?? "?");
    const stage = String(ev["stage"] ?? "");
    const details = ev["details"];
    let brief = "";
    if (typeof details === "object" && details !== null && !Array.isArray(details)) {
      const kv = Object.entries(details as Record<string, unknown>)
        .slice(0, 3)
        .map(([k, v]) => `${k}=${briefValue(v)}`);
      if (kv.length > 0) brief = ` ${kv.join(" ")}`;
    }
    out.push(`${ts} ${type}@${stage}${brief}`);
  }
  return out;
}

async function truncatePartialTail(paths: TaskCapsulePaths): Promise<boolean> {
  return jsonlIO.truncatePartialTail(paths.eventsPath);
}

async function quarantine(paths: TaskCapsulePaths): Promise<string> {
  return jsonlIO.quarantine(paths.eventsPath);
}

export const eventsIO: EventsIO = {
  append,
  appendWorkerEndedIdempotent,
  appendReviewerEndedIdempotent,
  readRecentSummaries,
  truncatePartialTail,
  quarantine,
};
