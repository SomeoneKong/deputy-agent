/**
 * Stage legal-transition table + host-autonomous vs Meta-driven layering + two host gates.
 *
 * - Legal transition table: from / to / trigger
 * - Host-autonomous (submitted→clarifying / paused in-out) vs Meta tool (other in-progress advances)
 * - bootstrap_self_review gate (any non-running → running, not just bootstrapping → running):
 *   requires a non-failed reviewer_verdict with reviewerPhase="bootstrap_self_review" (verdict_missing
 *   counts); judged by whether such a verdict ever existed during the task lifecycle (not per-transition),
 *   so re-entries like awaiting_user→running pass transparently
 * - final_review gate (running→{awaiting_user,done}): anchored on worker declare_done
 *   (worker_completion_claim); requires a non-failed reviewer_verdict with reviewerPhase="final_review"
 *   whose composite key (createdAt, stateSeq) is strictly greater than the latest
 *   worker_completion_claim's composite key
 * - Physical writes reuse manifestIO.applyStageTransition
 * - When the bus is uninitialized, gates fail closed
 *
 * `handleStageAdvance` is the host-side entry called by the sh_stage__advance tool handler.
 */
import type { MessagingBus } from "../messaging/index.js";
import { StageCasMismatch } from "../shared/errors.js";
import { manifestIO, type Manifest, type Stage, type StageInProgress } from "../shared/manifest.js";
import type { TaskCapsulePaths } from "../shared/paths.js";
import { renderStatusMd } from "../shared/status_md.js";
import { HostOrchestrationErrorKind, HostToolCommonErrorKind } from "./errorKinds.js";
import { eventsIO } from "./events.js";

export type TransitionTrigger = "host" | "meta_tool" | "user_cli";

const IN_PROGRESS: ReadonlySet<Stage> = new Set<StageInProgress>([
  "submitted",
  "clarifying",
  "bootstrapping",
  "running",
  "awaiting_user",
]);

const TERMINAL: ReadonlySet<Stage> = new Set<Stage>(["done", "failed", "cancelled"]);

export function isInProgress(stage: Stage): stage is StageInProgress {
  return IN_PROGRESS.has(stage);
}

export function isTerminal(stage: Stage): boolean {
  return TERMINAL.has(stage);
}

/**
 * Legal transition table — only validates whether the (from, to, trigger) combination is in the table.
 * Returns null if legal; returns a string rejection reason (human note) otherwise.
 *
 * Note: `paused` transitions are handled separately on the host-autonomous path; this table covers
 * the Meta tool / user_cli paths.
 */
export function checkTransitionAllowed(from: Stage, to: Stage, trigger: TransitionTrigger): string | null {
  if (to === "submitted") return "submitted is unreachable initial stage";

  if (trigger === "meta_tool") {
    // Meta cannot transition to paused (a user privilege)
    if (to === "paused") return "paused is a user privilege; Meta cannot request it";
    // Meta main path + reset: source must be an in-progress stage
    if (!isInProgress(from)) return `cannot transition from ${from} via meta_tool`;
    switch (from) {
      case "clarifying":
        if (to === "bootstrapping" || isInProgress(to) || to === "failed" || to === "cancelled") return null;
        return `illegal meta_tool transition ${from} → ${to}`;
      case "bootstrapping":
        if (to === "running" || isInProgress(to) || to === "failed" || to === "cancelled") return null;
        return `illegal meta_tool transition ${from} → ${to}`;
      case "running":
        if (to === "awaiting_user" || to === "done" || isInProgress(to) || to === "failed" || to === "cancelled")
          return null;
        return `illegal meta_tool transition ${from} → ${to}`;
      case "awaiting_user":
        if (to === "running" || to === "done" || isInProgress(to) || to === "failed" || to === "cancelled")
          return null;
        return `illegal meta_tool transition ${from} → ${to}`;
      case "submitted":
        // submitted → clarifying is host-autonomous, not via meta_tool
        return `cannot transition from submitted via meta_tool`;
      default:
        return `illegal meta_tool transition ${from} → ${to}`;
    }
  }

  if (trigger === "user_cli") {
    // User CLI: done (awaiting_user→done) / cancel (any in-progress + paused → cancelled)
    if (to === "done") {
      if (from === "awaiting_user") return null;
      return `user_cli done only from awaiting_user (found ${from})`;
    }
    if (to === "cancelled") {
      if (isInProgress(from) || from === "paused") return null;
      return `user_cli cancel rejected from terminal stage ${from}`;
    }
    if (to === "paused") {
      if (isInProgress(from)) return null;
      return `user_cli pause only from in-progress stage (found ${from})`;
    }
    // resume: paused → origin (origin can be any in-progress stage clarifying/bootstrapping/running/awaiting_user)
    if (from === "paused" && isInProgress(to)) return null;
    return `illegal user_cli transition ${from} → ${to}`;
  }

  // trigger === "host"
  if (from === "submitted" && to === "clarifying") return null;
  if (from === "paused" && isInProgress(to)) return null; // resume to origin
  if (isInProgress(from) && to === "paused") return null;
  if (isInProgress(from) && to === "failed") return null; // host forces failed
  return `illegal host transition ${from} → ${to}`;
}

export type GatePhase = "bootstrap_self_review" | "final_review";

export interface GateResult {
  readonly passed: boolean;
  /** Reason when passed=false; null when passed=true. */
  readonly reason: string | null;
}

/**
 * bootstrap_self_review gate: the task lifecycle must have had a non-failed reviewer_verdict
 * envelope with extras.reviewerPhase === "bootstrap_self_review" (verdict_missing counts —
 * verdict=null still means it was reviewed). Fails closed if the bus is uninitialized.
 */
async function checkBootstrapGate(bus: MessagingBus | null): Promise<GateResult> {
  if (bus === null) return { passed: false, reason: "messaging bus not initialized (fail-closed)" };
  const seen = await bus.hasEnvelopeWithExtrasAfter({
    kind: "reviewer_verdict",
    extrasMatch: { reviewerPhase: "bootstrap_self_review" },
  });
  if (!seen) return { passed: false, reason: "no bootstrap_self_review reviewer_verdict found" };
  return { passed: true, reason: null };
}

/**
 * final_review gate: only active when a non-failed worker_completion_claim envelope exists.
 * When active, requires a non-failed reviewer_verdict with reviewerPhase="final_review" whose
 * composite key (createdAt, stateSeq) is strictly greater than the latest worker_completion_claim's
 * composite key. No worker_completion_claim → gate inactive (passed). Fails closed if the bus is uninitialized.
 */
async function checkFinalReviewGate(bus: MessagingBus | null): Promise<GateResult> {
  if (bus === null) return { passed: false, reason: "messaging bus not initialized (fail-closed)" };
  const anchor = await bus.findLatestEnvelopeAnchorOfKind("worker_completion_claim");
  if (anchor === null) return { passed: true, reason: null }; // gate inactive
  const seen = await bus.hasEnvelopeWithExtrasAfter({
    kind: "reviewer_verdict",
    extrasMatch: { reviewerPhase: "final_review" },
    since: anchor,
  });
  if (!seen) {
    return {
      passed: false,
      reason: "no final_review reviewer_verdict after latest worker_completion_claim",
    };
  }
  return { passed: true, reason: null };
}

/**
 * Stage-transition gate selection: returns the gate check applicable to (from, to) (no gate → pass directly).
 *
 * The bootstrap gate for entering running covers all non-running sources (a harness must pass
 * bootstrap_self_review before entering running): the "any in-progress → any in-progress" reset
 * path plus `clarifying → running` / `awaiting_user → running` could let a non-bootstrapping source
 * jump straight to running, bypassing a gate scoped only to `bootstrapping → running`. So any
 * `from !== running` → running checks bootstrap_self_review (the gate passes if such a
 * reviewer_verdict ever existed during the task lifecycle — a normal `awaiting_user → running`
 * after the first run already has that envelope and won't be falsely blocked).
 */
export async function checkStageGate(bus: MessagingBus | null, from: Stage, to: Stage): Promise<GateResult> {
  if (to === "running" && from !== "running") return checkBootstrapGate(bus);
  if (from === "running" && (to === "awaiting_user" || to === "done")) return checkFinalReviewGate(bus);
  return { passed: true, reason: null };
}

export interface StageAdvanceRequest {
  readonly targetStage: Stage;
  readonly reason: string | null;
  /** When the Meta tool explicitly passes lastError (including null), it is written with tri-state semantics; omitted leaves lastError untouched. */
  readonly lastError?: Manifest["lastError"];
}

export type StageAdvanceResult =
  | { readonly ok: true; readonly manifest: Manifest }
  | { readonly ok: false; readonly errorKind: string; readonly errorMessage: string };

export interface HandleStageAdvanceDeps {
  readonly paths: TaskCapsulePaths;
  readonly bus: MessagingBus | null;
}

/**
 * Host-side entry for a stage transition triggered by the Meta tool (sh_stage__advance).
 *
 * Flow: validate transition legality → host gate check (no manifest / events writes) →
 * applyStageTransition → append stage_transition event. On validation failure returns `ok:false`
 * + errorKind (reviewer_required / illegal_state / invalid_argument) without writing the manifest.
 *
 * Note: this entry only serves the Meta tool path (trigger=meta_tool); the host-autonomous and
 * user_cli paths call applyStageTransition directly.
 */
export async function handleStageAdvance(
  deps: HandleStageAdvanceDeps,
  req: StageAdvanceRequest,
): Promise<StageAdvanceResult> {
  const { paths, bus } = deps;
  let manifest: Manifest;
  try {
    manifest = await manifestIO.load(paths);
  } catch (err) {
    return {
      ok: false,
      errorKind: HostToolCommonErrorKind.hostInternal,
      errorMessage: `failed to load manifest: ${(err as Error).message}`,
    };
  }
  const from = manifest.stage;
  const to = req.targetStage;

  const allowedReason = checkTransitionAllowed(from, to, "meta_tool");
  if (allowedReason !== null) {
    return {
      ok: false,
      errorKind: HostToolCommonErrorKind.illegalState,
      errorMessage: allowedReason,
    };
  }

  let gate: GateResult;
  try {
    gate = await checkStageGate(bus, from, to);
  } catch (err) {
    // The gate query goes through the messaging bus (IO / corrupt state / lock timeout may throw);
    // do not bubble up to the wrapper/session layer → host_internal
    return {
      ok: false,
      errorKind: HostToolCommonErrorKind.hostInternal,
      errorMessage: `stage gate check failed: ${(err as Error).message}`,
    };
  }
  if (!gate.passed) {
    return {
      ok: false,
      errorKind: HostOrchestrationErrorKind.reviewerRequired,
      errorMessage: gate.reason ?? "reviewer required",
    };
  }

  let updated: Manifest;
  try {
    updated = await manifestIO.applyStageTransition(paths, to, {
      expectedFromStage: from,
      ...(req.lastError !== undefined ? { lastError: req.lastError } : {}),
    });
  } catch (err) {
    // CAS conflict (TOCTOU: the gate used the from snapshot at load time, but by write time the
    // stage was changed by a CLI cancel/pause etc.) → concurrent_conflict (prompts the agent to retry)
    if (err instanceof StageCasMismatch) {
      return {
        ok: false,
        errorKind: HostToolCommonErrorKind.concurrentConflict,
        errorMessage: `stage changed concurrently: ${err.message}`,
      };
    }
    // lock timeout / atomic write failure / other → host_internal
    return {
      ok: false,
      errorKind: HostToolCommonErrorKind.hostInternal,
      errorMessage: `applyStageTransition failed: ${(err as Error).message}`,
    };
  }

  // The manifest (stage SSoT) is already applied; a missing stage_transition in events.jsonl
  // does not affect behavior (fail-soft) → warn, no rollback
  try {
    await eventsIO.append(paths, {
      type: "stage_transition",
      stage: to,
      details: {
        fromStage: from,
        toStage: to,
        triggeredBy: "meta_tool",
        reason: req.reason,
      },
    });
  } catch (err) {
    console.warn(`[stage_machine] stage_transition event append failed (stage already applied): ${(err as Error).message}`);
  }

  // Stage transition done → re-render status.md (host-side render point; fail-soft, internal catch does not block).
  await renderStatusMd(paths);

  return { ok: true, manifest: updated };
}
