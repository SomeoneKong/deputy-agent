/**
 * Host-synthesized summary for the lenient compact path.
 *
 * When the watcher provider cannot observe the SDK compaction summary
 * (`canObserveSummary=false`, compact() returns success=false and the adapter emits
 * `compact_summary_missing`), compaction has moved observation detail out of the watcher
 * context. The host instead reads that watcher session's pre-compaction stream JSONL (via the
 * same `readStreamIncrement` reader the watcher pipeline uses) and synthesizes a bounded
 * summary, used as `hostManagedSummary` and reinjected back into the same session to restore
 * observation continuity.
 *
 * Strategy: concatenate recent assistant text block text with turn boundary markers; when the
 * total exceeds `MAX_SUMMARY_BYTES`, keep the most recent (tail) content in chronological order
 * (compaction cares about recent observation continuity) plus a head-truncation marker.
 * Read-only; never writes the stream (the stream's sole writer is the wrapper adapter).
 */
import type { StreamJsonlLine } from "../../wrapper/index.js";
import { readStreamIncrement } from "./offsetTracker.js";

/** Byte cap (UTF-8) for the synthesized summary. Compaction cares about recent observation continuity, so when over the cap the most recent (tail) content is kept. */
export const MAX_SUMMARY_BYTES = 12 * 1024;

const encoder = new TextEncoder();

/**
 * Reads a watcher session's pre-compaction stream JSONL and synthesizes a summary. On read IO
 * failure or when no usable content exists, returns null (caller fail-soft: can still reinject
 * without hostManagedSummary, or degrade as appropriate).
 *
 * @param streamAbsPath absolute path to the watcher session stream JSONL.
 * @param logLabel label for row-level skip logs.
 */
export async function synthesizeWatcherCompactSummary(
  streamAbsPath: string,
  logLabel: string,
): Promise<string | null> {
  let events: ReadonlyArray<StreamJsonlLine>;
  try {
    // Read the full stream from offset 0: the summary_unobservable terminal state provides no
    // reliable firstKeptEntryId boundary, so the host cannot precisely know which segment was
    // compacted. Condense the whole history, preferring the most recent (tail) content
    // (boundTail), which is what the watcher needs to resume observation.
    events = (await readStreamIncrement(streamAbsPath, 0, logLabel)).events;
  } catch {
    return null; // read IO failure: fail-soft (caller decides how to degrade)
  }
  return synthesizeFromEvents(events);
}

/**
 * Synthesize a summary from already-read stream events (pure function; easy to unit-test).
 * Extracts assistant text block text, groups it by turn with boundary markers, and joins into
 * bounded text. Returns null when there is no assistant text.
 */
export function synthesizeFromEvents(events: ReadonlyArray<StreamJsonlLine>): string | null {
  // Collect assistant text per turn; mark turn boundaries with the turn_started sequence number.
  const turns: Array<{ label: string; texts: string[] }> = [];
  let current: { label: string; texts: string[] } | null = null;
  let turnNo = 0;

  for (const ev of events) {
    const kind = (ev as { kind?: unknown }).kind;
    if (kind === "turn_started") {
      turnNo += 1;
      current = { label: `[turn ${turnNo}]`, texts: [] };
      turns.push(current);
      continue;
    }
    if (kind === "assistant_block") {
      const block = (ev as { block?: { type?: string; text?: unknown } }).block;
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
        // Assistant text appearing before any turn_started (rare) goes into an implicit first group.
        if (current === null) {
          current = { label: "[turn 1]", texts: [] };
          turns.push(current);
        }
        current.texts.push(block.text.trim());
      }
    }
  }

  const sections: string[] = [];
  for (const t of turns) {
    if (t.texts.length === 0) continue;
    sections.push(`${t.label}\n${t.texts.join("\n")}`);
  }
  if (sections.length === 0) return null;

  const joined = sections.join("\n\n");
  return boundTail(joined, MAX_SUMMARY_BYTES);
}

/** When over maxBytes, keep the most recent (tail) content (at a UTF-8-safe boundary) plus a head-truncation marker. */
function boundTail(s: string, maxBytes: number): string {
  const full = encoder.encode(s);
  if (full.length <= maxBytes) return s;
  // Move the maxBytes start point back to a character boundary (UTF-8 continuation byte 0x80..0xBF).
  let start = full.length - maxBytes;
  while (start < full.length && (full[start]! & 0xc0) === 0x80) start += 1;
  const tail = new TextDecoder("utf-8").decode(full.subarray(start));
  return `... (earlier observations truncated, kept latest ${full.length - start} of ${full.length} bytes)\n\n${tail}`;
}
