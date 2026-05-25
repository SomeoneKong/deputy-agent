/**
 * Runtime user message rendering.
 *
 * - renderWatcherCompactRoleReinjectMessage: re-inject role + task anchoring after compaction
 * - renderWakeInjectUserMessage: wake cursor inject (empty envelopes -> empty string); header uses
 *   snake_case env_id / created_at (matching the messaging physical field names)
 */
import type { Envelope } from "../messaging/index.js";
import type { TaskCapsulePaths } from "../shared/paths.js";
import {
  checkAssetsOrFallback,
  formatClarifyHistory,
  formatTemplate,
  readHarnessTaskpart,
  readRawTaskOrPlaceholder,
  readRolePrompt,
  readTemplate,
} from "./assets.js";
import type { Lang } from "./lang.js";
import { literals } from "./literals.js";

export interface RuntimePromptRenderer {
  renderWatcherCompactRoleReinjectMessage(opts: {
    paths: TaskCapsulePaths;
    watcherLang?: Lang;
    /** Host-synthesized summary: passed when the summary alone is unobservable (lenient summary_unobservable path);
     *  provided -> insert the "host-managed summary" section with the full text embedded; omitted (strict /
     *  observable) -> insert the "summary already in context" section. */
    hostManagedSummary?: string;
    /** Lenient self-synthesis failed (summary neither in context nor host-managed): insert the "early observations lost" section (do not falsely claim it is in context). */
    summaryLost?: boolean;
  }): Promise<string>;
  renderWakeInjectUserMessage(opts: { envelopes: ReadonlyArray<Envelope>; lang?: Lang }): string;
  renderMetaProgressReminder(opts: { stage: string; lang?: Lang }): string;
}

async function renderWatcherCompactRoleReinjectMessage(opts: {
  paths: TaskCapsulePaths;
  watcherLang?: Lang;
  hostManagedSummary?: string;
  /** Lenient summary self-synthesis failed (IO failure / no assistant text): neither in context nor
   *  host-managed; must tell the watcher early observations are lost and to re-anchor from the current
   *  task (do not falsely claim the summary is in context). */
  summaryLost?: boolean;
}): Promise<string> {
  const requested = opts.watcherLang ?? "en";
  const used = await checkAssetsOrFallback({
    role: "watcher",
    requestedLang: requested,
    templateNames: ["watcher_compact_reinject_intro"],
  });
  const lits = literals(used);
  const intro = (await readTemplate("watcher_compact_reinject_intro", used)).trimEnd();
  const watcherRole = await readRolePrompt("watcher", used);
  const rawTask = await readRawTaskOrPlaceholder(opts.paths, used);
  const clarify = await formatClarifyHistory(opts.paths, used);
  const watcherTaskpart = await readHarnessTaskpart(opts.paths, "watcher_taskpart.md");

  // Summary section, three-way: hostManagedSummary present -> embed the full host-managed summary;
  // summaryLost -> "early observations lost"; otherwise (strict / observable) -> "summary already in context".
  const summaryBody =
    opts.hostManagedSummary !== undefined
      ? formatTemplate(lits["watcher_compact_summary_host_managed"], { host_managed_summary: opts.hostManagedSummary })
      : opts.summaryLost === true
        ? lits["watcher_compact_summary_lost"]
        : lits["watcher_compact_summary_in_context"];

  const blocks: string[] = [];
  if (intro) blocks.push(intro);
  blocks.push(`${lits["watcher_compact_section_summary"]}\n\n${summaryBody}`);
  blocks.push(`${lits["watcher_compact_section_role"]}\n\n${watcherRole}`);
  blocks.push(`${lits["watcher_compact_section_raw_task"]}\n\n${rawTask}`);
  blocks.push(`${lits["watcher_compact_section_clarify"]}\n\n${clarify}`);
  if (watcherTaskpart) {
    blocks.push(`${lits["watcher_compact_section_taskpart"]}\n\n${watcherTaskpart}`);
  }
  blocks.push(lits["watcher_compact_footer"]);
  return blocks.join("\n\n");
}

function renderWakeInjectUserMessage(opts: {
  envelopes: ReadonlyArray<Envelope>;
  lang?: Lang;
}): string {
  if (opts.envelopes.length === 0) return "";
  const lits = literals(opts.lang ?? "en");
  const blocks: string[] = [lits["wake_inject_header"], lits["wake_inject_intro"]];
  for (const env of opts.envelopes) {
    const header = `## env_id=${env.envId} / kind=${env.kind} / from=${env.from} / created_at=${env.createdAt}`;
    blocks.push(`${header}\n\n${env.body.trimEnd()}`);
  }
  return blocks.join("\n\n");
}

/** Driver-stage progress reminder body (lang-aware; {stage} placeholder replaced with the current stage). */
function renderMetaProgressReminder(opts: { stage: string; lang?: Lang }): string {
  return literals(opts.lang ?? "en")["meta_progress_reminder"].replace("{stage}", opts.stage);
}

export const runtimePromptRenderer: RuntimePromptRenderer = {
  renderWatcherCompactRoleReinjectMessage,
  renderWakeInjectUserMessage,
  renderMetaProgressReminder,
};
