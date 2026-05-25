/**
 * Branded identifier types, their generation and validation, and path-safety checks.
 *
 * `SessionId` is defined in the wrapper's public contract; this module re-exports
 * it rather than redefining it.
 */
import { randomBytes } from "node:crypto";

import { PathEscapeError } from "./errors.js";

export type { SessionId } from "../wrapper/types/common.js";

export type TaskId = string & { readonly __brand: "TaskId" };
export type EnvelopeId = string & { readonly __brand: "EnvelopeId" };
export type UploadId = string & { readonly __brand: "UploadId" };
export type TopicSlug = string & { readonly __brand: "TopicSlug" };

export const TASK_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const HEX8_PATTERN = /^[a-f0-9]{8}$/;
const TOPIC_SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function isValidTaskId(s: string): s is TaskId {
  return TASK_ID_PATTERN.test(s);
}

/** Throws `PathEscapeError` on invalid input (same check buildTaskCapsulePaths uses for task_id). */
export function assertTaskId(s: string): asserts s is TaskId {
  if (!isValidTaskId(s)) {
    throw new PathEscapeError(`invalid task_id: ${JSON.stringify(s)}`, { details: { value: s } });
  }
}

export function isValidEnvelopeId(s: string): s is EnvelopeId {
  return HEX8_PATTERN.test(s);
}

export function isValidTopicSlug(s: string): s is TopicSlug {
  return TOPIC_SLUG_PATTERN.test(s);
}

/** 8-char hex (4 bytes from a CSPRNG), path-safe. */
export function genEnvelopeId(): EnvelopeId {
  return randomBytes(4).toString("hex") as EnvelopeId;
}

/** 8-char hex (same scheme as envelopeId, semantically independent). */
export function genUploadId(): UploadId {
  return randomBytes(4).toString("hex") as UploadId;
}

/** Default task_id: `<yyyymmdd>-<hhmm>-<6char_hex>` (UTC). */
export function genDefaultTaskId(): TaskId {
  const d = new Date();
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const min = d.getUTCMinutes().toString().padStart(2, "0");
  const hex = randomBytes(3).toString("hex");
  return `${yyyy}${mm}${dd}-${hh}${min}-${hex}` as TaskId;
}

/** Worker sessionSeq filename prefix: zero-padded to 4 digits. */
export function formatSessionSeq(n: number): string {
  return n.toString().padStart(4, "0");
}

/**
 * Path-safety check: rejects empty strings, path separators, `.`, `..`, absolute
 * paths, and NUL. Throws `PathEscapeError` on failure. `what` is the semantic name
 * of the checked value, used in the error message.
 */
export function checkPathComponent(name: string, what: string): void {
  const reject = (reason: string): never => {
    throw new PathEscapeError(`unsafe ${what} (${reason}): ${JSON.stringify(name)}`, {
      details: { what, value: name, reason },
    });
  };
  if (name.length === 0) reject("empty");
  if (name.includes("/") || name.includes("\\")) reject("path_separator");
  if (name.includes("\0")) reject("nul_char");
  if (name === "." || name === "..") reject("dot_segment");
  // Absolute path (POSIX `/...` is already caught by the separator check; this handles the Windows drive `C:` form)
  if (/^[a-zA-Z]:/.test(name)) reject("absolute_path");
}
