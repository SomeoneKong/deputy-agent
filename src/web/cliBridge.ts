/**
 * CLI bridge: in-process invocation of CLI command functions + argument object construction.
 *
 * - source="user_web" passed through consistently (recorded in envelope/conversation, distinct from user_cli)
 * - required fields like host start mode filled explicitly (avoid the in-process caller blocking on a foreground host)
 * - consumes the structured CommandResult (message / warning) directly; does not capture stdout or redirect globally
 * - an in-process mutex serializes write actions (lightweight single-process scheduling; underlying concurrency safety comes from per-file locks)
 * - single-step CliError is not swallowed — propagated to the endpoint layer which maps exitCode to an HTTP status;
 *   per-upload CliError of the composite POST /api/tasks is aggregated here into failed[] (partial-success semantics)
 */
import { buildTaskCapsulePaths } from "../shared/index.js";
import {
  CliError,
  ensureHostRunning,
  execAnswer,
  execCancel,
  execDelete,
  execDone,
  execFeedback,
  execPause,
  execRename,
  execResume,
  execSubmit,
  execUpload,
  buildRoleBindings,
  tasksRootOf,
  type CommandResult,
  type EnsureHostRunningOpts,
} from "../cli/index.js";

const SOURCE = "user_web" as const;
const SPAWN_FAILED_NOTE = "(Note: background startup did not succeed; you can start it manually later with 'run <taskId>')";

export interface BridgeOpts {
  readonly projectRoot: string;
  /** Inject ensureHostRunning (tests use no-spawn to avoid actually starting a host). */
  readonly spawnHost?: EnsureHostRunningOpts["spawnHost"];
}

/** Process-level write mutex: ensures only one write action / composite segment runs at a time within the web backend process. */
let writeChain: Promise<unknown> = Promise.resolve();

/** Serialize a write action (single step or a whole composite segment). Read-only endpoints / streams bypass this. */
export function serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  // Keep the chain alive: swallow rejections so later actions can still queue (the result is returned to the caller via the `run` branch).
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function spawnOf(opts: BridgeOpts): { spawnHost?: EnsureHostRunningOpts["spawnHost"] } {
  return opts.spawnHost !== undefined ? { spawnHost: opts.spawnHost } : {};
}

// ---- Single-step write actions (CliError propagates to the endpoint layer) ----

export function bridgeAnswer(opts: BridgeOpts, taskId: string, text: string): Promise<CommandResult> {
  return serializeWrite(() =>
    execAnswer({ projectRoot: opts.projectRoot, source: SOURCE, noSpawn: false, ...spawnOf(opts), taskId, text }),
  );
}

export function bridgeFeedback(opts: BridgeOpts, taskId: string, text: string): Promise<CommandResult> {
  return serializeWrite(() =>
    execFeedback({ projectRoot: opts.projectRoot, source: SOURCE, noSpawn: false, ...spawnOf(opts), taskId, text }),
  );
}

export function bridgeUpload(
  opts: BridgeOpts,
  taskId: string,
  filePath: string,
  note?: string,
): Promise<CommandResult> {
  return serializeWrite(() =>
    execUpload({
      projectRoot: opts.projectRoot,
      source: SOURCE,
      noSpawn: false,
      ...spawnOf(opts),
      taskId,
      filePath,
      ...(note !== undefined ? { note } : {}),
    }),
  );
}

export function bridgePause(opts: BridgeOpts, taskId: string): Promise<CommandResult> {
  return serializeWrite(() => execPause({ projectRoot: opts.projectRoot, source: SOURCE, noSpawn: true, taskId }));
}

export function bridgeResume(opts: BridgeOpts, taskId: string): Promise<CommandResult> {
  return serializeWrite(() =>
    execResume({ projectRoot: opts.projectRoot, source: SOURCE, noSpawn: false, ...spawnOf(opts), taskId }),
  );
}

export function bridgeCancel(opts: BridgeOpts, taskId: string, reason?: string): Promise<CommandResult> {
  return serializeWrite(() =>
    execCancel({
      projectRoot: opts.projectRoot,
      source: SOURCE,
      noSpawn: true,
      taskId,
      ...(reason !== undefined ? { reason } : {}),
    }),
  );
}

export function bridgeDone(opts: BridgeOpts, taskId: string): Promise<CommandResult> {
  return serializeWrite(() => execDone({ projectRoot: opts.projectRoot, source: SOURCE, noSpawn: true, taskId }));
}

export function bridgeRename(opts: BridgeOpts, taskId: string, title: string): Promise<CommandResult> {
  return serializeWrite(() =>
    execRename({ projectRoot: opts.projectRoot, source: SOURCE, noSpawn: true, taskId, title }),
  );
}

export function bridgeDelete(opts: BridgeOpts, taskId: string): Promise<CommandResult> {
  return serializeWrite(() => execDelete({ projectRoot: opts.projectRoot, source: SOURCE, noSpawn: true, taskId }));
}

// ---- Composite write action: POST /api/tasks (chains submit + upload loop + a final ensureHostRunning) ----

export interface SubmitAttachment {
  /** Absolute path of the already-written temp file. */
  readonly tempPath: string;
  /** Original filename (used for failure reporting). */
  readonly filename: string;
  /** Optional note. */
  readonly note?: string;
}

export interface UploadResultDto {
  readonly uploadId: string;
  readonly filename: string;
  readonly sizeBytes: number;
}

export interface UploadFailureDto {
  readonly filename: string;
  readonly message: string;
}

export interface SubmitCompositeResult {
  readonly taskId: string;
  readonly message: string;
  readonly warning?: string;
  readonly uploaded: UploadResultDto[];
  readonly failed: UploadFailureDto[];
}

/**
 * Composite submit: submit(--no-start) → upload loop (--no-spawn) → a single final ensureHostRunning.
 * The whole sequence runs inside one serializeWrite critical section (the composite operation is not interrupted).
 * CliError from submit and the final ensureHostRunning propagate to the endpoint layer; per-upload CliError is aggregated into failed[] (partial-success semantics).
 */
export function bridgeSubmitComposite(
  opts: BridgeOpts,
  args: {
    rawTask: string;
    taskId?: string;
    attachments: ReadonlyArray<SubmitAttachment>;
    /** per-role provider selection (role→provider); invalid values cause buildRoleBindings to throw CliError → endpoint 400. */
    roleProviders?: Readonly<Record<string, string>>;
  },
): Promise<SubmitCompositeResult> {
  return serializeWrite(async () => {
    // 0. Validate roleBindings (submit-level; invalid → CliError to endpoint layer; placed at the start of the critical section to reject before any submit).
    const roleBindings =
      args.roleProviders !== undefined ? buildRoleBindings(args.roleProviders) : undefined;

    // 1. submit --no-start: no enqueue / no host start (CliError propagates)
    const submitRes = await execSubmit({
      projectRoot: opts.projectRoot,
      source: SOURCE,
      noSpawn: true,
      noStart: true,
      rawTask: args.rawTask,
      ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
      ...(roleBindings !== undefined ? { roleBindings } : {}),
    });
    const taskId = String(submitRes.data?.["taskId"] ?? args.taskId ?? "");

    // 2. upload loop --no-spawn: per-upload CliError aggregated into failed[] (does not block the rest)
    const uploaded: UploadResultDto[] = [];
    const failed: UploadFailureDto[] = [];
    for (const att of args.attachments) {
      try {
        const r = await execUpload({
          projectRoot: opts.projectRoot,
          source: SOURCE,
          noSpawn: true,
          taskId,
          filePath: att.tempPath,
          ...(att.note !== undefined ? { note: att.note } : {}),
        });
        uploaded.push({
          uploadId: String(r.data?.["uploadId"] ?? ""),
          filename: String(r.data?.["filename"] ?? att.filename),
          sizeBytes: Number(r.data?.["sizeBytes"] ?? 0),
        });
      } catch (err) {
        if (err instanceof CliError) {
          failed.push({ filename: att.filename, message: err.message });
        } else {
          failed.push({ filename: att.filename, message: "File upload could not be completed; please try again later" });
        }
      }
    }

    // 3. A single final ensureHostRunning (submit/upload both used noSpawn=true so the host was not started).
    const warning = await ensureHostOnce(opts, taskId);

    return {
      taskId,
      message: submitRes.message,
      ...(warning !== undefined ? { warning } : {}),
      uploaded,
      failed,
    };
  });
}

/** Start the host once at the end; spawn_failed → warning (does not change the write-success semantics). */
async function ensureHostOnce(opts: BridgeOpts, taskId: string): Promise<string | undefined> {
  const paths = buildTaskCapsulePaths(tasksRootOf(opts.projectRoot), taskId);
  try {
    const result = await ensureHostRunning(paths, {
      projectRoot: opts.projectRoot,
      ...(opts.spawnHost !== undefined ? { spawnHost: opts.spawnHost } : {}),
    });
    return result === "spawn_failed" ? SPAWN_FAILED_NOTE : undefined;
  } catch {
    return SPAWN_FAILED_NOTE;
  }
}
