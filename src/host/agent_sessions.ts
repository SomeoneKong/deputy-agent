/**
 * Agent session lifecycle orchestration for the four roles.
 *
 * Responsibilities:
 * - sessionId pre-generation (crypto.randomUUID, path-safe, zero dependencies)
 * - assemble systemPrompt / firstUserMessage and write agent_prompts
 * - STARTED is written before startSession; STARTED/ENDED pairing discipline
 * - Worker sessionSeq maintained via control/worker/next_seq.json
 * - worker_session_end envelope derivation after a worker exits (exitReason last-wins)
 * - the host does not self-restart workers + the WorkerCompletionPending state machine
 * - Reviewer short session (verdict_missing fallback)
 * - Watcher long session (compact is orchestrated by a main_loop background task)
 *
 * Decision ownership: physical lifecycle belongs to the host; continuation / termination semantics
 * belong to Meta. This module does not self-restart.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
  AgentRuntime,
  InjectAck,
  InjectInput,
  SessionEndReason,
  SessionHandle,
  SessionRequest,
} from "../wrapper/index.js";
import type { MessagingBus } from "../messaging/index.js";
import { atomicWriter } from "../shared/atomic.js";
import type { EnvelopeId, SessionId } from "../shared/ids.js";
import { jsonlIO } from "../shared/jsonl.js";
import { withLock } from "../shared/locks.js";
import type { TaskCapsulePaths } from "../shared/paths.js";
import { type Iso8601Us } from "../shared/timeUtils.js";
import {
  firstUserMessageAssembler,
  promptAssembler,
  type ReviewerPhase,
} from "../prompts/index.js";
import type { Stage } from "../shared/manifest.js";
import { eventsIO } from "./events.js";

// ---- WorkerExitReason ----

export type WorkerExitReason =
  | "natural_completion"
  | "declare_deferred"
  | "declare_done"
  | "meta_interrupt"
  | "meta_stop"
  | "watchdog_worker_no_progress"
  | "watchdog_worker_tool_loop"
  | "sdk_crash"
  | "subprocess_crash"
  | "host_internal_error"
  | "host_shutdown";

const ACTIVE_EXIT_REASONS: ReadonlySet<WorkerExitReason> = new Set<WorkerExitReason>([
  "natural_completion",
  "declare_deferred",
  "declare_done",
  // A watchdog-closed worker also needs Meta arbitration to continue (the host does not
  // self-restart) → enters workerCompletionPending + reminder, ensuring Meta does not miss it.
  "watchdog_worker_no_progress",
  "watchdog_worker_tool_loop",
]);

/** Active-exit class (enters workerCompletionPending). */
export function isActiveExit(reason: WorkerExitReason): boolean {
  return ACTIVE_EXIT_REASONS.has(reason);
}

/**
 * Fallback mapping from wrapper SessionEndReason → host WorkerExitReason.
 * Note: the `subprocess_crash` refinement is not in this function — `fatal_runtime_error` defaults
 * to `sdk_crash`, and the caller (main_loop) refines it when the accompanying
 * `RuntimeErrorEvent.diagnostics.providerSubprocessExit === true`.
 * `host_close` / `host_close_forced` are derived by the caller from the actual trigger
 * (meta_interrupt / meta_stop / watchdog_* / host_shutdown); this fallback conservatively maps to
 * host_shutdown only when the caller does not provide one.
 */
export function mapSessionEndReason(reason: SessionEndReason): WorkerExitReason {
  switch (reason) {
    case "session_natural_end":
      return "natural_completion";
    case "worker_declared_done":
      return "declare_done";
    case "worker_declared_deferred":
      return "declare_deferred";
    case "fatal_runtime_error":
      return "sdk_crash";
    case "host_close":
    case "host_close_forced":
      // host-derived (by the actual trigger) — the caller usually knows; conservatively map to host_shutdown here
      return "host_shutdown";
    case "unknown":
      return "sdk_crash";
    default:
      return "sdk_crash";
  }
}

/**
 * Last-wins arbitration of exit intent within a session:
 * map the last exit-intent-carrying tool call in this session's tool history to an exitReason.
 * - declare_done → "declare_done"
 * - escalate(exitIntent=declare_deferred) → "declare_deferred"
 * - notify / escalate(continue) do not participate
 * No exit-intent tool → null (caller falls back to the SessionEndReason mapping).
 */
/**
 * Worker exit-intent tool names (`sh_msg__declare_done_to_meta` /
 * `sh_msg__escalate_to_meta(exitIntent="declare_deferred")`, last-wins).
 */
export const WORKER_DECLARE_DONE_TOOL = "sh_msg__declare_done_to_meta";
export const WORKER_ESCALATE_TOOL = "sh_msg__escalate_to_meta";

export function deriveExitIntentLastWins(
  toolEvents: ReadonlyArray<{ toolName: string; input: unknown }>,
): WorkerExitReason | null {
  let result: WorkerExitReason | null = null;
  for (const ev of toolEvents) {
    if (ev.toolName === WORKER_DECLARE_DONE_TOOL) {
      result = "declare_done";
    } else if (ev.toolName === WORKER_ESCALATE_TOOL) {
      const intent = (ev.input as { exitIntent?: unknown } | null)?.exitIntent;
      if (intent === "declare_deferred") result = "declare_deferred";
      // continue does not participate (does not override)
    }
  }
  return result;
}

// ---- sessionSeq (control/worker/next_seq.json) ----

interface NextSeqFile {
  readonly next: number;
}

/** Allocate and increment the Worker sessionSeq (under an independent path lock, separate from events / messaging locks). */
export async function allocateWorkerSessionSeq(paths: TaskCapsulePaths): Promise<number> {
  // Use a .lock alongside next_seq.json (independent of the events / messaging locks)
  const lockPath = `${paths.workerNextSeq}.lock`;
  return withLock(lockPath, async () => {
    let current: number | null = null;
    let fileExisted = true;
    try {
      const text = await readFile(paths.workerNextSeq, "utf8");
      const obj = JSON.parse(text) as Partial<NextSeqFile>;
      if (typeof obj.next === "number" && Number.isInteger(obj.next) && obj.next >= 1) current = obj.next;
      // Parsed successfully but value invalid → current stays null, falling through to the fold fallback (no silent reset to 1 that would cause a sessionSeq regression conflict)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") fileExisted = false;
      // Other (corruption / parse error) → current stays null, fall through to the fold fallback
    }
    if (current === null) {
      // File missing → first allocation is 1; exists but corrupt / invalid → conservative value folded from events.jsonl (max worker sessionSeq + 1)
      current = fileExisted ? (await foldMaxWorkerSessionSeq(paths)) + 1 : 1;
    }
    await atomicWriter.writeText(paths.workerNextSeq, JSON.stringify({ next: current + 1 } satisfies NextSeqFile));
    return current;
  });
}

/** Max sessionSeq of role=worker agent_session_started in events.jsonl (recovery / next_seq corruption fallback). */
export async function foldMaxWorkerSessionSeq(paths: TaskCapsulePaths): Promise<number> {
  let max = 0;
  try {
    for await (const obj of jsonlIO.readLines(paths.eventsPath)) {
      const ev = obj as Record<string, unknown>;
      if (ev["type"] !== "agent_session_started") continue;
      const details = ev["details"];
      if (typeof details !== "object" || details === null) continue;
      const d = details as Record<string, unknown>;
      if (d["role"] !== "worker") continue;
      const seq = d["session_seq"]; // events.jsonl details are physically snake_case
      if (typeof seq === "number" && Number.isInteger(seq) && seq > max) max = seq;
    }
  } catch {
    // fold failed on corruption → return the current max (conservative)
  }
  return max;
}

// ---- prompt persistence ----

async function writeSystemPrompt(paths: TaskCapsulePaths, sessionId: SessionId, content: string): Promise<void> {
  await atomicWriter.writeText(paths.agentPromptPath(sessionId), content);
}

async function writeFirstMessage(paths: TaskCapsulePaths, sessionId: SessionId, content: string): Promise<void> {
  await atomicWriter.writeText(paths.agentFirstMsgPath(sessionId), content);
}

// ---- STARTED / ENDED events ----

type NonWorkerRole = "meta" | "watcher" | "reviewer";

/**
 * STARTED details: a discriminated union enforcing at the type level that sessionSeq is required
 * when role=worker; non-worker roles omit sessionSeq.
 */
export type SessionStartedDetails =
  | { role: "worker"; sessionId: SessionId; sessionSeq: number; reason?: string }
  | { role: NonWorkerRole; sessionId: SessionId; sessionSeq?: undefined; reason?: string };

export type SessionEndedDetails =
  | { role: "worker"; sessionId: SessionId; sessionSeq: number; exitReason: string }
  | { role: NonWorkerRole; sessionId: SessionId; sessionSeq?: undefined; exitReason: string };

export async function appendSessionStarted(
  paths: TaskCapsulePaths,
  stage: Stage,
  details: SessionStartedDetails,
): Promise<void> {
  await eventsIO.append(paths, { type: "agent_session_started", stage, details });
}

export async function appendSessionEnded(
  paths: TaskCapsulePaths,
  stage: Stage,
  details: SessionEndedDetails,
): Promise<void> {
  await eventsIO.append(paths, { type: "agent_session_ended", stage, details });
}

/**
 * Idempotent compare-and-append of the worker paired `agent_session_ended` (a physical invariant).
 * A thin wrapper over `eventsIO.appendWorkerEndedIdempotent` (scan+append under the lock), unifying
 * the three worker closeout entries (finalizeWorker / wrapAgentControl.stopWorker / cleanupAndExit)
 * plus recovery's backfill path → exactly one physical worker ENDED, independent of in-memory flag
 * timing. Returns { appended, scanOk }: appended=true written this call; appended=false already
 * existed, skipped; scanOk=false scan corrupted, not written (left to recovery's fallback).
 */
export async function appendWorkerEndedIdempotent(
  paths: TaskCapsulePaths,
  args: { stage: Stage; sessionId: SessionId; sessionSeq: number; exitReason: WorkerExitReason },
): Promise<{ appended: boolean; scanOk: boolean }> {
  return eventsIO.appendWorkerEndedIdempotent(paths, args);
}

/**
 * Idempotent compare-and-append of the reviewer paired `agent_session_ended` (a physical invariant).
 * A thin wrapper over `eventsIO.appendReviewerEndedIdempotent` (scan+append under the lock, dedup by
 * session_id). Shared by triggerReviewer's closeout branches (natural/timeout/failed/host_internal)
 * plus cleanupAndExit's fallback (host_shutdown) → exactly one physical reviewer ENDED; this lets
 * triggerReviewer clear the active handle only after the ENDED is durably persisted (owner
 * semantics, closing the await-window gap).
 */
export async function appendReviewerEndedIdempotent(
  paths: TaskCapsulePaths,
  args: { stage: Stage; sessionId: SessionId; exitReason: string },
): Promise<{ appended: boolean; scanOk: boolean }> {
  return eventsIO.appendReviewerEndedIdempotent(paths, args);
}

// ---- sessionId pre-generation ----

export function generateSessionId(): SessionId {
  return randomUUID();
}

// ---- worker_session_end envelope derivation ----

/** exitReasons enqueueable as worker_session_end — host_internal_error / host_shutdown are not enqueued, excluded at the type level. */
export type EnqueuableWorkerExitReason = Exclude<WorkerExitReason, "host_internal_error" | "host_shutdown">;

export interface DeriveWorkerSessionEndInput {
  readonly workerSessionId: SessionId;
  readonly sessionSeq: number;
  readonly exitReason: EnqueuableWorkerExitReason;
  readonly doneCriteriaOutcome: Readonly<Record<string, unknown>> | null;
  readonly body: string;
  readonly nowIso?: Iso8601Us;
}

/**
 * Enqueue the worker_session_end envelope into the Meta inbox first, then append
 * agent_session_ended (the caller controls ordering). `host_internal_error` / `host_shutdown` are
 * not enqueued (the caller decides; this function does not — callers already route those away).
 */
export async function enqueueWorkerSessionEnd(
  bus: MessagingBus,
  input: DeriveWorkerSessionEndInput,
): Promise<EnvelopeId> {
  return bus.enqueue({
    channel: "meta",
    kind: "worker_session_end",
    from: "host",
    body: input.body,
    ...(input.nowIso !== undefined ? { nowIso: input.nowIso } : {}),
    extras: {
      workerSessionId: input.workerSessionId,
      sessionSeq: input.sessionSeq,
      exitReason: input.exitReason,
      doneCriteriaOutcome: input.doneCriteriaOutcome,
    },
  });
}

// ---- session startup build (assemble systemPrompt / firstMessage + persist + STARTED) ----

export interface BuildSessionRequestCommon {
  readonly cwd: string;
  readonly model: SessionRequest["model"];
  readonly isolation: SessionRequest["isolation"];
  readonly toolNames: ReadonlyArray<string>;
}

/**
 * Whether an inject ack means actually delivered: `delivered_immediate` / `delivered_after_interrupt`
 * / `queued_steering` / `queued_followup` all count as delivered (the message was accepted by the
 * session); only `rejected_busy` (session streaming under the require_idle policy) counts as not delivered.
 *
 * inject is fire-and-ack: `rejected_busy` does not throw, so all three inject call sites (Meta wake /
 * Worker first message / Reviewer first message) must explicitly check ack.mode, or a backpressure
 * rejection is mistaken for success.
 */
export function isInjectDelivered(ack: InjectAck): boolean {
  return ack.mode !== "rejected_busy";
}

/** Build the first_message InjectInput (first_message marker; require_idle policy). */
export function firstMessageInject(paths: TaskCapsulePaths, sessionId: SessionId, humanNote?: string): InjectInput {
  return {
    content: [{ type: "text", textPath: paths.agentFirstMsgPath(sessionId) }],
    marker: {
      kind: "first_message",
      envelopeIds: [],
      ...(humanNote !== undefined ? { humanNote } : {}),
    },
    policy: { kind: "require_idle" },
  };
}

// ---- prompt assembly helpers (thin wrappers; fail-soft handled internally) ----

export const prompts = {
  metaSystem: promptAssembler.assembleMetaSystemPrompt,
  workerSystem: promptAssembler.assembleWorkerSystemPrompt,
  watcherSystem: promptAssembler.assembleWatcherSystemPrompt,
  reviewerSystem: promptAssembler.assembleReviewerSystemPrompt,
  metaFirst: firstUserMessageAssembler.assembleMetaFirstUserMessage,
  workerFirst: firstUserMessageAssembler.assembleWorkerFirstUserMessage,
  reviewerFirst: firstUserMessageAssembler.assembleReviewerFirstUserMessage,
};

export { writeSystemPrompt, writeFirstMessage };

// ---- Reviewer phase validation ----

const REVIEWER_PHASES: ReadonlySet<string> = new Set<ReviewerPhase>([
  "bootstrap_self_review",
  "final_review",
  "harness_revision_review",
]);

export function isValidReviewerPhase(phase: string): phase is ReviewerPhase {
  return REVIEWER_PHASES.has(phase);
}

// ---- WorkerCompletionPending state machine (in-memory) ----

export interface WorkerOrchestrationState {
  /** The previous worker exited but Meta has not finished reacting (the generic "awaiting Meta reaction" state for non-active exits). */
  sessionEndPending: boolean;
  /** Set true on the tick a worker actively exits; the next tick's reconcile decides to keep or clear it. */
  workerCompletionPending: boolean;
  /** Reminder counter for the current pending round. */
  workerCompletionReminderSeq: number;
  /** Meta called sh_agent__stop_worker(restartAfter=false). */
  metaStopNoRestart: boolean;
  /**
   * The "default-continue pending" state after a passive meta_interrupt exit: after a worker is
   * interrupted out by sh_msg__interrupt_worker, if Meta stays silent (no worker-channel unread, no
   * dispatch) → the host starts a new worker by default (rather than waiting forever). Opposite to
   * metaStopNoRestart (default not-continue): meta_interrupt defaults to continue. The next tick's
   * reconcile consumes this flag to start a new worker when Meta is idle with no explicit stop; any
   * worker-dispatch tool / send_to_worker / leaving running clears it.
   */
  metaInterruptDefaultContinue: boolean;
  /** worker_session_end envId associated with the current pending (referenced by reminders). */
  lastWorkerSessionEndEnvId: string | null;
  /** sessionId / sessionSeq / exitReason associated with the current pending (reminder details). */
  lastWorkerSessionId: string | null;
  lastWorkerSessionSeq: number | null;
  lastWorkerExitReason: WorkerExitReason | null;
}

export function initWorkerOrchestrationState(): WorkerOrchestrationState {
  return {
    sessionEndPending: false,
    workerCompletionPending: false,
    workerCompletionReminderSeq: 0,
    metaStopNoRestart: false,
    metaInterruptDefaultContinue: false,
    lastWorkerSessionEndEnvId: null,
    lastWorkerSessionId: null,
    lastWorkerSessionSeq: null,
    lastWorkerExitReason: null,
  };
}

// ---- tool history collection (accumulated from the subscribed event stream, for exitReason last-wins) ----

/**
 * Collects this session's successful host tool calls (used to derive exitReason last-wins).
 * The caller only submits via `recordRaw` on `tool_result_recorded(isError=false)` (a failed
 * handler does not derive an exit intent).
 */
export class SessionToolHistory {
  readonly #events: Array<{ toolName: string; input: unknown; invokedAt: number }> = [];

  recordRaw(toolName: string, input: unknown, invokedAt: number): void {
    this.#events.push({ toolName, input, invokedAt });
  }

  exitIntent(): WorkerExitReason | null {
    return deriveExitIntentLastWins(this.#events);
  }

  lastInvokedAt(): number | null {
    const last = this.#events.at(-1);
    return last ? last.invokedAt : null;
  }

  all(): ReadonlyArray<{ toolName: string; input: unknown; invokedAt: number }> {
    return this.#events;
  }
}

export type { SessionHandle, AgentRuntime };
