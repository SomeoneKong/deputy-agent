/**
 * Read-only data source: pure filesystem reads + reuse of existing parsers (manifestIO / conversationIO /
 * jsonlIO / stream reader). Modifies no files and never goes through write command functions.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, normalize, relative, resolve, sep } from "node:path";

import {
  buildTaskCapsulePaths,
  fileLock,
  jsonlIO,
  manifestIO,
  type ConversationRow,
  type Manifest,
  type Stage,
  type TaskCapsulePaths,
} from "../shared/index.js";
import { cliErrors, tasksRootOf } from "../cli/index.js";

export interface TaskSummaryDto {
  readonly taskId: string;
  readonly stage: Stage;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Resolve taskId → paths; invalid → cli_task_id_invalid; missing → cli_task_not_found (propagated to the endpoint mapping). */
export function resolvePaths(projectRoot: string, taskId: string): TaskCapsulePaths {
  let paths: TaskCapsulePaths;
  try {
    paths = buildTaskCapsulePaths(tasksRootOf(projectRoot), taskId);
  } catch {
    throw cliErrors.taskIdInvalid(`invalid task_id: ${taskId}`);
  }
  if (!existsSync(paths.taskRoot)) throw cliErrors.taskNotFound(taskId);
  return paths;
}

/** Task list: scan tasks/ and read each manifest (skip on read failure) → sort by updatedAt descending. */
export async function listTaskSummaries(projectRoot: string): Promise<TaskSummaryDto[]> {
  const tasksRoot = tasksRootOf(projectRoot);
  let names: string[];
  try {
    names = await readdir(tasksRoot);
  } catch {
    return [];
  }
  const out: TaskSummaryDto[] = [];
  for (const name of names) {
    let paths: TaskCapsulePaths;
    try {
      paths = buildTaskCapsulePaths(tasksRoot, name);
    } catch {
      continue;
    }
    if (!existsSync(paths.manifestPath)) continue;
    try {
      const m = await manifestIO.load(paths);
      out.push({ taskId: m.taskId, stage: m.stage, title: m.title, createdAt: m.createdAt, updatedAt: m.updatedAt });
    } catch {
      // skip on read failure
    }
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return out;
}

export async function loadManifest(paths: TaskCapsulePaths): Promise<Manifest> {
  try {
    return await manifestIO.load(paths);
  } catch (err) {
    throw cliErrors.io("Failed to read task status; please try again later", err);
  }
}

/**
 * Determine whether the host is online: non-blocking acquire of host.pid.lock.
 * Acquired = host not running (release immediately, return false); cannot acquire (null) = host running (return true);
 * any IO / lock-level exception conservatively treated as "host running" (avoid false offline reports).
 */
export async function probeHostOnline(paths: TaskCapsulePaths): Promise<boolean> {
  // Lock file missing → host cannot be online (host startup always acquires and creates this file). Return early to
  // avoid tryAcquire's O_CREAT side effect recreating a stale control/host.pid.lock under deleted/missing task paths
  // (which the frontend closing connections alone cannot fully prevent under multi-tab / timing races).
  if (!existsSync(paths.hostPidLock)) return false;
  try {
    const handle = await fileLock.tryAcquireNonblocking(paths.hostPidLock);
    if (handle === null) return true; // held = host running
    await handle.release().catch(() => {});
    return false;
  } catch {
    return true; // on exception, conservatively treat as running
  }
}

/** Read all of conversation.jsonl → ConversationRow[] (KB-scale; leniently skips corrupted rows). */
export async function readConversation(paths: TaskCapsulePaths): Promise<ConversationRow[]> {
  const out: ConversationRow[] = [];
  if (!existsSync(paths.conversationJsonl)) return out;
  try {
    for await (const obj of jsonlIO.readLines(paths.conversationJsonl)) {
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        out.push(obj as ConversationRow);
      }
    }
  } catch (err) {
    // The protocol stream throws by default; web rendering prefers fail-soft — return the already-parsed rows.
    console.warn(`readConversation fail-soft: ${(err as Error).message}`);
  }
  return out;
}

export interface EventRow {
  readonly type: string;
  readonly ts: string;
  readonly stage: string;
  readonly eventSeq: number;
  readonly details: Record<string, unknown>;
}

/** Read events.jsonl (physical snake_case → camelCase top-level keys; details kept as-is); optional `since` filter. */
export async function readEvents(paths: TaskCapsulePaths, since?: string): Promise<EventRow[]> {
  const out: EventRow[] = [];
  if (!existsSync(paths.eventsPath)) return out;
  try {
    for await (const obj of jsonlIO.readLines(paths.eventsPath)) {
      if (typeof obj !== "object" || obj === null || Array.isArray(obj)) continue;
      const o = obj as Record<string, unknown>;
      const ts = String(o["ts"] ?? "");
      if (since !== undefined && ts <= since) continue;
      out.push({
        type: String(o["type"] ?? "?"),
        ts,
        stage: String(o["stage"] ?? ""),
        eventSeq: typeof o["event_seq"] === "number" ? (o["event_seq"] as number) : 0,
        details:
          typeof o["details"] === "object" && o["details"] !== null
            ? (o["details"] as Record<string, unknown>)
            : {},
      });
    }
  } catch (err) {
    console.warn(`readEvents fail-soft: ${(err as Error).message}`);
  }
  return out;
}

export type StreamAgent = "meta" | "worker" | "watcher" | "reviewer";

export interface StreamFileInfo {
  /** Filename (with extension; the frontend reuses it as the `file` parameter). */
  readonly file: string;
  readonly sizeBytes: number;
  /** File mtime (ISO). */
  readonly mtime: string;
}

const STREAM_DIRS: Readonly<Record<StreamAgent, (p: TaskCapsulePaths) => string>> = {
  meta: (p) => p.metaStreamsDir,
  worker: (p) => p.workerStreamsDir,
  watcher: (p) => p.watcherStreamsDir,
  reviewer: (p) => p.reviewerStreamsDir,
};

export function isStreamAgent(s: string): s is StreamAgent {
  return s === "meta" || s === "worker" || s === "watcher" || s === "reviewer";
}

/** List an agent's stream files (sorted by mtime ascending, approximating chronological order). */
export async function listStreamFiles(paths: TaskCapsulePaths, agent: StreamAgent): Promise<StreamFileInfo[]> {
  const dir = STREAM_DIRS[agent](paths);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: StreamFileInfo[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const st = await stat(join(dir, name));
      out.push({ file: name, sizeBytes: st.size, mtime: st.mtime.toISOString() });
    } catch {
      // skip
    }
  }
  out.sort((a, b) => (a.mtime < b.mtime ? -1 : a.mtime > b.mtime ? 1 : 0));
  return out;
}

/** Absolute path of a stream file (path-safe: `file` must contain no separators and stay under the agent directory). */
export function streamFilePath(paths: TaskCapsulePaths, agent: StreamAgent, file: string): string {
  if (file.includes("/") || file.includes("\\") || file.includes("\0") || file === "." || file === "..") {
    throw cliErrors.taskIdInvalid(`unsafe stream file: ${file}`);
  }
  return join(STREAM_DIRS[agent](paths), file);
}

/** Read agent_prompts/<sid>.md (path safety via paths.agentPromptPath's checkPathComponent). */
export async function readAgentPrompt(paths: TaskCapsulePaths, sessionId: string): Promise<string> {
  let p: string;
  try {
    p = paths.agentPromptPath(sessionId as never);
  } catch {
    throw cliErrors.taskIdInvalid(`unsafe sessionId: ${sessionId}`);
  }
  if (!existsSync(p)) throw cliErrors.fileNotFound(p);
  try {
    return await readFile(p, "utf8");
  } catch (err) {
    throw cliErrors.io("Read failed; please try again later", err);
  }
}

/** Absolute path of host.log (control/host.log, matching where hostSpawn writes it). */
export function hostLogPath(paths: TaskCapsulePaths): string {
  return join(paths.control, "host.log");
}

/** Tail the last N lines of host.log (default 500). */
export async function readHostLogTail(paths: TaskCapsulePaths, tailN = 500): Promise<string> {
  const p = hostLogPath(paths);
  if (!existsSync(p)) return "";
  try {
    const text = await readFile(p, "utf8");
    const lines = text.split("\n");
    return lines.slice(-tailN).join("\n");
  } catch (err) {
    throw cliErrors.io("Failed to read log; please try again later", err);
  }
}

// ---- workspace file tree / download ----

export interface FileTreeEntry {
  readonly name: string;
  readonly relPath: string;
  readonly type: "file" | "dir";
  readonly sizeBytes?: number;
}

/** Workspace directory tree (shallow recursive walk). */
export async function listWorkspaceTree(paths: TaskCapsulePaths): Promise<FileTreeEntry[]> {
  const root = paths.workspace;
  if (!existsSync(root)) return [];
  const out: FileTreeEntry[] = [];
  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > 6) return;
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix.length > 0 ? `${prefix}/${e.name}` : e.name;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        out.push({ name: e.name, relPath: rel, type: "dir" });
        await walk(abs, rel, depth + 1);
      } else {
        let size = 0;
        try {
          size = (await stat(abs)).size;
        } catch {
          // ignore
        }
        out.push({ name: e.name, relPath: rel, type: "file", sizeBytes: size });
      }
    }
  }
  await walk(root, "", 0);
  return out;
}

/**
 * Resolve a workspace-relative path → absolute path, verifying it stays under the workspace subtree (prevents .. escape).
 * Failure throws cli_task_id_invalid (→ 400) / cli_file_not_found (→ 404).
 */
export function resolveWorkspaceFile(paths: TaskCapsulePaths, relPath: string): string {
  return resolveUnder(paths.workspace, relPath);
}

/** Resolve control/uploads/<uploadId>/<filename> → absolute path, verifying it stays under the uploadsDir subtree. */
export function resolveUploadFile(paths: TaskCapsulePaths, uploadId: string, filename: string): string {
  return resolveUnder(paths.uploadsDir, `${uploadId}/${filename}`);
}

function resolveUnder(baseDir: string, relPath: string): string {
  if (relPath.includes("\0")) throw cliErrors.taskIdInvalid("unsafe path: nul char");
  const baseResolved = resolve(baseDir);
  const target = resolve(baseResolved, normalize(relPath));
  const rel = relative(baseResolved, target);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`)) {
    throw cliErrors.taskIdInvalid(`path escapes base: ${relPath}`);
  }
  if (!existsSync(target)) throw cliErrors.fileNotFound(target);
  return target;
}
