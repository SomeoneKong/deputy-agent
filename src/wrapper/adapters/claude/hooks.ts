/**
 * Claude hooks registration (path guard + compact).
 *
 * - PreToolUse (matcher Write|Edit|MultiEdit|NotebookEdit): a path matching a
 *   pathGuards deny rule returns permissionDecision:"deny" (a soft guardrail,
 *   toolEnforcement.preflightHook=true).
 * - PreCompact: marks compaction start (emits CompactStartedEvent), distinguishing manual / auto.
 * - PostCompact: carries compact_summary -> emits CompactEndedEvent (summary must be non-empty).
 */
import type {
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
  PreToolUseHookInput,
  PreCompactHookInput,
  PostCompactHookInput,
} from "@anthropic-ai/claude-agent-sdk";

import { resolve as pathResolve } from "node:path";

import type { CompactReason, PathGuardRule } from "../../types/index.js";
import { MCP_NAMESPACE, isHostToolName } from "./toolBridge.js";

const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const DOUBLE_STAR_TOKEN = "GLOBDOUBLESTAR";
const IS_WIN = process.platform === "win32";

/** Normalizes path separators (Windows `\` -> `/`) so glob matching works cross-platform. */
function normalizeSep(p: string): string {
  return p.replace(/\\/g, "/");
}

/** win32 case-insensitive normalization (same case-folding semantics as `os.path.normcase`) -- prevents case-based bypass like `WORKSPACE/Harness`. */
function normcase(p: string): string {
  return IS_WIN ? p.toLowerCase() : p;
}

/**
 * Strips Windows extended-length / device path prefixes (`\\?\` / `\\.\`) to prevent bypassing the guard via an extended path.
 * The UNC form `\\?\UNC\server\share\...` is restored to `\\server\share\...` (otherwise stripping to `UNC\...` would be misread as a relative path joined under cwd).
 */
function stripExtendedPrefix(p: string): string {
  const unc = p.replace(/^[\\/]{2}[?.][\\/]UNC[\\/]/i, "\\\\");
  if (unc !== p) return unc;
  return p.replace(/^[\\/]{2}[?.][\\/]/, "");
}

/**
 * Hardens a tool target path into a matchable form (purely lexical):
 * strip extended prefix -> resolve a relative path against the session cwd to an
 * absolute path (`pathResolve` also collapses `..` / `.` traversal) -> normalize
 * separators to `/` -> win32 normcase. This eliminates three bypass classes:
 * `workspace/sub/../harness/x` traversal, case, and extended-path.
 * Note: `pathResolve` is a purely lexical collapse and does not follow
 * symlinks/junctions (use a realpath-style check if following is required).
 * A symlink into the protected area requires deliberately creating the link
 * (not an accidental write), which is an adversarial scenario; this guard
 * targets accidental writes and does not cover that long tail.
 */
export function hardenPath(raw: string, cwd: string): string {
  const stripped = stripExtendedPrefix(raw);
  // Always pathResolve: a relative path resolves against cwd, an absolute path
  // ignores cwd -- both collapse `..`/`.`. An absolute path must not be returned
  // directly (`D:\ws\tmp\..\harness\x` is absolute but uncollapsed -> would bypass
  // a `${dir}/**` match while the FS lands inside it). pathResolve(absolute)
  // collapses it and matches correctly.
  const abs = pathResolve(cwd, stripped);
  return normcase(normalizeSep(abs));
}

/** Roughly converts a glob pattern (`**` across segments, `*` within a segment) to a RegExp. For path-guard soft matching only. Separators are already normalized to `/`. */
export function patternToRegExp(pattern: string): RegExp {
  const escaped = normalizeSep(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, DOUBLE_STAR_TOKEN)
    .replace(/\*/g, "[^/]*")
    .replace(new RegExp(DOUBLE_STAR_TOKEN, "g"), ".*");
  return new RegExp(`^${escaped}$`);
}

/** Extracts the target path from tool_input (Write/Edit use file_path, NotebookEdit uses notebook_path). */
export function extractPath(toolInput: unknown): string | undefined {
  if (toolInput === null || typeof toolInput !== "object") return undefined;
  const o = toolInput as Record<string, unknown>;
  for (const key of ["file_path", "notebook_path", "path"]) {
    const v = o[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

interface CompiledGuard {
  readonly rule: PathGuardRule;
  readonly re: RegExp;
}

/**
 * Decides whether a single tool call triggers a deny guard. Returns denyReason on a hit, otherwise undefined.
 * `cwd` is the session cwd (the base for resolving relative paths); target goes through hardenPath (strip extended prefix + collapse traversal + normcase).
 */
export function evaluatePathGuard(compiled: ReadonlyArray<CompiledGuard>, toolName: string, toolInput: unknown, cwd: string): string | undefined {
  if (!EDIT_TOOLS.includes(toolName)) return undefined;
  const raw = extractPath(toolInput);
  if (raw === undefined) return undefined;
  const target = hardenPath(raw, cwd);
  for (const { rule, re } of compiled) {
    if (rule.affectedTools.length > 0 && !rule.affectedTools.includes(toolName)) continue;
    if (re.test(target)) return rule.denyReason ?? `path ${raw} blocked by guard ${rule.pattern}`;
  }
  return undefined;
}

/** Compiles deny rules: the pattern is normcase'd (win32 lowercase) like the target before becoming a RegExp, ensuring consistent matching on case-insensitive platforms. */
export function compileGuards(pathGuards: ReadonlyArray<PathGuardRule>): ReadonlyArray<CompiledGuard> {
  return pathGuards.filter((r) => r.mode === "deny").map((r) => ({ rule: r, re: patternToRegExp(normcase(r.pattern)) }));
}

export interface CompactCallbacks {
  readonly onCompactStarted: (reason: CompactReason, tokensBefore: number | undefined) => void;
  readonly onCompactSummary: (success: boolean, summary: string | undefined, errorMessage: string | undefined) => void;
  readonly markCompactHookSeen: () => void;
}

/**
 * Builds the hooks Options fragment. PreToolUse always registers the subagent
 * control-plane isolation matcher (denies subagents from calling `mcp__sh__*`
 * host tools); when pathGuards is non-empty, a path guard matcher is appended.
 */
export function buildHooks(
  pathGuards: ReadonlyArray<PathGuardRule>,
  compact: CompactCallbacks,
  cwd: string,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};

  const preToolUse: HookCallbackMatcher[] = [];

  // subagent control-plane isolation (always registered, all roles): host
  // control-plane tools (in-process MCP `mcp__sh__*`) are reserved for the main
  // agent. The SDK inlines a subagent's internal tool calls into the main stream,
  // and a subagent inherits the session's MCP tools by default (observed to be
  // callable); if a subagent calls a control-plane tool, its handler would
  // enqueue a completion claim / escalation that the recovery / final-review gate
  // treats as the agent's own exit signal -> the subagent would declare
  // completion on the agent's behalf, breaking long-task delivery.
  // The PreToolUse hook is the SDK's only entry point that can distinguish a
  // subagent call (BaseHookInput.agent_id is present only when triggered by a subagent).
  preToolUse.push({
    matcher: `mcp__${MCP_NAMESPACE}__.*`,
    hooks: [
      async (input): Promise<HookJSONOutput> => {
        const pre = input as PreToolUseHookInput & { agent_id?: string };
        // agent_id present = call originated from a subagent; deny host control-plane tools (double check: matcher + isHostToolName prefix).
        if (typeof pre.agent_id === "string" && pre.agent_id.length > 0 && isHostToolName(pre.tool_name)) {
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason:
                `Host control-plane tool ${pre.tool_name} is reserved for the main agent; the subagent (agent_id=${pre.agent_id}) cannot call it. ` +
                `To report or declare completion, the main agent should call it itself after receiving the subagent's result.`,
            },
          };
        }
        return { continue: true };
      },
    ],
  });

  const compiled = compileGuards(pathGuards);
  if (compiled.length > 0) {
    preToolUse.push({
      matcher: EDIT_TOOLS.join("|"),
      hooks: [
        async (input): Promise<HookJSONOutput> => {
          const pre = input as PreToolUseHookInput;
          // per-call fail-closed: an exception during evaluation -> deny
          // (conservative; hardenPath is regex + isAbsolute + pathResolve and the
          // input is a string guaranteed by extractPath, so there is virtually no
          // throwing path). A conservative deny is reasonable for a soft guardrail.
          let denyReason: string | undefined;
          try {
            denyReason = evaluatePathGuard(compiled, pre.tool_name, pre.tool_input, cwd);
          } catch (err) {
            denyReason = `path guard evaluation failed (${(err as Error).message}); denied (fail-closed)`;
          }
          if (denyReason === undefined) return { continue: true };
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: denyReason,
            },
          };
        },
      ],
    });
  }

  hooks.PreToolUse = preToolUse;

  hooks.PreCompact = [
    {
      hooks: [
        async (input): Promise<HookJSONOutput> => {
          const pre = input as PreCompactHookInput;
          compact.markCompactHookSeen();
          const reason: CompactReason = pre.trigger === "manual" ? "manual_host" : "auto_threshold";
          compact.onCompactStarted(reason, undefined);
          return { continue: true };
        },
      ],
    },
  ];

  hooks.PostCompact = [
    {
      hooks: [
        async (input): Promise<HookJSONOutput> => {
          const post = input as PostCompactHookInput;
          const summary = post.compact_summary;
          if (typeof summary === "string" && summary.length > 0) {
            compact.onCompactSummary(true, summary, undefined);
          } else {
            // summary unavailable -> success:false + protocol error (do not silently accept an empty summary).
            compact.onCompactSummary(false, undefined, "PostCompact hook delivered empty summary");
          }
          return { continue: true };
        },
      ],
    },
  ];

  return hooks;
}
