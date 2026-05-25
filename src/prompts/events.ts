/**
 * Read the last N events from control/events.jsonl and turn each into a one-line summary.
 *
 * Fail-soft: events.jsonl missing / parse failure -> return empty array (the caller folds these
 * summaries into the Meta first user message only as a reference; a corrupt audit stream must not
 * block assembly).
 */
import { jsonlIO } from "../shared/jsonl.js";
import type { TaskCapsulePaths } from "../shared/paths.js";

export async function readRecentEventsSummaries(
  paths: TaskCapsulePaths,
  limit = 10,
): Promise<ReadonlyArray<string>> {
  const all: Array<Record<string, unknown>> = [];
  try {
    for await (const entry of jsonlIO.readLines(paths.eventsPath)) {
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
        all.push(entry as Record<string, unknown>);
      }
    }
  } catch (exc) {
    console.warn(`read events.jsonl for summaries failed: ${String(exc)}`);
    return [];
  }

  const tail = limit > 0 ? all.slice(-limit) : all;
  const summaries: string[] = [];
  for (const entry of tail) {
    const ts = entry["ts"] ?? "";
    const eventType = entry["type"] ?? "?";
    const stage = entry["stage"] ?? "";
    const details = entry["details"];
    let detailsBrief = "";
    if (typeof details === "object" && details !== null && !Array.isArray(details)) {
      const kv = Object.entries(details as Record<string, unknown>)
        .slice(0, 3)
        .map(([k, v]) => `${k}=${String(v)}`);
      if (kv.length > 0) detailsBrief = ` ${kv.join(" ")}`;
    }
    summaries.push(`${String(ts)} ${String(eventType)}@${String(stage)}${detailsBrief}`);
  }
  return summaries;
}
