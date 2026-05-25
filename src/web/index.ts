/**
 * Web GUI subsystem barrel.
 *
 * - app: fastify instance assembly + startWebServer
 * - security: single-authority isLoopbackHost + two-layer validation
 * - httpError: CliExitCode → HTTP mapping + CliError → JSON
 * - streamReader: shared stream JSONL reader (reverse tail + forward increment)
 * - cliBridge: in-process CLI invocation + source=user_web + write serialization
 * - readService: read-only data source, pure file reads
 * - sse: file watching + SSE push
 */
export { buildWebApp, startWebServer, type WebServerOpts } from "./app.js";
export { isLoopbackHost, assertLoopbackBindHost, rejectIfUnsafe } from "./security.js";
export { EXIT_TO_HTTP, httpStatusForCliError, sendError } from "./httpError.js";
export { tailStreamLines, readStreamFrom, type StreamReadResult } from "./streamReader.js";
export {
  bridgeSubmitComposite,
  bridgeUpload,
  bridgeFeedback,
  bridgeAnswer,
  serializeWrite,
  type BridgeOpts,
} from "./cliBridge.js";
export {
  listTaskSummaries,
  resolvePaths,
  probeHostOnline,
  readConversation,
  readEvents,
  type TaskSummaryDto,
} from "./readService.js";
