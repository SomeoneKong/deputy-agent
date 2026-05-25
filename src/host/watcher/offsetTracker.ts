/**
 * Per-worker-session offset tracker + byte-offset incremental read.
 *
 * OffsetTracker is in-memory state, not persisted. Reads of the stream JSONL resume from
 * lastStreamOffset; a trailing half-written line is conservatively excluded from the offset
 * (partial write), while a corrupt line in the middle is row-level fail-soft (skip + log warn,
 * with the offset including the corrupt line's bytes to avoid re-reading it in an infinite loop).
 *
 * This subsystem only reads the worker stream JSONL; it never writes it (the stream's sole writer
 * is the wrapper adapter).
 */
import { open, stat } from "node:fs/promises";

import type { SessionId } from "../../shared/ids.js";
import type { Iso8601Us } from "../../shared/timeUtils.js";
import type { StreamJsonlLine } from "../../wrapper/index.js";

export interface OffsetTracker {
  readonly workerSessionId: SessionId;
  readonly workerSessionSeq: number;
  /** Task-capsule-relative path (includes the workspace/ prefix); used in envelope extras / body header. */
  readonly streamPath: string;
  /** Physical absolute path of the stream JSONL (internal reader only; never in envelope / body). */
  readonly streamAbsPath: string;
  /** Monotonic seconds; the window anchor origin. */
  readonly startedAtMono: number;
  /** Wall-clock anchor; snapshotted once at onWorkerSessionStarted. */
  readonly startedAtWall: Iso8601Us;
  /** Numeric ms-epoch cache of startedAtWall (used to compute tsRelative, avoiding repeated parsing). */
  readonly startedAtWallMs: number;
  /** Monotonic seconds when the next window is due; first window = startedAtMono + windowSeconds. */
  nextWindowDueMono: number;
  /** Bytes read so far; 0 initially. */
  lastStreamOffset: number;
  /** Nominal windowStart of the earliest undelivered window; null initially. */
  pendingWindowStartWall: Iso8601Us | null;
}

const LF = 0x0a;

export interface ReadIncrementResult {
  readonly events: ReadonlyArray<StreamJsonlLine>;
  /** Advanced to the end of all complete lines (including the bytes of skipped corrupt lines). */
  readonly newOffset: number;
  /** receivedAt (ms) of the last record read; undefined when there are no complete lines (used for the windowEnd max). */
  readonly lastReceivedAt: number | undefined;
}

/**
 * Read from fromOffset to the current end of file (by byte), split into lines, and JSON.parse each line.
 * - A trailing segment without a final \n is treated as a partial write and conservatively excluded from the offset.
 * - A line that fails to parse / is empty / is not an object is skipped + log warn, with the offset still including its bytes.
 * - A missing file (ENOENT) yields an empty result (fail-soft).
 *
 * A read IO failure (non-ENOENT) is thrown and handled fail-soft by the dispatcher.
 */
export async function readStreamIncrement(
  absPath: string,
  fromOffset: number,
  logLabel: string,
): Promise<ReadIncrementResult> {
  let size: number;
  try {
    size = (await stat(absPath)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], newOffset: fromOffset, lastReceivedAt: undefined };
    }
    throw err;
  }
  if (size <= fromOffset) {
    return { events: [], newOffset: fromOffset, lastReceivedAt: undefined };
  }

  const length = size - fromOffset;
  const buf = Buffer.alloc(length);
  const fh = await open(absPath, "r");
  try {
    await fh.read(buf, 0, length, fromOffset);
  } finally {
    await fh.close();
  }

  // Cut to the last \n; the segment after it is a partial write, conservatively excluded from the offset.
  const lastNl = buf.lastIndexOf(LF);
  if (lastNl === -1) {
    // No complete line in the whole segment (all half-written); do not advance the offset.
    return { events: [], newOffset: fromOffset, lastReceivedAt: undefined };
  }
  const completeLen = lastNl + 1; // includes the trailing \n
  const newOffset = fromOffset + completeLen;

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const events: StreamJsonlLine[] = [];
  let lastReceivedAt: number | undefined;
  let start = 0;
  let lineNo = 0;
  while (start < completeLen) {
    let nl = buf.indexOf(LF, start);
    if (nl === -1 || nl >= completeLen) nl = completeLen;
    const segment = buf.subarray(start, nl);
    start = nl + 1;
    lineNo += 1;
    if (segment.length === 0) continue; // empty line: skip
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(segment));
    } catch (err) {
      console.warn(`watcher stream row-level skip ${logLabel} line~${lineNo}: ${(err as Error).message}`);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn(`watcher stream row-level skip ${logLabel} line~${lineNo}: not an object`);
      continue;
    }
    const ev = parsed as StreamJsonlLine;
    events.push(ev);
    if (typeof ev.receivedAt === "number") lastReceivedAt = ev.receivedAt;
  }

  return { events, newOffset, lastReceivedAt };
}
