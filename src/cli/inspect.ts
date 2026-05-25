/**
 * inspect read-only view (debug-facing, internal terms retained).
 *
 * sub-modes: --inbox / --worker-stream / --meta-stream / --watcher-stream / --events / a combined
 * dashboard with no args. Pure filesystem reads (manifest / messaging fold / events.jsonl / stream jsonl
 * tail); referencing something that doesn't exist -> cli_task_not_found (debug-facing text). Web read-only
 * uses its own pure-read path and does not go through this module.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { createMessagingBus } from "../messaging/index.js";
import { jsonlIO } from "../shared/jsonl.js";
import { manifestIO } from "../shared/manifest.js";
import { buildTaskCapsulePaths, type TaskCapsulePaths } from "../shared/paths.js";
import type { SessionId } from "../shared/ids.js";

import { cliErrors } from "./errors.js";
import { tasksRootOf } from "./projectRoot.js";

export interface InspectMode {
  readonly inbox?: string | true;
  readonly workerStream?: string | true;
  readonly metaStream?: string | true;
  readonly watcherStream?: string | true;
  readonly watcherContext?: true;
  readonly events?: number;
  readonly last?: number;
}

function resolvePaths(projectRoot: string, taskId: string): TaskCapsulePaths {
  let paths: TaskCapsulePaths;
  try {
    paths = buildTaskCapsulePaths(tasksRootOf(projectRoot), taskId);
  } catch {
    throw cliErrors.taskNotFound(taskId);
  }
  if (!existsSync(paths.taskRoot)) throw cliErrors.taskNotFound(taskId);
  return paths;
}

async function tailLines(path: string, n: number): Promise<string[]> {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(-n);
}

/** Combined dashboard (no sub-mode): stage / recent events / inbox stats (plain text). */
async function renderDashboard(paths: TaskCapsulePaths, last: number): Promise<string> {
  const out: string[] = [];
  const manifest = await manifestIO.load(paths);
  out.push(`task_id: ${manifest.taskId}`);
  out.push(`stage: ${manifest.stage}`);
  out.push(`title: ${manifest.title || "(empty)"}`);
  out.push(`updated_at: ${manifest.updatedAt}`);
  if (manifest.lastError !== null) {
    out.push(`last_error: ${manifest.lastError.errorKind} - ${manifest.lastError.message}`);
  }

  // inbox stats（per channel unread count）
  out.push("");
  out.push("== inbox (unread) ==");
  const bus = createMessagingBus(paths);
  for (const ch of ["meta", "worker", "watcher"] as const) {
    try {
      const unread = await bus.peekUnread(ch);
      out.push(`${ch}: ${unread.length} unread`);
    } catch (err) {
      out.push(`${ch}: <error: ${(err as Error).message}>`);
    }
  }

  out.push("");
  out.push(`== recent events (last ${last}) ==`);
  const { eventsIO } = await import("../host/events.js");
  const summaries = await eventsIO.readRecentSummaries(paths, last).catch(() => [] as string[]);
  for (const s of summaries) out.push(s);
  return out.join("\n");
}

async function renderInbox(paths: TaskCapsulePaths, channel: string | true): Promise<string> {
  const bus = createMessagingBus(paths);
  const channels = channel === true ? (["meta", "worker", "watcher"] as const) : ([channel] as const);
  const out: string[] = [];
  for (const ch of channels) {
    if (ch !== "meta" && ch !== "worker" && ch !== "watcher") {
      out.push(`unknown channel: ${ch}`);
      continue;
    }
    out.push(`== inbox channel=${ch} ==`);
    try {
      const unread = await bus.peekUnread(ch);
      if (unread.length === 0) out.push("(no unread)");
      for (const e of unread) {
        out.push(`env_id=${e.envId} kind=${e.kind} from=${e.from} created_at=${e.createdAt}`);
      }
    } catch (err) {
      out.push(`<error: ${(err as Error).message}>`);
    }
  }
  return out.join("\n");
}

/** Render inspect output (debug-facing text); an all-empty mode -> dashboard. */
export async function renderInspect(projectRoot: string, taskId: string, mode: InspectMode): Promise<string> {
  const paths = resolvePaths(projectRoot, taskId);
  const last = mode.last ?? 20;

  if (mode.inbox !== undefined) return renderInbox(paths, mode.inbox);
  if (mode.events !== undefined) {
    const lines = await tailLines(paths.eventsPath, mode.events);
    return lines.length > 0 ? lines.join("\n") : "(no events)";
  }
  if (mode.metaStream !== undefined) {
    const sid = typeof mode.metaStream === "string" ? mode.metaStream : await latestSessionId(paths, "meta");
    if (sid === null) return "(no meta stream found; pass a session id explicitly)";
    const lines = await tailLines(paths.metaStreamPath(sid as SessionId), last);
    return lines.length > 0 ? lines.join("\n") : `(no stream content / not found for sid=${sid})`;
  }
  if (mode.watcherStream !== undefined) {
    const sid = typeof mode.watcherStream === "string" ? mode.watcherStream : await latestSessionId(paths, "watcher");
    if (sid === null) return "(no watcher stream found; pass a session id explicitly)";
    const lines = await tailLines(paths.watcherStreamPath(sid as SessionId), last);
    return lines.length > 0 ? lines.join("\n") : `(no stream content / not found for sid=${sid})`;
  }
  if (mode.workerStream !== undefined) {
    if (typeof mode.workerStream === "string") {
      // Explicit sid given: resolve its seq from events -> tail the worker stream.
      const seq = await latestWorkerSeqForSid(paths, mode.workerStream);
      if (seq === null) return `(worker session ${mode.workerStream} not found in events.jsonl)`;
      const lines = await tailLines(paths.workerStreamPath(seq, mode.workerStream as SessionId), last);
      return lines.length > 0 ? lines.join("\n") : `(no stream content for worker sid=${mode.workerStream} seq=${seq})`;
    }
    // Default: take the latest worker session (seq + sid).
    const latest = await latestWorker(paths);
    if (latest === null) return "(no worker session found in events.jsonl)";
    const lines = await tailLines(paths.workerStreamPath(latest.seq, latest.sid as SessionId), last);
    return lines.length > 0 ? lines.join("\n") : `(no stream content for latest worker seq=${latest.seq})`;
  }
  if (mode.watcherContext === true) {
    return renderWatcherContext(paths);
  }
  return renderDashboard(paths, mode.events ?? 30);
}

/**
 * Watcher context compact-orchestration overview. Live token usage is host in-memory state that the
 * short-lived CLI doesn't hold; this view derives the observable parts from events.jsonl: the compact
 * threshold, a context-token snapshot at the latest trigger, compact-flow counts, and giveup status.
 */
async function renderWatcherContext(paths: TaskCapsulePaths): Promise<string> {
  const triggered: Array<Record<string, unknown>> = [];
  const reinjected: Array<Record<string, unknown>> = [];
  const failed: Array<Record<string, unknown>> = [];
  try {
    for await (const obj of jsonlIO.readLines(paths.eventsPath)) {
      const o = obj as Record<string, unknown>;
      const d = (o["details"] ?? {}) as Record<string, unknown>;
      if (o["type"] === "watcher_compact_triggered") triggered.push(d);
      else if (o["type"] === "watcher_compact_role_reinjected") reinjected.push(d);
      else if (o["type"] === "watcher_compact_failed") failed.push(d);
    }
  } catch {
    return "(failed to read events.jsonl)";
  }
  const out: string[] = [];
  out.push("watcher context (compact orchestration) — live token usage is host in-memory state; the following is derived from events.jsonl (snapshot at the latest compact trigger).");
  if (triggered.length === 0) {
    out.push("compact has not been triggered yet (watcher context below threshold, or watcher long session not running).");
    return out.join("\n");
  }
  // events.jsonl details are persisted on disk as snake_case (eventsIO.append converts recursively); reads must use snake_case keys.
  const flows = new Set(triggered.map((d) => String(d["compact_flow_id"])));
  const last = triggered[triggered.length - 1]!;
  out.push(`compact threshold (tokens): ${last["threshold"] ?? "?"}`);
  out.push(`context tokens at latest trigger: ${last["total_tokens_before"] ?? "?"} (messages portion: ${last["messages_tokens_before"] ?? "?"})`);
  out.push(`compact flows: ${flows.size} (triggered attempts: ${triggered.length})`);
  out.push(`reinjected ok: ${reinjected.length}; failed giveup: ${failed.length}`);
  if (failed.length > 0) {
    const lf = failed[failed.length - 1]!;
    out.push(`latest failure: step=${lf["failed_step"] ?? "?"} errorKind=${lf["error_kind"] ?? "?"} (this watcher session will not attempt compact again)`);
  }
  return out.join("\n");
}

/** Resolve a role's most recent agent_session_started sessionId from events.jsonl (defaults to the latest session). */
async function latestSessionId(paths: TaskCapsulePaths, role: string): Promise<string | null> {
  let latest: string | null = null;
  try {
    for await (const obj of jsonlIO.readLines(paths.eventsPath)) {
      const ev = obj as Record<string, unknown>;
      if (ev["type"] !== "agent_session_started") continue;
      const d = ev["details"];
      if (typeof d !== "object" || d === null) continue;
      const dd = d as Record<string, unknown>;
      if (dd["role"] !== role) continue;
      const sid = dd["session_id"];
      if (typeof sid === "string") latest = sid; // later occurrences override (events are appended in time order)
    }
  } catch {
    /* fold failure is fail-soft */
  }
  return latest;
}

/** The latest worker session (seq + sid). */
async function latestWorker(paths: TaskCapsulePaths): Promise<{ seq: number; sid: string } | null> {
  let latest: { seq: number; sid: string } | null = null;
  try {
    for await (const obj of jsonlIO.readLines(paths.eventsPath)) {
      const ev = obj as Record<string, unknown>;
      if (ev["type"] !== "agent_session_started") continue;
      const d = ev["details"];
      if (typeof d !== "object" || d === null) continue;
      const dd = d as Record<string, unknown>;
      if (dd["role"] !== "worker") continue;
      const sid = dd["session_id"];
      const seq = dd["session_seq"];
      if (typeof sid === "string" && typeof seq === "number") latest = { seq, sid };
    }
  } catch {
    /* fail-soft */
  }
  return latest;
}

/** Resolve the sessionSeq for a given worker sid. */
async function latestWorkerSeqForSid(paths: TaskCapsulePaths, sid: string): Promise<number | null> {
  try {
    for await (const obj of jsonlIO.readLines(paths.eventsPath)) {
      const ev = obj as Record<string, unknown>;
      if (ev["type"] !== "agent_session_started") continue;
      const d = ev["details"];
      if (typeof d !== "object" || d === null) continue;
      const dd = d as Record<string, unknown>;
      if (dd["role"] !== "worker" || dd["session_id"] !== sid) continue;
      const seq = dd["session_seq"];
      if (typeof seq === "number") return seq;
    }
  } catch {
    /* fail-soft */
  }
  return null;
}
