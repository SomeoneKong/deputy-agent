/**
 * harness editing tools: sh_harness__write_worker / write_watcher / read. Meta only (read also allowed for the Watcher, read-only).
 *
 * - Pure file write + audit (harness_changed event); does not schedule agents as a side effect.
 * - Path whitelist exposed via inputSchema enum + pattern; the handler re-validates and prevents escaping workspace/harness/.
 * - done_criteria.yaml is sync-parse-validated (schematic content is not exempt); natural-language text is exempt.
 * - read fail-soft truncates oversized files and sets truncated.
 * - Writing in a terminal / paused stage -> illegal_state.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { HostTool, JsonSchema } from "../../wrapper/index.js";
import { atomicWriter } from "../../shared/atomic.js";
import { manifestIO } from "../../shared/manifest.js";
import { HostToolCommonErrorKind } from "../errorKinds.js";
import { eventsIO } from "../events.js";
import { validateDoneCriteriaContent } from "../done_criteria/index.js";
import {
  asInputObject,
  callerSessionId,
  checkCallerRole,
  fail,
  ok,
  requireNonBlankString,
  toCallResult,
  type HostToolDeps,
  type HostToolResultBase,
} from "./common.js";

const HARNESS_READ_TRUNCATE_BYTES = 64 * 1024;

/**
 * Truncate a UTF-8 string to a byte limit, backing off to a character boundary (never cutting mid-sequence).
 * `String.prototype.slice` cuts by UTF-16 code unit, which can far exceed the byte limit for multibyte content;
 * this function guarantees a return of valid UTF-8 within maxBytes.
 */
function truncateUtf8Bytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return s;
  let end = maxBytes;
  // A continuation byte is 0b10xxxxxx (0x80-0xBF); back off to the lead byte to avoid cutting half a character.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

// Fixed file whitelist (worker-facing)
const WORKER_FIXED_FILES = [
  "methodology.md",
  "done_criteria.yaml",
  "worker_prompt_taskpart.md",
  "tools/.mcp.json",
] as const;

// Subdir path pattern (sop/<name>.md / tools/...)
const WORKER_SUBDIR_PATTERN =
  "^(sop/[A-Za-z0-9._-]+\\.md|tools/skills_local/[A-Za-z0-9._/-]+|tools/mcp_servers_local/[A-Za-z0-9._/-]+|tools/scripts/[A-Za-z0-9._-]+)$";

const WORKER_SUBDIR_RE = new RegExp(WORKER_SUBDIR_PATTERN);

/** Whether path is in the worker harness whitelist (fixed files plus the subdir pattern). */
function isWorkerHarnessPath(path: string): boolean {
  if ((WORKER_FIXED_FILES as ReadonlyArray<string>).includes(path)) return true;
  return WORKER_SUBDIR_RE.test(path);
}

/** Prevent `..` / absolute paths / drive letters from escaping workspace/harness/ (the whitelist already limits this; a backstop). */
function isSafeRelative(path: string): boolean {
  if (path.length === 0) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  if (path.split(/[/\\]/).some((seg) => seg === "..")) return false;
  if (path.includes("\0")) return false;
  return true;
}

interface WriteHarnessInput {
  readonly path: string;
  readonly content: string;
  readonly mode: "overwrite" | "create";
  readonly reason: string | null;
}

function parseWriteInput(
  toolName: string,
  input: unknown,
  allowedPath: (p: string) => boolean,
): { value: WriteHarnessInput } | { fail: HostToolResultBase } {
  const objR = asInputObject(toolName, input);
  if ("fail" in objR) return objR;
  const obj = objR.obj;

  const pathR = requireNonBlankString("path", obj["path"]);
  if ("fail" in pathR) return pathR;
  const path = pathR.value;
  if (!isSafeRelative(path) || !allowedPath(path)) {
    return { fail: fail(HostToolCommonErrorKind.invalidArgument, `path '${path}' is not in the harness write whitelist`) };
  }

  if (typeof obj["content"] !== "string") {
    return { fail: fail(HostToolCommonErrorKind.invalidArgument, "field 'content' must be a string") };
  }
  const content = obj["content"];

  let mode: "overwrite" | "create" = "overwrite";
  if (obj["mode"] !== undefined) {
    if (obj["mode"] !== "overwrite" && obj["mode"] !== "create") {
      return { fail: fail(HostToolCommonErrorKind.invalidArgument, "field 'mode' must be 'overwrite' or 'create'") };
    }
    mode = obj["mode"];
  }

  const reason = typeof obj["reason"] === "string" ? obj["reason"] : null;
  return { value: { path, content, mode, reason } };
}

/** Sync parse-validate schematic content. Returns a diagnostic or null. */
function validateSchematicContent(path: string, content: string): string | null {
  if (path === "done_criteria.yaml") {
    // Reuse the single sync validate entry of done_criteria: full schema validation (unknown kind / missing field /
    // path out of bounds / interpreter allowlist) fails fast and rejects the write. A shallow check (only top-level
    // mapping + checks is a list) would let invalid checks through, surfacing only at evaluate time.
    return validateDoneCriteriaContent(content);
  }
  if (path === "tools/.mcp.json") {
    try {
      JSON.parse(content);
    } catch (err) {
      return `tools/.mcp.json is not valid JSON: ${(err as Error).message}`;
    }
  }
  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

const TERMINAL_OR_PAUSED = new Set(["done", "failed", "cancelled", "paused"]);

async function writeHarnessFile(
  deps: HostToolDeps,
  parsed: WriteHarnessInput,
  harnessRole: "worker" | "watcher",
  bySession: string,
): Promise<HostToolResultBase & { path?: string; bytesWritten?: number }> {
  // stage second line of defense: terminal / paused is not writable
  let stage: string;
  try {
    stage = (await manifestIO.load(deps.paths)).stage;
  } catch (err) {
    return fail(HostToolCommonErrorKind.hostInternal, `failed to load manifest: ${(err as Error).message}`);
  }
  if (TERMINAL_OR_PAUSED.has(stage)) {
    return fail(HostToolCommonErrorKind.illegalState, `cannot write harness in stage '${stage}'`);
  }

  const diag = validateSchematicContent(parsed.path, parsed.content);
  if (diag !== null) {
    return fail(HostToolCommonErrorKind.invalidArgument, diag);
  }

  const absPath = join(deps.paths.harnessDir, parsed.path);
  if (parsed.mode === "create") {
    let exists: boolean;
    try {
      exists = await fileExists(absPath);
    } catch (err) {
      return fail(HostToolCommonErrorKind.hostInternal, `stat failed: ${(err as Error).message}`);
    }
    if (exists) {
      return fail(HostToolCommonErrorKind.illegalState, `file already exists (mode=create): ${parsed.path}`);
    }
  }

  const bytesWritten = Buffer.byteLength(parsed.content, "utf8");
  try {
    await atomicWriter.writeText(absPath, parsed.content);
  } catch (err) {
    return fail(HostToolCommonErrorKind.hostInternal, `atomic write failed: ${(err as Error).message}`);
  }

  // audit harness_changed (fail-soft: the file is already written; a missing event is not rolled back)
  try {
    await eventsIO.append(deps.paths, {
      type: "harness_changed",
      stage: stage as never,
      // bySession audits "who changed the harness in which session", formatted {callerRole}_session:{sessionId}.
      details: { path: parsed.path, bytesWritten, harnessRole, reason: parsed.reason, bySession },
    });
  } catch (err) {
    console.warn(`[harness] harness_changed event append failed (file already written): ${(err as Error).message}`);
  }

  return ok({ path: parsed.path, bytesWritten });
}

const LANG_REMINDER =
  " Configuration files (worker_prompt_taskpart.md / methodology.md / sop/*.md / done_criteria.yaml) " +
  "must be written in the Worker prompt language (the Worker is the primary consumer); see the " +
  "'## Harness file language directives' section in your system prompt.";

const WRITE_WORKER_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description:
        "Path relative to workspace/harness/. One of the fixed files (" +
        WORKER_FIXED_FILES.join(", ") +
        ") or a subdir path matching sop/<name>.md, tools/skills_local/<...>, tools/mcp_servers_local/<...>, tools/scripts/<name>.",
      pattern:
        "^(methodology\\.md|done_criteria\\.yaml|worker_prompt_taskpart\\.md|tools/\\.mcp\\.json|" +
        "sop/[A-Za-z0-9._-]+\\.md|tools/skills_local/[A-Za-z0-9._/-]+|tools/mcp_servers_local/[A-Za-z0-9._/-]+|tools/scripts/[A-Za-z0-9._-]+)$",
    },
    content: { type: "string", description: "Full file content (write-once; overwrites if exists)." },
    mode: { type: "string", enum: ["overwrite", "create"], description: "Default 'overwrite'. 'create' fails if file exists." },
    reason: { type: ["string", "null"], description: "Why this harness change (recorded in events.jsonl audit). Strongly recommended every call; pass null to omit." },
  },
  required: ["path", "content"],
  additionalProperties: false,
};

const WRITE_WATCHER_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    path: { type: "string", enum: ["watcher_taskpart.md"], description: "Only watcher_taskpart.md." },
    content: { type: "string", description: "Full file content (natural language; no schema validation)." },
    mode: { type: "string", enum: ["overwrite", "create"] },
    reason: { type: ["string", "null"], description: "Why this watcher harness change (events.jsonl audit); pass null to omit." },
  },
  required: ["path", "content"],
  additionalProperties: false,
};

const READ_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description:
        "Path relative to workspace/harness/. One of the worker harness fixed files (" +
        WORKER_FIXED_FILES.join(", ") +
        "), a subdir path matching sop/<name>.md, tools/skills_local/<...>, tools/mcp_servers_local/<...>, tools/scripts/<name>, or watcher_taskpart.md.",
      pattern:
        "^(methodology\\.md|done_criteria\\.yaml|worker_prompt_taskpart\\.md|tools/\\.mcp\\.json|" +
        "sop/[A-Za-z0-9._-]+\\.md|tools/skills_local/[A-Za-z0-9._/-]+|tools/mcp_servers_local/[A-Za-z0-9._/-]+|tools/scripts/[A-Za-z0-9._-]+|watcher_taskpart\\.md)$",
    },
  },
  required: ["path"],
  additionalProperties: false,
};

export function makeWriteWorkerTool(deps: HostToolDeps): HostTool {
  return {
    name: "sh_harness__write_worker",
    description:
      "Write a worker-facing harness file under workspace/harness/ atomically with audit. Meta only. " +
      "Writes the file ONLY; it does NOT start/stop or schedule the Worker (separate concern) — to make the Worker " +
      "use new harness, separately call sh_msg__send_to_worker / sh_agent__start_worker. Schematic files are fully " +
      "schema-validated before write (done_criteria.yaml: non-empty 'checks' list, each a known kind with required " +
      "fields and safe relative paths; tools/.mcp.json: valid JSON) — invalid content is rejected (not written)." +
      LANG_REMINDER,
    scope: ["meta"],
    inputSchema: WRITE_WORKER_SCHEMA,
    metadata: { concurrent: false },
    handler: async (input, ctx) => {
      const roleFail = checkCallerRole("sh_harness__write_worker", ctx, ["meta"]);
      if (roleFail !== null) return toCallResult(roleFail);
      const parsed = parseWriteInput("sh_harness__write_worker", input, isWorkerHarnessPath);
      if ("fail" in parsed) return toCallResult(parsed.fail);
      const bySession = `${ctx.agentRole}_session:${callerSessionId(ctx)}`;
      return toCallResult(await writeHarnessFile(deps, parsed.value, "worker", bySession));
    },
  };
}

export function makeWriteWatcherTool(deps: HostToolDeps): HostTool {
  return {
    name: "sh_harness__write_watcher",
    description:
      "Write watcher_taskpart.md under workspace/harness/ atomically with audit. Meta only. Writes the file ONLY; " +
      "it does NOT schedule the Watcher — for lightweight observation hints use sh_msg__send_to_watcher instead.",
    scope: ["meta"],
    inputSchema: WRITE_WATCHER_SCHEMA,
    metadata: { concurrent: false },
    handler: async (input, ctx) => {
      const roleFail = checkCallerRole("sh_harness__write_watcher", ctx, ["meta"]);
      if (roleFail !== null) return toCallResult(roleFail);
      const parsed = parseWriteInput("sh_harness__write_watcher", input, (p) => p === "watcher_taskpart.md");
      if ("fail" in parsed) return toCallResult(parsed.fail);
      const bySession = `${ctx.agentRole}_session:${callerSessionId(ctx)}`;
      return toCallResult(await writeHarnessFile(deps, parsed.value, "watcher", bySession));
    },
  };
}

export function makeReadHarnessTool(deps: HostToolDeps): HostTool {
  return {
    name: "sh_harness__read",
    description:
      "Read a harness file under workspace/harness/. Meta and Watcher (read-only). Large files are fail-soft " +
      "truncated with truncated=true; use the built-in Read tool for full content in that case.",
    scope: ["meta", "watcher"],
    inputSchema: READ_SCHEMA,
    handler: async (input, ctx) => {
      const roleFail = checkCallerRole("sh_harness__read", ctx, ["meta", "watcher"]);
      if (roleFail !== null) return toCallResult(roleFail);
      const objR = asInputObject("sh_harness__read", input);
      if ("fail" in objR) return toCallResult(objR.fail);
      const pathR = requireNonBlankString("path", objR.obj["path"]);
      if ("fail" in pathR) return toCallResult(pathR.fail);
      const path = pathR.value;
      if (!isSafeRelative(path) || !(isWorkerHarnessPath(path) || path === "watcher_taskpart.md")) {
        return toCallResult(fail(HostToolCommonErrorKind.invalidArgument, `path '${path}' is not in the harness read whitelist`));
      }
      const absPath = join(deps.paths.harnessDir, path);
      let raw: string;
      try {
        raw = await readFile(absPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return toCallResult(fail(HostToolCommonErrorKind.targetNotFound, `harness file not found: ${path}`));
        }
        return toCallResult(fail(HostToolCommonErrorKind.hostInternal, `read failed: ${(err as Error).message}`));
      }
      const truncated = Buffer.byteLength(raw, "utf8") > HARNESS_READ_TRUNCATE_BYTES;
      const content = truncated ? truncateUtf8Bytes(raw, HARNESS_READ_TRUNCATE_BYTES) : raw;
      return toCallResult(ok({ path, content, truncated }));
    },
  };
}
