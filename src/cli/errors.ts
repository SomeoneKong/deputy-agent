/**
 * CLI exit codes + CliError + cli_* errorKind.
 *
 * Exec functions uniformly `throw CliError` on every error path (carrying exitCode + errorKind +
 * user-facing message + debug debugMessage). The CLI top-level entry catches and maps by exitCode;
 * the Web bridge reuses the same CliError, mapping exitCode to an HTTP status.
 */

/** Exit code set. */
export const CliExitCode = {
  Ok: 0, // success
  GeneralError: 1, // general error / task in failed terminal state / internal state anomaly
  NotFound: 2, // task / resource not found
  IllegalState: 3, // operation not allowed in the current task state
  InvalidArgument: 4, // invalid input argument (bad task_id / wrong type / file too large)
  IoError: 5, // file IO error (fallback)
  SingleInstance: 6, // host single-instance lock conflict (a host is already running this task)
  Sigint: 130, // SIGINT
} as const;

export type CliExitCode = (typeof CliExitCode)[keyof typeof CliExitCode];

/** cli_* errorKind + the user-privileged audit kind (user_cancelled). */
export const CliErrorKind = {
  taskIdInvalid: "cli_task_id_invalid",
  taskIdConflict: "cli_task_id_conflict",
  taskNotFound: "cli_task_not_found",
  fileNotFound: "cli_file_not_found",
  fileTooLarge: "cli_file_too_large",
  argConflict: "cli_arg_conflict",
  argMissing: "cli_arg_missing",
  /** Argument validation failure other than task_id (empty title / control chars / too long / unsafe filename / argv parse error). Exit code 4. */
  argInvalid: "cli_arg_invalid",
  stageNotAllowed: "cli_stage_not_allowed",
  hostAlreadyRunning: "cli_host_already_running",
  hostRunning: "cli_host_running",
  pausedFromMissing: "cli_paused_from_missing",
  /** File IO fallback error. Exit code 5 (distinct from cli_internal's exit code 1). */
  ioError: "cli_io_error",
  internal: "cli_internal",
} as const;

export type CliErrorKind = (typeof CliErrorKind)[keyof typeof CliErrorKind];

/** Audit errorKind for a user-initiated cancel (written to manifest.lastError, not delivered as an envelope). */
export const USER_CANCELLED_ERROR_KIND = "user_cancelled";

export interface CliErrorOptions {
  readonly exitCode: CliExitCode;
  readonly errorKind: string;
  /** Debug-facing diagnostics (internal info such as stage / envId / stack); only output when DEPUTY_DEBUG=1 / to backend logs. */
  readonly debugMessage?: string;
  readonly cause?: unknown;
}

/**
 * Thrown uniformly by command exec functions on error paths. `message` is user-facing text (no internal terms).
 */
export class CliError extends Error {
  readonly exitCode: CliExitCode;
  readonly errorKind: string;
  readonly debugMessage: string | undefined;

  constructor(message: string, opts: CliErrorOptions) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "CliError";
    this.exitCode = opts.exitCode;
    this.errorKind = opts.errorKind;
    this.debugMessage = opts.debugMessage;
  }
}

/** Convenience constructors: one factory per cli_* errorKind with a fixed exit code (so callers can't get the mapping wrong). */
export const cliErrors = {
  taskIdInvalid: (debugMessage?: string): CliError =>
    new CliError("task_id may only contain letters / digits / _ / -, length 1-64", {
      exitCode: CliExitCode.InvalidArgument,
      errorKind: CliErrorKind.taskIdInvalid,
      ...(debugMessage !== undefined ? { debugMessage } : {}),
    }),
  taskIdConflict: (taskId: string): CliError =>
    new CliError(`task_id ${taskId} already exists; pick another name or run list to see existing tasks`, {
      exitCode: CliExitCode.GeneralError,
      errorKind: CliErrorKind.taskIdConflict,
      debugMessage: `task capsule already exists: ${taskId}`,
    }),
  taskNotFound: (taskId: string): CliError =>
    new CliError("Task not found; run list to see existing tasks", {
      exitCode: CliExitCode.NotFound,
      errorKind: CliErrorKind.taskNotFound,
      debugMessage: `task not found: ${taskId}`,
    }),
  fileNotFound: (path: string): CliError =>
    new CliError(`File not found: ${path}`, {
      exitCode: CliExitCode.NotFound,
      errorKind: CliErrorKind.fileNotFound,
      debugMessage: `file not found: ${path}`,
    }),
  fileTooLarge: (sizeHuman: string, limitMb: number): CliError =>
    new CliError(`File too large (${sizeHuman}); the limit is ${limitMb} MB. Consider compressing or splitting it`, {
      exitCode: CliExitCode.InvalidArgument,
      errorKind: CliErrorKind.fileTooLarge,
      debugMessage: `upload exceeds size limit (${sizeHuman} > ${limitMb}MB)`,
    }),
  argConflict: (message: string, debugMessage?: string): CliError =>
    new CliError(message, {
      exitCode: CliExitCode.InvalidArgument,
      errorKind: CliErrorKind.argConflict,
      ...(debugMessage !== undefined ? { debugMessage } : {}),
    }),
  argMissing: (message: string, debugMessage?: string): CliError =>
    new CliError(message, {
      exitCode: CliExitCode.InvalidArgument,
      errorKind: CliErrorKind.argMissing,
      ...(debugMessage !== undefined ? { debugMessage } : {}),
    }),
  /** Argument validation failure other than task_id (title / filename / other input). errorKind=cli_arg_invalid, exit code 4. */
  argInvalid: (message: string, debugMessage?: string): CliError =>
    new CliError(message, {
      exitCode: CliExitCode.InvalidArgument,
      errorKind: CliErrorKind.argInvalid,
      ...(debugMessage !== undefined ? { debugMessage } : {}),
    }),
  /** Alias for argInvalid (for the Web bridge callers; same errorKind=cli_arg_invalid + exit code 4). */
  invalidArgument: (message: string, debugMessage?: string): CliError =>
    new CliError(message, {
      exitCode: CliExitCode.InvalidArgument,
      errorKind: CliErrorKind.argInvalid,
      ...(debugMessage !== undefined ? { debugMessage } : {}),
    }),
  stageNotAllowed: (userMessage: string, debugMessage: string): CliError =>
    new CliError(userMessage, {
      exitCode: CliExitCode.IllegalState,
      errorKind: CliErrorKind.stageNotAllowed,
      debugMessage,
    }),
  hostAlreadyRunning: (debugMessage?: string): CliError =>
    new CliError("This task is already running in the background; no need to start it again", {
      exitCode: CliExitCode.SingleInstance,
      errorKind: CliErrorKind.hostAlreadyRunning,
      ...(debugMessage !== undefined ? { debugMessage } : {}),
    }),
  hostRunning: (userMessage: string, debugMessage: string): CliError =>
    new CliError(userMessage, {
      exitCode: CliExitCode.IllegalState,
      errorKind: CliErrorKind.hostRunning,
      debugMessage,
    }),
  pausedFromMissing: (): CliError =>
    new CliError("Rare internal state issue; run inspect to look into it, or submit again", {
      exitCode: CliExitCode.GeneralError,
      errorKind: CliErrorKind.pausedFromMissing,
      debugMessage: "pausedFrom missing on paused manifest (data anomaly)",
    }),
  io: (userMessage: string, cause: unknown): CliError =>
    new CliError(userMessage, {
      exitCode: CliExitCode.IoError,
      errorKind: CliErrorKind.ioError,
      debugMessage: `IO error: ${(cause as Error)?.message ?? String(cause)}`,
      cause,
    }),
  internal: (cause: unknown): CliError =>
    new CliError("The operation could not be completed; try again later or run inspect for details", {
      exitCode: CliExitCode.GeneralError,
      errorKind: CliErrorKind.internal,
      debugMessage: `cli internal error: ${(cause as Error)?.message ?? String(cause)}`,
      cause,
    }),
};
