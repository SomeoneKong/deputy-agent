/**
 * CLI top-level entry: parse argv -> build a params object (source="user_cli") -> call the exec
 * function -> render CommandResult.message (+ warning) to stdout with exit code 0; on CliError ->
 * print message to stderr (append debugMessage when DEPUTY_DEBUG=1) and exit with its exitCode.
 *
 * argv is parsed with Node's built-in util.parseArgs. SIGINT -> exit code 130.
 */
import { parseArgs, type ParseArgsConfig } from "node:util";

import { listTasks } from "./exec.js";
import { STAGES_ALL } from "../shared/manifest.js";
import {
  execAnswer,
  execCancel,
  assertRunnableTask,
  execDelete,
  execDone,
  execFeedback,
  execPause,
  execRename,
  execResume,
  execRun,
  execSubmit,
  execUpload,
  buildRoleBindings,
  parseRoleFlagPairs,
  type CommandResult,
  type ExecEnv,
} from "./exec.js";
import { cliErrors, CliError, CliErrorKind, CliExitCode } from "./errors.js";
import { renderInspect, type InspectMode } from "./inspect.js";
import { resolveProjectRoot, tasksRootOf } from "./projectRoot.js";
import { readOrRenderStatusMd } from "../shared/status_md.js";
import { buildTaskCapsulePaths } from "../shared/paths.js";
import { buildProductionDaemonConfig, loadManifestRoleBindings, hostExitToCliExit, runDaemon } from "./productionHost.js";

const SOURCE = "user_cli" as const;

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

const HELP = `deputy <command> [args]

Write commands:
  submit [<task>] [--file <path>] [--task-id <id>] [--role <role>=<provider>]... [--no-start] [--foreground]
  run <taskId> [--foreground]
  answer <taskId> [<text>] [--file <path>]
  feedback <taskId> [<text>] [--file <path>]
  upload <taskId> <filePath> [--note <text>]
  pause <taskId>
  resume <taskId> [--foreground]
  done <taskId>
  cancel <taskId> [--reason <text>]
  rename <taskId> <title>
  delete <taskId>

Read commands:
  list [--stage <stage>]
  status <taskId> [--full]
  inspect <taskId> [--inbox [<ch>]] [--meta-stream [<sid>]] [--watcher-stream [<sid>]]
                   [--worker-stream [<sid>]] [--events [<n>]] [--last <n>]

Web GUI:
  web [--host <addr>] [--port <n>]

Global: --project-root <path>`;

function emit(io: CliIo, result: CommandResult): void {
  io.out(result.message);
  if (result.warning !== undefined) io.out(result.warning);
}

/** Print the error message (append debugMessage / errorKind in debug mode) and return the exit code. */
function reportError(io: CliIo, err: unknown): number {
  if (err instanceof CliError) {
    io.err(err.message);
    if (process.env["DEPUTY_DEBUG"] === "1") {
      io.err(`[debug] errorKind=${err.errorKind} exitCode=${err.exitCode}`);
      if (err.debugMessage !== undefined) io.err(`[debug] ${err.debugMessage}`);
    }
    return err.exitCode;
  }
  io.err("The operation could not be completed; please try again later");
  if (process.env["DEPUTY_DEBUG"] === "1") io.err(`[debug] ${(err as Error)?.stack ?? String(err)}`);
  return CliExitCode.GeneralError;
}

/** Main entry: parse argv (excluding node / script), run the command, return the exit code. IO is injectable (for tests). */
export async function runCli(argv: ReadonlyArray<string>, io: CliIo = defaultIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.out(HELP);
    return CliExitCode.Ok;
  }

  try {
    return await dispatch(command, rest, io);
  } catch (err) {
    return reportError(io, err);
  }
}

function projectRootFrom(values: Record<string, unknown>): string {
  const explicit = typeof values["project-root"] === "string" ? (values["project-root"] as string) : undefined;
  return resolveProjectRoot(explicit !== undefined ? { explicit } : {});
}

function baseEnv(values: Record<string, unknown>): ExecEnv {
  return {
    projectRoot: projectRootFrom(values),
    source: SOURCE,
    ...(values["no-spawn"] === true ? { noSpawn: true } : {}),
  };
}

async function dispatch(command: string, rest: ReadonlyArray<string>, io: CliIo): Promise<number> {
  switch (command) {
    case "submit":
      return cmdSubmit(rest, io);
    case "run":
      return cmdRun(rest, io);
    case "answer":
      return cmdTextWrite(rest, io, execAnswer);
    case "feedback":
      return cmdTextWrite(rest, io, execFeedback);
    case "upload":
      return cmdUpload(rest, io);
    case "pause":
      return cmdTaskOnly(rest, io, execPause);
    case "resume":
      return cmdResume(rest, io);
    case "done":
      return cmdTaskOnly(rest, io, execDone);
    case "cancel":
      return cmdCancel(rest, io);
    case "rename":
      return cmdRename(rest, io);
    case "delete":
      return cmdTaskOnly(rest, io, execDelete);
    case "list":
      return cmdList(rest, io);
    case "status":
      return cmdStatus(rest, io);
    case "inspect":
      return cmdInspect(rest, io);
    case "web":
      return cmdWeb(rest, io);
    default:
      io.err(`Unknown command: ${command}`);
      io.out(HELP);
      return CliExitCode.InvalidArgument;
  }
}

// ---- parse helpers ----

type ParseArgsOptions = NonNullable<ParseArgsConfig["options"]>;

function tryParse(
  args: ReadonlyArray<string>,
  options: ParseArgsOptions,
): { values: Record<string, unknown>; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options,
      allowPositionals: true,
      strict: true,
    });
    return { values: values as Record<string, unknown>, positionals: positionals as string[] };
  } catch (err) {
    throw cliErrors.argInvalid("Invalid arguments; please check the command usage", (err as Error).message);
  }
}

function requireTaskId(positionals: ReadonlyArray<string>): string {
  const id = positionals[0];
  if (id === undefined) {
    throw new CliError("Please provide a task ID (run list to see existing tasks)", {
      exitCode: CliExitCode.InvalidArgument,
      errorKind: CliErrorKind.argMissing,
    });
  }
  return id;
}

const COMMON_OPTS = {
  "project-root": { type: "string" },
} as const;

// ---- command implementations ----

async function cmdSubmit(args: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const { values, positionals } = tryParse(args, {
    ...COMMON_OPTS,
    file: { type: "string" },
    "task-id": { type: "string" },
    role: { type: "string", multiple: true },
    "no-start": { type: "boolean" },
    foreground: { type: "boolean" },
  });
  const env = baseEnv(values);
  // --role role=provider (repeatable) -> a validated RoleBindingMap; invalid input throws exit code 4.
  const roleFlags = (values["role"] as string[] | undefined) ?? [];
  const roleBindings = roleFlags.length > 0 ? buildRoleBindings(parseRoleFlagPairs(roleFlags)) : undefined;
  const result = await execSubmit({
    ...env,
    ...(positionals[0] !== undefined ? { rawTask: positionals[0] } : {}),
    ...(typeof values["file"] === "string" ? { file: values["file"] as string } : {}),
    ...(typeof values["task-id"] === "string" ? { taskId: values["task-id"] as string } : {}),
    ...(values["no-start"] === true || values["foreground"] === true ? { noStart: true } : {}),
    ...(roleBindings !== undefined ? { roleBindings } : {}),
  });
  emit(io, result);
  // --foreground: after submit (noStart), run the host main loop in the foreground of this process.
  if (values["foreground"] === true) {
    const taskId = (result.data as { taskId?: string } | undefined)?.taskId;
    if (taskId === undefined) return CliExitCode.GeneralError;
    return runForeground(env.projectRoot, taskId, io);
  }
  return CliExitCode.Ok;
}

async function cmdRun(args: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const { values, positionals } = tryParse(args, { ...COMMON_OPTS, foreground: { type: "boolean" } });
  const taskId = requireTaskId(positionals);
  const env = baseEnv(values);
  if (values["foreground"] === true) {
    // Foreground: run the host main loop directly in this process.
    return runForeground(env.projectRoot, taskId, io);
  }
  const result = await execRun({ ...env, taskId });
  emit(io, result);
  return CliExitCode.Ok;
}

/**
 * --foreground: run the host main loop directly inside the CLI process; host logs go straight to the
 * terminal and the exit code is mapped accordingly. Shares the assertRunnableTask check with background
 * run (task exists + not paused/terminal) so foreground and background run have identical semantics.
 */
async function runForeground(projectRoot: string, taskId: string, io: CliIo): Promise<number> {
  let paths;
  try {
    paths = await assertRunnableTask({ projectRoot, source: SOURCE, taskId });
  } catch (err) {
    if (err instanceof CliError) {
      io.err(err.message);
      return err.exitCode;
    }
    throw err;
  }
  // Like background detached run, honor per-task manifest.roleBindings; load failure is fail-soft.
  const roleBindings = await loadManifestRoleBindings(paths);
  const result = await runDaemon(buildProductionDaemonConfig(paths, projectRoot, roleBindings));
  io.err(`host exited: ${result.reason}`);
  return hostExitToCliExit(result.exitCode);
}

async function cmdTextWrite(
  args: ReadonlyArray<string>,
  io: CliIo,
  fn: (input: ExecEnv & { taskId: string; text?: string; file?: string }) => Promise<CommandResult>,
): Promise<number> {
  const { values, positionals } = tryParse(args, {
    ...COMMON_OPTS,
    file: { type: "string" },
    "no-spawn": { type: "boolean" },
  });
  const taskId = requireTaskId(positionals);
  const env = baseEnv(values);
  const result = await fn({
    ...env,
    taskId,
    ...(positionals[1] !== undefined ? { text: positionals[1] } : {}),
    ...(typeof values["file"] === "string" ? { file: values["file"] as string } : {}),
  });
  emit(io, result);
  return CliExitCode.Ok;
}

async function cmdUpload(args: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const { values, positionals } = tryParse(args, {
    ...COMMON_OPTS,
    note: { type: "string" },
    "no-spawn": { type: "boolean" },
  });
  const taskId = requireTaskId(positionals);
  const filePath = positionals[1];
  if (filePath === undefined) {
    throw new CliError("Please provide the path of the file to upload", {
      exitCode: CliExitCode.InvalidArgument,
      errorKind: CliErrorKind.argMissing,
    });
  }
  const env = baseEnv(values);
  const result = await execUpload({
    ...env,
    taskId,
    filePath,
    ...(typeof values["note"] === "string" ? { note: values["note"] as string } : {}),
  });
  emit(io, result);
  return CliExitCode.Ok;
}

async function cmdTaskOnly(
  args: ReadonlyArray<string>,
  io: CliIo,
  fn: (input: ExecEnv & { taskId: string }) => Promise<CommandResult>,
): Promise<number> {
  const { values, positionals } = tryParse(args, COMMON_OPTS);
  const taskId = requireTaskId(positionals);
  const result = await fn({ ...baseEnv(values), taskId });
  emit(io, result);
  return CliExitCode.Ok;
}

async function cmdResume(args: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const { values, positionals } = tryParse(args, { ...COMMON_OPTS, foreground: { type: "boolean" } });
  const taskId = requireTaskId(positionals);
  if (values["foreground"] === true) {
    // resume: first transition stage (noSpawn skips background launch), then run the host in the foreground.
    const r = await execResume({ ...baseEnv(values), noSpawn: true, taskId });
    emit(io, r);
    return runForeground(projectRootFrom(values), taskId, io);
  }
  const result = await execResume({ ...baseEnv(values), taskId });
  emit(io, result);
  return CliExitCode.Ok;
}

async function cmdCancel(args: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const { values, positionals } = tryParse(args, { ...COMMON_OPTS, reason: { type: "string" } });
  const taskId = requireTaskId(positionals);
  const result = await execCancel({
    ...baseEnv(values),
    taskId,
    ...(typeof values["reason"] === "string" ? { reason: values["reason"] as string } : {}),
  });
  emit(io, result);
  return CliExitCode.Ok;
}

async function cmdRename(args: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const { values, positionals } = tryParse(args, COMMON_OPTS);
  const taskId = requireTaskId(positionals);
  const title = positionals[1];
  if (title === undefined) {
    throw new CliError("Please provide a task title", { exitCode: CliExitCode.InvalidArgument, errorKind: CliErrorKind.argMissing });
  }
  const result = await execRename({ ...baseEnv(values), taskId, title });
  emit(io, result);
  return CliExitCode.Ok;
}

async function cmdList(args: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const { values } = tryParse(args, { ...COMMON_OPTS, stage: { type: "string" } });
  const projectRoot = projectRootFrom(values);
  const stageFilter = typeof values["stage"] === "string" ? (values["stage"] as string) : undefined;
  // Reject an unknown stage value: otherwise an empty list is returned silently, masking typos.
  if (stageFilter !== undefined && !(STAGES_ALL as ReadonlyArray<string>).includes(stageFilter)) {
    throw cliErrors.argInvalid(`Unknown stage: ${stageFilter} (valid values: ${STAGES_ALL.join(", ")})`, `unknown stage ${stageFilter}`);
  }
  const entries = await listTasks(projectRoot, stageFilter);
  // Debug-facing table (shows the raw stage string).
  const header = `${"task_id".padEnd(26)}${"stage".padEnd(18)}${"updated_at".padEnd(28)}title`;
  io.out(header);
  for (const e of entries) {
    const title = e.title.length > 40 ? e.title.slice(0, 39) + "…" : e.title;
    io.out(`${e.taskId.padEnd(26)}${e.stage.padEnd(18)}${e.updatedAt.padEnd(28)}${title}`);
  }
  if (entries.length === 0) io.out("(no tasks)");
  return CliExitCode.Ok;
}

async function cmdStatus(args: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const { values, positionals } = tryParse(args, { ...COMMON_OPTS, full: { type: "boolean" } });
  const taskId = requireTaskId(positionals);
  const projectRoot = projectRootFrom(values);
  const { existsSync } = await import("node:fs");
  const paths = (() => {
    try {
      return buildTaskCapsulePaths(tasksRootOf(projectRoot), taskId);
    } catch {
      return null;
    }
  })();
  if (paths === null || !existsSync(paths.taskRoot)) {
    throw cliErrors.taskNotFound(taskId);
  }
  const md = await readOrRenderStatusMd(paths);
  io.out(md);
  if (values["full"] === true) {
    const { readFile } = await import("node:fs/promises");
    try {
      const manifestText = await readFile(paths.manifestPath, "utf8");
      io.out("--- manifest ---");
      io.out(manifestText);
    } catch {
      io.out("(manifest read failed)");
    }
  }
  return CliExitCode.Ok;
}

/**
 * Optional-value flags (`--inbox [<ch>]` / `--events [N]` / stream with optional sid): util.parseArgs
 * with `type:"string"` reports "argument missing" for a bare flag (no value following it). Preprocess
 * argv: if such a flag has no value right after it (end of args / next is another flag / next is the
 * positional taskId), inject an empty-string sentinel "" so parseArgs accepts it; downstream treats ""
 * as the "no value" branch.
 */
const INSPECT_OPTIONAL_VALUE_FLAGS = new Set([
  "--inbox",
  "--meta-stream",
  "--watcher-stream",
  "--worker-stream",
  "--events",
  "--last",
]);

function normalizeOptionalValueFlags(args: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    out.push(a);
    if (INSPECT_OPTIONAL_VALUE_FLAGS.has(a)) {
      const next = args[i + 1];
      // Next is another flag or missing -> treat the flag as bare, inject empty-string sentinel.
      if (next === undefined || next.startsWith("-")) out.push("");
    }
  }
  return out;
}

/** Parse an optional numeric flag: absent -> undefined; empty-string sentinel (bare flag) -> default; explicit number (including 0) -> that number. */
function parseOptionalCount(raw: unknown, dflt: number): number | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw === "") return dflt;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

async function cmdInspect(args: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const { values, positionals } = tryParse(normalizeOptionalValueFlags(args), {
    ...COMMON_OPTS,
    inbox: { type: "string" },
    "meta-stream": { type: "string" },
    "watcher-stream": { type: "string" },
    "worker-stream": { type: "string" },
    "watcher-context": { type: "boolean" },
    events: { type: "string" },
    last: { type: "string" },
  });
  const taskId = requireTaskId(positionals);
  const projectRoot = projectRootFrom(values);
  const optStr = (key: string): string | true | undefined => {
    const v = values[key];
    if (v === undefined) return undefined;
    return v === "" ? true : (v as string);
  };
  const events = parseOptionalCount(values["events"], 30);
  const last = parseOptionalCount(values["last"], 20);
  const mode: InspectMode = {
    ...(optStr("inbox") !== undefined ? { inbox: optStr("inbox")! } : {}),
    ...(optStr("meta-stream") !== undefined ? { metaStream: optStr("meta-stream")! } : {}),
    ...(optStr("watcher-stream") !== undefined ? { watcherStream: optStr("watcher-stream")! } : {}),
    ...(optStr("worker-stream") !== undefined ? { workerStream: optStr("worker-stream")! } : {}),
    ...(values["watcher-context"] === true ? { watcherContext: true } : {}),
    ...(events !== undefined ? { events } : {}),
    ...(last !== undefined ? { last } : {}),
  };
  const text = await renderInspect(projectRoot, taskId, mode);
  io.out(text);
  return CliExitCode.Ok;
}

/** web subcommand: start the Web GUI backend. Loopback-only binding. */
async function cmdWeb(args: ReadonlyArray<string>, io: CliIo): Promise<number> {
  const { values } = tryParse(args, { ...COMMON_OPTS, host: { type: "string" }, port: { type: "string" } });
  const projectRoot = projectRootFrom(values);
  const host = typeof values["host"] === "string" ? (values["host"] as string) : "127.0.0.1";
  const port = typeof values["port"] === "string" ? Number.parseInt(values["port"] as string, 10) : 4319;
  const { startWebServer } = await import("../web/index.js");
  try {
    const { url } = await startWebServer({ projectRoot, host, port });
    io.out(`Web GUI started: ${url}`);
    io.out("(Ctrl-C to exit)");
    // Block: keep the process alive until terminated by a signal.
    await new Promise<void>(() => {});
    return CliExitCode.Ok;
  } catch (err) {
    io.err(`Web GUI failed to start: ${(err as Error).message}`);
    return CliExitCode.GeneralError;
  }
}
