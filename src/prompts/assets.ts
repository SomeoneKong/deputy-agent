/**
 * Prompt asset resolution + fail-soft reads + per-prompt whole-role fallback precheck + assembly helpers.
 *
 * - Asset root located via `import.meta.url` (shipped in-package; caller does not pass a path).
 * - fail-soft: asset missing / IO error / non-UTF-8 -> return empty string + warn, do not throw.
 * - per-prompt whole-role fallback: any required asset missing `*.<lang>.md` -> the role falls back
 *   entirely to `en` + audit callback.
 */
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { TaskCapsulePaths } from "../shared/paths.js";
import type { AgentRole } from "../wrapper/types/index.js";
import { emitPromptLangFallbackAudit, type Lang } from "./lang.js";
import { literals } from "./literals.js";

const ASSETS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "assets");

/** Explicit framework section order (semantic layering: base concepts -> concrete strategy). */
export const FRAMEWORK_SECTIONS = [
  "messaging_protocol",
  "tool_usage",
  "isolation_declaration",
  "inbox_consumption",
] as const;

/** Reviewer calls submit_verdict once; framework keeps only isolation_declaration. */
export const REVIEWER_FRAMEWORK_SECTIONS = ["isolation_declaration"] as const;

function frameworkSectionPath(name: string, lang: Lang): string {
  return join(ASSETS_ROOT, "framework", `${name}.${lang}.md`);
}

function rolePath(role: string, lang: Lang): string {
  return join(ASSETS_ROOT, "roles", `${role}.${lang}.md`);
}

function templatePath(name: string, lang: Lang): string {
  return join(ASSETS_ROOT, "templates", `${name}.${lang}.md`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Read text; missing / IO error / non-UTF-8 -> return empty string + warn. */
async function readTextFailSoft(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, { encoding: "utf-8" });
  } catch (exc) {
    const code = (exc as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      console.warn(`prompt asset missing: ${path} (${what})`);
    } else {
      console.warn(`prompt asset read failed: ${path} (${what}): ${String(exc)}`);
    }
    return "";
  }
}

export async function readFrameworkSection(name: string, lang: Lang): Promise<string> {
  return (await readTextFailSoft(frameworkSectionPath(name, lang), `framework:${name}.${lang}`)).trimEnd();
}

export async function readRolePrompt(role: AgentRole, lang: Lang): Promise<string> {
  return (await readTextFailSoft(rolePath(role, lang), `role:${role}.${lang}`)).trimEnd();
}

/** Load a template (does not substitute variables; caller runs formatTemplate / joins). */
export async function readTemplate(name: string, lang: Lang): Promise<string> {
  return await readTextFailSoft(templatePath(name, lang), `template:${name}.${lang}`);
}

/** Join framework sections in explicit order (missing items are warned and skipped). */
export async function frameworkPrompt(sections: ReadonlyArray<string>, lang: Lang): Promise<string> {
  const parts: string[] = [];
  for (const name of sections) {
    const text = await readFrameworkSection(name, lang);
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

export interface CheckAssetsOpts {
  readonly role: AgentRole;
  readonly requestedLang: Lang;
  readonly frameworkSections?: ReadonlyArray<string>;
  readonly templateNames?: ReadonlyArray<string>;
  /** Whether the role prompt participates in the precheck (first user message assembly does not need the role asset). */
  readonly checkRole?: boolean;
}

/**
 * Per-prompt whole-role fallback precheck.
 *
 * Checks whether all required assets for the role exist under `requestedLang`; any missing ->
 * return `en` + warn + audit callback (en is terminal, no further fallback). All present ->
 * return the original `requestedLang`.
 */
export async function checkAssetsOrFallback(opts: CheckAssetsOpts): Promise<Lang> {
  const { role, requestedLang } = opts;
  const frameworkSections = opts.frameworkSections ?? [];
  const templateNames = opts.templateNames ?? [];
  const checkRole = opts.checkRole ?? true;

  const missing: string[] = [];
  for (const name of frameworkSections) {
    if (!(await exists(frameworkSectionPath(name, requestedLang)))) {
      missing.push(`framework/${name}.${requestedLang}.md`);
    }
  }
  if (checkRole && !(await exists(rolePath(role, requestedLang)))) {
    missing.push(`roles/${role}.${requestedLang}.md`);
  }
  for (const tpl of templateNames) {
    if (!(await exists(templatePath(tpl, requestedLang)))) {
      missing.push(`templates/${tpl}.${requestedLang}.md`);
    }
  }
  if (missing.length === 0) return requestedLang;

  if (requestedLang === "en") {
    console.warn(
      `prompt_lang_en_asset_missing: role=${role} missing_assets=${JSON.stringify(missing)} ` +
        "(en is fallback terminal; packaging may be broken)",
    );
  } else {
    console.warn(
      `prompt_lang_fallback: role=${role} requested_lang=${requestedLang} used_lang=en ` +
        `missing_assets=${JSON.stringify(missing)}`,
    );
  }
  await emitPromptLangFallbackAudit({
    role,
    requestedLang,
    usedLang: "en",
    missingAssets: missing,
  });
  return "en";
}

// ============================================================================
// consumer prompt lang directives
// ============================================================================

const CONSUMER_LANG_DIRECTIVES_EN = `## Harness file language directives

When writing harness via sh_harness__write_* tools:
- workspace/harness/worker_prompt_taskpart.md content → {worker_lang}
- workspace/harness/watcher_taskpart.md content → {watcher_lang}
- workspace/harness/methodology.md / sop/*.md / done_criteria.yaml configurations → {worker_lang} (Worker is primary consumer)

Tool names, file paths, YAML keys, code identifiers remain in English / unchanged regardless of language directive.

User-facing messages (sh_msg__send_to_user content) continue to follow the raw_task user language —— independent from the harness file language above.`;

const CONSUMER_LANG_DIRECTIVES_ZH = `## Harness 文件语言指令

通过 sh_harness__write_* 工具写 harness 时：
- workspace/harness/worker_prompt_taskpart.md 内容 → {worker_lang}
- workspace/harness/watcher_taskpart.md 内容 → {watcher_lang}
- workspace/harness/methodology.md / sop/*.md / done_criteria.yaml 配置 → {worker_lang}（Worker 是首要消费方）

工具名 / 文件路径 / YAML key / 代码标识符无论以上语言指令为何均保留英文 / 原样不变。

用户面消息（sh_msg__send_to_user 内容）依然遵循 raw_task 用户语言 —— 与以上 harness 文件语言独立。`;

/** Validate consumer lang values (guard against caller passing non-en/zh); invalid falls back to "en". */
export function normalizeConsumerLangs(consumerLangs: { worker?: Lang; watcher?: Lang } | undefined): {
  worker: Lang;
  watcher: Lang;
} {
  const pick = (v: Lang | undefined, role: string): Lang => {
    if (v === "en" || v === "zh") return v;
    if (v !== undefined) {
      console.warn(`consumer lang invalid for role ${role}: ${String(v)}; falling back to 'en'`);
    }
    return "en";
  };
  return {
    worker: pick(consumerLangs?.worker, "worker"),
    watcher: pick(consumerLangs?.watcher, "watcher"),
  };
}

/** Build the consumer prompt lang directives section (metaLang decides the explanatory text language). */
export function consumerLangDirectives(
  consumerLangs: { worker: Lang; watcher: Lang },
  metaLang: Lang,
): string {
  const tpl = metaLang === "zh" ? CONSUMER_LANG_DIRECTIVES_ZH : CONSUMER_LANG_DIRECTIVES_EN;
  return formatTemplate(tpl, {
    worker_lang: consumerLangs.worker,
    watcher_lang: consumerLangs.watcher,
  });
}

// ============================================================================
// template placeholder substitution + join helpers
// ============================================================================

/**
 * Simple template substitution: replace `{key}` with `vars[key]`.
 * `{xxx}` not present in vars is kept verbatim (no throw); values are String-coerced.
 */
export function formatTemplate(tpl: string, vars: Readonly<Record<string, string | number>>): string {
  return tpl.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, key: string) => {
    if (Object.hasOwn(vars, key)) return String(vars[key]);
    return match;
  });
}

/** Join all non-empty sections with double newlines; normalize inter-section newlines. */
export function joinNonEmpty(parts: ReadonlyArray<string>): string {
  return parts
    .filter((p) => p && p.trim())
    .map((p) => p.trimEnd())
    .join("\n\n");
}

// ============================================================================
// clarify / stage / events formatting
// ============================================================================

// Strict clarify filename rule: number >= 1; names with extra segments are rejected.
const CLARIFY_NAME_RE = /^round_([1-9]\d*)_(questions|answers)\.md$/;

/** Pair round_N_questions.md + round_N_answers.md by round (per lang). */
export async function formatClarifyHistory(paths: TaskCapsulePaths, lang: Lang): Promise<string> {
  const lits = literals(lang);
  const { readdir } = await import("node:fs/promises");
  let entries: string[];
  try {
    entries = await readdir(paths.clarifyDir);
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === "ENOENT") return lits["clarify_history_none"];
    console.warn(`clarify dir read failed: ${String(exc)}`);
    return lits["clarify_history_none"];
  }
  const rounds = new Set<number>();
  for (const name of entries) {
    const m = CLARIFY_NAME_RE.exec(name);
    if (m && m[1] !== undefined) {
      rounds.add(Number(m[1]));
    }
  }
  if (rounds.size === 0) return lits["clarify_history_none"];

  const blocks: string[] = [];
  for (const n of [...rounds].sort((a, b) => a - b)) {
    const qText = (await readTextFailSoft(paths.clarifyQuestionsPath(n), `clarify_q_${n}`)).trimEnd();
    const aText = (await readTextFailSoft(paths.clarifyAnswersPath(n), `clarify_a_${n}`)).trimEnd();
    const roundHeader = formatTemplate(lits["clarify_history_round_label"], { n });
    blocks.push(
      `${roundHeader}\n\n${lits["clarify_history_question_label"]}\n\n` +
        `${qText || lits["clarify_history_question_missing"]}\n\n` +
        `${lits["clarify_history_answer_label"]}\n\n${aText || lits["clarify_history_answer_missing"]}`,
    );
  }
  return blocks.join("\n\n");
}

/** Format stage_history list as a markdown list (at most 5 entries, per lang). */
export function formatStageHistory(history: ReadonlyArray<string>, lang: Lang): string {
  if (history.length === 0) return literals(lang)["stage_history_none"];
  return history
    .slice(-5)
    .map((s) => `  - ${s}`)
    .join("\n");
}

/** Format recent_events list as markdown bullets (per lang). */
export function formatRecentEvents(events: ReadonlyArray<string>, lang: Lang): string {
  if (events.length === 0) return literals(lang)["recent_events_none"];
  return events.map((e) => `- ${e}`).join("\n");
}

/** Read full raw_task; missing -> placeholder. */
export async function readRawTaskOrPlaceholder(paths: TaskCapsulePaths, lang: Lang): Promise<string> {
  const raw = (await readTextFailSoft(paths.rawTaskPath, "raw_task")).trimEnd();
  return raw || literals(lang)["raw_task_missing_placeholder"];
}

/** Read a taskpart file under harness (missing -> empty string). */
export async function readHarnessTaskpart(paths: TaskCapsulePaths, filename: string): Promise<string> {
  return (await readTextFailSoft(join(paths.harnessDir, filename), filename)).trimEnd();
}
