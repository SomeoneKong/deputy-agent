/**
 * Execution semantics for the 6 check kinds + workspace containment re-check (prefix comparison after resolve).
 *
 * Returns (result, errorKind, detail):
 * - result=pass/fail -> errorKind=null
 * - result=error -> errorKind from the check-level error-kind subset + detail.reason human-readable text
 *
 * A containment escape is treated as result=error.
 */
import { readFile, lstat, stat, realpath } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { parse as parseYaml } from "yaml";

import { DoneCriteriaErrorKind } from "./errorKinds.js";
import { runScript, type ScriptProcessRegistry } from "./scriptRunner.js";
import {
  DEFAULT_SCRIPT_TIMEOUT_SECONDS,
  SCRIPT_STDERR_TAIL,
  SCRIPT_STDOUT_TAIL,
  type DirMinFilesCheck,
  type DoneCriteriaCheck,
  type FileExistsCheck,
  type FileMinBytesCheck,
  type FileMinLinesCheck,
  type ScriptCheck,
  type YamlFieldPresentCheck,
} from "./types.js";
import { interpreterAllowed } from "./validate.js";

export interface CheckExecResult {
  readonly result: "pass" | "fail" | "error";
  readonly errorKind: DoneCriteriaErrorKind | null;
  readonly detail: Record<string, unknown>;
}

function pass(detail: Record<string, unknown>): CheckExecResult {
  return { result: "pass", errorKind: null, detail };
}
function fail(detail: Record<string, unknown>): CheckExecResult {
  return { result: "fail", errorKind: null, detail };
}
function error(errorKind: DoneCriteriaErrorKind, detail: Record<string, unknown>): CheckExecResult {
  return { result: "error", errorKind, detail };
}

/**
 * Resolve a relative path within the workspace and perform a containment check.
 * Returns the lexical absolute path (preserving symlink form for lstat checks); on escape / resolve error returns an escape marker.
 */
async function resolveInWorkspace(
  workspaceAbs: string,
  rel: string,
): Promise<{ readonly lexical: string } | { readonly escape: true }> {
  const lexical = join(workspaceAbs, rel);
  try {
    // realpath follows symlinks for the containment check (guards against a symlink pointing outside); a non-existent path falls back to lexical.
    const wsReal = await safeRealpath(workspaceAbs);
    const targetReal = await safeRealpath(lexical);
    const wsPrefix = wsReal.endsWith(sep) ? wsReal : wsReal + sep;
    if (targetReal !== wsReal && !targetReal.startsWith(wsPrefix)) {
      return { escape: true };
    }
    return { lexical };
  } catch {
    return { escape: true };
  }
}

/** realpath of an existing path; for a non-existent path, falls back to a lexically normalized resolve. */
async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    // Non-existent: fall back to resolve (lexical normalization, collapsing .. etc.) for the containment check.
    return resolve(p);
  }
}

async function isRegularFile(absPath: string): Promise<{ ok: boolean } | { osError: string }> {
  try {
    const st = await lstat(absPath);
    if (st.isSymbolicLink()) return { ok: false };
    return { ok: st.isFile() };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ok: false };
    return { osError: e.message };
  }
}

// ---- file_exists ----

export async function checkFileExists(check: FileExistsCheck, workspaceAbs: string): Promise<CheckExecResult> {
  const r = await resolveInWorkspace(workspaceAbs, check.path);
  if ("escape" in r) {
    return error(DoneCriteriaErrorKind.pathEscape, { path: check.path, absolute: null, reason: "path_escape" });
  }
  const reg = await isRegularFile(r.lexical);
  if ("osError" in reg) {
    return error(DoneCriteriaErrorKind.checkIoError, { path: check.path, absolute: r.lexical, reason: `io_error: ${reg.osError}` });
  }
  if (reg.ok) return pass({ path: check.path, absolute: r.lexical });
  return fail({ path: check.path, absolute: r.lexical, reason: "not_a_regular_file" });
}

// ---- file_min_lines ----

export async function checkFileMinLines(check: FileMinLinesCheck, workspaceAbs: string): Promise<CheckExecResult> {
  const r = await resolveInWorkspace(workspaceAbs, check.path);
  if ("escape" in r) {
    return error(DoneCriteriaErrorKind.pathEscape, { path: check.path, lines: 0, minLines: check.minLines, reason: "path_escape" });
  }
  const reg = await isRegularFile(r.lexical);
  if ("osError" in reg) {
    return error(DoneCriteriaErrorKind.checkIoError, { path: check.path, lines: 0, minLines: check.minLines, reason: `io_error: ${reg.osError}` });
  }
  if (!reg.ok) {
    return fail({ path: check.path, lines: 0, minLines: check.minLines, reason: "not_a_regular_file" });
  }
  let text: string;
  try {
    text = await readFile(r.lexical, "utf8"); // utf-8 invalid bytes → U+FFFD replacement (fail-soft)
  } catch (err) {
    return error(DoneCriteriaErrorKind.checkIoError, { path: check.path, lines: 0, minLines: check.minLines, reason: `io_error: ${(err as Error).message}` });
  }
  const lines = countLines(text);
  if (lines >= check.minLines) return pass({ path: check.path, lines, minLines: check.minLines });
  return fail({ path: check.path, lines, minLines: check.minLines, reason: "lines_below_min" });
}

/** Line count: a final line without a \n still counts; robust to mixed line endings (splitlines semantics). */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  // Split on \r\n / \r / \n (splitlines semantics).
  const segs = text.split(/\r\n|\r|\n/);
  // If the text ends with a newline, split produces a trailing empty string; drop it.
  if (segs.length > 0 && segs[segs.length - 1] === "") segs.pop();
  return segs.length;
}

// ---- file_min_bytes ----

export async function checkFileMinBytes(check: FileMinBytesCheck, workspaceAbs: string): Promise<CheckExecResult> {
  const r = await resolveInWorkspace(workspaceAbs, check.path);
  if ("escape" in r) {
    return error(DoneCriteriaErrorKind.pathEscape, { path: check.path, bytes: 0, minBytes: check.minBytes, reason: "path_escape" });
  }
  const reg = await isRegularFile(r.lexical);
  if ("osError" in reg) {
    return error(DoneCriteriaErrorKind.checkIoError, { path: check.path, bytes: 0, minBytes: check.minBytes, reason: `io_error: ${reg.osError}` });
  }
  if (!reg.ok) {
    return fail({ path: check.path, bytes: 0, minBytes: check.minBytes, reason: "not_a_regular_file" });
  }
  let size: number;
  try {
    size = (await stat(r.lexical)).size;
  } catch (err) {
    return error(DoneCriteriaErrorKind.checkIoError, { path: check.path, bytes: 0, minBytes: check.minBytes, reason: `io_error: ${(err as Error).message}` });
  }
  if (size >= check.minBytes) return pass({ path: check.path, bytes: size, minBytes: check.minBytes });
  return fail({ path: check.path, bytes: size, minBytes: check.minBytes, reason: "bytes_below_min" });
}

// ---- yaml_field_present ----

export async function checkYamlFieldPresent(check: YamlFieldPresentCheck, workspaceAbs: string): Promise<CheckExecResult> {
  const r = await resolveInWorkspace(workspaceAbs, check.path);
  if ("escape" in r) {
    return error(DoneCriteriaErrorKind.pathEscape, { path: check.path, field: check.field, reason: "path_escape" });
  }
  const reg = await isRegularFile(r.lexical);
  if ("osError" in reg) {
    return error(DoneCriteriaErrorKind.checkIoError, { path: check.path, field: check.field, reason: `io_error: ${reg.osError}` });
  }
  if (!reg.ok) {
    return fail({ path: check.path, field: check.field, reason: "not_a_regular_file" });
  }
  let text: string;
  try {
    text = await readFile(r.lexical, "utf8");
  } catch (err) {
    return error(DoneCriteriaErrorKind.checkIoError, { path: check.path, field: check.field, reason: `io_error: ${(err as Error).message}` });
  }
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    return error(DoneCriteriaErrorKind.yamlParseError, { path: check.path, field: check.field, reason: `parse_error: ${(err as Error).message}` });
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return fail({ path: check.path, field: check.field, reason: "root_not_mapping" });
  }
  const segments = check.field.split(".");
  let cursor: unknown = data;
  for (let depth = 0; depth < segments.length; depth++) {
    const seg = segments[depth]!;
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
      const parent = segments.slice(0, depth).join(".") || "<root>";
      return fail({ path: check.path, field: check.field, reason: `segment_value_not_dict:${parent}` });
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, seg)) {
      return fail({ path: check.path, field: check.field, reason: `missing_segment:${seg}` });
    }
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return pass({ path: check.path, field: check.field });
}

// ---- dir_min_files ----

export async function checkDirMinFiles(check: DirMinFilesCheck, workspaceAbs: string): Promise<CheckExecResult> {
  const r = await resolveInWorkspace(workspaceAbs, check.path);
  if ("escape" in r) {
    return error(DoneCriteriaErrorKind.pathEscape, { path: check.path, pattern: check.pattern, count: 0, minCount: check.minCount, reason: "path_escape" });
  }
  let isDir = false;
  try {
    isDir = (await stat(r.lexical)).isDirectory();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return fail({ path: check.path, pattern: check.pattern, count: 0, minCount: check.minCount, reason: "dir_not_exist" });
    }
    return error(DoneCriteriaErrorKind.checkIoError, { path: check.path, pattern: check.pattern, count: 0, minCount: check.minCount, reason: `glob_io_error: ${e.message}` });
  }
  if (!isDir) {
    return fail({ path: check.path, pattern: check.pattern, count: 0, minCount: check.minCount, reason: "dir_not_exist" });
  }

  const wsReal = await safeRealpath(workspaceAbs);
  const wsPrefix = wsReal.endsWith(sep) ? wsReal : wsReal + sep;
  let count = 0;
  try {
    for await (const entry of glob(check.pattern, { cwd: r.lexical })) {
      const abs = join(r.lexical, entry);
      // Containment re-check: out-of-bounds entries are not counted (filtered, not an error).
      const entryReal = await safeRealpath(abs);
      if (entryReal !== wsReal && !entryReal.startsWith(wsPrefix)) continue;
      const reg = await isRegularFile(abs);
      if ("ok" in reg && reg.ok) count += 1;
    }
  } catch (err) {
    return error(DoneCriteriaErrorKind.checkIoError, { path: check.path, pattern: check.pattern, count, minCount: check.minCount, reason: `glob_io_error: ${(err as Error).message}` });
  }
  if (count >= check.minCount) {
    return pass({ path: check.path, pattern: check.pattern, count, minCount: check.minCount });
  }
  return fail({ path: check.path, pattern: check.pattern, count, minCount: check.minCount, reason: "count_below_min" });
}

// ---- script ----

export async function checkScript(
  check: ScriptCheck,
  workspaceAbs: string,
  opts: { readonly taskId?: string | undefined; readonly registry?: ScriptProcessRegistry | undefined },
): Promise<CheckExecResult> {
  const timeoutSeconds = check.timeoutSeconds ?? DEFAULT_SCRIPT_TIMEOUT_SECONDS;
  const baseDetail = {
    scriptPath: check.scriptPath,
    interpreter: check.interpreter,
    returnCode: null as number | null,
    stdout: "",
    stderr: "",
    durationMs: 0,
  };

  // interpreter allowlist: a per-check runtime error (does not short-circuit the whole evaluate).
  if (!interpreterAllowed(check.interpreter)) {
    return error(DoneCriteriaErrorKind.interpreterNotAllowed, { ...baseDetail, reason: `interpreter_not_allowed: ${check.interpreter}` });
  }

  const r = await resolveInWorkspace(workspaceAbs, check.scriptPath);
  if ("escape" in r) {
    return error(DoneCriteriaErrorKind.pathEscape, { ...baseDetail, reason: "path_escape" });
  }
  const reg = await isRegularFile(r.lexical);
  if ("osError" in reg) {
    return error(DoneCriteriaErrorKind.scriptIoError, { ...baseDetail, reason: `script_io_error: ${reg.osError}` });
  }
  if (!reg.ok) {
    return error(DoneCriteriaErrorKind.scriptIoError, { ...baseDetail, reason: "script_not_a_regular_file" });
  }

  // env allowlist injection: base variables + WORKSPACE + TASK_ID; does not inherit host secrets.
  const env = buildScriptEnv(workspaceAbs, opts.taskId);

  const run = await runScript({
    interpreter: check.interpreter,
    scriptAbsPath: r.lexical,
    workspaceAbs,
    env,
    timeoutSeconds,
    registry: opts.registry,
  });

  const stdout = run.stdout.length > SCRIPT_STDOUT_TAIL ? run.stdout.slice(run.stdout.length - SCRIPT_STDOUT_TAIL) : run.stdout;
  const stderr = run.stderr.length > SCRIPT_STDERR_TAIL ? run.stderr.slice(run.stderr.length - SCRIPT_STDERR_TAIL) : run.stderr;
  const detail = {
    scriptPath: check.scriptPath,
    interpreter: check.interpreter,
    returnCode: run.returnCode,
    stdout,
    stderr,
    durationMs: run.durationMs,
  };

  if (run.kind === "timeout") {
    return error(DoneCriteriaErrorKind.scriptTimeout, { ...detail, reason: `timeout after ${timeoutSeconds}s` });
  }
  if (run.kind === "interpreter_not_found") {
    return error(DoneCriteriaErrorKind.interpreterNotFound, { ...detail, reason: `interpreter_not_found: ${run.errorMessage ?? check.interpreter}` });
  }
  if (run.kind === "io_error") {
    return error(DoneCriteriaErrorKind.scriptIoError, { ...detail, reason: `script_io_error: ${run.errorMessage ?? "subprocess error"}` });
  }
  if (run.returnCode === 0) return pass(detail);
  return fail({ ...detail, reason: `exit_code_${run.returnCode}` });
}

/** Allowlist-injected env: does not inherit host secrets, keeps the base variables a script needs to run. */
function buildScriptEnv(workspaceAbs: string, taskId: string | undefined): NodeJS.ProcessEnv {
  const baseKeys = ["PATH", "Path", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE", "SystemRoot", "windir", "PATHEXT", "COMSPEC"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of baseKeys) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  env["WORKSPACE"] = resolve(workspaceAbs);
  if (taskId !== undefined) env["TASK_ID"] = taskId;
  return env;
}

// ---- dispatch ----

export async function evaluateOne(
  check: DoneCriteriaCheck,
  workspaceAbs: string,
  opts: { readonly taskId?: string | undefined; readonly registry?: ScriptProcessRegistry | undefined },
): Promise<CheckExecResult> {
  switch (check.kind) {
    case "file_exists":
      return checkFileExists(check, workspaceAbs);
    case "file_min_lines":
      return checkFileMinLines(check, workspaceAbs);
    case "file_min_bytes":
      return checkFileMinBytes(check, workspaceAbs);
    case "yaml_field_present":
      return checkYamlFieldPresent(check, workspaceAbs);
    case "dir_min_files":
      return checkDirMinFiles(check, workspaceAbs);
    case "script":
      return checkScript(check, workspaceAbs, opts);
  }
}
