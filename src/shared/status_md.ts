/**
 * status.md rendering.
 *
 * status.md is a user-facing derived view, built from the manifest and
 * conversation.jsonl (it does not expose internal terms such as raw stage
 * strings, envelopes, or harness). Created on demand; fail-soft (errors are
 * caught internally and do not propagate to the caller); no dedicated lock
 * (last-writer-wins).
 *
 * Rendered by both the host (after each stage transition and after writing a
 * message to the user) and the CLI (when writing the manifest on submit / pause
 * / resume / done / cancel / rename). It lives in shared/ so both can call it
 * without introducing a host -> cli dependency.
 */
import { existsSync } from "node:fs";

import { atomicWriter } from "./atomic.js";
import { conversationIO, type ConversationMetaIntent, type ConversationRow } from "./conversation.js";
import { manifestIO, type Manifest, type Stage } from "./manifest.js";
import type { TaskCapsulePaths } from "./paths.js";

/** Stage to user-facing label. The Record<Stage, string> type ensures no stage is missed at compile time. */
export const STAGE_USER_LABEL: Readonly<Record<Stage, string>> = {
  submitted: "Received, getting ready to start",
  clarifying: "Confirming the requirements with you",
  bootstrapping: "Designing the execution plan",
  running: "In progress",
  awaiting_user: "Waiting for you to review / answer a question",
  paused: "Paused (use resume to continue)",
  done: "Done",
  cancelled: "Cancelled",
  failed: "Could not be completed",
};

const META_INTENT_LABEL: Readonly<Record<ConversationMetaIntent, string>> = {
  question: "Needs your answer",
  delivery_report: "Progress report",
  notification: "Progress update",
};

/** ISO8601 microseconds to human-readable (matching conversation.md: `YYYY-MM-DD HH:MM`). */
function formatTsHuman(tsIso: string): string {
  const tIdx = tsIso.indexOf("T");
  if (tIdx === -1) return tsIso;
  const datePart = tsIso.slice(0, tIdx);
  const hhmm = tsIso.slice(tIdx + 1, tIdx + 6);
  return `${datePart} ${hhmm}`;
}

function renderMetaMessage(row: ConversationRow): string {
  const ts = formatTsHuman(row.ts);
  const intentLabel = row.intent ? META_INTENT_LABEL[row.intent] : "Progress update";
  const bodyLines = row.body
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return `> [${ts}] ${intentLabel}\n${bodyLines}`;
}

/** Stage-aware action hints; terminal stages render no interaction entries. */
function renderActionHints(stage: Stage, taskId: string): string {
  const id = taskId;
  switch (stage) {
    case "clarifying":
      return [
        `Answer the question: deputy answer ${id} "<your answer>"`,
        `Upload a reference file: deputy upload ${id} <file path>`,
        `Pause the task: deputy pause ${id}`,
        `Abandon the task: deputy cancel ${id}`,
      ].join("\n");
    case "awaiting_user":
      return [
        `Reply / add thoughts: deputy feedback ${id} "<content>"`,
        `Accept the delivery: deputy done ${id}`,
        `Upload a reference file: deputy upload ${id} <file path>`,
        `Pause the task: deputy pause ${id}`,
        `Abandon the task: deputy cancel ${id}`,
      ].join("\n");
    case "submitted":
    case "bootstrapping":
    case "running":
      return [
        `Add feedback / more info: deputy feedback ${id} "<content>"`,
        `Upload a reference file: deputy upload ${id} <file path>`,
        `Pause the task: deputy pause ${id}`,
        `Abandon the task: deputy cancel ${id}`,
      ].join("\n");
    case "paused":
      return [`Resume the task: deputy resume ${id}`, `Abandon the task: deputy cancel ${id}`].join("\n");
    case "done":
    case "failed":
    case "cancelled":
      return "";
    default:
      return "";
  }
}

/** Assemble the status.md text (pure function, for easy testing). */
export function buildStatusMd(
  manifest: Manifest,
  recentMetaMessages: ReadonlyArray<ConversationRow>,
): string {
  const titleText = manifest.title.trim().length > 0 ? manifest.title : "(untitled)";
  const blocks: string[] = [];
  blocks.push(`# Task: ${titleText}`);
  blocks.push(`**Status**: ${STAGE_USER_LABEL[manifest.stage]}`);

  if (
    (manifest.stage === "cancelled" || manifest.stage === "failed") &&
    manifest.lastError !== null &&
    manifest.lastError.message.trim().length > 0
  ) {
    const label = manifest.stage === "cancelled" ? "Cancellation reason" : "Reason";
    blocks.push(`**${label}**: ${manifest.lastError.message}`);
  }

  if (recentMetaMessages.length > 0) {
    blocks.push(recentMetaMessages.map(renderMetaMessage).join("\n\n"));
  }

  blocks.push("---");

  const meta: string[] = [
    `**Task ID**: \`${manifest.taskId}\``,
    `**Created**: ${formatTsHuman(manifest.createdAt)}`,
    `**Last updated**: ${formatTsHuman(manifest.updatedAt)}`,
  ];
  blocks.push(meta.join("\n"));

  const hints = renderActionHints(manifest.stage, manifest.taskId);
  if (hints.length > 0) blocks.push(hints);

  return `${blocks.join("\n\n")}\n`;
}

/**
 * Derive status.md from the manifest and conversation.jsonl; fail-soft (errors are caught internally and do not propagate to the caller).
 */
export async function renderStatusMd(paths: TaskCapsulePaths): Promise<void> {
  try {
    const manifest = await manifestIO.load(paths);
    let recent: ReadonlyArray<ConversationRow> = [];
    try {
      recent = await conversationIO.readLastMetaToUser(paths, 3);
    } catch (err) {
      console.warn(`renderStatusMd: read conversation failed (fail-soft): ${(err as Error).message}`);
    }
    await atomicWriter.writeText(paths.statusMd, buildStatusMd(manifest, recent));
  } catch (err) {
    console.warn(`renderStatusMd failed (fail-soft): ${(err as Error).message}`);
  }
}

/** Return status.md content (for the status subcommand); renders on demand first if the file is missing. */
export async function readOrRenderStatusMd(paths: TaskCapsulePaths): Promise<string> {
  if (!existsSync(paths.statusMd)) {
    await renderStatusMd(paths);
  }
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(paths.statusMd, "utf8");
  } catch {
    // Still unreadable after rendering (rare IO failure): fall back to rendering in memory.
    const manifest = await manifestIO.load(paths);
    let recent: ReadonlyArray<ConversationRow> = [];
    try {
      recent = await conversationIO.readLastMetaToUser(paths, 3);
    } catch {
      recent = [];
    }
    return buildStatusMd(manifest, recent);
  }
}
