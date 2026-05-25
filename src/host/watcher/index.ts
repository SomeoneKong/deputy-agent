/**
 * Watcher pipeline subsystem barrel.
 *
 * Worker stream JSONL -> split into time windows + preprocess (drop / truncate / render) ->
 * dispatch worker_stream_window envelopes to the Watcher inbox. This subsystem only reads the
 * stream JSONL; it never writes it.
 */
export type { OffsetTracker, ReadIncrementResult } from "./offsetTracker.js";
export { readStreamIncrement } from "./offsetTracker.js";

export type { ProcessedRecord, RenderWindowBodyOpts } from "./preprocess.js";
export {
  preprocessEvents,
  isEmptyWindow,
  renderWindowBody,
  BODY_TOTAL_LIMIT_BYTES,
  TRUNCATE_TEXT_BYTES,
  TRUNCATE_THINKING_BYTES,
  TRUNCATE_TOOL_INPUT_BYTES,
  TRUNCATE_TOOL_RESULT_BYTES,
  TRUNCATE_COMPACT_SUMMARY_BYTES,
} from "./preprocess.js";

export type { WindowDispatcher, WindowDispatcherDeps, WorkerSessionInfo } from "./dispatcher.js";
export { createWindowDispatcher, DEFAULT_WINDOW_SECONDS } from "./dispatcher.js";

export { synthesizeWatcherCompactSummary, synthesizeFromEvents, MAX_SUMMARY_BYTES } from "./compact_summary.js";
