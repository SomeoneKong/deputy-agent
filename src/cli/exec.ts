/**
 * Command exec function layer.
 *
 * One exec function per user write operation (submit / answer / feedback / upload / cancel / done /
 * pause / resume / rename / delete), shared by the CLI and the Web layer (in-process calls to the same
 * layer, source passed through). Exec functions take a structured params object and return a
 * CommandResult (they don't print directly / don't throw to the top), with errors uniformly thrown as
 * CliError. The CLI top-level wrapper renders accordingly + sets the exit code.
 *
 * Read-only operations (list / inspect / status) bypass the write exec functions -- the CLI renders text
 * directly; Web read-only uses its own pure-read path. This module provides data-assembly helpers for
 * list / status (decoupled from rendering); inspect is assembled directly by the CLI layer.
 */
import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { createMessagingBus } from "../messaging/index.js";
import { createTaskCapsule } from "../shared/capsule.js";
import { conversationIO, type ConversationUserSource } from "../shared/conversation.js";
import { TaskCapsuleConflict } from "../shared/errors.js";
import { genUploadId, type EnvelopeId } from "../shared/ids.js";
import { fileLock } from "../shared/locks.js";
import {
  manifestIO,
  type Manifest,
  type RoleBindingMap,
  type Stage,
  type StageInProgress,
} from "../shared/manifest.js";
import { buildTaskCapsulePaths, type TaskCapsulePaths } from "../shared/paths.js";
import { nowIso8601Us } from "../shared/timeUtils.js";
import { ALL_AGENT_ROLES, type ProviderId } from "../wrapper/index.js";

import { cliErrors, CliError, CliExitCode, CliErrorKind, USER_CANCELLED_ERROR_KIND } from "./errors.js";
import { ensureHostRunning, type EnsureHostRunningOpts, type SpawnResult } from "./hostSpawn.js";
import { computeTaskId, tasksRootOf } from "./projectRoot.js";
import { renderStatusMd } from "../shared/status_md.js";

/** Upload file size limit (500 MB). */
export const UPLOAD_MAX_BYTES = 500 * 1024 * 1024;
export const UPLOAD_MAX_MB = 500;

const SPAWN_FAILED_NOTE = "(Note: background startup did not succeed; you can start it manually later with 'run <taskId>')";

/** Structured result returned by a command exec function. */
export interface CommandResult {
  /** User-facing success message body (no internal terms). */
  readonly message: string;
  /** Non-fatal diagnostic (e.g. a spawn_failed note). */
  readonly warning?: string;
  /** Structured supplementary fields produced by the command (e.g. submit's taskId, upload's uploadId). */
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Environment fields shared by all write exec functions. */
export interface ExecEnv {
  readonly projectRoot: string;
  readonly source: ConversationUserSource;
  /** Host startup mode: true = don't auto-resume the host (--no-spawn). */
  readonly noSpawn?: boolean;
  /** Inject ensureHostRunning (for tests). */
  readonly spawnHost?: EnsureHostRunningOpts["spawnHost"];
}

const IN_PROGRESS_STAGES: ReadonlySet<Stage> = new Set<StageInProgress>([
  "submitted",
  "clarifying",
  "bootstrapping",
  "running",
  "awaiting_user",
]);

function isInProgress(stage: Stage): stage is StageInProgress {
  return IN_PROGRESS_STAGES.has(stage);
}

function isTerminal(stage: Stage): boolean {
  return stage === "done" || stage === "failed" || stage === "cancelled";
}

// ---- shared helpers ----

/** Resolve taskId -> paths; not found -> cli_task_not_found. */
async function loadPathsAndManifest(
  env: ExecEnv,
  taskId: string,
): Promise<{ paths: TaskCapsulePaths; manifest: Manifest }> {
  let paths: TaskCapsulePaths;
  try {
    paths = buildTaskCapsulePaths(tasksRootOf(env.projectRoot), taskId);
  } catch {
    throw cliErrors.taskIdInvalid(`invalid task_id arg: ${taskId}`);
  }
  if (!existsSync(paths.taskRoot)) throw cliErrors.taskNotFound(taskId);
  let manifest: Manifest;
  try {
    manifest = await manifestIO.load(paths);
  } catch (err) {
    throw cliErrors.io("Failed to read task state; please try again later", err);
  }
  return { paths, manifest };
}

/** Read either inline text or --file (exactly one); both or neither -> cli_arg_*. */
async function resolveTextInput(opts: {
  text?: string;
  file?: string;
  projectRoot: string;
  bothMsg: string;
  missingMsg: string;
}): Promise<string> {
  const hasText = opts.text !== undefined && opts.text.length > 0;
  const hasFile = opts.file !== undefined && opts.file.length > 0;
  if (hasText && hasFile) throw cliErrors.argConflict(opts.bothMsg, "both text and --file given");
  if (!hasText && !hasFile) throw cliErrors.argMissing(opts.missingMsg, "neither text nor --file given");
  if (hasText) return opts.text!;
  const filePath = isAbsolute(opts.file!) ? opts.file! : resolve(opts.projectRoot, opts.file!);
  if (!existsSync(filePath)) throw cliErrors.fileNotFound(filePath);
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    throw cliErrors.io(`Failed to read file: ${filePath}`, err);
  }
}

/** Auto-resume the host (unless noSpawn); on spawn_failed, attach a warning. */
async function maybeEnsureHost(env: ExecEnv, paths: TaskCapsulePaths): Promise<string | undefined> {
  if (env.noSpawn === true) return undefined;
  let result: SpawnResult;
  try {
    result = await ensureHostRunning(paths, {
      projectRoot: env.projectRoot,
      ...(env.spawnHost !== undefined ? { spawnHost: env.spawnHost } : {}),
    });
  } catch {
    result = "spawn_failed";
  }
  return result === "spawn_failed" ? SPAWN_FAILED_NOTE : undefined;
}

/**
 * Append a user_cli_action to events.jsonl (fail-soft).
 * details schema = `{ action, envId?, extra? }`: envId is a top-level cross-reference; other structured
 * fields go into the nested extra (not flattened, so debug / parsing consumers read uniform fields).
 */
async function appendUserCliAction(
  paths: TaskCapsulePaths,
  stage: Stage,
  action: string,
  opts?: { envId?: string; extra?: Readonly<Record<string, unknown>> },
): Promise<void> {
  const { eventsIO } = await import("../host/events.js");
  try {
    await eventsIO.append(paths, {
      type: "user_cli_action",
      stage,
      details: {
        action,
        ...(opts?.envId !== undefined ? { envId: opts.envId } : {}),
        ...(opts?.extra !== undefined ? { extra: opts.extra } : {}),
      },
    });
  } catch (err) {
    console.warn(`user_cli_action(${action}) event append failed (fail-soft): ${(err as Error).message}`);
  }
}

/** stage_transition event (fail-soft). */
async function appendStageTransition(
  paths: TaskCapsulePaths,
  fromStage: Stage,
  toStage: Stage,
  reason: string | null,
): Promise<void> {
  const { eventsIO } = await import("../host/events.js");
  try {
    await eventsIO.append(paths, {
      type: "stage_transition",
      stage: toStage,
      details: { fromStage, toStage, triggeredBy: "user_cli", reason },
    });
  } catch (err) {
    console.warn(`stage_transition event append failed (fail-soft): ${(err as Error).message}`);
  }
}

/** Append user_to_meta to conversation.jsonl (fail-soft). */
async function appendUserConversation(opts: {
  paths: TaskCapsulePaths;
  source: ConversationUserSource;
  kind: Parameters<typeof conversationIO.appendUserToMeta>[0]["kind"];
  body: string;
  envId?: EnvelopeId | null;
  extras?: Record<string, unknown>;
}): Promise<void> {
  try {
    await conversationIO.appendUserToMeta({
      paths: opts.paths,
      kind: opts.kind,
      source: opts.source,
      body: opts.body,
      ...(opts.envId !== undefined ? { envId: opts.envId } : {}),
      ...(opts.extras !== undefined ? { extras: opts.extras } : {}),
    });
  } catch (err) {
    console.warn(`conversation append (${opts.kind}) failed (fail-soft): ${(err as Error).message}`);
  }
}

function bytesHuman(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ---- submit ----

export interface SubmitInput extends ExecEnv {
  readonly rawTask?: string;
  readonly file?: string;
  readonly taskId?: string;
  /** --no-start: don't start the host after creating (submit only). */
  readonly noStart?: boolean;
  /** per-role provider selection (--role role=provider); omitted entirely when absent, written to the initial manifest. */
  readonly roleBindings?: RoleBindingMap;
}

/** Roles selectable at submit (all roles; sourced from wrapper common ALL_AGENT_ROLES). */
const SUBMIT_ROLES: ReadonlySet<string> = new Set<string>(ALL_AGENT_ROLES);
/** Providers selectable at submit -- a subset: only providers with an implemented runtime (not the full ALL_PROVIDER_IDS). */
const SUBMIT_PROVIDERS: ReadonlySet<string> = new Set(["claude", "codex"]);
const SUBMIT_ROLE_HINT =
  "Invalid --role value; format is role=provider (role ∈ meta/worker/watcher/reviewer, provider ∈ claude/codex)";

/**
 * Validate and build a RoleBindingMap (shared by the CLI `--role role=provider` and Web roleBindings).
 * Input is a role->provider map; any invalid role / provider -> throw CliError(invalidArgument, exit code 4).
 * Empty input -> undefined. model is not exposed at submit (the host picks the default model per provider).
 */
export function buildRoleBindings(roleProviders: Readonly<Record<string, string>>): RoleBindingMap | undefined {
  const out: Record<string, { provider: ProviderId }> = {};
  let any = false;
  for (const [role, provider] of Object.entries(roleProviders)) {
    if (!SUBMIT_ROLES.has(role) || !SUBMIT_PROVIDERS.has(provider)) {
      throw cliErrors.invalidArgument(SUBMIT_ROLE_HINT, `invalid role binding: ${role}=${provider}`);
    }
    out[role] = { provider: provider as ProviderId };
    any = true;
  }
  return any ? (out as RoleBindingMap) : undefined;
}

/** Parse the CLI `--role role=provider` string array into a role->provider map (bad format throws CliError). Duplicate roles: last wins. */
export function parseRoleFlagPairs(pairs: ReadonlyArray<string>): Record<string, string> {
  // null-proto: special keys (__proto__ / constructor) become enumerable own properties so buildRoleBindings
  // can reject them (otherwise a plain object's __proto__ setter would swallow the key, silently treating an
  // invalid role as unselected).
  const out: Record<string, string> = Object.create(null);
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0 || eq === pair.length - 1) {
      throw cliErrors.invalidArgument(SUBMIT_ROLE_HINT, `invalid --role pair: ${pair}`);
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

export async function execSubmit(input: SubmitInput): Promise<CommandResult> {
  const rawTaskText = await resolveTextInput({
    ...(input.rawTask !== undefined ? { text: input.rawTask } : {}),
    ...(input.file !== undefined ? { file: input.file } : {}),
    projectRoot: input.projectRoot,
    bothMsg: "Provide either task text or a file, not both",
    missingMsg: "Please provide a task description (write it after the command or point --file at a file)",
  });
  const taskId = computeTaskId({
    projectRoot: input.projectRoot,
    ...(input.taskId !== undefined ? { explicit: input.taskId } : {}),
  });

  let paths: TaskCapsulePaths;
  try {
    paths = await createTaskCapsule({
      tasksRoot: tasksRootOf(input.projectRoot),
      taskId,
      rawTaskText,
      source: input.source,
      ...(input.roleBindings !== undefined ? { roleBindings: input.roleBindings } : {}),
    });
  } catch (err) {
    if (err instanceof TaskCapsuleConflict) throw cliErrors.taskIdConflict(taskId);
    if (err instanceof CliError) throw err;
    throw cliErrors.io("Failed to create the task; please try again later", err);
  }

  await renderStatusMd(paths);

  let warning: string | undefined;
  let message: string;
  if (input.noStart === true) {
    // --no-start: don't start the host after creating -- the message must not imply "the system is starting" (the Web bridge reuses this same message).
    message = `Task created: ${taskId}\nNot started yet; you can start it later with \`deputy run ${taskId}\`.`;
  } else {
    warning = await maybeEnsureHost({ ...input, noSpawn: false }, paths);
    message = `Task created: ${taskId}\nStarting up; you can check progress later with \`deputy status ${taskId}\`.`;
  }

  return {
    message,
    ...(warning !== undefined ? { warning } : {}),
    data: { taskId },
  };
}

// ---- answer ----

export interface AnswerInput extends ExecEnv {
  readonly taskId: string;
  readonly text?: string;
  readonly file?: string;
}

/** Infer the current clarify round: the max N among existing round_<N>_questions.md under clarify/ (default 1). */
async function inferClarifyRound(paths: TaskCapsulePaths): Promise<number> {
  try {
    const entries = await readdir(paths.clarifyDir);
    let max = 0;
    for (const name of entries) {
      const m = /^round_(\d+)_questions\.md$/.exec(name);
      if (m) {
        const n = Number.parseInt(m[1]!, 10);
        if (Number.isInteger(n) && n > max) max = n;
      }
    }
    return max >= 1 ? max : 1;
  } catch {
    return 1;
  }
}

export async function execAnswer(input: AnswerInput): Promise<CommandResult> {
  const { paths, manifest } = await loadPathsAndManifest(input, input.taskId);
  if (manifest.stage !== "clarifying") {
    throw cliErrors.stageNotAllowed(
      "There is no question to answer right now; use 'feedback' to add thoughts or 'status' to check progress",
      `stage=${manifest.stage}: answer only allowed in clarifying`,
    );
  }
  const text = await resolveTextInput({
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.file !== undefined ? { file: input.file } : {}),
    projectRoot: input.projectRoot,
    bothMsg: "Provide either answer text or a file, not both",
    missingMsg: "Please provide your answer (write it after the command or point --file at a file)",
  });
  const round = await inferClarifyRound(paths);

  // Write round_<N>_answers.md (consumed by the host clarify stage).
  try {
    await mkdir(paths.clarifyDir, { recursive: true });
    const { atomicWriter } = await import("../shared/atomic.js");
    await atomicWriter.writeText(paths.clarifyAnswersPath(round), text);
  } catch (err) {
    console.warn(`write clarify answers failed (fail-soft): ${(err as Error).message}`);
  }

  // Enqueue user_clarify_answer (the source of truth for user intent; failure -> the whole command errors).
  const bus = createMessagingBus(paths);
  let envId: EnvelopeId;
  try {
    envId = await bus.enqueue({
      channel: "meta",
      kind: "user_clarify_answer",
      from: input.source,
      body: text,
      extras: { round },
    });
  } catch (err) {
    throw cliErrors.io("Failed to submit your answer; please try again later", err);
  }

  await appendUserConversation({
    paths,
    source: input.source,
    kind: "user_clarify_answer",
    body: text,
    envId,
    extras: { round },
  });
  await appendUserCliAction(paths, manifest.stage, "answer", { envId });
  const warning = await maybeEnsureHost(input, paths);
  return { message: "Answer submitted; the system will process it and continue.", ...(warning !== undefined ? { warning } : {}), data: { envId, round } };
}

// ---- feedback ----

export interface FeedbackInput extends ExecEnv {
  readonly taskId: string;
  readonly text?: string;
  readonly file?: string;
}

export async function execFeedback(input: FeedbackInput): Promise<CommandResult> {
  const { paths, manifest } = await loadPathsAndManifest(input, input.taskId);
  if (manifest.stage === "paused") {
    throw cliErrors.stageNotAllowed("The task is paused; run 'resume' first to continue it", "stage=paused: feedback not allowed");
  }
  if (isTerminal(manifest.stage)) {
    throw cliErrors.stageNotAllowed("The task has ended; feedback can no longer be added", `stage=${manifest.stage} (terminal): feedback not allowed`);
  }
  const text = await resolveTextInput({
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.file !== undefined ? { file: input.file } : {}),
    projectRoot: input.projectRoot,
    bothMsg: "Provide either feedback text or a file, not both",
    missingMsg: "Please provide your feedback (write it after the command or point --file at a file)",
  });

  const bus = createMessagingBus(paths);
  let envId: EnvelopeId;
  try {
    envId = await bus.enqueue({ channel: "meta", kind: "user_feedback", from: input.source, body: text });
  } catch (err) {
    throw cliErrors.io("Failed to submit your feedback; please try again later", err);
  }
  await appendUserConversation({ paths, source: input.source, kind: "user_feedback", body: text, envId });
  await appendUserCliAction(paths, manifest.stage, "feedback", { envId });
  const warning = await maybeEnsureHost(input, paths);
  return { message: "Feedback recorded; the system will see it at the right time.", ...(warning !== undefined ? { warning } : {}), data: { envId } };
}

// ---- upload ----

export interface UploadInput extends ExecEnv {
  readonly taskId: string;
  readonly filePath: string;
  readonly note?: string;
}

export async function execUpload(input: UploadInput): Promise<CommandResult> {
  const { paths, manifest } = await loadPathsAndManifest(input, input.taskId);
  if (manifest.stage === "paused") {
    throw cliErrors.stageNotAllowed("The task is paused; run 'resume' first to continue it", "stage=paused: upload not allowed");
  }
  if (isTerminal(manifest.stage)) {
    throw cliErrors.stageNotAllowed("The task has ended; files can no longer be uploaded", `stage=${manifest.stage} (terminal): upload not allowed`);
  }

  const src = isAbsolute(input.filePath) ? input.filePath : resolve(input.projectRoot, input.filePath);
  let st;
  try {
    st = await stat(src);
  } catch {
    throw cliErrors.fileNotFound(src);
  }
  if (!st.isFile()) throw cliErrors.fileNotFound(src);
  if (st.size > UPLOAD_MAX_BYTES) throw cliErrors.fileTooLarge(bytesHuman(st.size), UPLOAD_MAX_MB);

  const uploadId = genUploadId();
  const filename = basename(input.filePath);
  let destPath: string;
  try {
    destPath = paths.uploadPath(uploadId, filename); // includes checkPathComponent path-safety validation
  } catch {
    throw cliErrors.argInvalid("The filename contains unsupported characters; please rename it before uploading", `unsafe upload filename: ${filename}`);
  }
  try {
    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(src, destPath);
  } catch (err) {
    throw cliErrors.io("Failed to save the file; please try again later", err);
  }

  const uploadedAt = nowIso8601Us();
  const body = input.note !== undefined && input.note.trim().length > 0 ? input.note : `User uploaded ${filename}`;

  const bus = createMessagingBus(paths);
  let envId: EnvelopeId;
  try {
    envId = await bus.enqueue({
      channel: "meta",
      kind: "user_upload",
      from: input.source,
      body,
      extras: { uploadId, filename, sizeBytes: st.size, uploadedAt },
    });
  } catch (err) {
    throw cliErrors.io("Failed to submit the upload; please try again later", err);
  }
  await appendUserConversation({
    paths,
    source: input.source,
    kind: "user_upload",
    body,
    envId,
    // The conversation line omits uploadedAt (the line's ts already records the persist time).
    extras: { uploadId, filename, sizeBytes: st.size },
  });
  await appendUserCliAction(paths, manifest.stage, "upload", { envId, extra: { uploadId } });
  const warning = await maybeEnsureHost(input, paths);
  return {
    message: `File uploaded: ${filename} (${bytesHuman(st.size)})\nThe system will decide how to use it.`,
    ...(warning !== undefined ? { warning } : {}),
    data: { envId, uploadId, filename, sizeBytes: st.size },
  };
}

// ---- run ----

export interface RunInput extends ExecEnv {
  readonly taskId: string;
}

/**
 * Task runnability check shared by run / `--foreground`: task exists + stage admission (paused -> suggest
 * resume; terminal -> reject). Returns paths. Host single-instance lock conflicts are handled by each path
 * (background execRun probes explicitly; foreground runDaemon acquires it itself).
 */
export async function assertRunnableTask(input: ExecEnv & { taskId: string }): Promise<TaskCapsulePaths> {
  const { paths, manifest } = await loadPathsAndManifest(input, input.taskId);
  if (manifest.stage === "paused") {
    throw cliErrors.stageNotAllowed("This task is paused; use 'resume' to continue it", "stage=paused: use resume");
  }
  if (isTerminal(manifest.stage)) {
    const msg =
      manifest.stage === "done"
        ? "This task has already ended; you can submit a new task"
        : manifest.stage === "failed"
          ? "This task has failed; check status to learn why"
          : "This task was cancelled; you can submit a new task";
    throw cliErrors.stageNotAllowed(msg, `stage=${manifest.stage} (terminal): run not allowed`);
  }
  return paths;
}

/**
 * Start / resume a task's host. Stage admission: in-progress states; paused -> suggest resume; terminal ->
 * reject. Single-instance lock conflict -> cli_host_already_running (exit code 6). This function uses
 * background detached spawn (--foreground calls runDaemon directly from the CLI layer, bypassing this
 * function but sharing the assertRunnableTask check).
 */
export async function execRun(input: RunInput): Promise<CommandResult> {
  const paths = await assertRunnableTask(input);
  // Host already running -> cli_host_already_running (exit code 6).
  let probe;
  try {
    probe = await fileLock.tryAcquireNonblocking(paths.hostPidLock);
  } catch (err) {
    throw cliErrors.io("Failed to check task state before starting; please try again later", err);
  }
  if (probe === null) {
    throw cliErrors.hostAlreadyRunning("host.pid.lock held when run requested");
  }
  await probe.release().catch(() => {});

  const warning = await maybeEnsureHost({ ...input, noSpawn: false }, paths);
  return {
    message: `Task started; check progress with 'deputy status ${input.taskId}'.`,
    ...(warning !== undefined ? { warning } : {}),
  };
}

// ---- pause ----

export interface TaskOnlyInput extends ExecEnv {
  readonly taskId: string;
}

export async function execPause(input: TaskOnlyInput): Promise<CommandResult> {
  const { paths, manifest } = await loadPathsAndManifest(input, input.taskId);
  if (manifest.stage === "paused") {
    throw cliErrors.stageNotAllowed("The task is already paused", "stage=paused already");
  }
  if (!isInProgress(manifest.stage)) {
    throw cliErrors.stageNotAllowed("The task has ended and cannot be paused", `stage=${manifest.stage} (terminal): pause not allowed`);
  }
  const from = manifest.stage;
  try {
    await manifestIO.applyStageTransition(paths, "paused", { pausedFrom: from, expectedFromStage: from });
  } catch (err) {
    throw cliErrors.io("The pause operation could not be completed; please try again later", err);
  }
  await appendUserCliAction(paths, "paused", "pause");
  await renderStatusMd(paths);
  return { message: "Task paused. Use 'resume' to continue it." };
}

// ---- resume ----

export async function execResume(input: TaskOnlyInput): Promise<CommandResult> {
  const { paths, manifest } = await loadPathsAndManifest(input, input.taskId);
  if (manifest.stage !== "paused") {
    throw cliErrors.stageNotAllowed("The task is not paused, so resume is not needed", `stage=${manifest.stage}: resume only from paused`);
  }
  const origin = manifest.pausedFrom;
  if (origin === null) throw cliErrors.pausedFromMissing();
  try {
    await manifestIO.applyStageTransition(paths, origin, { expectedFromStage: "paused" });
  } catch (err) {
    throw cliErrors.io("The resume operation could not be completed; please try again later", err);
  }
  await appendUserCliAction(paths, origin, "resume");
  await renderStatusMd(paths);
  const warning = await maybeEnsureHost(input, paths);
  return { message: "Task resumed. Check progress with status.", ...(warning !== undefined ? { warning } : {}) };
}

// ---- done ----

export async function execDone(input: TaskOnlyInput): Promise<CommandResult> {
  const { paths, manifest } = await loadPathsAndManifest(input, input.taskId);
  if (isTerminal(manifest.stage)) {
    throw cliErrors.stageNotAllowed("The task has already ended", `stage=${manifest.stage} (terminal): done not allowed`);
  }
  if (manifest.stage !== "awaiting_user") {
    throw cliErrors.stageNotAllowed(
      "done is only available when the task is awaiting your confirmation; check status for the current state",
      `stage=${manifest.stage}: done only from awaiting_user`,
    );
  }
  try {
    await manifestIO.applyStageTransition(paths, "done", { expectedFromStage: "awaiting_user" });
  } catch (err) {
    throw cliErrors.io("The confirmation could not be completed; please try again later", err);
  }
  await appendUserCliAction(paths, "done", "done");
  await appendStageTransition(paths, "awaiting_user", "done", null);
  await appendUserConversation({
    paths,
    source: input.source,
    kind: "user_done_confirmation",
    body: "User confirmed receipt of the delivery",
    extras: { fromStage: "awaiting_user" },
  });
  await renderStatusMd(paths);
  return { message: "Task completed." };
}

// ---- cancel ----

export interface CancelInput extends ExecEnv {
  readonly taskId: string;
  readonly reason?: string;
}

export async function execCancel(input: CancelInput): Promise<CommandResult> {
  const { paths, manifest } = await loadPathsAndManifest(input, input.taskId);
  if (isTerminal(manifest.stage)) {
    throw cliErrors.stageNotAllowed("The task has already ended", `stage=${manifest.stage} (terminal): cancel not allowed`);
  }
  if (!isInProgress(manifest.stage) && manifest.stage !== "paused") {
    throw cliErrors.stageNotAllowed("The task cannot be cancelled in its current state", `stage=${manifest.stage}: cancel not allowed`);
  }
  const from = manifest.stage;
  const reason = input.reason !== undefined && input.reason.trim().length > 0 ? input.reason : "";
  try {
    await manifestIO.applyStageTransition(paths, "cancelled", {
      lastError: { errorKind: USER_CANCELLED_ERROR_KIND, message: reason, at: nowIso8601Us() },
      expectedFromStage: from,
    });
  } catch (err) {
    throw cliErrors.io("The cancel operation could not be completed; please try again later", err);
  }
  await appendUserCliAction(paths, "cancelled", "cancel");
  await appendStageTransition(paths, from, "cancelled", reason.length > 0 ? reason : null);
  await appendUserConversation({
    paths,
    source: input.source,
    kind: "user_cancel",
    body: reason.length > 0 ? reason : "User cancelled the task",
    extras: { fromStage: from },
  });
  await renderStatusMd(paths);
  return { message: "Task cancelled." };
}

// ---- rename ----

export interface RenameInput extends ExecEnv {
  readonly taskId: string;
  readonly title: string;
}

const TITLE_MAX = 60;
// Control characters: U+0000-U+001F (incl. newline / tab) + DEL (U+007F).
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

export async function execRename(input: RenameInput): Promise<CommandResult> {
  const { paths } = await loadPathsAndManifest(input, input.taskId);
  const title = input.title.trim();
  if (title.length === 0) {
    throw cliErrors.argInvalid("Task title cannot be empty", "empty title");
  }
  if (CONTROL_CHAR_RE.test(input.title)) {
    throw cliErrors.argInvalid(
      "Task title cannot contain newlines / tabs / other control characters",
      "title contains control chars",
    );
  }
  if (title.length > TITLE_MAX) {
    throw cliErrors.argInvalid(`Task title may be at most ${TITLE_MAX} characters (currently ${title.length})`, "title too long");
  }
  let stage: Stage = "submitted";
  try {
    const updated = await manifestIO.mutate(paths, (m) => {
      m.title = title;
    });
    stage = updated.stage;
  } catch (err) {
    throw cliErrors.io("The rename operation could not be completed; please try again later", err);
  }
  await appendUserCliAction(paths, stage, "rename", { extra: { newTitle: title } });
  await renderStatusMd(paths);
  return { message: `Task title updated: ${title}`, data: { title } };
}

// ---- delete ----

export async function execDelete(input: TaskOnlyInput): Promise<CommandResult> {
  let paths: TaskCapsulePaths;
  try {
    paths = buildTaskCapsulePaths(tasksRootOf(input.projectRoot), input.taskId);
  } catch {
    throw cliErrors.taskIdInvalid(`invalid task_id arg: ${input.taskId}`);
  }
  if (!existsSync(paths.taskRoot)) throw cliErrors.taskNotFound(input.taskId);

  // The host must not be running (non-blocking acquire of host.pid.lock succeeds).
  let lockHandle;
  try {
    lockHandle = await fileLock.tryAcquireNonblocking(paths.hostPidLock);
  } catch (err) {
    throw cliErrors.io("Failed to check task state before deleting; please try again later", err);
  }
  if (lockHandle === null) {
    throw cliErrors.hostRunning(
      "The task is still running; 'cancel' or 'pause' it before deleting",
      "host.pid.lock held: host running",
    );
  }

  // Release the probe lock first (the lock fd is at tasks/<id>/control/host.pid.lock -- Windows cannot rename / rm a directory tree containing an open handle).
  await lockHandle.release().catch(() => {});

  // Shrink the "release lock -> isolate" race window: first rename the task capsule to a sibling tombstone
  // (near-instant, far faster than another process detached-spawning a host + acquiring the lock), so a
  // host spawn / write keyed by task_id hits a path that no longer exists; then recursively delete the
  // tombstone. If rename fails (lingering fd / cross-volume, etc.) fall back to a direct rm. The residual
  // race is tiny and degrades gracefully: a host raced into existence can't read the manifest ->
  // ManifestReadFatal exit code 2, so it won't pollute a half-deleted directory.
  const tombstone = `${paths.taskRoot}.deleting-${genUploadId()}`;
  let target = paths.taskRoot;
  try {
    const { rename } = await import("node:fs/promises");
    await rename(paths.taskRoot, tombstone);
    target = tombstone;
  } catch {
    // rename failed -> delete the original path directly.
    target = paths.taskRoot;
  }

  try {
    await rm(target, { recursive: true, force: true });
  } catch (err) {
    throw new CliError(`Delete failed: ${(err as Error).message}`, {
      exitCode: CliExitCode.IoError,
      errorKind: CliErrorKind.ioError,
      debugMessage: `rmtree failed: ${(err as Error).message}`,
      cause: err,
    });
  }
  return { message: `Task deleted: ${input.taskId}` };
}

// ---- read-only helper: list data assembly (for the CLI table rendering) ----

export interface TaskListEntry {
  readonly taskId: string;
  readonly stage: Stage;
  readonly updatedAt: string;
  readonly title: string;
}

/** Scan tasks/ and read each manifest (skipping tasks that fail to read) -> sorted by updatedAt descending; optional stage filter. */
export async function listTasks(projectRoot: string, stageFilter?: string): Promise<ReadonlyArray<TaskListEntry>> {
  const tasksRoot = tasksRootOf(projectRoot);
  let names: string[];
  try {
    names = await readdir(tasksRoot);
  } catch {
    return [];
  }
  const out: TaskListEntry[] = [];
  for (const name of names) {
    const paths = (() => {
      try {
        return buildTaskCapsulePaths(tasksRoot, name);
      } catch {
        return null;
      }
    })();
    if (paths === null) continue;
    if (!existsSync(paths.manifestPath)) continue;
    try {
      const m = await manifestIO.load(paths);
      if (stageFilter !== undefined && m.stage !== stageFilter) continue;
      out.push({ taskId: m.taskId, stage: m.stage, updatedAt: m.updatedAt, title: m.title });
    } catch {
      // Skip tasks that fail to read.
    }
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return out;
}
