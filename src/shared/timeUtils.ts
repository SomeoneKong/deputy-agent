/**
 * Timestamp utilities.
 *
 * All persisted time fields in a task capsule use ISO 8601 UTC with microsecond
 * precision: `2026-05-12T14:23:07.123456Z` (fixed width, so lexical order equals
 * chronological order).
 *
 * This does not cover the wrapper stream JSONL, which has its own contract (a
 * millisecond numeric form).
 */

export type Iso8601Us = string & { readonly __brand: "Iso8601Us" };

/** Fixed-width µs ISO: YYYY-MM-DDTHH:mm:ss.SSSSSSZ */
const ISO8601_US_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * In-process monotonic counter (integer µs since epoch). Node's `Date` only goes
 * down to ms; this counter works around that to guarantee each `nowIso8601Us()`
 * call within a single process is strictly increasing.
 */
let lastUs = 0;

function formatUs(totalMicros: number): Iso8601Us {
  const epochSeconds = Math.floor(totalMicros / 1_000_000);
  const microsOfSecond = totalMicros % 1_000_000;
  // toISOString() gives "YYYY-MM-DDTHH:mm:ss.mmmZ"; take the part up to seconds, then append 6 µs digits.
  const secondsPart = new Date(epochSeconds * 1000).toISOString().slice(0, 19);
  return `${secondsPart}.${microsOfSecond.toString().padStart(6, "0")}Z` as Iso8601Us;
}

/** Return the current time as µs ISO, strictly monotonically increasing within a single process. */
export function nowIso8601Us(): Iso8601Us {
  const nowUs = Math.max(Date.now() * 1000, lastUs + 1);
  lastUs = nowUs;
  return formatUs(nowUs);
}

/**
 * Format a ms epoch (with fractional µs) as µs ISO. Used for timestamps derived
 * from a wrapper stream `receivedAt` (a ms number) or from an anchor plus offset.
 * Unlike `nowIso8601Us`, it does not guarantee per-process monotonicity, since the
 * input is an external instant.
 */
export function iso8601UsFromMs(epochMs: number): Iso8601Us {
  return formatUs(Math.round(epochMs * 1000));
}

/** Parse a µs ISO back into a ms epoch number (for range max comparisons / tsRelative anchors). */
export function iso8601UsToMs(iso: Iso8601Us): number {
  const micros = iso.slice(20, 26); // the 6 µs digits in "...ss.SSSSSSZ"
  const seconds = new Date(iso.slice(0, 19) + "Z").getTime();
  return seconds + Number(micros) / 1000;
}

/** Validate the µs ISO format and convert to the branded type; throws `TypeError` on a format mismatch. */
export function parseIso8601Us(s: string): Iso8601Us {
  if (!ISO8601_US_PATTERN.test(s)) {
    throw new TypeError(`invalid Iso8601Us timestamp: ${JSON.stringify(s)}`);
  }
  return s as Iso8601Us;
}
