/**
 * System prompt assembly.
 *
 * - Meta: framework + role + user_message_tone + consumerLangDirectives
 * - Reviewer: framework_isolation + role
 * - Worker: framework + role + workerTaskpart
 * - Watcher: framework + role + (raw_task + clarify + watcher_taskpart)
 */
import type { TaskCapsulePaths } from "../shared/paths.js";
import {
  FRAMEWORK_SECTIONS,
  REVIEWER_FRAMEWORK_SECTIONS,
  checkAssetsOrFallback,
  consumerLangDirectives,
  formatClarifyHistory,
  frameworkPrompt,
  joinNonEmpty,
  normalizeConsumerLangs,
  readHarnessTaskpart,
  readRawTaskOrPlaceholder,
  readRolePrompt,
  readTemplate,
} from "./assets.js";
import type { Lang } from "./lang.js";
import { literals } from "./literals.js";

export interface PromptAssembler {
  assembleMetaSystemPrompt(opts: {
    metaLang?: Lang;
    consumerLangs?: { worker?: Lang; watcher?: Lang };
  }): Promise<string>;
  assembleReviewerSystemPrompt(opts?: { reviewerLang?: Lang }): Promise<string>;
  assembleWorkerSystemPrompt(opts: { paths: TaskCapsulePaths; workerLang?: Lang }): Promise<string>;
  assembleWatcherSystemPrompt(opts: { paths: TaskCapsulePaths; watcherLang?: Lang }): Promise<string>;
}

async function assembleMetaSystemPrompt(opts: {
  metaLang?: Lang;
  consumerLangs?: { worker?: Lang; watcher?: Lang };
}): Promise<string> {
  const requested = opts.metaLang ?? "en";
  const used = await checkAssetsOrFallback({
    role: "meta",
    requestedLang: requested,
    frameworkSections: FRAMEWORK_SECTIONS,
    templateNames: ["user_message_tone"],
  });
  const tone = (await readTemplate("user_message_tone", used)).trimEnd();
  const consumerLangs = normalizeConsumerLangs(opts.consumerLangs);
  return joinNonEmpty([
    await frameworkPrompt(FRAMEWORK_SECTIONS, used),
    await readRolePrompt("meta", used),
    tone,
    consumerLangDirectives(consumerLangs, used),
  ]);
}

async function assembleReviewerSystemPrompt(opts?: { reviewerLang?: Lang }): Promise<string> {
  const requested = opts?.reviewerLang ?? "en";
  const used = await checkAssetsOrFallback({
    role: "reviewer",
    requestedLang: requested,
    frameworkSections: REVIEWER_FRAMEWORK_SECTIONS,
  });
  return joinNonEmpty([
    await frameworkPrompt(REVIEWER_FRAMEWORK_SECTIONS, used),
    await readRolePrompt("reviewer", used),
  ]);
}

async function assembleWorkerSystemPrompt(opts: {
  paths: TaskCapsulePaths;
  workerLang?: Lang;
}): Promise<string> {
  const requested = opts.workerLang ?? "en";
  const used = await checkAssetsOrFallback({
    role: "worker",
    requestedLang: requested,
    frameworkSections: FRAMEWORK_SECTIONS,
  });
  let taskpart = await readHarnessTaskpart(opts.paths, "worker_prompt_taskpart.md");
  if (!taskpart) taskpart = literals(used)["worker_taskpart_placeholder"];
  return joinNonEmpty([
    await frameworkPrompt(FRAMEWORK_SECTIONS, used),
    await readRolePrompt("worker", used),
    taskpart,
  ]);
}

async function assembleWatcherSystemPrompt(opts: {
  paths: TaskCapsulePaths;
  watcherLang?: Lang;
}): Promise<string> {
  const requested = opts.watcherLang ?? "en";
  const used = await checkAssetsOrFallback({
    role: "watcher",
    requestedLang: requested,
    frameworkSections: FRAMEWORK_SECTIONS,
  });
  const lits = literals(used);
  const rawTask = await readRawTaskOrPlaceholder(opts.paths, used);
  const clarify = await formatClarifyHistory(opts.paths, used);
  const watcherTaskpart = await readHarnessTaskpart(opts.paths, "watcher_taskpart.md");

  const taskPartBlocks = [
    `${lits["watcher_section_raw_task"]}\n\n${rawTask}`,
    `${lits["watcher_section_clarify_history"]}\n\n${clarify}`,
  ];
  if (watcherTaskpart) {
    taskPartBlocks.push(`${lits["watcher_section_taskpart"]}\n\n${watcherTaskpart}`);
  }
  return joinNonEmpty([
    await frameworkPrompt(FRAMEWORK_SECTIONS, used),
    await readRolePrompt("watcher", used),
    taskPartBlocks.join("\n\n"),
  ]);
}

export const promptAssembler: PromptAssembler = {
  assembleMetaSystemPrompt,
  assembleReviewerSystemPrompt,
  assembleWorkerSystemPrompt,
  assembleWatcherSystemPrompt,
};
