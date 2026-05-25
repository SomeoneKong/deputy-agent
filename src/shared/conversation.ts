/**
 * Two-layer persistence for bidirectional user-Meta messaging.
 *
 * - `conversation.jsonl` is the source of truth (append-only, full body,
 *   structured; read only by this module and status rendering).
 * - `conversation.md` is a debug-only view (appended from the same data after
 *   the jsonl write; not parsed by any system component).
 *
 * Write order: append jsonl (with fsync) first, then append md, both inside the
 * same `conversation.lock`. A jsonl write failure always propagates to the caller
 * (both `LockTimeoutError` and I/O errors); an md failure only warns, since the
 * jsonl is the source of truth and the md can be rebuilt.
 */
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { atomicWriter } from "./atomic.js";
import { jsonlIO } from "./jsonl.js";
import type { EnvelopeId, SessionId } from "./ids.js";
import { withLock } from "./locks.js";
import type { TaskCapsulePaths } from "./paths.js";
import type { Iso8601Us } from "./timeUtils.js";
import { nowIso8601Us } from "./timeUtils.js";

export type ConversationDirection = "user_to_meta" | "meta_to_user";

/** User-side source (CLI and Web frontend entry points). */
export type ConversationUserSource = "user_cli" | "user_web";

export type ConversationUserKind =
  | "raw_task"
  | "user_clarify_answer"
  | "user_feedback"
  | "user_upload"
  | "user_cancel"
  | "user_done_confirmation";

export type ConversationMetaIntent = "question" | "delivery_report" | "notification";

export interface ConversationRow {
  readonly ts: Iso8601Us;
  readonly direction: ConversationDirection;
  readonly kind: ConversationUserKind | "meta_message";
  readonly body: string;
  readonly envId: EnvelopeId | null;
  readonly intent: ConversationMetaIntent | null;
  readonly from: string; // user rows: ConversationUserSource; meta rows: "meta_session:<sid>"
  readonly extras?: Readonly<Record<string, unknown>>;
}

export interface AppendUserToMetaOpts {
  readonly paths: TaskCapsulePaths;
  readonly kind: ConversationUserKind;
  readonly source: ConversationUserSource;
  readonly body: string;
  readonly envId?: EnvelopeId | null;
  readonly extras?: Record<string, unknown>;
}

export interface AppendMetaToUserOpts {
  readonly paths: TaskCapsulePaths;
  readonly intent: ConversationMetaIntent;
  readonly body: string;
  readonly fromSessionId: SessionId;
}

export interface ConversationIO {
  appendUserToMeta(opts: AppendUserToMetaOpts): Promise<void>;
  appendMetaToUser(opts: AppendMetaToUserOpts): Promise<void>;
  readLastMetaToUser(paths: TaskCapsulePaths, limit?: number): Promise<ReadonlyArray<ConversationRow>>;
  rebuildMdFromJsonl(paths: TaskCapsulePaths): Promise<void>;
  ensureMdExistsOrRebuild(paths: TaskCapsulePaths): Promise<void>;
}

const SIZE_WARN_THRESHOLD_BYTES = 1_000_000;

const INTENT_LABEL: Readonly<Record<ConversationMetaIntent, string>> = {
  question: "Needs your answer",
  delivery_report: "Stage report",
  notification: "Progress update",
};

const USER_KIND_LABEL: Readonly<Record<ConversationUserKind, string>> = {
  raw_task: "Submit task",
  user_clarify_answer: "Answer clarification",
  user_feedback: "Add feedback",
  user_upload: "Upload file",
  user_cancel: "Cancel task",
  user_done_confirmation: "Confirm receipt",
};

async function statOrNull(path: string): Promise<{ size: number } | null> {
  try {
    return await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function formatTsHuman(tsIso: string): string {
  const tIdx = tsIso.indexOf("T");
  if (tIdx !== -1) {
    const datePart = tsIso.slice(0, tIdx);
    const hhmm = tsIso.slice(tIdx + 1, tIdx + 6);
    return `${datePart} ${hhmm} UTC`;
  }
  return tsIso;
}

function renderMdBlock(row: ConversationRow): string {
  const tsHuman = formatTsHuman(row.ts);
  let header: string;
  if (row.direction === "meta_to_user") {
    const intent = row.intent ?? "";
    const intentLabel = row.intent ? INTENT_LABEL[row.intent] : "";
    header =
      `---\n` +
      `ts: ${tsHuman}\n` +
      `direction: meta_to_user\n` +
      `intent: ${intent}${intentLabel ? ` (${intentLabel})` : ""}\n` +
      `from: ${row.from}\n` +
      `---\n\n`;
  } else {
    const kind = row.kind;
    const kindLabel = kind in USER_KIND_LABEL ? USER_KIND_LABEL[kind as ConversationUserKind] : kind;
    const envLine = row.envId ? `env_id: ${row.envId}\n` : "";
    const extras = row.extras ?? {};
    const extrasLines = Object.entries(extras)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}\n`)
      .join("");
    header =
      `---\n` +
      `ts: ${tsHuman}\n` +
      `direction: user_to_meta\n` +
      `kind: ${kind} (${kindLabel})\n` +
      `from: ${row.from}\n` +
      `${envLine}` +
      `${extrasLines}` +
      `---\n\n`;
  }
  return `${header}${row.body}\n\n`;
}

/** Lenient read: skip corrupt lines (with a warning); return [] when the file does not exist. */
async function readRowsLenient(paths: TaskCapsulePaths): Promise<ConversationRow[]> {
  const st = await statOrNull(paths.conversationJsonl);
  if (st === null) return [];
  if (st.size > SIZE_WARN_THRESHOLD_BYTES) {
    console.warn(`conversation.jsonl size ${st.size} bytes > ${SIZE_WARN_THRESHOLD_BYTES}; consider reverse-streaming read`);
  }
  let text: string;
  try {
    text = await readFile(paths.conversationJsonl, "utf8");
  } catch (err) {
    console.warn(`read conversation.jsonl failed: ${(err as Error).message}`);
    return [];
  }
  const rows: ConversationRow[] = [];
  // Partial-tail semantics (matching jsonlIO.readLines): a last line without a trailing `\n` is a
  // crash partial write, so drop the final segment and keep half-written lines out of the view.
  // When the file ends with `\n` the final split segment is empty and is skipped by the trim below.
  const segments = text.split("\n");
  if (!text.endsWith("\n") && segments.length > 0) segments.pop();
  for (const line of segments) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const row = JSON.parse(trimmed) as unknown;
      // Exclude arrays (typeof [] === "object"), matching jsonlIO.readLines's non-object strictness.
      if (row !== null && typeof row === "object" && !Array.isArray(row)) rows.push(row as ConversationRow);
    } catch {
      console.warn(`conversation.jsonl line skip (corrupted): ${trimmed.slice(0, 80)}`);
    }
  }
  return rows;
}

async function writeOneRowLocked(paths: TaskCapsulePaths, row: ConversationRow): Promise<void> {
  await mkdir(dirname(paths.conversationLock), { recursive: true });
  await withLock(paths.conversationLock, async () => {
    // jsonl first: jsonlIO.appendLine prepends a `\n` when the previous write did not end with one,
    // isolating a half-written line so the new line is not concatenated onto it. Failures propagate to the caller.
    await jsonlIO.appendLine(paths.conversationJsonl, row);
    // md second (same lock); failures only warn.
    try {
      await appendFile(paths.conversationMd, renderMdBlock(row), { encoding: "utf8" });
    } catch (err) {
      console.warn(`append conversation.md failed: ${(err as Error).message}`);
    }
  });
}

async function appendUserToMeta(opts: AppendUserToMetaOpts): Promise<void> {
  const row: ConversationRow = {
    ts: nowIso8601Us(),
    direction: "user_to_meta",
    kind: opts.kind,
    body: opts.body,
    envId: opts.envId ?? null,
    intent: null,
    from: opts.source,
    ...(opts.extras !== undefined ? { extras: opts.extras } : {}),
  };
  await writeOneRowLocked(opts.paths, row);
}

async function appendMetaToUser(opts: AppendMetaToUserOpts): Promise<void> {
  const row: ConversationRow = {
    ts: nowIso8601Us(),
    direction: "meta_to_user",
    kind: "meta_message",
    body: opts.body,
    envId: null,
    intent: opts.intent,
    from: `meta_session:${opts.fromSessionId}`,
  };
  await writeOneRowLocked(opts.paths, row);
}

async function readLastMetaToUser(
  paths: TaskCapsulePaths,
  limit = 3,
): Promise<ReadonlyArray<ConversationRow>> {
  if (limit <= 0) return [];
  const rows = (await readRowsLenient(paths)).filter((r) => r.direction === "meta_to_user");
  return rows.slice(-limit).reverse(); // reverse chronological (newest first)
}

async function rebuildMdFromJsonl(paths: TaskCapsulePaths): Promise<void> {
  const st = await statOrNull(paths.conversationJsonl);
  if (st === null) return;
  const rows = await readRowsLenient(paths);
  await atomicWriter.writeText(paths.conversationMd, rows.map(renderMdBlock).join(""));
}

async function ensureMdExistsOrRebuild(paths: TaskCapsulePaths): Promise<void> {
  const jsonlSt = await statOrNull(paths.conversationJsonl);
  if (jsonlSt === null) return;
  const mdSt = await statOrNull(paths.conversationMd);
  if (mdSt !== null && mdSt.size > 0) return;
  try {
    await rebuildMdFromJsonl(paths);
  } catch (err) {
    console.warn(`rebuild conversation.md failed: ${(err as Error).message}`);
  }
}

export const conversationIO: ConversationIO = {
  appendUserToMeta,
  appendMetaToUser,
  readLastMetaToUser,
  rebuildMdFromJsonl,
  ensureMdExistsOrRebuild,
};
