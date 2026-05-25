/**
 * Worker stream preprocessing + body.md rendering.
 *
 * Pure functions: take StreamJsonlLine (SessionEvent + _writer), drop / keep / truncate by kind,
 * render into ProcessedRecord (an intermediate form), then render into a readable body.md log.
 * Does not touch the filesystem or the bus.
 *
 * Per-field truncation thresholds (KB = 1024 bytes): text 4 KB / thinking 2 KB /
 * tool_use.input 2 KB / tool_result 4 KB / compact_ended.summary 2 KB; total body per window 32 KB.
 * Truncation respects UTF-8-safe character boundaries (never cuts a multi-byte character in half).
 */
import type {
  AssistantBlock,
  EnvelopeId,
  HostInjectKind,
  HostToolContentBlock,
  SessionEvent,
  StreamJsonlLine,
} from "../../wrapper/index.js";
import type { Lang, LiteralsKey } from "../../prompts/index.js";
import { formatTemplate, literals } from "../../prompts/index.js";

// ---- Truncation thresholds (bytes) ----

const KB = 1024;
export const TRUNCATE_TEXT_BYTES = 4 * KB;
export const TRUNCATE_THINKING_BYTES = 2 * KB;
export const TRUNCATE_TOOL_INPUT_BYTES = 2 * KB;
export const TRUNCATE_TOOL_RESULT_BYTES = 4 * KB;
export const TRUNCATE_COMPACT_SUMMARY_BYTES = 2 * KB;
export const TRUNCATE_SUBAGENT_TEXT_BYTES = 2 * KB; // truncates subagent_started.description / subagent_stopped.summary
export const BODY_TOTAL_LIMIT_BYTES = 32 * KB;
/** Byte budget reserved for the truncation-tail note (about 200 bytes). */
const BODY_TAIL_RESERVE_BYTES = 200;

// ---- ProcessedRecord ----

export interface ProcessedRecord {
  readonly kind: string;
  readonly receivedAt: number;
  readonly lines: ReadonlyArray<string>;
  readonly injectMarkerKind?: HostInjectKind;
  readonly injectEnvelopeIds?: ReadonlyArray<EnvelopeId>;
}

// ---- UTF-8-safe truncation ----

const encoder = new TextEncoder();

function byteLen(s: string): number {
  return encoder.encode(s).length;
}

/**
 * Truncate a string to at most maxBytes (UTF-8 bytes); on truncation, back off to a safe
 * character boundary and append a marker. Returns { text, truncated, fullBytes }.
 */
function truncateBytes(s: string, maxBytes: number): { text: string; truncated: boolean; fullBytes: number } {
  const full = encoder.encode(s);
  if (full.length <= maxBytes) return { text: s, truncated: false, fullBytes: full.length };
  // Back off from maxBytes to a character boundary: a UTF-8 continuation byte is 0b10xxxxxx (0x80..0xBF).
  let cut = maxBytes;
  while (cut > 0 && (full[cut]! & 0xc0) === 0x80) cut -= 1;
  const head = new TextDecoder("utf-8").decode(full.subarray(0, cut));
  return {
    text: `${head}... (truncated, full ${full.length} bytes)`,
    truncated: true,
    fullBytes: full.length,
  };
}

// ---- HostToolContentBlock stringification ----

function stringifyToolContent(blocks: ReadonlyArray<HostToolContentBlock>): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        parts.push(b.text);
        break;
      case "image":
        parts.push(`[image ${b.mediaType}]`);
        break;
      case "resource":
        parts.push(`[resource ${b.uri}${b.mediaType !== undefined ? ` ${b.mediaType}` : ""}]`);
        break;
      case "json":
        parts.push(JSON.stringify(b.value));
        break;
    }
  }
  return parts.join("\n");
}

// ---- Block-level rendering ----

function renderBlock(block: AssistantBlock): string {
  switch (block.type) {
    case "text":
      return `[text] ${truncateBytes(block.text, TRUNCATE_TEXT_BYTES).text}`;
    case "thinking":
      return `[thinking] ${truncateBytes(block.thinking, TRUNCATE_THINKING_BYTES).text}`;
    case "tool_use": {
      const inputJson = JSON.stringify(block.input ?? null);
      const truncated = truncateBytes(inputJson, TRUNCATE_TOOL_INPUT_BYTES).text;
      return `[tool_use] ${block.toolName}(${truncated})`;
    }
  }
}

// ---- Single SessionEvent -> ProcessedRecord | null (null = skip) ----

function processEvent(event: SessionEvent, lit: Readonly<Record<LiteralsKey, string>>): ProcessedRecord | null {
  switch (event.kind) {
    case "assistant_block":
      // Subagent internal output (non-empty parentToolUseId) is rendered into the window the same
      // as the main agent's: the watcher must directly supervise the subagent's actual work (tool
      // calls / reasoning), not just the subagent's self-reported summary.
      return { kind: "assistant_block", receivedAt: event.receivedAt, lines: [renderBlock(event.block)] };

    case "tool_result_recorded": {
      const contentStr = stringifyToolContent(event.result.content);
      const t = truncateBytes(contentStr, TRUNCATE_TOOL_RESULT_BYTES);
      const ok = !event.result.isError;
      const line = `[tool_result] ${event.toolName} ok=${ok}, contentLen=${byteLen(contentStr)}: ${t.text}`;
      return { kind: "tool_result", receivedAt: event.receivedAt, lines: [line] };
    }

    case "session_started":
      return {
        kind: "session_started",
        receivedAt: event.receivedAt,
        lines: [
          `${lit.watcher_record_session_started} role=${event.role}, model=${event.model.modelId}`,
        ],
      };

    case "session_resumed":
      return {
        kind: "session_resumed",
        receivedAt: event.receivedAt,
        lines: [`${lit.watcher_record_session_resumed} (resume)`],
      };

    case "session_ended": {
      const isError = event.reason === "fatal_runtime_error";
      return {
        kind: "session_ended",
        receivedAt: event.receivedAt,
        lines: [
          `${formatTemplate(lit.watcher_record_session_ended, { is_error: String(isError) })} reason=${event.reason}`,
        ],
      };
    }

    case "compact_started":
      return {
        kind: "compact_started",
        receivedAt: event.receivedAt,
        lines: [`${lit.watcher_record_compact_started} reason=${event.reason}`],
      };

    case "compact_ended": {
      const summary = event.summary ?? "";
      const t = truncateBytes(summary, TRUNCATE_COMPACT_SUMMARY_BYTES);
      return {
        kind: "compact_ended",
        receivedAt: event.receivedAt,
        lines: [`${lit.watcher_record_compact_ended} success=${event.success}; summary=${t.text}`],
      };
    }

    case "host_inject_requested": {
      const lines: string[] = [];
      for (const block of event.content) {
        if (block.type === "text" && "text" in block) {
          lines.push(`[text] ${truncateBytes(block.text, TRUNCATE_TEXT_BYTES).text}`);
        } else if (block.type === "text") {
          lines.push(`[text] (textPath=${block.textPath})`);
        } else if (block.type === "image") {
          lines.push(`[image ${block.mediaType}]`);
        } else {
          lines.push(`[reference ${block.uri}]`);
        }
      }
      if (lines.length === 0) lines.push("[text] (empty inject)");
      return {
        kind: "host_inject",
        receivedAt: event.receivedAt,
        lines,
        injectMarkerKind: event.marker.kind,
        injectEnvelopeIds: event.marker.envelopeIds,
      };
    }

    case "runtime_error":
      return {
        kind: "runtime_error",
        receivedAt: event.receivedAt,
        lines: [
          `${formatTemplate(lit.watcher_record_runtime_error, { error_kind: event.error.kind })} ` +
            `subKind=${event.error.subKind}, recoverable=${event.recoverable}`,
        ],
      };

    case "provider_raw":
      return {
        kind: "provider_raw",
        receivedAt: event.receivedAt,
        lines: [formatTemplate(lit.watcher_record_provider_raw, { rtype: event.providerEventType })],
      };

    case "subagent_started":
      return {
        kind: "subagent_started",
        receivedAt: event.receivedAt,
        lines: [
          formatTemplate(lit.watcher_record_subagent_started, {
            subagent_type: event.subagentType ?? "?",
            // Truncate the description: an LLM-provided subagent task description can be very long, and without truncation it could blow past the 32KB window cap (the first oversized record is forcibly kept).
            description: truncateBytes(event.description ?? "", TRUNCATE_SUBAGENT_TEXT_BYTES).text,
          }),
        ],
      };

    case "subagent_stopped":
      return {
        kind: "subagent_stopped",
        receivedAt: event.receivedAt,
        lines: [
          formatTemplate(lit.watcher_record_subagent_stopped, {
            agent_id: event.agentId,
            status: event.status,
            summary: truncateBytes(event.summary ?? "", TRUNCATE_SUBAGENT_TEXT_BYTES).text,
          }),
        ],
      };

    // ---- Skipped kinds (not a silent drop; the originals remain in the stream JSONL) ----
    case "subagent_progress":
    case "tool_invoked":
    case "turn_started":
    case "turn_ended":
    case "assistant_delta":
    case "inject_accepted":
    case "inject_queued":
    case "inject_delivered":
    case "inject_cancelled":
    case "inject_dropped":
    case "inject_rejected":
    case "retry_started":
    case "retry_ended":
    case "usage_snapshot":
    case "synthetic_state_snapshot":
      return null;

    default: {
      // Unrecognized kind: leave a trace.
      const unknownKind = (event as { kind: string }).kind;
      const receivedAt = (event as { receivedAt?: number }).receivedAt ?? 0;
      return {
        kind: unknownKind,
        receivedAt,
        lines: [formatTemplate(lit.watcher_record_unknown, { rtype: unknownKind })],
      };
    }
  }
}

// ---- preprocessEvents ----

export function preprocessEvents(
  events: ReadonlyArray<StreamJsonlLine>,
  opts: { watcherLang: Lang },
): ReadonlyArray<ProcessedRecord> {
  const lit = literals(opts.watcherLang);
  const out: ProcessedRecord[] = [];
  for (const ev of events) {
    // Per-record isolation. readStreamIncrement only guarantees a JSON object, not that a
    // known-kind event has complete internal fields (e.g. an assistant_block missing its block
    // would throw in renderBlock). Without isolation, one bad record throwing would make the
    // dispatcher tick throw (swallowed upstream) without advancing the offset, permanently
    // stalling the watcher window on that line. Here an unrenderable record is degraded to a
    // malformed placeholder (still traced, window advances), so one bad record cannot drag down
    // the whole window or stall it forever.
    let rec: ProcessedRecord | null;
    try {
      rec = processEvent(ev, lit);
    } catch (err) {
      const kind = (ev as { kind?: unknown }).kind;
      const kindStr = typeof kind === "string" ? kind : "unknown";
      const receivedAt = typeof (ev as { receivedAt?: unknown }).receivedAt === "number" ? (ev as { receivedAt: number }).receivedAt : 0;
      rec = {
        kind: kindStr,
        receivedAt,
        lines: [formatTemplate(lit.watcher_record_unknown, { rtype: `${kindStr} (malformed: ${(err as Error).message})` })],
      };
    }
    if (rec !== null) out.push(rec);
  }
  return out;
}

/** Empty-window check: a non-empty processed list means a non-empty window (preprocess already filtered by kind). */
export function isEmptyWindow(processed: ReadonlyArray<ProcessedRecord>): boolean {
  return processed.length === 0;
}

// ---- body.md rendering ----

/**
 * tsRelative: seconds of a record's receivedAt (ms) relative to the startedAtWall anchor.
 * Missing / earlier than the anchor (float rounding / minor clock jitter) falls back to +0s.
 */
function tsRelative(receivedAt: number, startedAtWallMs: number): number {
  const rel = Math.floor((receivedAt - startedAtWallMs) / 1000);
  return rel > 0 ? rel : 0;
}

/** Section header. */
function recordHeader(rec: ProcessedRecord, seq: number, rel: number): string {
  if (rec.kind === "host_inject") {
    const markerKind = rec.injectMarkerKind ?? "unknown";
    const envIds = rec.injectEnvelopeIds ?? [];
    const envSuffix = envIds.length > 0 ? `, envIds: ${envIds.join(",")}` : "";
    return `## [${seq}] host_inject (${markerKind}${envSuffix}) @ +${rel}s`;
  }
  return `## [${seq}] ${rec.kind} @ +${rel}s`;
}

export interface RenderWindowBodyOpts {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly workerSessionId: string;
  readonly workerSessionSeq: number;
  readonly streamPath: string;
  /** Anchor (ms epoch) for computing tsRelative. */
  readonly startedAtWallMs: number;
  readonly watcherLang: Lang;
}

/**
 * Render body.md. Returns the body plus whether the 32 KB truncation was triggered.
 * When over 32 KB, keep a prefix of records in chronological order and append a truncation marker
 * at the end; the window is not re-split.
 */
export function renderWindowBody(
  processed: ReadonlyArray<ProcessedRecord>,
  opts: RenderWindowBodyOpts,
): { bodyMd: string; truncated: boolean } {
  const lit = literals(opts.watcherLang);
  const startedAtWallMs = opts.startedAtWallMs;

  const headerLines = [
    lit.watcher_window_header,
    formatTemplate(lit.watcher_window_range, { window_start: opts.windowStart, window_end: opts.windowEnd }),
    formatTemplate(lit.watcher_window_worker_session_line, {
      worker_session_id: opts.workerSessionId,
      worker_session_seq: opts.workerSessionSeq,
    }),
    formatTemplate(lit.watcher_window_stream_path_line, { stream_path: opts.streamPath }),
    formatTemplate(lit.watcher_window_record_count, { count: processed.length }),
  ];
  const header = headerLines.join("\n");

  // Render each record's section, accumulating against the byte budget.
  const sections: string[] = [];
  let usedBytes = byteLen(header);
  const budget = BODY_TOTAL_LIMIT_BYTES - BODY_TAIL_RESERVE_BYTES;
  let keptCount = 0;

  for (let i = 0; i < processed.length; i += 1) {
    const rec = processed[i]!;
    const rel = tsRelative(rec.receivedAt, startedAtWallMs);
    const section = `${recordHeader(rec, i + 1, rel)}\n${rec.lines.join("\n")}`;
    // +2 for the "\n\n" join separator before this section.
    const addBytes = byteLen(section) + 2;
    if (usedBytes + addBytes > budget && keptCount > 0) break;
    sections.push(section);
    usedBytes += addBytes;
    keptCount += 1;
  }

  const truncated = keptCount < processed.length;
  let body = [header, ...sections].join("\n\n");
  if (truncated) {
    body += formatTemplate(lit.watcher_window_truncation_tail, {
      skipped_count: processed.length - keptCount,
      kb: BODY_TOTAL_LIMIT_BYTES / KB,
    });
  }
  return { bodyMd: body, truncated };
}
