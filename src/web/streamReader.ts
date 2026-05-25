/**
 * Shared stream JSONL reader: reverse tail + forward incremental read.
 *
 * The stream JSONL is an audit log (read-only side); this reader only reads, never writes. Reading discipline:
 * - safely skip partial tail: trailing bytes not ending with \n are a writer's half-written state → not parsed, offset not advanced
 * - corrupted-row fail-soft: a single row failing JSON parse → log warn, skip, and keep advancing offset (unlike the protocol stream which throws)
 * - does not interpret schema: returns StreamJsonlLine; kind semantics are interpreted by the rendering layer
 */
import { open, stat } from "node:fs/promises";

import type { StreamJsonlLine } from "../wrapper/index.js";

const LF = 0x0a;

export interface StreamReadResult {
  /** Parsed complete lines. */
  readonly lines: ReadonlyArray<StreamJsonlLine>;
  /** Advanced byte offset (for forward increments). */
  readonly nextOffset: number;
  /** Offset of the earliest line in this batch (for loading earlier content). */
  readonly headOffset: number;
}

const EMPTY: StreamReadResult = { lines: [], nextOffset: 0, headOffset: 0 };

async function sizeOrNull(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function readRange(path: string, from: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const fh = await open(path, "r");
  try {
    await fh.read(buf, 0, length, from);
  } finally {
    await fh.close();
  }
  return buf;
}

/**
 * Parse complete lines within [0, completeLen) (buf holds those bytes, already trimmed to \n boundaries).
 * Corrupted / empty lines are skipped with a warn.
 */
function parseLines(buf: Buffer, completeLen: number, logLabel: string): StreamJsonlLine[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const lines: StreamJsonlLine[] = [];
  let start = 0;
  let lineNo = 0;
  while (start < completeLen) {
    let nl = buf.indexOf(LF, start);
    if (nl === -1 || nl >= completeLen) nl = completeLen;
    const segment = buf.subarray(start, nl);
    start = nl + 1;
    lineNo += 1;
    if (segment.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(segment));
    } catch (err) {
      console.warn(`stream reader row-level skip ${logLabel} line~${lineNo}: ${(err as Error).message}`);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn(`stream reader row-level skip ${logLabel} line~${lineNo}: not an object`);
      continue;
    }
    lines.push(parsed as StreamJsonlLine);
  }
  return lines;
}

/**
 * Forward increment: read from offset to the current end of file.
 * - last segment has no trailing \n (partial write) → conservatively not counted into offset
 * - file missing → empty result
 */
export async function readStreamFrom(path: string, offset: number): Promise<StreamReadResult> {
  const size = await sizeOrNull(path);
  if (size === null) return { lines: [], nextOffset: offset, headOffset: offset };
  if (size <= offset) return { lines: [], nextOffset: offset, headOffset: offset };

  const length = size - offset;
  const buf = await readRange(path, offset, length);
  const lastNl = buf.lastIndexOf(LF);
  if (lastNl === -1) {
    // No complete line in the whole segment → all half-lines, do not advance
    return { lines: [], nextOffset: offset, headOffset: offset };
  }
  const completeLen = lastNl + 1;
  const lines = parseLines(buf, completeLen, path);
  return { lines, nextOffset: offset + completeLen, headOffset: offset };
}

/**
 * Reverse tail: from the end of file (or beforeOffset), scan backward to the n-th newline (or file start), and return the complete lines in that range.
 * - beforeOffset: when loading earlier content, pass the previous headOffset (reads the [0, beforeOffset) range)
 * - file missing → empty result
 */
export async function tailStreamLines(
  path: string,
  n: number,
  opts?: { beforeOffset?: number },
): Promise<StreamReadResult> {
  if (n <= 0) return EMPTY;
  const size = await sizeOrNull(path);
  if (size === null) return EMPTY;

  // Right bound of the read range: beforeOffset (loading earlier) or end of file.
  const right = opts?.beforeOffset !== undefined ? Math.min(opts.beforeOffset, size) : size;
  if (right <= 0) return { lines: [], nextOffset: right, headOffset: 0 };

  const buf = await readRange(path, 0, right);

  // Trailing partial-write (only possible on the first tail / when right=size): trim to the last \n.
  let usableLen = right;
  if (opts?.beforeOffset === undefined) {
    const lastNl = buf.lastIndexOf(LF);
    if (lastNl === -1) return { lines: [], nextOffset: right, headOffset: right };
    usableLen = lastNl + 1; // includes the trailing \n
  }

  // From usableLen, scan backward for n newlines (excluding the trailing one), keeping the last n lines.
  let count = 0;
  let head = 0;
  for (let i = usableLen - 2; i >= 0; i--) {
    if (buf[i] === LF) {
      count += 1;
      if (count === n) {
        head = i + 1;
        break;
      }
    }
  }
  // count < n → fewer than n lines, start from file beginning (head=0)

  const slice = buf.subarray(head, usableLen);
  const lines = parseLines(slice, slice.length, path);
  return { lines, nextOffset: usableLen, headOffset: head };
}
