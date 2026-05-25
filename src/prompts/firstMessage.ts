/**
 * First user message assembly.
 *
 * - Meta: single meta_session_start template; {recovery_note} placeholder distinguishes fresh / recovery
 * - Worker: worker_session_start template; header injects sessionSeq / prevSessionId
 * - Reviewer: reviewer_first_message template; includes the harness file language directives section
 *
 * fail-soft: template missing / format failure -> return the role's minimal fallback literal.
 */
import type { SessionId } from "../shared/ids.js";
import type { Stage } from "../shared/manifest.js";
import type { TaskCapsulePaths } from "../shared/paths.js";
import {
  checkAssetsOrFallback,
  formatClarifyHistory,
  formatRecentEvents,
  formatStageHistory,
  formatTemplate,
  normalizeConsumerLangs,
  readRawTaskOrPlaceholder,
  readTemplate,
} from "./assets.js";
import type { Lang, ReviewerPhase } from "./lang.js";
import { literals } from "./literals.js";

export interface FirstUserMessageAssembler {
  assembleMetaFirstUserMessage(opts: {
    paths: TaskCapsulePaths;
    currentStage: Stage;
    stageHistory: ReadonlyArray<string>;
    lastError: string | null;
    inboxCount: number;
    recentEvents: ReadonlyArray<string>;
    isRecovery?: boolean;
    metaLang?: Lang;
  }): Promise<string>;
  assembleWorkerFirstUserMessage(opts: {
    sessionSeq: number;
    prevSessionId: SessionId | null;
    workerLang?: Lang;
  }): Promise<string>;
  assembleReviewerFirstUserMessage(opts: {
    paths: TaskCapsulePaths;
    phase: ReviewerPhase;
    round: number;
    subject: string;
    additionalDirs?: ReadonlyArray<string>;
    reviewerLang?: Lang;
    consumerLangs?: { worker?: Lang; watcher?: Lang };
  }): Promise<string>;
}

async function assembleMetaFirstUserMessage(opts: {
  paths: TaskCapsulePaths;
  currentStage: Stage;
  stageHistory: ReadonlyArray<string>;
  lastError: string | null;
  inboxCount: number;
  recentEvents: ReadonlyArray<string>;
  isRecovery?: boolean;
  metaLang?: Lang;
}): Promise<string> {
  const requested = opts.metaLang ?? "en";
  const used = await checkAssetsOrFallback({
    role: "meta",
    requestedLang: requested,
    templateNames: ["meta_session_start"],
    checkRole: false,
  });
  const lits = literals(used);
  const minimalFallback = (): string =>
    formatTemplate(lits["meta_first_minimal_fallback"], {
      current_stage: opts.currentStage,
      inbox_count: opts.inboxCount,
      last_error: opts.lastError ?? lits["meta_first_no_error_text"],
    });

  const template = await readTemplate("meta_session_start", used);
  if (!template) return minimalFallback();

  try {
    const rawTask = await readRawTaskOrPlaceholder(opts.paths, used);
    const clarify = await formatClarifyHistory(opts.paths, used);
    return formatTemplate(template, {
      recovery_note: opts.isRecovery ? lits["recovery_note"] : "",
      raw_task: rawTask,
      clarify_history: clarify,
      current_stage: opts.currentStage,
      stage_history: formatStageHistory(opts.stageHistory, used),
      last_error: opts.lastError ? opts.lastError : lits["meta_first_no_error_text"],
      inbox_count: opts.inboxCount,
      recent_events: formatRecentEvents(opts.recentEvents, used),
    });
  } catch (exc) {
    console.warn(`meta_session_start template format failed: ${String(exc)}`);
    return minimalFallback();
  }
}

async function assembleWorkerFirstUserMessage(opts: {
  sessionSeq: number;
  prevSessionId: SessionId | null;
  workerLang?: Lang;
}): Promise<string> {
  const requested = opts.workerLang ?? "en";
  const used = await checkAssetsOrFallback({
    role: "worker",
    requestedLang: requested,
    templateNames: ["worker_session_start"],
    checkRole: false,
  });
  const lits = literals(used);
  const prevSidText = opts.prevSessionId ?? "null";
  const fallback = (): string =>
    formatTemplate(lits["worker_session_start_fallback"], {
      session_seq: opts.sessionSeq,
      prev_sid_text: prevSidText,
    });

  const template = await readTemplate("worker_session_start", used);
  if (!template) return fallback();
  try {
    return formatTemplate(template, {
      session_seq: opts.sessionSeq,
      prev_session_id: prevSidText,
    });
  } catch (exc) {
    console.warn(`worker_session_start template format failed: ${String(exc)}`);
    return fallback();
  }
}

async function assembleReviewerFirstUserMessage(opts: {
  paths: TaskCapsulePaths;
  phase: ReviewerPhase;
  round: number;
  subject: string;
  additionalDirs?: ReadonlyArray<string>;
  reviewerLang?: Lang;
  consumerLangs?: { worker?: Lang; watcher?: Lang };
}): Promise<string> {
  const requested = opts.reviewerLang ?? "en";
  const used = await checkAssetsOrFallback({
    role: "reviewer",
    requestedLang: requested,
    templateNames: ["reviewer_first_message"],
    checkRole: false,
  });
  const lits = literals(used);
  const minimalFallback = (): string =>
    formatTemplate(lits["reviewer_first_minimal_fallback"], {
      phase: opts.phase,
      round_: opts.round,
      subject: opts.subject,
    });

  const template = await readTemplate("reviewer_first_message", used);
  if (!template) return minimalFallback();
  try {
    const rawTask = await readRawTaskOrPlaceholder(opts.paths, used);
    const clarify = await formatClarifyHistory(opts.paths, used);
    const dirs = opts.additionalDirs ?? [];
    const dirsText =
      dirs.length > 0
        ? dirs.map((d) => `- \`${d}\``).join("\n")
        : lits["reviewer_first_no_additional_dirs_text"];
    const consumerLangs = normalizeConsumerLangs(opts.consumerLangs);
    return formatTemplate(template, {
      raw_task: rawTask,
      clarify_history: clarify,
      phase: opts.phase,
      round: opts.round,
      subject: opts.subject,
      task_root: opts.paths.taskRoot,
      additional_dirs: dirsText,
      worker_lang: consumerLangs.worker,
      watcher_lang: consumerLangs.watcher,
    });
  } catch (exc) {
    console.warn(`reviewer_first_message template format failed: ${String(exc)}`);
    return minimalFallback();
  }
}

export const firstUserMessageAssembler: FirstUserMessageAssembler = {
  assembleMetaFirstUserMessage,
  assembleWorkerFirstUserMessage,
  assembleReviewerFirstUserMessage,
};
