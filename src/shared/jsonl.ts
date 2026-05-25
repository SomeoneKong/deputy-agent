/**
 * JSONL append / read / corruption handling.
 *
 * One JSON object per line with an explicit LF; JSON.stringify preserves the
 * original unicode; append-only.
 * Corruption rules: a final line without a trailing `\n` (partial write) is
 * skipped on read; a non-final line that fails UTF-8 decoding or JSON parsing,
 * or an empty line, raises `CorruptJsonlError` (with the line number), leaving
 * the quarantine / fail-soft decision to each reader.
 *
 * This tool serves host/CLI persistence streams such as events, state, and
 * conversation; it is not the writer for the stream files under
 * `workspace/streams/` or `control/streams/`.
 */
import { createReadStream } from "node:fs";
import { open, readFile, rename, stat } from "node:fs/promises";
import { TextDecoder } from "node:util";

import { CorruptJsonlError } from "./errors.js";
import { nowIso8601Us } from "./timeUtils.js";

const LF = 0x0a;

export interface JsonlIO {
  appendLine(path: string, obj: object): Promise<void>;
  readLines(path: string): AsyncIterableIterator<object>;
  /** Truncate a half-written partial tail; the caller must hold the lock; returns whether anything was truncated. */
  truncatePartialTail(path: string): Promise<boolean>;
  /** Rename to `<path>.corrupt.<ts>` (colons stripped from ts); returns the new path. */
  quarantine(path: string): Promise<string>;
}

async function lastByte(path: string, size: number): Promise<number | undefined> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, size - 1);
    return buf[0];
  } finally {
    await fh.close();
  }
}

async function appendLine(path: string, obj: object): Promise<void> {
  const line = JSON.stringify(obj);
  let needLeadingNl = false;
  try {
    const st = await stat(path);
    if (st.size > 0 && (await lastByte(path, st.size)) !== LF) {
      // The previous partial write did not end with \n: prepend a \n to isolate the
      // half-written line, so the new line is not concatenated onto its tail.
      needLeadingNl = true;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const fh = await open(path, "a");
  try {
    await fh.write(`${needLeadingNl ? "\n" : ""}${line}\n`);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

function parseSegment(segment: Buffer, lineNo: number, path: string, decoder: TextDecoder): object {
  if (segment.length === 0) {
    throw new CorruptJsonlError(`empty line at ${path}:${lineNo}`, { details: { path, lineNo } });
  }
  let text: string;
  try {
    text = decoder.decode(segment);
  } catch {
    throw new CorruptJsonlError(`invalid UTF-8 at ${path}:${lineNo}`, { details: { path, lineNo } });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CorruptJsonlError(`invalid JSON at ${path}:${lineNo}`, { details: { path, lineNo } });
  }
  // Valid JSON but not an object (array / scalar / null) is also treated as corrupt; otherwise downstream destructuring gets the wrong shape and fails silently instead of quarantining.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CorruptJsonlError(`non-object JSON line at ${path}:${lineNo}`, { details: { path, lineNo } });
  }
  return parsed;
}

async function* readLines(path: string): AsyncIterableIterator<object> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let leftover = Buffer.alloc(0);
  let lineNo = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      let buf = Buffer.concat([leftover, chunk as Buffer]);
      let idx: number;
      while ((idx = buf.indexOf(LF)) !== -1) {
        const segment = buf.subarray(0, idx);
        buf = buf.subarray(idx + 1);
        lineNo += 1;
        yield parseSegment(segment, lineNo, path, decoder);
      }
      leftover = buf;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  // Any leftover (a final line without a trailing \n) is a partial write: skip it (neither yield nor throw).
}

async function truncatePartialTail(path: string): Promise<boolean> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  if (size === 0) return false;
  if ((await lastByte(path, size)) === LF) return false; // already on a clean \n boundary

  const content = await readFile(path);
  const lastNl = content.lastIndexOf(LF);
  const newLen = lastNl === -1 ? 0 : lastNl + 1;
  const fh = await open(path, "r+");
  try {
    await fh.truncate(newLen);
    await fh.sync();
  } finally {
    await fh.close();
  }
  return true;
}

async function quarantine(path: string): Promise<string> {
  const ts = nowIso8601Us().replace(/:/g, "");
  const dest = `${path}.corrupt.${ts}`;
  await rename(path, dest);
  return dest;
}

export const jsonlIO: JsonlIO = { appendLine, readLines, truncatePartialTail, quarantine };
