/**
 * Host daemon orchestrator (assembles the tick main loop).
 *
 * Wires the host subsystem mechanisms into a complete daemon:
 *  - single-instance lock (acquireSingleInstanceLock)
 *  - startup recovery (runStartupRecovery)
 *  - tick while loop: readManifestSnapshot → terminal / paused → cleanupAndExit; otherwise
 *    dispatchByStage → start/stop Meta / Worker / Watcher sessions per TickAction (via wrapper +
 *    prompt assembly + registering host tools) + wake-cursor inject + worker reconcile (first auto
 *    start + Meta explicit start) + Watcher window dispatch
 *  - exit codes + append host_stopping + remove host.pid
 *  - permanent Meta failure: N consecutive start failures → force failed
 *
 * Provides the concrete HostAgentControl (tool deps): requestWorkerStart / stopWorker /
 * triggerReviewer / workerSessionSeqResolver / active-handle getters. The orchestration layer
 * enqueues a worker_interrupt_softkill_failed host_event when interrupt_worker soft-kill fails; on
 * success it enqueues worker_session_end.
 *
 * Decision ownership: the daemon does not self-restart workers (worker exit → worker_session_end,
 * awaiting Meta arbitration).
 *
 * Watchdog integration (three session-level kinds; pure-function detection in src/host/watchdog.ts):
 *  - Worker session: no_progress (idle past threshold since last tool_use) + tool_loop (N consecutive
 *    identical (toolName, hash(input))) — startWorker's subscribe listener accumulates
 *    WorkerWatchdogState, monitorActiveWorker calls checkWorkerWatchdog each tick; trip → the unified
 *    action (forceAbort close + derive watchdog_* exitReason + worker_session_end + watchdog_triggered
 *    + host_event). The host does not self-restart.
 *  - Reviewer session timeout: inside agent_control.triggerReviewer (with injected now + thresholds).
 *  - Meta push: driveMetaWake / ensureMetaOnline wraps Meta inject with withTimeout; on timeout it
 *    does not close Meta (only Meta can exit Meta), emits host_event + watchdog_triggered, and after
 *    M consecutive → metaStartFailures +1 (feeding the META_START_FAILURE_LIMIT force-failed path).
 *  - tool-level / API-level watchdogs are not re-implemented here (already handled by the Claude
 *    adapter toolBridge / wrapper RuntimeError + retry).
 *
 * Time is injectable (DaemonConfig.now / watchdogThresholds) for fake-clock testing.
 *
 * The daemon uses an injected AgentRuntime (a real provider adapter in production, a stub in tests).
 */
import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import type { Channel, Envelope, MessagingBus } from "../messaging/index.js";
import type { EnvelopeId, SessionId } from "../shared/ids.js";
import type { LockHandle } from "../shared/locks.js";
import { manifestIO, type Manifest, type Stage } from "../shared/manifest.js";
import type { TaskCapsulePaths } from "../shared/paths.js";
import { conversationIO } from "../shared/conversation.js";
import { nowIso8601Us } from "../shared/timeUtils.js";
import { renderStatusMd } from "../shared/status_md.js";
import {
  firstUserMessageAssembler,
  runtimePromptRenderer,
  readRecentEventsSummaries,
  type Lang,
} from "../prompts/index.js";
import type {
  AgentRole,
  AgentRuntime,
  ContextUsage,
  ProviderId,
  SessionEndReason,
  SessionEvent,
  SessionHandle,
  SessionRequest,
} from "../wrapper/index.js";
import { createHostToolRegistry, RuntimeErrorImpl } from "../wrapper/index.js";
import { RoleResolver, type RoleBinding, type WatcherCompactMode } from "./role_assembly.js";

import {
  allocateWorkerSessionSeq,
  appendReviewerEndedIdempotent,
  appendSessionEnded,
  appendSessionStarted,
  appendWorkerEndedIdempotent,
  enqueueWorkerSessionEnd,
  firstMessageInject,
  generateSessionId,
  initWorkerOrchestrationState,
  isActiveExit,
  isInjectDelivered,
  mapSessionEndReason,
  prompts,
  SessionToolHistory,
  writeFirstMessage,
  writeSystemPrompt,
  type EnqueuableWorkerExitReason,
  type WorkerExitReason,
  type WorkerOrchestrationState,
} from "./agent_sessions.js";
import {
  createHostAgentControl,
  ReviewerVerdictBuffer,
  type HostAgentControl,
} from "./agent_control.js";
import {
  AgentBehaviorErrorKind,
  HostEventKind,
  HostOrchestrationErrorKind,
  SdkErrorKind,
  sdkErrorKindFromRuntimeError,
  WatchdogKind,
} from "./errorKinds.js";
import { eventsIO } from "./events.js";
import {
  checkWorkerWatchdog,
  recordWorkerActivity,
  withTimeout,
  HostTimeoutError,
  DEFAULT_WATCHDOG_THRESHOLDS,
  type WatchdogThresholds,
  type WorkerWatchdogState,
  type WorkerWatchdogTrigger,
} from "./watchdog.js";
import {
  acquireSingleInstanceLock,
  dispatchByStage,
  enqueueHostEvent,
  enqueueWorkerCompletionReminder,
  foldUnreadForWake,
  WakeCursor,
} from "./main_loop.js";
import { withTransientRetry, type RetryConfig, type RetryHooks } from "./retry.js";
import { runStartupRecovery, ManifestReadFatal } from "./recovery.js";
import { evaluateOutcome, renderOutcomeSummary, ScriptProcessRegistry } from "./done_criteria/index.js";
import { registerHostTools } from "./tools/index.js";
import { isTerminal } from "./stage_machine.js";
import { createWindowDispatcher, DEFAULT_WINDOW_SECONDS, synthesizeWatcherCompactSummary, type WindowDispatcher } from "./watcher/index.js";

/** Host process exit codes. */
export const HostExitCode = {
  Ok: 0, // done / paused / awaiting_user yield
  GeneralError: 1, // failed terminal / permanent Meta failure
  Fatal: 2, // manifest read failure / host's own fatal error
  SingleInstance: 6, // host.pid.lock conflict
  Sigint: 130,
} as const;

export type HostExitCode = (typeof HostExitCode)[keyof typeof HostExitCode];

export interface DaemonConfig {
  readonly paths: TaskCapsulePaths;
  readonly projectRoot: string;
  /**
   * Single-provider shorthand: when `roleBindings` / `runtimes` are not provided, all roles resolve
   * to this single runtime + `model`. Ignored when roleBindings is provided.
   */
  readonly runtime?: AgentRuntime;
  /**
   * Per-role provider→runtime assembly: each role binds `(provider, model)`; provided together with
   * `runtimes`. When provided, the host starts sessions via per-role resolution (runtime from
   * `runtimes`, resolving (runtime, model, isolation) by role). When omitted → use the `runtime` +
   * `model` single-provider shorthand.
   */
  readonly roleBindings?: Readonly<Record<AgentRole, RoleBinding>>;
  /**
   * provider → AgentRuntime map: one runtime instance per provider used by roleBindings (lazily
   * created). When `roleBindings` is provided this field must be provided and cover all bound
   * providers (otherwise RoleResolver construction throws a clear config error).
   */
  readonly runtimes?: ReadonlyMap<ProviderId, AgentRuntime>;
  /** Per-provider isolation templates (resolved per provider; missing providers use the isolation fallback template). */
  readonly isolationByProvider?: ReadonlyMap<ProviderId, SessionRequest["isolation"]>;
  /**
   * Watcher proactive-compact dryrun mode: strict needs compact.canObserveSummary &&
   * canCustomizeSummary; lenient needs only compact.canTrigger. Default strict.
   */
  readonly watcherCompactMode?: WatcherCompactMode;
  /**
   * Production mode (affects meta capability gating: only production mode requires the path-guard
   * capability preflightHook || firstClassBlock || osSandboxWritableRoots). Default false (test / stub).
   */
  readonly productionMode?: boolean;
  /**
   * The same HostToolRegistry the runtime uses for tool dispatch. The daemon registers host tools
   * (injected with agentControl / verdictBuffer / seqResolver) into it. In production the entry
   * builds the registry first → passes it to factory.create + this config; in tests the stub uses
   * the same registry. When omitted → the daemon builds its own (only usable when the runtime does
   * not depend on an external registry).
   */
  readonly toolRegistry?: ReturnType<typeof createHostToolRegistry>;
  /** session cwd (worker / watcher isolation root, default paths.workspace). */
  readonly sessionCwd?: string;
  /** session model (the single-provider shorthand's model; default stub model). Ignored when roleBindings is provided. */
  readonly model?: SessionRequest["model"];
  /**
   * thinking / effort config shared by all roles (a single value for all roles).
   * Default undefined → do not explicitly declare thinking (SDK default). Production uses { level: "xhigh" }.
   */
  readonly thinking?: SessionRequest["thinking"];
  /** isolation profile template (default capsule control + env auth). */
  readonly isolation?: SessionRequest["isolation"];
  readonly metaLang?: Lang;
  readonly watcherLang?: Lang;
  readonly windowSeconds?: number;
  /** Main tick interval ms (default 1000; tests may shrink it). */
  readonly tickIntervalMs?: number;
  /** Max tick count (test guard against infinite loops); default unlimited. */
  readonly maxTicks?: number;
  /** Injected stop signal (test): when it returns true, gracefully exit at the next tick boundary. */
  readonly shouldStop?: () => boolean;
  /** Injected clock (fake clock for testing, default Date.now) — watchdog timing (worker no_progress / reviewer / meta push). */
  readonly now?: () => number;
  /** watchdog threshold overrides (tests shrink thresholds). */
  readonly watchdogThresholds?: Partial<WatchdogThresholds>;
  /**
   * Watcher context-compact trigger threshold (tokens): watcher idle and contextUsage.tokens ≥ this
   * value → trigger compact orchestration. Default 500_000. Tests shrink it to drive triggering.
   */
  readonly watcherCompactThreshold?: number;
  /** Watcher compact overall retry cap (one full compact+reinject flow; exhausted → giveup, no further attempts this session). Default 1. */
  readonly watcherCompactRetryMax?: number;
  /**
   * Host-level transient retry config for SDK-boundary calls (startSession / worker first inject).
   * Defaults to DEFAULT_RETRY_CONFIG (3 tries / 1-2-4s backoff). Tests inject `retryHooks.sleep` to
   * skip real backoff.
   */
  readonly retryConfig?: Partial<RetryConfig>;
  readonly retryHooks?: RetryHooks;
  /**
   * Cap (ms) on how long cleanup waits for in-flight worker closeout to complete (tests may shrink
   * it to verify the timeout-takeover epoch fence; default 10_000). Production uses the default
   * (a teardown safety bound, wall-clock).
   */
  readonly workerFinalizeWaitMs?: number;
}

// `by` prefixes for host fallback-wakeup markRead: host inject carries `host_inject:<role>_session:<sid>`
// (distinguishing the two read paths; an agent's own pull markRead uses the bare `<role>_session:`).
const META_READ_BY_PREFIX = "host_inject:meta_session:";
const WATCHER_READ_BY_PREFIX = "host_inject:watcher_session:";

/**
 * Watcher context-compact default parameters.
 * Overall retry cap 1 (one retry on compact+reinject failure, then giveup).
 */
const WATCHER_COMPACT_THRESHOLD_TOKENS = 500_000;
const WATCHER_COMPACT_RETRY_MAX = 1;

/**
 * Host-level transient retry wrapper for SDK-boundary calls. Only retries (with backoff) wrapper
 * `RuntimeError.kind === "transient"` (network / rate-limit etc.); permanent / protocol / timeout /
 * cancelled is rethrown immediately to the caller. If retries are exhausted and it is still
 * transient → rethrow the last error (the caller escalates to a permanent failure signal into the
 * Meta inbox).
 *
 * Purpose: ensure transient SDK jitter is not miscounted by the caller as a "start failure" (meta
 * startSession failures reaching 5 → force failed; worker first inject failure → host_internal_error),
 * avoiding mistaking transient failures for permanent ones and wrongly terminating the task.
 */
async function withSdkRetry<T>(ctx: TickContext, label: string, fn: () => Promise<T>): Promise<T> {
  const hooks: RetryHooks = {
    onRetry: (attempt, delayMs, err) => {
      console.warn(`[daemon] transient SDK retry (${label}) attempt ${attempt} after ${delayMs}ms: ${err.subKind ?? err.kind}`);
    },
    ...(ctx.retryHooks ?? {}),
  };
  return withTransientRetry(fn, ctx.retryConfig ?? {}, hooks);
}

function defaultModel(): SessionRequest["model"] {
  return { provider: "claude", modelId: "stub-model" };
}

/**
 * Build the per-role resolver from DaemonConfig. With roleBindings → multi-provider assembly
 * (runtimes must cover all bound providers, validated by the RoleResolver constructor); otherwise
 * the single-provider shorthand (runtime + model).
 */
function buildRoleResolver(config: DaemonConfig, fallbackIsolation: SessionRequest["isolation"]): RoleResolver {
  const common = {
    fallbackIsolation,
    ...(config.watcherCompactMode !== undefined ? { watcherCompactMode: config.watcherCompactMode } : {}),
    productionMode: config.productionMode ?? false,
  };
  if (config.roleBindings !== undefined) {
    if (config.runtimes === undefined) {
      throw new RuntimeErrorImpl({
        kind: "permanent",
        subKind: "invalid_request",
        providerId: "claude",
        message: "DaemonConfig.roleBindings provided but runtimes missing",
      });
    }
    return new RoleResolver({
      multi: {
        roleBindings: config.roleBindings,
        runtimes: config.runtimes,
        ...(config.isolationByProvider !== undefined ? { isolationByProvider: config.isolationByProvider } : {}),
      },
      ...common,
    });
  }
  // Single-provider shorthand: runtime + model (default stub), all roles resolve to this single assembly.
  if (config.runtime === undefined) {
    throw new RuntimeErrorImpl({
      kind: "permanent",
      subKind: "invalid_request",
      providerId: "claude",
      message: "DaemonConfig: neither runtime (single) nor roleBindings (multi) provided",
    });
  }
  return new RoleResolver({
    single: {
      runtime: config.runtime,
      model: config.model ?? defaultModel(),
      isolation: config.isolation ?? fallbackIsolation,
    },
    ...common,
  });
}

/**
 * Production default model config: a single model for all roles, `claude-opus-4-8` +
 * `thinking_effort=xhigh` (a single effort value for all roles); summary=summarized makes the
 * server return a reasoning summary. Tests use `defaultModel()` (stub-model) instead of this;
 * production passes these two constants explicitly via `DaemonConfig.model` + `DaemonConfig.thinking`.
 */
export const PRODUCTION_MODEL: SessionRequest["model"] = { provider: "claude", modelId: "claude-opus-4-8" };
export const PRODUCTION_THINKING: SessionRequest["thinking"] = { level: "xhigh", summary: "summarized" };

/**
 * Production codex model — currently a fixed model (model selection is a reserved capability, not
 * exposed in the UI / CLI). The current default codex model is `gpt-5.5`; roles bound to codex use
 * this default model.
 */
export const PRODUCTION_CODEX_MODEL: SessionRequest["model"] = { provider: "codex", modelId: "gpt-5.5" };

function defaultIsolation(paths: TaskCapsulePaths): SessionRequest["isolation"] {
  return {
    capsuleConfigDir: paths.control,
    promptLang: "en",
    authSource: { kind: "env", varName: "DEPUTY_API_KEY" },
  };
}

/**
 * Meta path guard: forbid Meta from directly editing `workspace/harness/**` with built-in
 * file-write tools (Write/Edit/MultiEdit/NotebookEdit) — harness revisions must go through
 * `sh_harness__write_*` via the audit trail (harness_changed event + by_session). Registered for
 * Meta only (the worker is the executor and may freely write the workspace). Uses an absolute
 * harness-path glob; the adapter hardenPath resolves targets to absolute + folds traversal +
 * normcase before matching (preventing `..` / case / extended-path bypass).
 */
function metaHarnessPathGuards(paths: TaskCapsulePaths): NonNullable<SessionRequest["pathGuards"]> {
  const harnessGlob = `${paths.harnessDir.replace(/\\/g, "/")}/**`;
  return {
    rules: [
      {
        pattern: harnessGlob,
        mode: "deny",
        affectedTools: [], // empty = all built-in file-write tools (hooks.ts EDIT_TOOLS)
        denyReason:
          "workspace/harness/** is protected — use sh_harness__write_worker / sh_harness__write_watcher (these go through the audit trail). Direct built-in file edits to harness are blocked.",
      },
    ],
  };
}

/**
 * Daemon runtime state — Meta / Watcher long-session handles + Worker handle + orchestration
 * in-memory state. This is host-orchestration-layer in-memory state that vanishes when the host
 * exits; the next startup cold-resumes via the recovery summary.
 */
class DaemonState {
  metaHandle: SessionHandle | null = null;
  watcherHandle: SessionHandle | null = null;
  workerHandle: SessionHandle | null = null;
  reviewerHandle: SessionHandle | null = null;
  /** worker sessionId → sessionSeq (used by workerSessionSeqResolver). */
  readonly workerSeqBySession = new Map<string, number>();
  readonly orchestration: WorkerOrchestrationState = initWorkerOrchestrationState();
  readonly metaWakeCursor = new WakeCursor();
  /** Watcher inbox wake cursor (structurally identical to Meta wake); independent of metaWakeCursor. */
  readonly watcherWakeCursor = new WakeCursor();
  /**
   * Watcher context-compact orchestration state:
   *  - `watcherCompactTask` non-null = one compact flow (compact + role reinject + wait for turn) is
   *    running in the background (does not block the main tick). The flow has self-contained error
   *    handling (never rejects); its `finally` clears it back to null while still the same watcher
   *    session. driveWatcherWake skips the wake inject while this task is non-null (the backlog
   *    resumes the next tick after compact completes).
   *  - `watcherCompactGiveup` = overall retries exhausted, no further compact attempts this watcher
   *    session (avoiding a repeated-failure hot-loop).
   * A watcher restart (ensureWatcherOnline starting a new session) resets both (the old session's
   * in-flight task naturally no-ops via the handle-identity guard).
   */
  watcherCompactTask: Promise<void> | null = null;
  watcherCompactGiveup = false;
  metaInited = false;
  /** Positive flag that Meta explicitly requested starting a worker via sh_agent__start_worker (orchestration-local state, consumed next tick). */
  wantWorkerStart = false;
  /** The current active worker's sessionId / seq / tool exit intent (exitReason derivation). */
  workerSessionId: SessionId | null = null;
  workerSessionSeq: number | null = null;
  /** Active worker cross-tick state (event-driven lifecycle): tool history (exitReason last-wins) / subscription handle / whether the turn ended. */
  workerToolHistory: SessionToolHistory | null = null;
  workerUnsub: (() => void) | null = null;
  workerTurnEnded = false;
  /**
   * First-message inject failure flag (threw / ack=rejected_busy): the worker never received its
   * first message and did nothing. finalizeWorker derives host_internal_error from this (does not
   * enqueue worker_session_end / does not misreport natural_completion).
   */
  workerInjectFailed = false;
  /**
   * Active worker's watchdog cross-tick state: lastToolUseAt (session start time when there is no
   * tool) + recentSignatures (the most recent toolUseSignatures). startWorker's subscribe listener
   * accumulates it; monitorActiveWorker calls checkWorkerWatchdog each tick. Cleared on worker finalize.
   */
  workerWatchdog: { lastToolUseAt: number; recentSignatures: string[] } | null = null;
  /** Meta start-failure tally (force failed at the threshold, avoiding a permanently failing Meta spinning forever). */
  metaStartFailures = 0;
  /**
   * Meta push (inject/await) consecutive-timeout counter: M consecutive watchdog_meta_push_timeout →
   * metaStartFailures +1 and this counter resets to 0; any successful Meta inject → reset to 0.
   */
  metaPushTimeoutStreak = 0;
  /**
   * WCP reminder cadence ("one reminder per Meta-turn idle", one-to-one): whether a reminder was
   * already posted during this Meta idle. Meta going from idle back to streaming (a new turn) →
   * reset, post one again on the next idle; also reset when pending is cleared.
   */
  metaReminderPostedForCurrentIdle = false;
  /** cleanupAndExit idempotency guard. */
  cleanedUp = false;
  /**
   * Unified worker-closeout mutex guard (single closeout owner). Meaning: "worker closeout is
   * in-flight, the sole closeout owner is determined". With a real adapter, worker closeout has three
   * concurrent entries (Node single-threaded: each async interleaves at await points, synchronous
   * sections are atomic):
   *  (a) tick main loop monitorActiveWorker → finalizeWorker;
   *  (b) a tool handler within a Meta turn (sh_agent__stop_worker / sh_msg__interrupt_worker) via wrapAgentControl.stopWorker;
   *  (c) cleanupAndExit (process-exit teardown).
   * All three check-then-set this flag synchronously to race for the "sole owner". The winner = the
   * first to set it true synchronously, exclusively doing physical close + writing ENDED +
   * worker_session_end + flag transitions throughout; the losers:
   *  - finalizeWorker loses → return immediately (pure noop, no close / no write);
   *  - stopWorker loses → a true noop ack (no base physical close, no flag transition, no end/ENDED
   *    write; the worker is already being closed out, stop is idempotently meaningless; in particular
   *    does not mis-transition meta_interrupt into metaStopNoRestart);
   *  - cleanupAndExit loses → waits for the in-flight closeout to complete (which writes the ENDED)
   *    then does not re-close / re-write the worker.
   * Guarantees worker ENDED / worker_session_end are written exactly once, no flag mis-transition, no
   * deadlock. All holding paths (including exceptions / early-return) must release in finally. Under
   * a stub synchronous turn the three entries don't truly concur, but a real adapter requires this.
   */
  workerFinalizing = false;
  /**
   * Worker-closeout owner/takeover epoch. Monotonically increasing. Meaning: the generation number
   * of closeout ownership. Ordinary closeout owners (finalizeWorker / wrapAgentControl.stopWorker)
   * capture the current epoch on entry (after setting workerFinalizing=true); before writing
   * worker_session_end / ENDED / clearing the handle they compare their captured epoch with the
   * current one — a mismatch means "already taken over by cleanup timeout", so they abandon all
   * writes (cleanup already wrote the host_shutdown ENDED), avoiding duplicate ENDED /
   * worker_session_end and preserving "exactly one ENDED".
   *
   * Only cleanupAndExit's timeout-takeover path bumps the epoch (waitForWorkerFinalizeIdle waits for
   * the in-flight closeout owner to exceed 10s without completing → cleanup forcibly takes over close
   * + writes the host_shutdown ENDED; the bump makes a late-completing original owner abandon its
   * writes). The normal path (waitForWorkerFinalizeIdle not timed out / no in-flight closeout owner)
   * does not bump, leaving normal concurrent behavior completely unchanged.
   */
  workerFinalizeEpoch = 0;
  /**
   * Whether the current worker session's paired ENDED is durably persisted. finalizeWorker /
   * wrapAgentControl.stopWorker set it true after appendSessionEnded succeeds; startWorker resets it
   * to false when starting a new worker. cleanupAndExit's timeout takeover uses it to decide whether
   * to backfill a host_shutdown ENDED:
   *  - false (the in-flight closeout owner was taken over before / during the ENDED write) → cleanup
   *    uses the retained owner context (workerSessionId/Seq, even if workerHandle was nulled by the
   *    owner) to backfill the single host_shutdown ENDED, guaranteeing worker STARTED pairs with ENDED.
   *  - true (the owner wrote ENDED but was taken over while in a later non-durable step like
   *    onWorkerSessionEnded) → cleanup does not re-write.
   * Reflects only the "current active worker session"; after worker closeout clears the active
   * handle, that session needs no further ENDED (the last worker only keeps sessionId/seq for
   * firstStart gating, already paired with an ENDED).
   */
  workerEndedWritten = false;
  /**
   * Worker start-failure (startSession / sessionSeq allocation failure, host-orchestration-layer
   * abnormal path) awaiting-Meta-decision state. After startWorker returns false it is set true and
   * wantWorkerStart cleared — preventing reconcileWorker's firstStart / a residual wantWorkerStart
   * from retrying every tick into a hot-loop (repeatedly allocating seq / writing STARTED-ENDED /
   * host_event). startWorker already surfaced host_event(agent_session_start_failed) to inform Meta.
   * An explicit Meta sh_agent__start_worker (requestWorkerStart → wantWorkerStart=true) clears this
   * flag to continue (the host does not self-restart, Meta decides). Also cleared once a worker starts successfully.
   */
  workerStartFailedPending = false;
  /**
   * The inbox-gate baseline for the workerStartFailedPending state: on entering it, snapshot the set
   * of all read=false meta_instruction envIds currently in the worker inbox.
   * reconcileWorkerCompletionPending's inbox gate triggers starting a new worker only when a
   * meta_instruction beyond the baseline appears — otherwise, under persistent start/inject failure,
   * the same old unread meta_instruction (consumed by the worker pull, not markRead by the host)
   * would trigger the gate every tick → clear pending → wantWorkerStart → startWorker fails again →
   * re-enter this state → the same old instruction is still there → hot-loop (repeatedly allocating
   * seq / writing STARTED-ENDED / host_event). Meaningful only while workerStartFailedPending is true
   * (null otherwise). Other awaiting-Meta states (workerCompletionPending etc.) are unaffected: they
   * do not repeatedly re-enter the failure state, and a gate hit continues successfully (a successful
   * worker start clears pending).
   */
  workerStartFailedBaselineEnvIds: ReadonlySet<string> | null = null;
  /**
   * Registry of script subprocesses for the current in-flight done_criteria evaluate (held while
   * finalizeWorker runs evaluateOutcome). cleanupAndExit (host exit / cancel) calls terminateAll to
   * forcibly terminate the in-flight script process tree + close pipes — otherwise cancel only makes
   * the await return while the underlying script subprocess runs to its own timeout (≤3600s),
   * blocking host shutdown for tens of minutes. Cleared to null after evaluate returns (by then all
   * subprocesses have settled and the registry is empty).
   */
  activeEvaluateRegistry: ScriptProcessRegistry | null = null;
}

export interface DaemonResult {
  readonly exitCode: HostExitCode;
  readonly reason: string;
}

/**
 * Daemon main entry: hold the single-instance lock → startup recovery → tick loop → exit. Returns
 * exit code + reason (does not call process.exit directly; wrapped by the entry).
 */
export async function runDaemon(config: DaemonConfig): Promise<DaemonResult> {
  const { paths } = config;

  // 1. single-instance lock
  let lockResult;
  try {
    lockResult = await acquireSingleInstanceLock(paths);
  } catch (err) {
    return { exitCode: HostExitCode.Fatal, reason: `single-instance lock error: ${(err as Error).message}` };
  }
  if (!lockResult.acquired) {
    return {
      exitCode: HostExitCode.SingleInstance,
      reason: `host already running (pid=${lockResult.otherPid ?? "?"}, ${HostOrchestrationErrorKind.hostSingleInstanceConflict})`,
    };
  }
  const lock: LockHandle = lockResult.handle!;

  try {
    return await runDaemonLocked(config);
  } catch (err) {
    if (err instanceof ManifestReadFatal) {
      return { exitCode: HostExitCode.Fatal, reason: `manifest fatal: ${err.message}` };
    }
    // host's own fatal error (an unrecoverable code bug) → exit code 2
    return { exitCode: HostExitCode.Fatal, reason: `host fatal: ${(err as Error).message}` };
  } finally {
    await lock.release().catch(() => {});
  }
}

async function runDaemonLocked(config: DaemonConfig): Promise<DaemonResult> {
  const { paths } = config;
  const tickMs = config.tickIntervalMs ?? 1_000;
  const cwd = config.sessionCwd ?? paths.workspace;
  const thinking = config.thinking;
  const fallbackIsolation = config.isolation ?? defaultIsolation(paths);
  const metaLang = config.metaLang;
  const watcherLang = config.watcherLang ?? "en";
  const now = config.now ?? Date.now;
  const watchdogThresholds: WatchdogThresholds = { ...DEFAULT_WATCHDOG_THRESHOLDS, ...(config.watchdogThresholds ?? {}) };

  // Per-role provider→runtime resolver. With roleBindings → multi-provider assembly; otherwise the
  // single-provider shorthand (runtime + model). The RoleResolver constructor validates multi
  // consistency (roleBindings must be covered by runtimes), throwing a clear config error otherwise.
  const resolver = buildRoleResolver(config, fallbackIsolation);

  // 2. startup recovery — ManifestReadFatal rethrown is caught by runDaemon → exit code 2
  const recovery = await runStartupRecovery(paths);
  const bus = recovery.bus;

  // conversation.md startup hook (ensureMdExistsOrRebuild)
  await conversationIO.ensureMdExistsOrRebuild(paths).catch(() => {});

  const state = new DaemonState();
  const verdictBuffer = new ReviewerVerdictBuffer();

  // Recovered active-exit worker_session_end (synthesized / durable-but-unarbitrated) → restore the
  // in-memory WorkerCompletionPending. After restart Meta is woken and sees that worker_session_end,
  // but if it isn't handled within a round the host continues the reminder chain to prompt Meta.
  // reminderSeq restarts from 1 (the first posted by this recovery path on the next idle tick via
  // reconcileWorkerCompletionPending). Also backfill workerSessionId/Seq + workerSeqBySession:
  // otherwise reconcileWorker mistakes workerSessionId=null as firstStart and auto-starts a new
  // worker bypassing Meta arbitration, and the next worker's prevSessionId breaks and
  // workerSessionSeqResolver fails.
  if (recovery.synthesizedWorkerEnd !== null) {
    const swe = recovery.synthesizedWorkerEnd;
    state.orchestration.workerCompletionPending = true;
    state.orchestration.workerCompletionReminderSeq = 0; // 0 → post seq 1 on the next idle tick (reconcileWorkerCompletionPending)
    state.orchestration.lastWorkerSessionEndEnvId = swe.endEnvId;
    state.orchestration.lastWorkerSessionId = swe.workerSessionId;
    state.orchestration.lastWorkerSessionSeq = swe.sessionSeq;
    state.orchestration.lastWorkerExitReason = swe.exitReason;
    state.workerSessionId = swe.workerSessionId as SessionId;
    state.workerSessionSeq = swe.sessionSeq;
    state.workerSeqBySession.set(swe.workerSessionId, swe.sessionSeq);
  } else if (recovery.crashPending !== null) {
    // A crash (worker STARTED with no ENDED, host crashed while the worker was running) or a durable
    // non-active-exit worker_session_end that Meta has not arbitrated. recovery already backfilled the
    // paired ENDED (+ a pure crash also enqueued an sdk_crash end + host_event). The daemon backfills
    // the last worker sessionId/Seq + enters the waiting state per waitState: so reconcileWorker
    // neither mistakes workerSessionId=null as firstStart self-restart (the host does not self-restart
    // on abnormal exits) nor fails to continue on the inbox gate (an explicit Meta send_to_worker /
    // start_worker). Does not enter WCP / has no reminder (passive abnormal exits / explicit interrupts
    // are already known to Meta). The next worker's prevSessionId + workerSessionSeqResolver also
    // depend on this backfill.
    //  - sessionEndPending (sdk_crash/subprocess_crash): await Meta reaction, inbox gate / silence does not self-restart.
    //  - metaInterruptDefaultContinue (meta_interrupt): on Meta silence the host default-continues by starting a new worker.
    //  - metaStopNoRestart (meta_stop): does not start a new worker until Meta calls any worker-dispatch tool / send_to_worker again.
    //    Known gap: meta_stop's restartAfter is not persisted → restartAfter=true after a crash
    //    uniformly restores metaStopNoRestart, requiring Meta to re-dispatch after restart (see the
    //    recovery.waitStateForExitReason comment).
    const cp = recovery.crashPending;
    state.orchestration.workerCompletionReminderSeq = 0; // passive crash / explicit interrupt does not enter WCP / has no reminder (explicit reset, symmetric with the clear-pending paths)
    if (cp.waitState === "metaInterruptDefaultContinue") {
      state.orchestration.metaInterruptDefaultContinue = true;
    } else if (cp.waitState === "metaStopNoRestart") {
      state.orchestration.metaStopNoRestart = true;
    } else {
      state.orchestration.sessionEndPending = true;
    }
    state.orchestration.lastWorkerSessionId = cp.workerSessionId;
    state.orchestration.lastWorkerSessionSeq = cp.sessionSeq;
    state.orchestration.lastWorkerExitReason = cp.exitReason;
    state.workerSessionId = cp.workerSessionId as SessionId;
    state.workerSessionSeq = cp.sessionSeq;
    state.workerSeqBySession.set(cp.workerSessionId, cp.sessionSeq);
  }

  // Reviewer per-role resolution: the reviewer session's (runtime, model, isolation) is resolved by
  // role and injected into HostAgentControl (used by triggerReviewer).
  const reviewerAssembly = resolver.resolve("reviewer");

  // concrete HostAgentControl (tool deps)
  const baseControl: HostAgentControl = createHostAgentControl({
    paths,
    bus,
    runtime: reviewerAssembly.runtime,
    runtimeForRole: (role: AgentRole) => resolver.resolve(role).runtime,
    orchestration: state.orchestration,
    verdictBuffer,
    reviewerSessionConfig: {
      cwd,
      model: reviewerAssembly.model,
      ...(thinking !== undefined ? { thinking } : {}),
      isolation: reviewerAssembly.isolation,
      toolNames: ["sh_reviewer__submit_verdict"],
    },
    getActiveWorkerHandle: () => state.workerHandle,
    getActiveReviewerHandle: () => state.reviewerHandle,
    setActiveReviewerHandle: (h) => {
      state.reviewerHandle = h;
    },
    now,
    watchdogThresholds,
    // The reviewer is also a one-shot SDK-boundary call (startSession + first inject), wired into transient retry by the same rule.
    ...(config.retryConfig !== undefined ? { retryConfig: config.retryConfig } : {}),
    ...(config.retryHooks !== undefined ? { retryHooks: config.retryHooks } : {}),
  });
  const windowDispatcher = createWindowDispatcher({
    bus,
    paths,
    events: eventsIO,
    windowSeconds: config.windowSeconds ?? DEFAULT_WINDOW_SECONDS,
    watcherLang,
  });

  // Wrap baseControl:
  //  - requestWorkerStart: besides clearing base flags, set the daemon-local wantWorkerStart (actually start the session next tick)
  //  - stopWorker: unify finalization for all active closes (meta_interrupt / meta_stop)
  //    (worker_session_end + ENDED + watcher final window + clear daemon-local worker state); surface a host_event on soft-kill failure
  const agentControl = wrapAgentControl(baseControl, bus, state, paths, windowDispatcher);

  // host tool registry (shared by Meta / Worker / Watcher / Reviewer; scope is trimmed by startSession's toolNames).
  // Must be the same registry the runtime uses for dispatch (otherwise tool calls find no handler).
  const registry = config.toolRegistry ?? createHostToolRegistry();
  registerHostTools(registry, {
    paths,
    bus,
    agentControl,
    verdictBuffer,
    workerSessionSeqResolver: (sid: SessionId) => state.workerSeqBySession.get(sid) ?? 0,
  });

  const ctx: TickContext = {
    paths,
    bus,
    resolver,
    runtimeForRole: (role: AgentRole) => resolver.resolve(role).runtime,
    modelForRole: (role: AgentRole) => resolver.resolve(role).model,
    isolationForRole: (role: AgentRole) => resolver.resolve(role).isolation,
    registry,
    state,
    windowDispatcher,
    cwd,
    ...(thinking !== undefined ? { thinking } : {}),
    ...(metaLang !== undefined ? { metaLang } : {}),
    watcherLang,
    isRecovery: recovery.mode === "recovery",
    now,
    watchdogThresholds,
    workerFinalizeWaitMs: config.workerFinalizeWaitMs ?? WORKER_FINALIZE_WAIT_MS,
    watcherCompactThreshold: config.watcherCompactThreshold ?? WATCHER_COMPACT_THRESHOLD_TOKENS,
    watcherCompactRetryMax: config.watcherCompactRetryMax ?? WATCHER_COMPACT_RETRY_MAX,
    watcherCompactMode: config.watcherCompactMode ?? "strict",
    retryConfig: config.retryConfig,
    retryHooks: config.retryHooks,
  };

  // 3. tick loop. The fatal-exception path also goes through cleanupAndExit (close held sessions +
  //    append host_stopping + remove host.pid — "all exit paths go through cleanup") — once ctx is
  //    built, any throw cleans up first then rethrows.
  try {
    let ticks = 0;
    for (;;) {
      if (config.shouldStop?.()) {
        return await cleanupAndExit(ctx, HostExitCode.Ok, "host_stop_signal");
      }
      if (config.maxTicks !== undefined && ticks >= config.maxTicks) {
        return await cleanupAndExit(ctx, HostExitCode.Ok, "max_ticks_reached");
      }
      ticks += 1;

      let manifest: Manifest;
      try {
        manifest = await manifestIO.load(paths);
      } catch (err) {
        throw new ManifestReadFatal(`manifest reload failed mid-loop: ${(err as Error).message}`, { cause: err });
      }
      const stage = manifest.stage;

      // terminal / paused → cleanupAndExit
      if (isTerminal(stage) || stage === "paused") {
        const exitCode = stage === "failed" ? HostExitCode.GeneralError : HostExitCode.Ok;
        return await cleanupAndExit(ctx, exitCode, `terminal_stage:${stage}`);
      }

      const action = dispatchByStage(stage);
      const outcome = await runTickAction(ctx, manifest, action);
      if (outcome !== null) {
        return await cleanupAndExit(ctx, outcome.exitCode, outcome.reason);
      }

      await sleep(tickMs);
    }
  } catch (err) {
    // fatal (including ManifestReadFatal): clean up first (without overriding the original exit-code semantics) then rethrow to runDaemon for exit-code mapping
    await cleanupAndExit(ctx, HostExitCode.Fatal, `fatal: ${(err as Error).message}`).catch(() => {});
    throw err;
  }
}

interface TickContext {
  readonly paths: TaskCapsulePaths;
  readonly bus: MessagingBus;
  /** Per-role provider→runtime resolver. */
  readonly resolver: RoleResolver;
  /** Resolve runtime by role. Handle-based operations resolve by handle.role (a stable role→runtime mapping). */
  readonly runtimeForRole: (role: AgentRole) => AgentRuntime;
  /** Resolve model by role. */
  readonly modelForRole: (role: AgentRole) => SessionRequest["model"];
  /** Resolve isolation by role (resolving authSource per provider). */
  readonly isolationForRole: (role: AgentRole) => SessionRequest["isolation"];
  readonly registry: ReturnType<typeof createHostToolRegistry>;
  readonly state: DaemonState;
  readonly windowDispatcher: WindowDispatcher;
  readonly cwd: string;
  readonly thinking?: SessionRequest["thinking"];
  readonly metaLang?: Lang;
  readonly watcherLang: Lang;
  readonly isRecovery: boolean;
  /** Injected clock (watchdog timing). */
  readonly now: () => number;
  /** watchdog thresholds with defaults merged. */
  readonly watchdogThresholds: WatchdogThresholds;
  /** Cap (ms) on cleanup waiting for in-flight worker closeout. */
  readonly workerFinalizeWaitMs: number;
  /** Watcher context-compact trigger threshold (tokens) + overall retry cap (defaults merged). */
  readonly watcherCompactThreshold: number;
  readonly watcherCompactRetryMax: number;
  /** Watcher proactive-compact dryrun mode: default strict. Under lenient, compact_summary_missing is a non-retryable terminal state. */
  readonly watcherCompactMode: WatcherCompactMode;
  /** SDK-boundary transient retry config / hooks (undefined → withTransientRetry uses built-in defaults). */
  readonly retryConfig: Partial<RetryConfig> | undefined;
  readonly retryHooks: RetryHooks | undefined;
}

interface TickExit {
  readonly exitCode: HostExitCode;
  readonly reason: string;
}

/**
 * Execute one TickAction. Returns null = continue looping; returns TickExit = this tick decides to exit (only awaiting_user yields).
 */
async function runTickAction(
  ctx: TickContext,
  manifest: Manifest,
  action: ReturnType<typeof dispatchByStage>,
): Promise<TickExit | null> {
  switch (action.kind) {
    case "cleanup_and_exit":
      // Already handled before the main loop (terminal / paused); defensive yield return
      return { exitCode: HostExitCode.Ok, reason: `cleanup_and_exit:${action.stage}` };
    case "ensure_meta_then_clarifying": {
      await ensureClarifyingTransition(ctx);
      await ensureMetaOnline(ctx, "clarifying");
      await driveMetaWake(ctx);
      await maybeRemindMetaProgress(ctx);
      // Meta start failures / push timeouts reaching the cap → force failed
      return await maybeForceFailedOnMetaFailure(ctx, "clarifying");
    }
    case "ensure_meta": {
      await ensureMetaOnline(ctx, manifest.stage);
      await driveMetaWake(ctx);
      await maybeRemindMetaProgress(ctx);
      return await maybeForceFailedOnMetaFailure(ctx, manifest.stage);
    }
    case "ensure_running_agents": {
      await ensureMetaOnline(ctx, manifest.stage);
      await ensureWatcherOnline(ctx);
      // WCP state machine follow-up: worker-channel unread → clear pending and start a new worker;
      // Meta idle with pending persisting → increment the reminder. Before reconcileWorker (which may set wantWorkerStart).
      await reconcileWorkerCompletionPending(ctx);
      // worker startup: auto-start on first entering running + an explicit Meta start_worker;
      // after exit, continuation awaits Meta arbitration (the host does not self-restart). See reconcileWorker.
      await reconcileWorker(ctx);
      await driveMetaWake(ctx);
      // window dispatch before watcher wake: a worker_stream_window dispatched this tick lands in the
      // Watcher inbox and can immediately be consumed by driveWatcherWake (dispatch enqueue / wake inject are separate).
      await ctx.windowDispatcher.tick().catch(() => {});
      await driveWatcherWake(ctx);
      // Watcher context-compact orchestration: watcher idle and context usage over threshold → run
      // compact + role reinject in the background (does not block this tick; see maybeStartWatcherCompact / runWatcherCompactFlow).
      await maybeStartWatcherCompact(ctx);
      return await maybeForceFailedOnMetaFailure(ctx, manifest.stage);
    }
    case "await_user":
      return await handleAwaitUser(ctx);
    default:
      return null;
  }
}

/** submitted → clarifying (host-autonomous). A CAS guard prevents racing the CLI. */
async function ensureClarifyingTransition(ctx: TickContext): Promise<void> {
  try {
    await manifestIO.applyStageTransition(ctx.paths, "clarifying", { expectedFromStage: "submitted" });
    await eventsIO
      .append(ctx.paths, {
        type: "stage_transition",
        stage: "clarifying",
        details: { fromStage: "submitted", toStage: "clarifying", triggeredBy: "host", reason: "auto_start_clarify" },
      })
      .catch(() => {});
    await renderStatusMd(ctx.paths); // re-render status.md after the stage transition (fail-soft)
  } catch {
    // CAS conflict (the CLI already changed the stage) or already transitioned → ignore, re-read next tick
  }
}

/**
 * Keep the Meta long session online. Already online → noop; start failure → metaStartFailures +1
 * (the caller later decides force-failed by the tally via maybeForceFailedOnMetaFailure).
 */
async function ensureMetaOnline(ctx: TickContext, stage: Stage): Promise<void> {
  const { state } = ctx;
  if (state.metaHandle !== null && isSessionLive(ctx, state.metaHandle)) return;
  // The old Meta handle is non-live (closed/closing) but not cleared → before starting a new session
  // to replace it, backfill the paired ENDED for the old session, otherwise the old long-session
  // STARTED dangles forever. Idempotent close (reading the end reason) + append one agent_session_ended.
  if (state.metaHandle !== null) {
    // If the ENDED write fails → do not clear the handle (keep it for endStaleLongSession to retry the
    // ENDED backfill next tick), and do not start a new Meta this tick (next tick isSessionLive is
    // still non-live → re-enter this path and retry). Clear the handle and start a new session only on a successful write.
    const { endedWritten } = await endStaleLongSession(ctx, state.metaHandle, "meta", stage);
    if (!endedWritten) return;
    state.metaHandle = null;
  }

  // Per-role resolution: the meta role's (runtime, model, isolation).
  const meta = ctx.resolver.resolve("meta");
  const sessionId = generateSessionId();
  const systemPrompt = await prompts.metaSystem({ ...(ctx.metaLang !== undefined ? { metaLang: ctx.metaLang } : {}) });
  const recentEvents = await readRecentEventsSummaries(ctx.paths, 5).catch(() => [] as string[]);
  const manifest = await manifestIO.load(ctx.paths);
  const inboxCount = (await peekMetaUnread(ctx.bus)).length;
  const firstMessage = await firstUserMessageAssembler.assembleMetaFirstUserMessage({
    paths: ctx.paths,
    currentStage: stage,
    stageHistory: manifest.stageHistory.map((e) => e.stage),
    lastError: manifest.lastError ? manifest.lastError.message : null,
    inboxCount,
    recentEvents,
    isRecovery: ctx.isRecovery || state.metaInited,
    ...(ctx.metaLang !== undefined ? { metaLang: ctx.metaLang } : {}),
  });
  await writeSystemPrompt(ctx.paths, sessionId, systemPrompt);
  await writeFirstMessage(ctx.paths, sessionId, firstMessage);
  await appendSessionStarted(ctx.paths, stage, { role: "meta", sessionId, reason: "ensure_meta_online" });

  let handle: SessionHandle | null = null;
  let injectAttempted = false; // set true only on reaching the first-message inject stage — distinguishes a recovery inject failure from an earlier startSession/latestReadEnvId failure
  try {
    handle = await withSdkRetry(ctx, "meta startSession", () =>
      meta.runtime.startSession({
        role: "meta",
        sessionId,
        cwd: ctx.cwd,
        model: meta.model,
        ...(ctx.thinking !== undefined ? { thinking: ctx.thinking } : {}),
        systemPromptPath: ctx.paths.agentPromptPath(sessionId),
        firstMessagePath: ctx.paths.agentFirstMsgPath(sessionId),
        toolNames: toolNamesFor(ctx, "meta"),
        streamPath: ctx.paths.metaStreamPath(sessionId),
        isolation: meta.isolation,
        pathGuards: metaHarnessPathGuards(ctx.paths), // Meta-only harness write protection
        metadata: { lifecycleHint: "long" },
      }),
    );
    state.metaHandle = handle;
    // startup: inject the first message + init the wake cursor (take the inbox's latest read=true id)
    const latestRead = await latestReadEnvId(ctx.bus, "meta");
    state.metaWakeCursor.initFromLatestRead(latestRead);
    // Meta push watchdog: a single timeout on the first-message inject counts toward the push-timeout
    // tally (does not close Meta). A non-timeout inject error is still rethrown → counts toward the
    // startSession failure tally below (a startup-related failure).
    injectAttempted = true; // start point of the recovery first-message inject stage (the catch uses this to classify meta_recovery_inject_failed)
    const firstMsgDelivered = await metaInjectWithTimeout(ctx, handle, firstMessageInject(ctx.paths, sessionId), stage, true);
    // If the first-message inject is not delivered (timeout / rejected_busy) → do not complete Meta
    // init. Otherwise metaHandle exists, later ticks think it's online and don't retry the first
    // message → with no other unread, Meta never receives the initial context. A fresh session should
    // be idle, require_idle should not rejected_busy; a timeout can → treat all as a start failure
    // (close session + backfill the paired ENDED + count toward metaStartFailures, rebuild and retry
    // next tick; feeds the force-failed threshold). Do not silently mark online.
    // Note: a timeout inside metaInjectWithTimeout already emitted watchdog_meta_push_timeout host_event /
    // streak (not surfaced again); here only complete the "uninitialized" closeout (close + ENDED +
    // metaStartFailures+1). The throw enters the catch's unified closeout path (consistent with non-timeout inject errors).
    if (!firstMsgDelivered) {
      throw new RuntimeErrorImpl({
        kind: "timeout",
        subKind: "session_init_timeout",
        providerId: meta.model.provider,
        sessionId,
        message: "meta first message inject not delivered (timeout/rejected_busy); not completing init",
      });
    }
    // Only a confirmed-delivered first message counts as fully initialized → clear the start-failure
    // tally (the "consecutive" semantics). Cannot clear right after startSession succeeds: otherwise,
    // under a persistent first-message timeout (a Meta inject black hole), each tick a successful
    // startSession resets to 0 and an inject timeout adds +1, so metaStartFailures oscillates between
    // 0/1 and the threshold (N consecutive start failures) never trips → the host spins forever on an
    // uninitializable Meta. Clearing only on delivered makes the tally truly reflect "consecutive
    // failures to fully start Meta".
    state.metaStartFailures = 0;
    // metaInited=true is moved to after the first message is confirmed delivered (same place as
    // metaStartFailures=0). Otherwise an init failure goes through the catch path but metaInited is
    // already true → the next Meta rebuild's first message wrongly gets recovery semantics
    // (isRecovery || metaInited), treating "the first Meta start that never succeeded" as a recovery
    // restart. The catch path does not set it → preserving the fresh semantics of the first Meta start.
    state.metaInited = true;
  } catch (err) {
    // startSession already succeeded but a later step (latestReadEnvId / a non-timeout inject error)
    // threw → must closeSession this handle, otherwise the old Meta wrapper / subprocess leaks as an
    // orphan. If startSession itself failed → handle is still null, skip the close.
    if (handle !== null) {
      await meta.runtime.closeSession(handle, { reason: "host_close", forceAbort: true }).catch(() => {});
    }
    await appendSessionEnded(ctx.paths, stage, { role: "meta", sessionId, exitReason: "host_internal_error" });
    // Count toward the Meta start-failure tally; errorKind is Meta-specific (distinct from
    // Worker/Watcher/Reviewer's agent_session_start_failed). If the failure happened in the
    // recovery-summary first-message inject stage (injectAttempted) and this round has recovery-restart
    // semantics (ctx.isRecovery || metaInited, same condition as the first-message recovery semantics
    // above) → classified as meta_recovery_inject_failed (still counted as a Meta start failure);
    // otherwise (startSession / latestReadEnvId failure / fresh first inject failure) → meta_permanent_failure.
    state.metaStartFailures += 1;
    const recoveryInjectFailed = injectAttempted && (ctx.isRecovery || state.metaInited);
    const errorKind = recoveryInjectFailed
      ? HostOrchestrationErrorKind.metaRecoveryInjectFailed
      : HostOrchestrationErrorKind.metaPermanentFailure;
    await enqueueHostEvent(
      ctx.bus,
      errorKind,
      `meta ${recoveryInjectFailed ? "recovery inject" : "startSession"} failed (${state.metaStartFailures}/${META_START_FAILURE_LIMIT}): ${(err as Error).message}`,
      // finalFailure: transient was already retried with backoff and exhausted inside withSdkRetry (or it was permanent); by here it is treated as a permanent failure signal into the Meta inbox.
      { role: "meta", sessionId, failures: state.metaStartFailures, finalFailure: true },
    ).catch(() => {});
    state.metaHandle = null;
  }
}

/** Permanent Meta failure: N consecutive start failures → host forces failed (default 5). */
const META_START_FAILURE_LIMIT = 5;

/** M: M consecutive watchdog_meta_push_timeout → metaStartFailures +1 (default 3). */
const META_PUSH_TIMEOUT_STREAK_LIMIT = 3;

/**
 * Single-timeout wrapper for Meta long-session inject + await (meta_push_timeout).
 *
 * Success (truly delivered_*) → reset the push-timeout consecutive counter, return true. Timeout
 * (HostTimeoutError) → do not close Meta (only Meta can exit Meta): write events.jsonl
 * watchdog_triggered + emit host_event (eventKind=watchdog_meta_push_timeout), accumulate the streak;
 * M consecutive → metaStartFailures +1 and reset the streak (feeding the force-failed path, not an
 * independent third path); return false.
 *
 * inject ack=`rejected_busy` (normal backpressure while Meta is streaming under require_idle) →
 * neither a timeout nor an error: not counted in metaPushTimeoutStreak, no host_event surfaced
 * (avoiding misreporting normal backpressure as a watchdog failure); returns false so the caller
 * retries next tick (no markRead / no cursor advance). A non-timeout inject error is rethrown for the caller.
 */
async function metaInjectWithTimeout(
  ctx: TickContext,
  handle: SessionHandle,
  input: Parameters<AgentRuntime["inject"]>[1],
  stage: Stage,
  retryTransient = false,
): Promise<boolean> {
  const { state } = ctx;
  try {
    // first-message inject (retryTransient=true): transient jitter is absorbed inside the await via
    // withSdkRetry, not wrongly escalated to metaStartFailures (same as worker first inject /
    // startSession). Only the first message wraps retry — wake inject deliberately does not (it
    // already has cross-tick retry + push timeout streak). timeout (HostTimeoutError, not RuntimeError)
    // / permanent / cancelled are not retried by withSdkRetry and are rethrown per the original
    // semantics (permanent → count metaStartFailures; timeout → streak).
    // Handle-based operation: resolve the runtime by handle.role (a stable role→runtime mapping).
    const runtime = ctx.runtimeForRole(handle.role);
    const doInject = retryTransient
      ? (): ReturnType<AgentRuntime["inject"]> => withSdkRetry(ctx, "meta first inject", () => runtime.inject(handle, input))
      : (): ReturnType<AgentRuntime["inject"]> => runtime.inject(handle, input);
    const ack = await withTimeout(
      doInject,
      ctx.watchdogThresholds.metaPushMs,
      WatchdogKind.metaPushTimeout,
      `meta push (inject/await) exceeded ${ctx.watchdogThresholds.metaPushMs}ms`,
    );
    if (!isInjectDelivered(ack)) {
      // rejected_busy: normal Meta backpressure, retry next tick. Do not touch the streak (not a timeout failure), do not surface.
      return false;
    }
    state.metaPushTimeoutStreak = 0; // any successful delivery → reset the consecutive counter
    // A successful inject proves Meta is healthy and reachable → clear metaStartFailures so the
    // "consecutive start failures" semantics holds true: this tally is +1'd by startSession failure /
    // push timeout streak reaching the limit / wake permanent error, and any successful inject should
    // reset the consecutive count (a permanent severe error should be counted, but a successful
    // delivery breaks the consecutiveness).
    state.metaStartFailures = 0;
    return true;
  } catch (err) {
    if (!(err instanceof HostTimeoutError)) throw err; // rethrow a non-timeout inject error
    state.metaPushTimeoutStreak += 1;
    await eventsIO
      .append(ctx.paths, {
        type: "watchdog_triggered",
        stage,
        details: {
          watchdogKind: WatchdogKind.metaPushTimeout,
          subject: `meta:${handle.id}`,
          pushTimeoutStreak: state.metaPushTimeoutStreak,
        },
      })
      .catch(() => {});
    await enqueueHostEvent(
      ctx.bus,
      WatchdogKind.metaPushTimeout,
      `meta push timeout (${state.metaPushTimeoutStreak}/${META_PUSH_TIMEOUT_STREAK_LIMIT} consecutive); Meta not closed (only Meta can exit Meta).`,
      { metaSessionId: handle.id, pushTimeoutStreak: state.metaPushTimeoutStreak },
    ).catch(() => {});
    // M consecutive → count toward the start-failure tally +1 (feeding the force-failed path), and reset the streak
    if (state.metaPushTimeoutStreak >= META_PUSH_TIMEOUT_STREAK_LIMIT) {
      state.metaStartFailures += 1;
      state.metaPushTimeoutStreak = 0;
    }
    return false;
  }
}

/**
 * Safely read the current stage (fail-soft: conservatively returns running on read failure). Used
 * for the events.jsonl audit field and the stage gating of the driver progress reminder
 * (maybeRemindMetaProgress) — for the latter, fail-soft to `running` (a non-driver state) is the
 * safe direction of "conservatively skip, do not misfire".
 */
async function currentStageSafe(ctx: TickContext): Promise<Stage> {
  try {
    return (await manifestIO.load(ctx.paths)).stage;
  } catch {
    return "running";
  }
}

/**
 * Meta start-failure tally reached the cap → force the manifest to failed. Returns TickExit (exit
 * code 1) or null.
 *
 * Only return exit (GeneralError → host cleanup) when the failed transition truly succeeds. A CAS /
 * IO write failure → the manifest is still non-terminal: cannot pretend it failed and exit
 * (otherwise the host exits but the manifest stays running, and the next startup recovers into
 * running in a loop / inconsistent state). On failure → surface (host_event) + return null to
 * continue next tick; metaStartFailures is still ≥ threshold, so the next tick retries the
 * transition (succeeding once CAS/IO recovers). Infinite retry is acceptable: Meta has permanently
 * failed and the host keeps retrying the failed transition until it succeeds, with only one CAS
 * attempt per tick (not a hot-loop busy spin, throttled by tickIntervalMs).
 */
async function maybeForceFailedOnMetaFailure(ctx: TickContext, stage: Stage): Promise<TickExit | null> {
  if (ctx.state.metaStartFailures < META_START_FAILURE_LIMIT) return null;
  try {
    await manifestIO.applyStageTransition(ctx.paths, "failed", {
      lastError: {
        errorKind: HostOrchestrationErrorKind.metaStartThresholdExceeded,
        message: `meta failed to start ${ctx.state.metaStartFailures} times (limit ${META_START_FAILURE_LIMIT})`,
        at: nowIso8601Us(),
      },
      expectedFromStage: stage,
    });
  } catch (err) {
    // CAS / write failure → the manifest didn't transition to failed: surface + return null without
    // exiting (do not pretend it failed), retry the transition next tick (metaStartFailures still at
    // threshold). On a CAS conflict (the CLI already changed the stage), the next tick re-reads the new stage and routes naturally.
    await enqueueHostEvent(
      ctx.bus,
      HostOrchestrationErrorKind.metaStartThresholdExceeded,
      `meta start threshold exceeded but failed transition write failed (will retry next tick): ${(err as Error).message}`,
      { failures: ctx.state.metaStartFailures, fromStage: stage },
    ).catch(() => {});
    return null;
  }
  await renderStatusMd(ctx.paths); // re-render status.md after transitioning to failed (fail-soft)
  return { exitCode: HostExitCode.GeneralError, reason: "meta_start_threshold_exceeded" };
}

/** Keep the Watcher long session online. noop if already online. */
async function ensureWatcherOnline(ctx: TickContext): Promise<void> {
  const { state } = ctx;
  if (state.watcherHandle !== null && isSessionLive(ctx, state.watcherHandle)) return;
  // The old Watcher handle is non-live but not cleared → backfill the paired ENDED for the old session before starting a new one (same as Meta).
  if (state.watcherHandle !== null) {
    // Same as Meta — on ENDED write failure keep the handle to retry next tick, do not start a new Watcher this tick.
    const { endedWritten } = await endStaleLongSession(ctx, state.watcherHandle, "watcher", "running");
    if (!endedWritten) return;
    state.watcherHandle = null;
  }

  // Per-role resolution: the watcher role's (runtime, model, isolation).
  const watcher = ctx.resolver.resolve("watcher");
  const sessionId = generateSessionId();
  const systemPrompt = await prompts.watcherSystem({ paths: ctx.paths, watcherLang: ctx.watcherLang });
  await writeSystemPrompt(ctx.paths, sessionId, systemPrompt);
  await appendSessionStarted(ctx.paths, "running", { role: "watcher", sessionId, reason: "ensure_watcher_online" });

  try {
    const handle = await withSdkRetry(ctx, "watcher startSession", () =>
      watcher.runtime.startSession({
        role: "watcher",
        sessionId,
        cwd: ctx.cwd,
        model: watcher.model,
        ...(ctx.thinking !== undefined ? { thinking: ctx.thinking } : {}),
        systemPromptPath: ctx.paths.agentPromptPath(sessionId),
        toolNames: toolNamesFor(ctx, "watcher"),
        streamPath: ctx.paths.watcherStreamPath(sessionId),
        isolation: watcher.isolation,
        metadata: { lifecycleHint: "long" },
      }),
    );
    state.watcherHandle = handle;
    // New watcher session: reset the compact orchestration state. The old session's in-flight compact
    // task (if any) becomes a no-op via its internal handle-identity guard (no longer writes the new
    // session's state); giveup is per-session so it resets to let the new session re-trigger.
    state.watcherCompactTask = null;
    state.watcherCompactGiveup = false;
    // startup: init the wake cursor (take the Watcher inbox's latest read=true id; fresh inbox →
    // null). The Watcher has no first-message inject (the taskPart is carried inline in the
    // systemPrompt); after startup it is driven by the worker_stream_window stream + driveWatcherWake fallback wakeup.
    const latestRead = await latestReadEnvId(ctx.bus, "watcher").catch(() => null);
    state.watcherWakeCursor.initFromLatestRead(latestRead);
  } catch (err) {
    await appendSessionEnded(ctx.paths, "running", { role: "watcher", sessionId, exitReason: "host_internal_error" });
    await enqueueHostEvent(ctx.bus, HostOrchestrationErrorKind.agentSessionStartFailed, `watcher startSession failed: ${(err as Error).message}`, {
      role: "watcher",
      sessionId,
      finalFailure: true, // transient was already retried and exhausted inside withSdkRetry
    }).catch(() => {});
    state.watcherHandle = null;
  }
}

/**
 * Watcher inbox wake (structurally identical to driveMetaWake): fold unread Watcher-channel
 * envelopes (worker_stream_window / send_to_watcher etc.) → render the wake user message → inject
 * (require_idle, fire-and-ack) → markRead + advance watcherWakeCursor.
 *
 * The Watcher is a long session, inject is fire-and-ack like Meta: ack=rejected_busy (normal
 * backpressure while the Watcher is streaming) → no markRead / no cursor advance, retry next tick.
 * inject exceptions are fail-soft. The only difference from Meta: the markRead-failure host_event
 * still goes to the Meta inbox (the Watcher has no orchestration decision power). Watcher inject does
 * not count toward the Meta push timeout (it is not Meta) and uses a plain await (API-level watchdog
 * is covered by the wrapper).
 */
async function driveWatcherWake(ctx: TickContext): Promise<void> {
  const { state } = ctx;
  if (state.watcherHandle === null) return;
  if (!isSessionLive(ctx, state.watcherHandle)) return;
  // compact in progress: pause wake inject. The compact flow exclusively holds the watcher turn
  // (compact + role reinject); backlog envelopes resume on the next tick's driveWatcherWake after
  // compact completes and the task is cleared to null. The cursor does not advance.
  if (state.watcherCompactTask !== null) return;
  // busy pre-filter (structurally identical to Meta): skip this tick only while streaming (no inject,
  // no fold); allow initializing + idle. The Watcher has no explicit startup inject — its init is
  // triggered by the first wake inject — so the pre-filter must allow initializing or it deadlocks.
  // The correctness fallback is still require_idle below: a race where the pre-filter saw non-streaming
  // but it turned streaming by inject time is rejected by require_idle (rejected_busy).
  if (isSessionStreaming(ctx, state.watcherHandle)) return;

  let unread: ReadonlyArray<Envelope>;
  try {
    unread = await foldUnreadForWake(ctx.bus, "watcher", state.watcherWakeCursor);
  } catch {
    return; // fold IO failure is fail-soft
  }
  if (unread.length === 0) return;

  const message = runtimePromptRenderer.renderWakeInjectUserMessage({
    envelopes: unread,
    lang: ctx.watcherLang,
  });
  if (message.length === 0) return;

  const envIds = unread.map((e) => e.envId as EnvelopeId);
  const latestEnvId = envIds.at(-1) ?? null;
  let ack;
  try {
    ack = await ctx.runtimeForRole(state.watcherHandle.role).inject(state.watcherHandle, {
      content: [{ type: "text", text: message }],
      marker: { kind: "wake_inject", envelopeIds: envIds },
      policy: { kind: "require_idle" },
    });
  } catch (err) {
    // inject exception: non-transient (permanent SDK / protocol error) → emit a Meta host_event
    // (Watcher failure signals all go to the Meta inbox). transient (network / rate-limit) is just
    // fail-soft retry next tick, no host_event. The cursor does not advance.
    await surfaceWatcherWakeInjectError(ctx, err);
    return;
  }
  if (!isInjectDelivered(ack)) return; // rejected_busy: normal Watcher backpressure, retry next tick
  try {
    await ctx.bus.markReadBatch(envIds, `${WATCHER_READ_BY_PREFIX}${state.watcherHandle.id}`);
    state.watcherWakeCursor.onInjectAndMarkSuccess(latestEnvId, envIds);
  } catch {
    const { eventKind, newEnvIds } = state.watcherWakeCursor.onMarkReadFailure(envIds);
    if (eventKind !== null) {
      // to the Meta inbox (the Watcher's orchestration failure signals all go through Meta)
      await enqueueHostEvent(ctx.bus, eventKind, `watcher wake inject markRead failed for ${newEnvIds.length} envelope(s)`, {
        envIds: newEnvIds,
      }).catch(() => {});
    }
  }
}

/**
 * Watcher context-compact trigger check (called once per tick). When all conditions hold → spawn the
 * background compact flow (does not block the tick):
 *  1. no in-flight compact task (only one flow at a time);
 *  2. this session has not given up (retries not exhausted);
 *  3. watcher live and idle (compact only while idle, to avoid interrupting a streaming turn);
 *  4. the adapter supports both contextUsage + compact capabilities (otherwise nothing to trigger);
 *  5. contextUsage.tokens ≥ threshold.
 * The contextUsage query itself awaits (a lightweight status-level query, already idle/capability-gated);
 * query failure is fail-soft retry next tick.
 */
async function maybeStartWatcherCompact(ctx: TickContext): Promise<void> {
  const { state } = ctx;
  if (state.watcherCompactTask !== null) return;
  if (state.watcherCompactGiveup) return;
  const handle = state.watcherHandle;
  if (handle === null || !isSessionLive(ctx, handle)) return;
  if (!isSessionIdle(ctx, handle)) return;
  const runtime = ctx.runtimeForRole(handle.role); // watcher provider runtime
  if (runtime.contextUsage === undefined || runtime.compact === undefined) return;

  let usage: ContextUsage;
  try {
    usage = await runtime.contextUsage(handle);
  } catch {
    return; // query failure is fail-soft
  }
  if (usage.tokens === undefined || usage.tokens < ctx.watcherCompactThreshold) return;

  // Trigger: spawn the background flow. The flow has self-contained error handling (never rejects); finally clears it back to null (reap) while still the same session.
  const task = runWatcherCompactFlow(ctx, handle, usage).finally(() => {
    if (state.watcherHandle === handle) state.watcherCompactTask = null;
  });
  state.watcherCompactTask = task;
}

/**
 * Watcher compact background flow: for a single watcher session, run compact + role/task-anchored
 * reinject + wait for the watcher to digest that turn. Retries up to `watcherCompactRetryMax` times
 * (re-emitting triggered each time); exhausted → giveup + watcher_compact_failed event + host_event to
 * the Meta inbox. Never rejects (a background task; all errors are absorbed internally), so the caller
 * needs no await/catch.
 *
 * Summary source by mode: summary observable (compact success=true) → strict path, the summary is
 * already in the compacted context, reinject carries no hostManagedSummary. summary not observable
 * (success=false) → in lenient mode this is an acceptable terminal state, no retry; the host reads the
 * pre-compact stream JSONL to self-synthesize a summary as the hostManagedSummary for reinject; in
 * strict mode it counts as a failure and retries. A compact() call error / reinject failure / other
 * success:false counts as a retry in both modes.
 *
 * If the watcher session is swapped mid-flight (restart / teardown, state.watcherHandle rewritten),
 * this flow is "stale": after each await point and before writing any event / host_event / giveup it
 * checks `isCurrent()`, and if stale it silently abandons the whole flow (not posting triggered/
 * role_reinjected/failed events belonging to a dead session to events.jsonl / the Meta inbox, not
 * polluting the new session's state and Meta's decisions; the new session's compact is handled by its own flow).
 */
async function runWatcherCompactFlow(ctx: TickContext, handle: SessionHandle, usage: ContextUsage): Promise<void> {
  const { state } = ctx;
  const compactFlowId = randomBytes(4).toString("hex");
  const sessionId = handle.id;
  // stale check = still the current watcher handle AND still live: cleanup clears state.watcherHandle
  // before closeAndEnd(watcher), so comparing handle identity alone would misjudge current during that
  // close→null window; combined with isSessionLive, once the watcher is closing/closed (cleanup teardown
  // or the session's own death) it is stale → no more compact/reinject on a closed watcher, no writing its events / to Meta.
  const isCurrent = (): boolean => state.watcherHandle === handle && isSessionLive(ctx, handle);

  for (let attempt = 1; attempt <= ctx.watcherCompactRetryMax + 1; attempt += 1) {
    let failedStep: "compact" | "reinject" = "compact";
    try {
      if (!isCurrent()) return; // stale (watcher was swapped) → silently abandon
      await eventsIO.append(ctx.paths, {
        type: "watcher_compact_triggered",
        stage: "running",
        details: {
          sessionId,
          compactFlowId,
          attempt,
          totalTokensBefore: usage.tokens ?? null,
          messagesTokensBefore: usage.categories?.["messages"] ?? null,
          threshold: ctx.watcherCompactThreshold,
        },
      });

      // (b) compact — the compact() capability was already gated in maybeStartWatcherCompact. The
      //     summary-observable branch + dryrun mode decide how success=false is handled.
      const runtime = ctx.runtimeForRole(handle.role);
      const outcome = await runtime.compact!(handle);

      // lenient mode check: DaemonConfig.watcherCompactMode==="lenient" or the resolved watcher runtime canObserveSummary===false.
      const lenient =
        ctx.watcherCompactMode === "lenient" || runtime.capabilities.compact.canObserveSummary === false;

      // summary observable (success===true and summary non-empty): strict path, reinject carries no hostManagedSummary (summary is already in context).
      // summary not observable (success===false): lenient → acceptable terminal state, no retry, host self-synthesizes a summary as hostManagedSummary;
      //   strict → treat as failure and retry (a compact() call error / other success:false retries in both modes).
      let hostManagedSummary: string | undefined;
      let synthesizedFailed = false;
      if (!outcome.success) {
        // The lenient self-synthesized terminal state holds only for summary_unobservable (compaction
        // happened, tokens dropped, the summary is unobservable); compact_not_performed (timeout / RPC
        // reject / compaction didn't happen) retries in both lenient and strict.
        if (!lenient || outcome.failureKind !== "summary_unobservable") {
          throw new Error(outcome.errorMessage ?? "compact returned success=false");
        }
        // lenient summary_unobservable: read the pre-compact stream JSONL to self-synthesize a summary (fail-soft: synthesis failure → reinject without a summary).
        const synthesized = await synthesizeWatcherCompactSummary(
          ctx.paths.watcherStreamPath(sessionId),
          `watcher_compact ${sessionId}`,
        );
        if (synthesized !== null) hostManagedSummary = synthesized;
        else synthesizedFailed = true;
      }

      // (c) role + task-anchored reinject (require_idle) + wait for the watcher to digest that turn end. A lenient self-synthesized summary is embedded via the parameter.
      failedStep = "reinject";
      const message = await runtimePromptRenderer.renderWatcherCompactRoleReinjectMessage({
        paths: ctx.paths,
        watcherLang: ctx.watcherLang,
        ...(hostManagedSummary !== undefined ? { hostManagedSummary } : {}),
        ...(synthesizedFailed ? { summaryLost: true } : {}),
      });
      await injectAndAwaitWatcherTurn(ctx, handle, message);

      // (d) success → role_reinjected event, end the flow. If stale, abandon (do not write a success event for a dead session).
      if (!isCurrent()) return;
      // audit write is fail-soft: the business side effects (compact + reinject) already succeeded; don't let an audit-event persistence failure re-run the whole flow.
      await eventsIO
        .append(ctx.paths, {
          type: "watcher_compact_role_reinjected",
          stage: "running",
          details: { sessionId, compactFlowId, attempt },
        })
        .catch(() => {});
      return;
    } catch (err) {
      if (attempt <= ctx.watcherCompactRetryMax) continue; // retries remaining
      // exhausted: if stale, silently abandon (no giveup / no failed / no Meta — belongs to a dead session).
      if (!isCurrent()) return;
      state.watcherCompactGiveup = true;
      const errorKind =
        err instanceof RuntimeErrorImpl ? sdkErrorKindFromRuntimeError(err) : SdkErrorKind.unknown;
      await eventsIO
        .append(ctx.paths, {
          type: "watcher_compact_failed",
          stage: "running",
          details: { sessionId, compactFlowId, attempt, failedStep, errorKind },
        })
        .catch(() => {});
      await enqueueHostEvent(
        ctx.bus,
        HostEventKind.watcherCompactFailed,
        `watcher compact failed after ${attempt} attempt(s) at step ${failedStep}: ${(err as Error).message}`,
        { watcherSessionId: sessionId, compactFlowId, failedStep, finalFailure: true },
      ).catch(() => {});
      return;
    }
  }
}

/**
 * inject the compact role-reinject message and wait for the watcher to digest the turn this reinject opened.
 *
 * Key: runtime.subscribe has bounded replay — registering (possibly synchronously) replays history
 * events, including this session's prior turn's `turn_ended` (compact only triggers while idle → there
 * must have been a historical turn_ended). So we must not resolve on any `turn_ended` (a history event
 * would complete early and mistake an undelivered reinject for success). Instead correlate by turnId:
 * complete only when `turn_ended.turnId === this inject ack's turnId`. Under a synchronous turn,
 * `turn_ended` may arrive before the ack returns → cache the ended turnId seen after inject and compare
 * once the ack arrives. `session_ended` is treated as an early turn termination (resolve). inject not
 * delivered (rejected_busy/queued/exception) or exceeding sdkApiMs → reject (caller counts it as a retry).
 */
async function injectAndAwaitWatcherTurn(ctx: TickContext, handle: SessionHandle, message: string): Promise<void> {
  const runtime = ctx.runtimeForRole(handle.role); // watcher provider runtime
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let injected = false; // inject has been issued (distinguishes replay-era history events from events after this inject)
    let targetTurnId: string | null = null; // this inject ack's turnId (filled after delivered)
    const endedAfterInject = new Set<string>(); // turn_ended turnIds observed after inject (for a synchronous turn where the ack lags turn_ended)
    let sawSessionEnded = false; // session_ended observed after inject (only resolve on it after confirming delivered)
    let unsub: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      unsub?.();
      action();
    };
    // Must confirm this inject is delivered (targetTurnId settled) before resolving on turn end:
    // session_ended / turn_ended only mean "a delivered turn ended early/normally", not "the inject
    // was delivered". A session_ended before delivered does not resolve (avoiding mistaking an
    // undelivered reinject for success) — here, if the ack is not delivered / inject throws, the .then branch rejects.
    const tryComplete = (): void => {
      if (targetTurnId === null) return;
      if (sawSessionEnded || endedAfterInject.has(targetTurnId)) finish(resolve);
    };
    unsub = runtime.subscribe(handle, (e: SessionEvent) => {
      if (settled) return;
      if (!injected) return; // ignore history events synchronously replayed during subscribe
      if (e.kind === "session_ended") {
        sawSessionEnded = true;
        tryComplete();
      } else if (e.kind === "turn_ended") {
        endedAfterInject.add(e.turnId);
        tryComplete();
      }
    });
    timer = setTimeout(
      () => finish(() => reject(new Error("watcher compact role-reinject turn-end timeout"))),
      ctx.watchdogThresholds.sdkApiMs,
    );
    // unref: this timeout is only a fallback guard for the background compact flow and should not by
    // itself keep the process alive to sdkApiMs (after host exit / teardown closes the watcher, that
    // turn won't end); while the main loop is alive the process stays running anyway.
    timer.unref();
    injected = true; // replay is done (subscribe returned synchronously); subsequent events are the real events for this inject
    runtime
      .inject(handle, {
        content: [{ type: "text", text: message }],
        marker: { kind: "compact_role_reinject", envelopeIds: [] },
        policy: { kind: "require_idle" },
      })
      .then(
        (ack) => {
          // Under require_idle, delivered must be delivered_immediate (with turnId); rejected_busy / queued_* count as not delivered → reject.
          const turnId = ack.mode === "delivered_immediate" || ack.mode === "delivered_after_interrupt" ? ack.turnId : null;
          if (turnId === null) {
            finish(() => reject(new Error(`compact role-reinject not delivered as turn: ${ack.mode}`)));
            return;
          }
          targetTurnId = turnId;
          tryComplete(); // under a synchronous turn, turn_ended may have already been emitted inside inject (already in endedAfterInject)
        },
        (err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
      );
  });
}

/**
 * Worker reconcile — event-driven cross-tick lifecycle.
 *
 * Start conditions (when there is no active worker):
 *  - first start: a worker has never been started (workerSessionId still null) + not in an
 *    "awaiting Meta reaction" state (no sessionEndPending / workerCompletionPending / metaStopNoRestart
 *    / metaInterruptDefaultContinue) → the host immediately starts the first worker (no need to wait for Meta).
 *  - explicit Meta start (wantWorkerStart): starts the next tick after Meta calls sh_agent__start_worker.
 * After a worker exits, the host does not self-restart for continuation; it awaits Meta arbitration.
 *
 * inject is fire-and-ack: with a real adapter the worker turn runs asynchronously and ends naturally
 * via declare_done etc., so the worker lifecycle spans ticks — after starting a worker the subscribe
 * listener sets the turn-ended flag on turn_ended/session_ended, and a later tick's monitor finalizes
 * on detecting the end. Under a stub synchronous turn it finalizes the same tick it starts (events already emitted inside inject).
 */
/**
 * Post-worker-exit continuation state machine, run each tick before reconcileWorker (meaningful only
 * when there is no active worker). Handles all "awaiting Meta reaction" states uniformly
 * (workerCompletionPending / sessionEndPending / metaStopNoRestart / metaInterruptDefaultContinue):
 *
 *  1. inbox gate (applies to all awaiting-Meta-reaction states): a read=false envelope appears on the
 *     worker channel (Meta called sh_msg__send_to_worker → meta_instruction into the worker inbox) →
 *     uniformly clear the four await flags + clear reminder seq + set wantWorkerStart (start a new
 *     worker to continue). This covers metaStopNoRestart (send_to_worker clears that flag) +
 *     meta_interrupt + the active-exit class (WCP send_to_worker).
 *  2. meta_interrupt default-continue (passive class): metaInterruptDefaultContinue and no
 *     worker-channel unread (gate not hit) and Meta idle (finished reacting this turn, no explicit
 *     stop action) → the host starts a new worker by default.
 *  3. active-exit reminder: workerCompletionPending and Meta idle and pending persisting → post an
 *     incrementing reminder at a one-to-one cadence (reminderSeq++), no cap (force-failed is the fallback).
 *
 * Meta idle→streaming resets metaReminderPostedForCurrentIdle, ensuring at most one reminder per Meta
 * idle turn. Meta dispatch tools (start_worker / stop_worker / advance) have their handlers clear the
 * relevant flag directly, so seeing the corresponding flag=false here means nothing to do.
 */
async function reconcileWorkerCompletionPending(ctx: TickContext): Promise<void> {
  const { state } = ctx;
  const o = state.orchestration;
  // The awaiting-Meta state set (the inbox-gate-effective set): includes the abnormal start/inject
  // failure waiting state workerStartFailedPending — otherwise, after a startWorker / first-message
  // inject failure, Meta calling send_to_worker into the worker channel wouldn't run the gate → stall
  // (violating "send_to_worker continues all awaiting-Meta states").
  const inAwaitMetaState =
    o.workerCompletionPending ||
    o.sessionEndPending ||
    o.metaStopNoRestart ||
    o.metaInterruptDefaultContinue ||
    state.workerStartFailedPending;
  if (!inAwaitMetaState) {
    state.metaReminderPostedForCurrentIdle = false;
    return;
  }
  // 1. inbox gate (applies to all awaiting-Meta-reaction states): a read=false meta_instruction
  // envelope appears on the worker channel → Meta actively dispatched via sh_msg__send_to_worker →
  // uniformly clear the four await flags + reminder seq + set wantWorkerStart (start a new worker to continue).
  // Only meta_instruction triggers the gate, not meta_interrupt: interrupt_worker already enqueued the
  // meta_interrupt envelope to the worker channel (for the interrupted worker's next continuation worker
  // to read) before soft-kill — it accompanies the worker being killed and is not itself a "Meta decided
  // to start a new worker" signal; its continuation is driven by metaInterruptDefaultContinue
  // (default-continue, awaiting Meta idle silence), and the new worker reads that meta_interrupt itself.
  // If meta_interrupt were treated as a gate trigger → the next tick after interrupt would restart
  // immediately, bypassing default-continue's "awaiting Meta reaction window".
  let instructionEnvIds: ReadonlyArray<string> = [];
  try {
    const unread = await ctx.bus.peekUnread("worker");
    instructionEnvIds = unread.filter((e) => e.kind === "meta_instruction").map((e) => e.envId);
  } catch {
    instructionEnvIds = [];
  }
  // The workerStartFailedPending state filters by baseline — only a meta_instruction beyond the
  // baseline (Meta newly calling send_to_worker after entering the failure state) counts as a gate
  // trigger. An old unread meta_instruction already present on entering the failure state does not
  // repeatedly trigger (consumed by the worker pull, not markRead by the host), eliminating the
  // hot-loop under persistent start/inject failure. Other awaiting-Meta states have no baseline (null)
  // → any unread meta_instruction triggers (original semantics, they do not repeatedly re-enter the failure state).
  const baseline = state.workerStartFailedPending ? state.workerStartFailedBaselineEnvIds : null;
  const triggeringInstruction =
    baseline === null ? instructionEnvIds.length > 0 : instructionEnvIds.some((id) => !baseline.has(id));
  if (triggeringInstruction) {
    o.workerCompletionPending = false;
    o.sessionEndPending = false;
    o.metaStopNoRestart = false;
    o.metaInterruptDefaultContinue = false;
    o.workerCompletionReminderSeq = 0;
    state.workerStartFailedPending = false; // send_to_worker continuation also clears the start/inject failure waiting state
    state.workerStartFailedBaselineEnvIds = null; // leaving the failure state → clear baseline
    state.metaReminderPostedForCurrentIdle = false;
    state.wantWorkerStart = true; // inbox gate: start a new worker to continue (the send_to_worker row)
    return;
  }
  // 2. meta_interrupt default-continue (passive class): Meta silent (no worker-channel unread) + Meta
  // idle (reacted this turn, no explicit stop) → the host starts a new worker by default. stop_worker(false)
  // uses metaStopNoRestart (default not-continue) — the two are mutually exclusive, different flags.
  if (o.metaInterruptDefaultContinue) {
    const metaIdleForContinue = state.metaHandle !== null && isSessionIdle(ctx, state.metaHandle);
    if (metaIdleForContinue) {
      o.metaInterruptDefaultContinue = false;
      state.metaReminderPostedForCurrentIdle = false;
      state.wantWorkerStart = true; // default continue
    }
    return;
  }
  // metaStopNoRestart / sessionEndPending (non-active-exit class): inbox gate not hit → keep waiting (no reminder, no new worker).
  if (!o.workerCompletionPending) return;
  // 3. active-exit reminder: Meta idle and pending persisting → post an incrementing reminder at a one-to-one cadence. Meta streaming (non-idle) → reset.
  const metaIdle = state.metaHandle !== null && isSessionIdle(ctx, state.metaHandle);
  if (!metaIdle) {
    state.metaReminderPostedForCurrentIdle = false;
    return;
  }
  if (state.metaReminderPostedForCurrentIdle) return; // already posted this idle (one-to-one cadence)
  if (
    o.lastWorkerSessionEndEnvId === null ||
    o.lastWorkerSessionId === null ||
    o.lastWorkerSessionSeq === null ||
    o.lastWorkerExitReason === null
  ) {
    return;
  }
  // Only on a successful enqueue increment seq + set the posted flag; on failure keep the retryable
  // state (do not set the flag → retry next idle tick) + surface (avoiding mistaking a failed enqueue
  // as already posted, permanently stalling the reminder chain). Post with a candidate seq, then commit into state on success.
  const candidateSeq = o.workerCompletionReminderSeq + 1;
  try {
    await enqueueWorkerCompletionReminder(ctx.bus, {
      workerSessionId: o.lastWorkerSessionId,
      sessionSeq: o.lastWorkerSessionSeq,
      exitReason: o.lastWorkerExitReason,
      workerSessionEndEnvId: o.lastWorkerSessionEndEnvId as EnvelopeId,
      relatedWorkerSignalEnvId: null,
      reminderSeq: candidateSeq,
    });
    o.workerCompletionReminderSeq = candidateSeq;
    state.metaReminderPostedForCurrentIdle = true;
  } catch (err) {
    // Do not increment seq / set the posted flag (keep retryable). surface: a bus enqueue failure
    // means we can't post a host_event into the Meta inbox either, so fall back to log. The next Meta
    // idle tick retries the same candidateSeq (cadence does not advance), so it won't stall permanently.
    console.warn(
      `[daemon] WCP reminder enqueue failed (seq ${candidateSeq}, will retry next idle tick): ${(err as Error).message}`,
    );
  }
}

/**
 * On entering the workerStartFailedPending state, snapshot all current read=false meta_instruction
 * envIds in the worker inbox as the inbox-gate baseline. reconcileWorkerCompletionPending's gate only
 * recognizes meta_instructions beyond the baseline as a "Meta explicit send_to_worker continuation"
 * signal, avoiding an old unread instruction repeatedly triggering a gate hot-loop under persistent
 * start/inject failure. A peek failure is fail-soft to the empty set (conservative: if the
 * instruction is still there next tick it is treated as new → triggers one gate retry, not a permanent stall, but rare).
 */
async function captureWorkerStartFailedBaseline(ctx: TickContext): Promise<void> {
  let envIds: string[] = [];
  try {
    const unread = await ctx.bus.peekUnread("worker");
    envIds = unread.filter((e) => e.kind === "meta_instruction").map((e) => e.envId);
  } catch {
    envIds = [];
  }
  ctx.state.workerStartFailedPending = true;
  ctx.state.workerStartFailedBaselineEnvIds = new Set(envIds);
}

async function reconcileWorker(ctx: TickContext): Promise<void> {
  const { state } = ctx;
  if (state.workerHandle === null) {
    const o = state.orchestration;
    const inAwaitMetaState =
      o.sessionEndPending || o.workerCompletionPending || o.metaStopNoRestart || o.metaInterruptDefaultContinue;
    // first start: a worker was never started (workerSessionId still null) + not in an "awaiting Meta
    // reaction" state + not in the start-failure waiting state. While workerStartFailedPending, only an
    // explicit Meta start_worker (wantWorkerStart) can continue — so firstStart excludes that flag.
    const firstStart = state.workerSessionId === null && !inAwaitMetaState && !state.workerStartFailedPending;
    if (!state.wantWorkerStart && !firstStart) return;
    const started = await startWorker(ctx);
    if (started) {
      state.wantWorkerStart = false;
      state.workerStartFailedPending = false; // successful start → clear the start-failure waiting state
      state.workerStartFailedBaselineEnvIds = null; // leaving the failure state → clear baseline
      // A new worker started successfully → all "awaiting Meta reaction" states have been consumed by
      // this continuation; uniformly clear all 4 await flags for self-consistent state semantics (each
      // dispatch path usually already cleared the relevant flag; this is a symmetric residual-clear fallback) + clear reminderSeq.
      state.orchestration.sessionEndPending = false;
      state.orchestration.metaInterruptDefaultContinue = false;
      state.orchestration.workerCompletionPending = false;
      state.orchestration.metaStopNoRestart = false;
      state.orchestration.workerCompletionReminderSeq = 0;
    } else {
      // startWorker failed (sessionSeq allocation / startSession failure, host-orchestration-layer
      // abnormal path) → do not self-retry (avoiding a per-tick firstStart / wantWorkerStart hot-loop
      // under persistent config / runtime failure). Clear wantWorkerStart + enter
      // workerStartFailedPending awaiting an explicit Meta start_worker (startWorker already surfaced
      // host_event(agent_session_start_failed) to inform Meta; the host does not self-restart, Meta decides).
      state.wantWorkerStart = false;
      await captureWorkerStartFailedBaseline(ctx); // set pending + snapshot the inbox-gate baseline (avoid an old unread instruction hot-loop)
      return;
    }
  }
  // active worker running → monitor turn end (under a stub synchronous turn it already ended → finalize same tick; a real adapter waits later ticks)
  await monitorActiveWorker(ctx);
}

/**
 * Start a worker session: allocate sessionSeq → assemble prompt → STARTED → startSession → cross-tick
 * subscribe (accumulate tool history + set the turn-ended flag on turn_ended/session_ended) → inject
 * the first message (fire-and-ack). Returns true on success; on startSession failure
 * (host_internal_error) the host_event + ENDED were already posted and returns false.
 */
async function startWorker(ctx: TickContext): Promise<boolean> {
  const { state } = ctx;
  // sessionSeq allocation (before STARTED). On failure do not silently reset to 1 (it would cause seq
  // conflicts / stream-path conflicts / STARTED-ENDED pairing mix-ups) → surface a host_event
  // (host_internal) + abandon this start, retry next tick.
  let sessionSeq: number;
  try {
    sessionSeq = await allocateWorkerSessionSeq(ctx.paths);
  } catch (err) {
    await enqueueHostEvent(
      ctx.bus,
      HostOrchestrationErrorKind.agentSessionStartFailed,
      `worker sessionSeq allocation failed (start aborted, awaiting Meta explicit start_worker/send_to_worker): ${(err as Error).message}`,
      { role: "worker" },
    ).catch(() => {});
    return false; // abandon this start (no STARTED written → no paired ENDED needed); reconcileWorker clears wantWorkerStart and enters workerStartFailedPending, awaiting an explicit Meta continuation (no auto retry)
  }
  const sessionId = generateSessionId();
  state.workerSeqBySession.set(sessionId, sessionSeq);

  // Per-role resolution: the worker role's (runtime, model, isolation).
  const worker = ctx.resolver.resolve("worker");
  const workerLang = ctx.metaLang ?? "en"; // worker deliverable language follows the task (metaLang), not the internal watcherLang
  const systemPrompt = await prompts.workerSystem({ paths: ctx.paths, workerLang });
  const firstMessage = await firstUserMessageAssembler.assembleWorkerFirstUserMessage({
    sessionSeq,
    prevSessionId: state.workerSessionId,
    workerLang,
  });
  await writeSystemPrompt(ctx.paths, sessionId, systemPrompt);
  await writeFirstMessage(ctx.paths, sessionId, firstMessage);
  await appendSessionStarted(ctx.paths, "running", { role: "worker", sessionId, sessionSeq, reason: "meta_requested_start" });

  const history = new SessionToolHistory();
  let handle: SessionHandle;
  try {
    handle = await withSdkRetry(ctx, "worker startSession", () =>
      worker.runtime.startSession({
        role: "worker",
        sessionId,
        cwd: ctx.cwd,
        model: worker.model,
        ...(ctx.thinking !== undefined ? { thinking: ctx.thinking } : {}),
        systemPromptPath: ctx.paths.agentPromptPath(sessionId),
        firstMessagePath: ctx.paths.agentFirstMsgPath(sessionId),
        toolNames: toolNamesFor(ctx, "worker"),
        streamPath: ctx.paths.workerStreamPath(sessionSeq, sessionId),
        isolation: worker.isolation,
        metadata: { lifecycleHint: "short" },
      }),
    );
  } catch (err) {
    // worker STARTED is already written → the paired ENDED uses an idempotent append (surface on
    // write failure / scanOk=false), avoiding a STARTED with no ENDED after that ENDED write fails →
    // recovery misjudging a crash and synthesizing sdk_crash.
    const endedRes = await appendWorkerEndedIdempotent(ctx.paths, {
      stage: "running",
      sessionId,
      sessionSeq,
      exitReason: "host_internal_error",
    }).catch(() => ({ appended: false, scanOk: false }));
    if (!endedRes.scanOk) {
      await enqueueHostEvent(ctx.bus, HostOrchestrationErrorKind.agentSessionStartFailed, `worker startSession-fail paired ENDED write failed (seq ${sessionSeq})`, {
        role: "worker",
        sessionId,
        sessionSeq,
      }).catch(() => {});
    }
    await enqueueHostEvent(ctx.bus, HostOrchestrationErrorKind.agentSessionStartFailed, `worker startSession failed: ${(err as Error).message}`, {
      role: "worker",
      sessionId,
      sessionSeq,
      finalFailure: true, // transient was already retried and exhausted inside withSdkRetry, consistent with the meta/watcher start-failure signals
    }).catch(() => {});
    return false;
  }
  state.workerHandle = handle;
  state.workerSessionId = sessionId;
  state.workerSessionSeq = sessionSeq;
  state.workerToolHistory = history;
  state.workerTurnEnded = false;
  state.workerInjectFailed = false;
  state.workerEndedWritten = false; // the new worker session's paired ENDED is not yet written
  // watchdog state: lastToolUseAt starts = the session start time (on the injected clock).
  state.workerWatchdog = { lastToolUseAt: ctx.now(), recentSignatures: [] };
  ctx.windowDispatcher.onWorkerSessionStarted({ workerSessionId: sessionId, workerSessionSeq: sessionSeq });

  // Cross-tick subscription:
  //  - tool_invoked → watchdog state (lastToolUseAt + signature, activity/loop check regardless of success) + stash (toolName,input) pending result adjudication
  //  - tool_result_recorded(isError=false) → commit the host tool call into exit-intent history (only
  //    a successful declare_done / escalate derives an exit intent; a failed handler does not — avoiding
  //    a failed declare_done wrongly deriving an exit + misreporting successful completion)
  //  - turn_ended/session_ended → turn-ended flag
  const pendingInvokes = new Map<string, { toolName: string; input: unknown; invokedAt: number; isHostTool: boolean }>();
  state.workerUnsub = worker.runtime.subscribe(handle, (e: SessionEvent) => {
    // watchdog cross-tick state: tool_invoked + subagent lifecycle are both reflected via
    // recordWorkerActivity (capped signature / refresh idle timer; subagent activity counts as worker
    // progress but does not record a tool_loop signature). Keep a signature window slightly larger than the threshold to avoid unbounded growth.
    const wdCap = ctx.watchdogThresholds.workerToolLoopCount + 4;
    if (e.kind === "tool_invoked") {
      pendingInvokes.set(e.toolUseId, { toolName: e.toolName, input: e.input, invokedAt: e.invokedAt, isHostTool: e.isHostTool });
      if (state.workerWatchdog !== null) recordWorkerActivity(state.workerWatchdog, e, ctx.now(), wdCap);
    } else if (e.kind === "tool_result_recorded") {
      const inv = pendingInvokes.get(e.toolUseId);
      pendingInvokes.delete(e.toolUseId);
      // A subagent-internal host tool (non-empty parentToolUseId, inlined into the main stream) does
      // not derive a worker exit intent: it is subagent behavior and does not represent the Worker
      // itself declaring declare_done/deferred (symmetric with watchdog not recording the signature).
      // Otherwise a subagent calling sh_msg__declare_done_to_meta internally would make the Worker
      // wrongly judged as autonomously complete and close out early, breaking long-task delivery.
      if (inv !== undefined && inv.isHostTool && !e.result.isError && e.parentToolUseId === undefined) {
        history.recordRaw(inv.toolName, inv.input, inv.invokedAt);
      }
    } else if (e.kind === "subagent_started" || e.kind === "subagent_progress" || e.kind === "subagent_stopped") {
      if (state.workerWatchdog !== null) recordWorkerActivity(state.workerWatchdog, e, ctx.now(), wdCap);
    } else if (e.kind === "turn_ended" || e.kind === "session_ended") {
      state.workerTurnEnded = true;
    }
  });

  // first-message inject (fire-and-ack): a thrown exception or ack=rejected_busy → the worker did
  // nothing. Mark workerInjectFailed (finalize derives host_internal_error, not misreporting
  // natural_completion) + surface a workerInjectFailed host_event. Mark turn ended so the next monitor finalizes.
  let injectFailureMsg: string | null = null;
  try {
    // The worker first inject is a one-shot await (no cross-tick retry; failure means the worker did
    // nothing) → wrap with transient retry to absorb transient jitter, avoiding misjudging
    // host_internal_error. rejected_busy is a return value (not thrown), so retry does not loop (a fresh worker should be idle).
    const ack = await withSdkRetry(ctx, "worker first inject", () => worker.runtime.inject(handle, firstMessageInject(ctx.paths, sessionId)));
    if (!isInjectDelivered(ack)) {
      injectFailureMsg = `inject rejected: ${ack.mode === "rejected_busy" ? ack.reason : ack.mode}`;
    }
  } catch (err) {
    injectFailureMsg = `inject threw: ${(err as Error).message}`;
  }
  if (injectFailureMsg !== null) {
    state.workerInjectFailed = true;
    state.workerTurnEnded = true;
    await enqueueHostEvent(
      ctx.bus,
      AgentBehaviorErrorKind.workerInjectFailed,
      `worker session ${sessionId} (seq ${sessionSeq}) first message inject failed: ${injectFailureMsg}`,
      { workerSessionId: sessionId, sessionSeq },
    ).catch(() => {});
  }
  return true;
}

/**
 * Monitor the active worker:
 *  - first run the Worker session watchdog (no_progress + tool_loop): trip → the unified action
 *    (forceAbort close + derive watchdog_* exitReason) via finalizeWorker.
 *  - otherwise the turn is still running (live and no end observed) → wait for the next tick; ended /
 *    non-live → finalizeWorker (normal derivation).
 */
async function monitorActiveWorker(ctx: TickContext): Promise<void> {
  const { state } = ctx;
  if (state.workerHandle === null) return;

  // watchdog check (meaningful only while the turn is still running; an ended turn goes to normal finalize)
  if (!state.workerTurnEnded && isSessionLive(ctx, state.workerHandle) && state.workerWatchdog !== null) {
    const wdState: WorkerWatchdogState = {
      lastToolUseAt: state.workerWatchdog.lastToolUseAt,
      recentSignatures: state.workerWatchdog.recentSignatures,
    };
    const trigger = checkWorkerWatchdog(wdState, ctx.now(), ctx.watchdogThresholds);
    if (trigger !== null) {
      await finalizeWorker(ctx, trigger);
      return;
    }
  }

  if (isSessionLive(ctx, state.workerHandle) && !state.workerTurnEnded) return;
  await finalizeWorker(ctx);
}

/**
 * worker turn end → close out the session: unsubscribe → closeSession → derive exitReason → enqueue
 * worker_session_end + the first reminder (active-exit class) → ENDED → clear active state. Keep
 * workerSessionId/Seq as the "last worker" (firstStart gating + the next worker's prevSessionId depend on it).
 *
 * `wdTrigger` non-null = a Worker session watchdog tripped (the unified action): forceAbort close +
 * exitReason derived as watchdog_* (not put into closeSession.reason) + additionally write
 * watchdog_triggered (events.jsonl) + host_event (extras.eventKind=WatchdogKind). Other paths use a
 * natural close + derivation (tool history last-wins / SessionEndReason).
 */
async function finalizeWorker(ctx: TickContext, wdTrigger: WorkerWatchdogTrigger | null = null): Promise<void> {
  const { state } = ctx;
  // Unified closeout mutex (finalizeWorker loser): if stopWorker / cleanupAndExit / a prior finalize
  // is already the in-flight closeout owner (workerFinalizing set) → return immediately (pure noop, no
  // close / no ENDED write / no flag transition), avoiding a second closeout.
  if (state.workerFinalizing) return;
  const handle = state.workerHandle;
  const sessionId = state.workerSessionId;
  const sessionSeq = state.workerSessionSeq;
  const history = state.workerToolHistory;
  const injectFailed = state.workerInjectFailed;
  if (handle === null || sessionId === null || sessionSeq === null || history === null) {
    // Inconsistency defense: clear residual state (unsubscribe + reset), do not write ENDED.
    state.workerUnsub?.();
    state.workerUnsub = null;
    state.workerHandle = null;
    state.workerToolHistory = null;
    state.workerTurnEnded = false;
    state.workerWatchdog = null;
    state.workerInjectFailed = false;
    return;
  }
  state.workerFinalizing = true;
  // Capture the closeout owner epoch. The close await may cross cleanup's 10s timeout-takeover bound →
  // cleanup bumps the epoch and backfills the host_shutdown ENDED; this owner, completing late,
  // compares the epoch and abandons its writes on mismatch (avoiding duplicate ENDED / worker_session_end).
  const myEpoch = state.workerFinalizeEpoch;
  try {
    // Clear active state + write ENDED only on a successful close; on close failure → the worker may
    // still be running → keep the handle (do not clear active state, do not write an "ended" ENDED),
    // surface a host_event + enter a retryable state: the next tick's monitorActiveWorker sees a
    // non-live handle and finalizes again to retry, with cleanupAndExit's forceAbort + paired ENDED
    // backfill as the fallback. The watchdog forceAbort close path is handled the same way.
    let endReasonRaw: ReturnType<typeof mapSessionEndReason> | null = null;
    let closeFailed = false;
    try {
      const closeRes =
        wdTrigger !== null
          ? await ctx.runtimeForRole(handle.role).closeSession(handle, { forceAbort: true, reason: "host_close" })
          : await ctx.runtimeForRole(handle.role).closeSession(handle, { reason: "session_natural_end" });
      endReasonRaw = mapSessionEndReason(closeRes.reason);
    } catch (err) {
      closeFailed = true;
      // worker physical close failed: keep the handle (do not clear active state) + surface + do not write ENDED (avoiding audit falsely claiming ended).
      await enqueueHostEvent(
        ctx.bus,
        HostOrchestrationErrorKind.agentSessionStartFailed,
        `worker session ${sessionId} (seq ${sessionSeq}) close failed (may still be running, will retry): ${(err as Error).message}`,
        { workerSessionId: sessionId, sessionSeq, closeFailed: true },
      ).catch(() => {});
    }
    if (closeFailed) return; // keep handle / do not clear state / do not write ENDED (finally resets the in-flight guard)

    // Compare the epoch after the close completes — if cleanup took over during the close await (bumped
    // the epoch) → cleanup already forceAbort-closed (idempotent) + wrote the host_shutdown ENDED +
    // cleared the handle. This owner abandons all writes (worker_session_end / ENDED / flag transition)
    // to avoid duplicate ENDED; does not clear the handle (cleanup already did). finally resets the
    // in-flight guard (cleanup already reset to its own takeover state, and this release has no side
    // effect on cleanup's path: cleanup no longer reads workerFinalizing for decisions, and cleanedUp is idempotent).
    if (state.workerFinalizeEpoch !== myEpoch) return;

    // close succeeded → unsubscribe + clear the active worker handle state (keep workerSessionId/Seq as the "last worker").
    state.workerUnsub?.();
    state.workerUnsub = null;
    state.workerHandle = null;
    state.workerToolHistory = null;
    state.workerTurnEnded = false;
    state.workerWatchdog = null;
    state.workerInjectFailed = false;
    // exitReason priority:
    //  - injectFailed (first message never delivered, worker did nothing) → host_internal_error (do
    //    not enqueue worker_session_end, avoiding misreporting "did nothing" as natural_completion;
    //    the host_event(worker_inject_failed) was already surfaced in startWorker)
    //  - watchdog tripped → the derived watchdog_* (only Worker watchdog labels enter exitReason)
    //  - otherwise tool-history last-wins (a successful declare_done / declare_deferred), then SessionEndReason mapping
    const exitReason: WorkerExitReason = injectFailed
      ? "host_internal_error"
      : wdTrigger !== null
        ? wdTrigger.kind
        : history.exitIntent() ?? endReasonRaw ?? "natural_completion";

    if (wdTrigger !== null) {
      // events.jsonl watchdog_triggered + host_event (extras.eventKind=WatchdogKind).
      await eventsIO
        .append(ctx.paths, {
          type: "watchdog_triggered",
          stage: "running",
          details: {
            watchdogKind: wdTrigger.kind,
            subject: `worker:${sessionId}`,
            sessionSeq,
            ...(wdTrigger.kind === WatchdogKind.workerNoProgress
              ? { idleMs: wdTrigger.idleMs }
              : { signature: wdTrigger.signature, count: wdTrigger.count }),
          },
        })
        .catch(() => {});
      await enqueueHostEvent(
        ctx.bus,
        wdTrigger.kind,
        `worker session ${sessionId} (seq ${sessionSeq}) closed by watchdog: ${wdTrigger.kind}`,
        { workerSessionId: sessionId, sessionSeq },
      ).catch(() => {});
    }

    // host_internal_error / host_shutdown do not enqueue worker_session_end; others enqueue + reminder
    if (exitReason !== "host_internal_error" && exitReason !== "host_shutdown") {
      const enqueuable = exitReason as EnqueuableWorkerExitReason;
      // Before enqueuing worker_session_end, run done_criteria evaluate once (the only canonical
      // outcome-production path), stash the outcome into extras + append a summary to body. fail-soft:
      // evaluate already catches-all into an overall=error object (non-null), never throws; does not block finalize.
      // done_criteria.yaml is at the workspace root (under harness/), so must pass paths.workspace —
      // ctx.cwd is the session cwd (sessionCwd ?? workspace), which when sessionCwd is configured ≠
      // workspace, and passing ctx.cwd would resolve done_criteria in the wrong place.
      // Pass taskId to inject the script check's TASK_ID env var. The registry tracks in-flight script
      // subprocesses, hung on state so cleanupAndExit (host exit / cancel) can terminateAll immediately, otherwise the await hangs to the script's own timeout.
      const evalRegistry = new ScriptProcessRegistry();
      state.activeEvaluateRegistry = evalRegistry;
      const outcome = await evaluateOutcome(ctx.paths.workspace, {
        taskId: ctx.paths.taskId,
        registry: evalRegistry,
      }).catch(() => null);
      state.activeEvaluateRegistry = null;
      // Recheck the epoch before each durable write — the evaluateOutcome await may cross cleanup's
      // timeout-takeover bound (bumped epoch). A mismatch means cleanup took over (it backfills the
      // host_shutdown ENDED) → abandon worker_session_end + ENDED + flag transition, avoiding duplication.
      if (state.workerFinalizeEpoch !== myEpoch) return;
      const outcomeSummary =
        outcome !== null ? `\n\n## doneCriteria outcome: ${outcome.overall}\n${renderOutcomeSummary(outcome)}` : "";
      let endEnvId: EnvelopeId | null = null;
      try {
        endEnvId = await enqueueWorkerSessionEnd(ctx.bus, {
          workerSessionId: sessionId,
          sessionSeq,
          exitReason: enqueuable,
          doneCriteriaOutcome: outcome as Readonly<Record<string, unknown>> | null,
          body: `worker session ${sessionId} (seq ${sessionSeq}) exited: ${exitReason}${outcomeSummary}`,
        });
      } catch (err) {
        // worker_session_end is the only canonical signal of a worker exit to Meta; an enqueue failure
        // → a deadlock window with a live Meta. Cannot silently swallow: explicit log. The fallback
        // relies on the ENDED already written to events.jsonl + recovery's repairHalfCompletedWorker
        // synthesizing worker_session_end on the next host restart.
        endEnvId = null;
        console.warn(
          `[daemon] worker_session_end enqueue failed for session ${sessionId} (seq ${sessionSeq}); ` +
            `relying on events.jsonl ENDED + restart recovery: ${(err as Error).message}`,
        );
      }
      // Active-exit class (natural / declare / watchdog) → workerCompletionPending + post the first
      // reminder. Passive crash (sdk_crash / subprocess_crash) does not enter reminder: worker_session_end
      // is already in the Meta inbox, and driveMetaWake's fallback wakeup (guaranteed delivery) ensures
      // Meta sees that abnormal event and reacts next turn; the "Meta sees but ignores" black hole is
      // backed by the force-failed path (watchdog_meta_push_timeout accumulation). reminder is dedicated
      // to "prompting Meta to decide continuation" for the active-exit class (abnormal exits are
      // unexpected events Meta must handle, needing no extra prompting cadence).
      // reminder epoch fence: recheck the owner epoch before active-exit WCP state changes + the first
      // reminder enqueue (the enqueueWorkerSessionEnd await may cross cleanup's takeover bound bumping
      // the epoch). If the epoch is invalid (taken over by cleanup, the worker already closed out by
      // host_shutdown) → do not set WCP / do not post a continuation reminder (reminder is not
      // idempotent, avoiding a meaningless continuation prompt for a worker closed with the host +
      // residual WCP in-memory state). The worker_session_end envelope already enqueued is harmless
      // (Meta restart recovery restores WCP via synthesizedWorkerEnd); here we only guard the
      // non-idempotent reminder + in-memory state.
      if (state.workerFinalizeEpoch !== myEpoch) return;
      if (isActiveExit(exitReason) && endEnvId !== null) {
        state.orchestration.workerCompletionPending = true;
        // Reset reminderSeq on entering a new WCP round — otherwise if the first reminder enqueue fails
        // (seq=1 not committed), the next idle tick's reconcileWorkerCompletionPending candidateSeq =
        // workerCompletionReminderSeq+1 would carry over the prior round's residual seq, misnumbering
        // this round's first reminder (should be 1). reminderSeq=0 → candidate always starts at 1.
        state.orchestration.workerCompletionReminderSeq = 0;
        state.orchestration.lastWorkerSessionEndEnvId = endEnvId;
        state.orchestration.lastWorkerSessionId = sessionId;
        state.orchestration.lastWorkerSessionSeq = sessionSeq;
        state.orchestration.lastWorkerExitReason = exitReason;
        // The first reminder uses a candidate seq, committing seq=1 + posted=true only on a successful
        // enqueue (consistent with subsequent reminders): on failure keep reminderSeq=0 + do not set
        // posted → the next Meta idle tick retries candidate seq=1 via reconcileWorkerCompletionPending,
        // so a first-reminder failure won't permanently stall the reminder chain.
        try {
          await enqueueWorkerCompletionReminder(ctx.bus, {
            workerSessionId: sessionId,
            sessionSeq,
            exitReason,
            workerSessionEndEnvId: endEnvId,
            relatedWorkerSignalEnvId: null,
            reminderSeq: 1,
          });
          // The enqueue await may cross cleanup's takeover bound (bumped epoch) → recheck before
          // committing in-memory state, and if invalid do not commit (the worker was closed out by
          // host_shutdown, the old owner should not commit reminder in-memory state).
          if (state.workerFinalizeEpoch !== myEpoch) return;
          state.orchestration.workerCompletionReminderSeq = 1;
          state.metaReminderPostedForCurrentIdle = true; // first one posted (avoid posting a 2nd in the same idle)
        } catch (err) {
          // Keep reminderSeq=0 / do not set posted (retryable) + warn (a bus enqueue failure means we can't post a host_event into the Meta inbox).
          console.warn(
            `[daemon] first WCP reminder enqueue failed (seq 1, will retry next idle tick): ${(err as Error).message}`,
          );
        }
      } else if (endEnvId !== null) {
        // Passive crash (sdk_crash / subprocess_crash): worker_session_end is already in the Meta inbox,
        // the host enters the sessionEndPending "awaiting Meta reaction" state — making the inbox gate
        // apply to it (Meta calling send_to_worker → start a new worker to continue). Does not enter
        // reminder (abnormal exits are unexpected events Meta must handle, woken by driveMetaWake; the
        // "sees but ignores" black hole is backed by the force-failed path). The host does not
        // self-restart (no default-continue on silence, only awaiting explicit Meta dispatch, consistent with abnormal exits).
        state.orchestration.sessionEndPending = true;
      }
    }
    // The host_internal_error derived from a first-message inject failure (worker did nothing, no
    // worker_session_end) → enter the workerStartFailedPending awaiting-Meta state (unified with the
    // startWorker startSession-failure path). Otherwise after this worker closes out there is no await
    // flag: reconcileWorker firstStart no longer triggers (workerSessionId already non-null), the gate
    // doesn't run → Meta calling send_to_worker stalls (this eliminates the "send_to_worker stall after
    // start/inject failure" class). Abnormal exits don't self-restart on silence, continuing only on an explicit send_to_worker / start_worker.
    if (injectFailed) {
      await captureWorkerStartFailedBaseline(ctx); // set pending + snapshot the inbox-gate baseline
    }
    // The worker paired ENDED uses an idempotent compare-and-append (scan+append under the lock,
    // physically exactly one). The epoch fence is retained as semantic protection: recheck the epoch
    // before writing, and a mismatch means cleanup took over (it backfills the host_shutdown ENDED) →
    // abandon this write. workerEndedWritten is set true only after the ENDED is durable (appended or
    // already exists, scanOk); scanOk=false (scan corrupt, not written) → do not set true + surface,
    // leaving cleanup / recovery's idempotent backfill as the fallback.
    if (state.workerFinalizeEpoch !== myEpoch) return;
    const endedRes = await appendWorkerEndedIdempotent(ctx.paths, { stage: "running", sessionId, sessionSeq, exitReason });
    if (endedRes.scanOk) {
      state.workerEndedWritten = true;
    } else {
      console.warn(`[daemon] worker ENDED idempotent append scan failed (seq ${sessionSeq}); relying on cleanup/recovery backfill`);
    }
    await ctx.windowDispatcher
      .onWorkerSessionEnded({ workerSessionId: sessionId, workerSessionSeq: sessionSeq })
      .catch(() => {});
  } finally {
    // Release the guard only when not taken over by cleanup (epoch matches = this owner is still
    // current). Otherwise after cleanup took over (bumped the epoch + reset workerFinalizing=true
    // holding the guard), the old owner's (invalid epoch) finally unconditionally releasing would wrongly
    // release cleanup's guard. Same discipline as stopWorker's finally owner-gate and the epoch fences before each durable write.
    if (state.workerFinalizeEpoch === myEpoch) {
      state.workerFinalizing = false;
    }
  }
}

/**
 * Meta wake cursor inject: fold unread envelopes → render the wake user message → inject → markRead +
 * advance cursor. fail-soft: an inject failure does not block; a markRead failure posts a host_event under the K=3 guard.
 */
async function driveMetaWake(ctx: TickContext): Promise<void> {
  const { state } = ctx;
  if (state.metaHandle === null) return;
  if (!isSessionLive(ctx, state.metaHandle)) return;
  // busy pre-filter: skip this tick only while streaming (no inject, no fold), eliminating the
  // rejected_busy stream noise from re-injecting every tick during a long busy Meta turn. Allow
  // initializing (a guaranteed-delivery state is not a gate; a startup long session is driven by the
  // first wake inject — Meta is driven by its existing first user message, but the pre-filter is
  // structurally identical to the Watcher and uniformly skips only streaming).
  // The correctness fallback is still the inject's require_idle below: status is not strongly
  // consistent, and a race where the pre-filter saw non-streaming but it turned streaming by inject
  // time is rejected by require_idle (rejected_busy → no markRead, retry next tick), so the pre-filter
  // is not a status-based check-then-act correctness dependency.
  if (isSessionStreaming(ctx, state.metaHandle)) return;

  let unread: ReadonlyArray<Envelope>;
  try {
    unread = await foldUnreadForWake(ctx.bus, "meta", state.metaWakeCursor);
  } catch {
    return; // fold IO failure is fail-soft
  }
  if (unread.length === 0) return;

  const message = runtimePromptRenderer.renderWakeInjectUserMessage({
    envelopes: unread,
    ...(ctx.metaLang !== undefined ? { lang: ctx.metaLang } : {}),
  });
  if (message.length === 0) return;

  const envIds = unread.map((e) => e.envId as EnvelopeId);
  const latestEnvId = envIds.at(-1) ?? null;
  // Meta push watchdog: a single wake-inject timeout counts toward the push-timeout tally (does not
  // close Meta). Timeout → false; rejected_busy (normal Meta backpressure) → false silent retry; a
  // non-timeout inject error → surface + classify as permanent/transient (permanent counts toward the
  // Meta-unhealthy tally feeding the force-failed path; transient just retries). Neither markReads (cursor does not advance).
  let injected: boolean;
  try {
    injected = await metaInjectWithTimeout(
      ctx,
      state.metaHandle,
      {
        content: [{ type: "text", text: message }],
        marker: { kind: "wake_inject", envelopeIds: envIds },
        policy: { kind: "require_idle" },
      },
      await currentStageSafe(ctx),
    );
  } catch (err) {
    await surfaceMetaWakeInjectError(ctx, err);
    return; // inject failure is fail-soft (retry next tick)
  }
  if (!injected) return; // inject timeout / rejected_busy fail-soft (retry next tick, already handled in metaInjectWithTimeout)
  try {
    await ctx.bus.markReadBatch(envIds, `${META_READ_BY_PREFIX}${state.metaHandle.id}`);
    state.metaWakeCursor.onInjectAndMarkSuccess(latestEnvId, envIds);
    // Meta completes a turn via this wake (seeing the unread including reminders) → reset the WCP
    // reminder cadence: the next WCP tick, seeing pending still persisting + Meta idle, can post the next incrementing reminder (one-to-one cadence).
    state.metaReminderPostedForCurrentIdle = false;
  } catch {
    const { eventKind, newEnvIds } = state.metaWakeCursor.onMarkReadFailure(envIds);
    if (eventKind !== null) {
      await enqueueHostEvent(ctx.bus, eventKind, `wake inject markRead failed for ${newEnvIds.length} envelope(s)`, {
        envIds: newEnvIds,
      }).catch(() => {});
    }
  }
}

/**
 * Meta driver progress reminder: in clarifying/bootstrapping (Meta is the sole driver), if Meta idle
 * + inbox has no unread + stage hasn't advanced = stall (Meta can't self-wake, the host has no
 * envelope to wake it → silent deadlock). Post one meta_progress_reminder host_event into the Meta
 * inbox, and the next tick driveMetaWake wakes Meta (with an explanation of why it stalled + a list of advancing actions).
 *
 * The cadence (at most one per idle) closes naturally by the conditions: after posting, the inbox
 * becomes non-empty → the next call's peekUnread is non-empty and skips; after wake inject consumes
 * it, Meta turns streaming (the idle check fails). No cap (same discipline as the WCP worker reminder).
 *
 * The call site is after driveMetaWake: if this tick had unread already consumed by driveMetaWake
 * (Meta turned streaming), the idle check fails and skips; when the inbox was already empty, driveMetaWake noops and this posts a reminder.
 */
async function maybeRemindMetaProgress(ctx: TickContext): Promise<void> {
  const { state } = ctx;
  if (state.metaHandle === null || !isSessionIdle(ctx, state.metaHandle)) return;
  // Re-read stage live (do not trust the tick-start / call-site argument) — Meta's turn completes
  // asynchronously via SDK events, and an advance tool handler may have pushed the stage out of the
  // driver state (e.g. to awaiting_user) during this tick's await gap. Posting a reminder against the
  // old stage would pollute the awaiting_user yield / a later stage's Meta context. Use the current manifest stage, post only in the driver states.
  const stage = await currentStageSafe(ctx);
  if (stage !== "clarifying" && stage !== "bootstrapping") return;
  // inbox has no read=false → stall (query messaging state directly, same source as the awaiting_user exit condition, independent of the wake cursor).
  let unread: ReadonlyArray<Envelope>;
  try {
    unread = await ctx.bus.peekUnread("meta");
  } catch {
    return; // peek IO failure is fail-soft (retry next tick)
  }
  if (unread.length > 0) return;
  const body = runtimePromptRenderer.renderMetaProgressReminder({
    stage,
    ...(ctx.metaLang !== undefined ? { lang: ctx.metaLang } : {}),
  });
  await enqueueHostEvent(ctx.bus, HostEventKind.metaProgressReminder, body, { stage }).catch(() => {});
}

/**
 * Surface a driveMetaWake non-timeout inject error: post a host_event (SDK-diagnostic sdkErrorKind),
 * deciding whether to count toward the Meta-unhealthy tally by retryability — only `transient`
 * (network / rate-limit etc.) silently retries without counting; other non-transient (permanent
 * auth/config, non-retryable protocol, timeout, cancelled) all "won't get better by retrying" and
 * count toward metaStartFailures (feeding the force-failed path), otherwise persistent protocol/permanent
 * wake failures never converge. A non-RuntimeError is conservatively treated as non-transient.
 */
async function surfaceMetaWakeInjectError(ctx: TickContext, err: unknown): Promise<void> {
  const { state } = ctx;
  const nonTransient = err instanceof RuntimeErrorImpl ? err.kind !== "transient" : true;
  // transient (self-recovering) — like surfaceWatcherWakeInjectError, just warn + retry next tick, do
  // not post a host_event. Otherwise, while the same unread batch keeps failing transiently, the
  // cursor doesn't advance and a host_event is appended every tick → Meta inbox self-amplifying noise;
  // and transient needs no Meta handling (not a Meta-health signal), so surfacing only wastes a Meta turn.
  if (!nonTransient) {
    console.warn(`[daemon] meta wake inject failed (transient, will retry): ${(err as Error).message}`);
    return;
  }
  const sdkKind = err instanceof RuntimeErrorImpl ? sdkErrorKindFromRuntimeError(err) : SdkErrorKind.unknown;
  state.metaStartFailures += 1;
  await enqueueHostEvent(
    ctx.bus,
    sdkKind,
    `meta wake inject failed (non-transient): ${(err as Error).message}`,
    { metaSessionId: state.metaHandle?.id ?? null, nonTransient: true, failures: state.metaStartFailures },
  ).catch(() => {});
}

/**
 * Surface a driveWatcherWake non-rejected_busy inject exception: a lightweight version structurally
 * identical to surfaceMetaWakeInjectError. The Watcher has no orchestration decision power, so failure
 * signals all go to the Meta inbox (host_event, SDK-diagnostic sdkErrorKind). Non-transient (permanent
 * auth/config, non-retryable protocol, timeout, cancelled) posts a host_event so Meta knows watcher
 * wake is broken; but Watcher inject does not count toward the Meta push timeout / metaStartFailures
 * (not a Meta-health signal). transient just logs + retries next tick without spamming the inbox.
 */
async function surfaceWatcherWakeInjectError(ctx: TickContext, err: unknown): Promise<void> {
  const nonTransient = err instanceof RuntimeErrorImpl ? err.kind !== "transient" : true;
  if (!nonTransient) {
    console.warn(`[daemon] watcher wake inject failed (transient, will retry): ${(err as Error).message}`);
    return;
  }
  const sdkKind = err instanceof RuntimeErrorImpl ? sdkErrorKindFromRuntimeError(err) : SdkErrorKind.unknown;
  await enqueueHostEvent(
    ctx.bus,
    sdkKind,
    `watcher wake inject failed (non-transient): ${(err as Error).message}`,
    { watcherSessionId: ctx.state.watcherHandle?.id ?? null, nonTransient: true },
  ).catch(() => {});
}

/**
 * awaiting_user handling: Meta inbox has no read=false envelope and Meta idle → the host exits/yields
 * (exit code 0); otherwise keep Meta online + wake inject for Meta to digest.
 */
async function handleAwaitUser(ctx: TickContext): Promise<TickExit | null> {
  // Exit only when it is successfully confirmed that the Meta inbox has no read=false envelope and
  // Meta is idle. A peekMetaUnread throw (messaging IO / fold corruption) cannot be treated as "no
  // unread" — otherwise a feedback/answer the user just submitted could be skipped by a single IO
  // error, the host exits, and Meta never digests it. On read failure → stay online, retry next tick (fail-safe biased to not exit).
  let unread: ReadonlyArray<Envelope>;
  try {
    unread = await peekMetaUnread(ctx.bus);
  } catch {
    // read failure: keep Meta online (do not exit), retry next tick
    await ensureMetaOnline(ctx, "awaiting_user");
    // under awaiting_user, persistent Meta start/push failures must also force failed, otherwise the tick-loop does not converge
    return await maybeForceFailedOnMetaFailure(ctx, "awaiting_user");
  }
  if (unread.length === 0) {
    const metaIdle = ctx.state.metaHandle === null || isSessionIdle(ctx, ctx.state.metaHandle);
    if (metaIdle) {
      return { exitCode: HostExitCode.Ok, reason: "awaiting_user_no_unread" };
    }
  }
  // has unread / Meta still busy → keep Meta online to digest
  await ensureMetaOnline(ctx, "awaiting_user");
  await driveMetaWake(ctx);
  // as above — ensureMetaOnline / driveMetaWake accumulate metaStartFailures, force failed at the threshold
  return await maybeForceFailedOnMetaFailure(ctx, "awaiting_user");
}

/**
 * cleanupAndExit: close all wrapper SessionHandles (a running worker / reviewer derives host_shutdown
 * exitReason, no worker_session_end enqueued) → append host_stopping → remove host.pid (the advisory
 * lock fd is released by runDaemon's finally) → return the exit code. Idempotent (cleanedUp guard):
 * both the fatal path and the normal path may reach it.
 *
 * This is the host process-exit physical teardown (all exit paths go through cleanup): must release
 * all wrapper handles (including Meta — close the SDK client / kill the CLI subprocess, avoiding leaks
 * / orphans). This is different from "the runtime watchdog does not actively close Meta": the latter
 * means not making a product-level close-Meta decision due to push timeout at runtime (only Meta can
 * exit Meta), whereas this function is process-physical termination, unrelated to runtime decisions
 * (the host-does-not-self-restart / close-Meta rule only constrains runtime; process-exit teardown is an exception).
 */
/**
 * Wait for the in-flight worker closeout owner (finalizeWorker / wrapAgentControl.stopWorker) to
 * finish (workerFinalizing reset). Node single-threaded: the in-flight owner advances via await
 * IO/runtime in this microtask queue; this poll yields via macrotasks to let it complete. A finite
 * cap (worker closeout is far smaller) is the fallback — if the owner is stuck (should not happen:
 * close paths all catch + finally reset the guard), cleanup still takes over to close the worker, not blocking process exit forever.
 */
async function waitForWorkerFinalizeIdle(ctx: TickContext): Promise<{ timedOut: boolean }> {
  const { state } = ctx;
  // The cap uses real wall-clock (Date.now) not the injected clock: it is a teardown safety bound,
  // unrelated to watchdog semantics; an injected fake clock would never expire the bound in tests that
  // don't advance the clock (the main exit condition is still !workerFinalizing, always satisfiable, but a wall-clock bound is more robust).
  const deadline = Date.now() + ctx.workerFinalizeWaitMs;
  while (state.workerFinalizing && Date.now() < deadline) {
    await sleep(WORKER_FINALIZE_POLL_MS);
  }
  // timedOut = an in-flight closeout owner still hasn't finished (timeout takeover). Normal completion → false.
  return { timedOut: state.workerFinalizing };
}

/** Cap / poll interval for cleanup waiting for in-flight worker closeout to complete. */
const WORKER_FINALIZE_WAIT_MS = 10_000;
const WORKER_FINALIZE_POLL_MS = 5;

async function cleanupAndExit(ctx: TickContext, exitCode: HostExitCode, reason: string): Promise<DaemonResult> {
  const { state } = ctx;
  if (state.cleanedUp) return { exitCode, reason };
  state.cleanedUp = true;

  // cancel: forcibly terminate any in-flight done_criteria script subprocess tree (hung on state while
  // finalizeWorker runs evaluateOutcome), so its await unblocks immediately — otherwise host exit
  // hangs to the script's own timeout (≤3600s). terminateAll is fail-soft.
  state.activeEvaluateRegistry?.terminateAll();

  // Unified closeout mutex (third entry): before cleanup closes the worker, coordinate with the
  // in-flight closeout owner (finalizeWorker / stopWorker), otherwise concurrently closing the same
  // worker again + writing duplicate ENDED / worker_session_end breaks "closeout written exactly once".
  // 1) If an in-flight owner exists → wait for it to finish (it writes ENDED and clears workerHandle).
  //    Poll the event loop to let it advance (same thread, only await IO/runtime, won't deadlock with
  //    this function); a finite cap avoids blocking teardown forever if the owner is extremely stuck, and on timeout cleanup takes over to close.
  const { timedOut } = await waitForWorkerFinalizeIdle(ctx);
  // 2) Take over as the sole closeout owner: hold the guard so concurrent tick finalizeWorker / Meta
  //    turn stopWorker all noop during teardown (worker ENDED is written once by this function as
  //    host_shutdown). If in-flight already finished → workerHandle is likely null (closeAndEnd noop).
  // Only a timeout takeover (in-flight owner exceeding 10s) bumps the epoch — making a late-completing
  //    original owner compare the epoch and abandon its writes (this function backfills forceAbort
  //    close + host_shutdown ENDED). Normal completion (!timedOut) does not bump, leaving normal concurrent behavior unchanged.
  if (timedOut) state.workerFinalizeEpoch += 1;
  state.workerFinalizing = true;

  // Unsubscribe before closing the worker handle (consistent with finalizeWorker / stopWorker): avoid
  // the session_ended emitted by close reaching the now-meaningless worker listener.
  state.workerUnsub?.();
  state.workerUnsub = null;

  let exitStage: Stage = "running";
  try {
    exitStage = (await manifestIO.load(ctx.paths)).stage;
  } catch {
    /* fail-soft */
  }

  // Process-exit teardown: close each active wrapper handle and backfill the paired agent_session_ended.
  // Otherwise recovery sees STARTED with no ENDED → misjudges a worker/reviewer crash. Per-role exitReason:
  //  - worker: host_shutdown (an exception class, no worker_session_end envelope — Meta closing with the host is meaningless)
  //  - meta / watcher: host_shutdown (teardown physical termination; different semantics from the runtime watchdog not closing Meta, see the top-of-function comment).
  //  - reviewer: handled separately below (idempotent ENDED, may concur with an in-flight triggerReviewer closeout).
  //    close and ENDED are both fail-soft, not blocking each other.
  const closeAndEnd = async (
    handle: SessionHandle | null,
    role: "meta" | "watcher",
  ): Promise<void> => {
    if (handle === null) return;
    try {
      // Resolve the runtime by handle.role (a handle of the same role always resolves to the same runtime).
      await ctx.runtimeForRole(handle.role).closeSession(handle, { reason: "host_close", forceAbort: true });
    } catch {
      // close fail-soft
    }
    await appendSessionEnded(ctx.paths, exitStage, { role, sessionId: handle.id as SessionId, exitReason: "host_shutdown" }).catch(() => {});
  };

  // worker: close the active handle (if non-null) + backfill the host_shutdown ENDED via an idempotent
  // compare-and-append using the retained owner context. No longer relies on the workerEndedWritten
  // flag timing to decide whether to backfill — the idempotent helper scans under the lock: if this
  // sessionSeq already has a worker ENDED (the owner wrote the real exitReason) it skips, otherwise it
  // backfills host_shutdown, physically exactly one. Covers all timeout-takeover orderings:
  //  (1) still has an active worker handle (no owner / already finished) — normal teardown close + idempotent ENDED backfill;
  //  (2) timeout takeover: the in-flight owner was stuck and taken over (workerHandle=null set but
  //      maybe ENDED not yet written) → backfill idempotently using the retained workerSessionId/Seq
  //      (even if the handle is null). When the owner completes late and calls the idempotent helper again, it sees it exists and skips — no double write, no flag race.
  if (state.workerHandle !== null) {
    try {
      await ctx.runtimeForRole(state.workerHandle.role).closeSession(state.workerHandle, { reason: "host_close", forceAbort: true });
    } catch {
      /* close fail-soft */
    }
  }
  if (state.workerSessionId !== null && state.workerSessionSeq !== null) {
    const sid = (state.workerSessionId ?? (state.workerHandle?.id as SessionId)) as SessionId;
    const endedRes = await appendWorkerEndedIdempotent(ctx.paths, {
      stage: exitStage,
      sessionId: sid,
      sessionSeq: state.workerSessionSeq,
      exitReason: "host_shutdown",
    }).catch(() => ({ appended: false, scanOk: false }));
    if (endedRes.scanOk) state.workerEndedWritten = true;
  }

  // reviewer: an in-flight triggerReviewer may be closing out (physically closed, but not yet written
  // ENDED during the await window before "clear active handle"). close the active handle (if non-null)
  // + backfill the host_shutdown ENDED via an idempotent compare-and-append (dedup by session_id): if
  // triggerReviewer wrote the real exitReason it skips, otherwise it backfills, physically exactly one with triggerReviewer's own ENDED.
  // Capture the owner handle into a local first and use only the local afterward — during closeSession's
  // await window an in-flight triggerReviewer may complete and setActiveReviewerHandle(null), and
  // reading state.reviewerHandle.id after the await would null-reference.
  const reviewerHandle = state.reviewerHandle;
  if (reviewerHandle !== null) {
    try {
      await ctx.runtimeForRole(reviewerHandle.role).closeSession(reviewerHandle, { reason: "host_close", forceAbort: true });
    } catch {
      /* close fail-soft */
    }
    await appendReviewerEndedIdempotent(ctx.paths, {
      stage: exitStage,
      sessionId: reviewerHandle.id as SessionId,
      exitReason: "host_shutdown",
    }).catch(() => {});
  }
  await closeAndEnd(state.metaHandle, "meta");
  // Clear state.watcherHandle before closeAndEnd: the in-flight watcher compact flow's isCurrent()
  // (handle-identity comparison) immediately judges stale by this, not relying on the lag window of
  // public status() switching to closing (the close entry sets the internal closing flag synchronously
  // but status may not have flipped yet) — avoiding the old compact flow writing dead-session events / to the Meta inbox during teardown.
  const watcherToClose = state.watcherHandle;
  state.watcherHandle = null;
  await closeAndEnd(watcherToClose, "watcher");
  state.workerHandle = null;
  state.reviewerHandle = null;
  state.metaHandle = null;
  await eventsIO
    .append(ctx.paths, { type: "host_stopping", stage: exitStage, details: { exitCode, reason } })
    .catch(() => {});

  // Remove the host.pid metadata file (the advisory lock fd is released by runDaemon's finally). fail-soft.
  await rm(ctx.paths.hostPid, { force: true }).catch(() => {});

  return { exitCode, reason };
}

// ---- helpers ----

function toolNamesFor(ctx: TickContext, role: "meta" | "watcher" | "worker"): ReadonlyArray<string> {
  // reuse the full set registered in the registry, trimmed by scope
  return ctx.registry.list(role).map((t) => t.name);
}

async function peekMetaUnread(bus: MessagingBus): Promise<ReadonlyArray<Envelope>> {
  return bus.peekUnread("meta");
}

async function latestReadEnvId(bus: MessagingBus, channel: Channel): Promise<EnvelopeId | null> {
  // take the inbox's latest read=true envelope id (the startup-init semantics)
  const snap = await bus.fold();
  let latestId: EnvelopeId | null = null;
  let latestSeq = -1;
  for (const s of snap.values()) {
    if (s.channel !== channel || s.failed || !s.read) continue;
    if (s.stateSeq > latestSeq) {
      latestSeq = s.stateSeq;
      latestId = s.envId;
    }
  }
  return latestId;
}

function isSessionLive(ctx: TickContext, handle: SessionHandle): boolean {
  const st = ctx.runtimeForRole(handle.role).status(handle);
  return st.state !== "closed" && st.state !== "closing";
}

/**
 * Backfill the paired agent_session_ended for a non-live (closed/closing) old long session (Meta /
 * Watcher) (the invariant: exactly one ENDED per STARTED). Called before ensure*Online starts a new
 * session and overwrites state. Idempotent closeSession reads the end reason (the session has likely
 * exited / half-closed on its own, and idempotent close returns the cached result, best-effort);
 * derive exitReason from the close reason (fatal_runtime_error → sdk_crash; else → host_internal_error);
 * append one ENDED. Each step is fail-soft, not blocking the others.
 */
async function endStaleLongSession(
  ctx: TickContext,
  handle: SessionHandle,
  role: "meta" | "watcher",
  stage: Stage,
): Promise<{ endedWritten: boolean }> {
  let reason: SessionEndReason | null = null;
  try {
    const res = await ctx.runtimeForRole(handle.role).closeSession(handle, { reason: "host_close", forceAbort: true });
    reason = res.reason;
  } catch {
    /* close fail-soft: the session may have exited on its own */
  }
  const exitReason = reason === "fatal_runtime_error" ? "sdk_crash" : "host_internal_error";
  // Report the ENDED append success/failure to the caller — on a transient write failure the caller
  // does not clear the old handle (keeps it for endStaleLongSession to retry next tick), otherwise the
  // old long-session STARTED permanently lacks a paired ENDED (the idempotent backfill mechanism uses
  // sessionSeq for workers; Meta/Watcher have no sessionSeq so they self-heal via the "keep handle on failure, retry next tick" path).
  const endedWritten = await appendSessionEnded(ctx.paths, stage, { role, sessionId: handle.id as SessionId, exitReason }).then(
    () => true,
    () => false,
  );
  return { endedWritten };
}

function isSessionIdle(ctx: TickContext, handle: SessionHandle): boolean {
  return ctx.runtimeForRole(handle.role).status(handle).state === "idle";
}

/**
 * For the wake-inject busy pre-filter only: only streaming counts as busy and needs skipping;
 * initializing / idle are both allowed. A startup long session (e.g. Watcher, no first user message)
 * stays in initializing, driven solely by the first wake inject — if the pre-filter also skipped
 * initializing, the first inject would never go out → never init → deadlock (initializing is a
 * guaranteed-delivery state, not a gate). Once initializing is allowed, the adapter receiving the inject
 * must drive to delivery or throw an init timeout, never hang forever.
 */
function isSessionStreaming(ctx: TickContext, handle: SessionHandle): boolean {
  return ctx.runtimeForRole(handle.role).status(handle).state === "streaming";
}

/**
 * Wrapper around HostAgentControl.stopWorker that unifies closeout for all active worker closes
 * (meta_interrupt / meta_stop). base.stopWorker only does the physical soft-kill + orchestration flag
 * (restartAfter); this wrapper does the unified finalization: enqueue worker_session_end +
 * appendSessionEnded + windowDispatcher.onWorkerSessionEnded (the watcher final window) + clear
 * daemon-local worker state (including workerWatchdog, aligned with finalizeWorker).
 *
 * Trigger → exitReason derivation:
 *  - meta_interrupt (sh_msg__interrupt_worker) → meta_interrupt
 *  - meta_stop (sh_agent__stop_worker, with restartAfter true/false) → meta_stop
 * Both are active closes and Meta knows itself (it called the tool), so they do not enter
 * workerCompletionPending / post a reminder (deliberate: a Meta active action needs no reminder to
 * react). Continuation state transition: meta_interrupt → passive default-continue
 * (metaInterruptDefaultContinue, the host starts a new worker on Meta silence); meta_stop enters
 * wantWorkerStart (true) / metaStopNoRestart (false) per restartAfter.
 *
 * soft-kill failure (!ok, or there is an active handle but the close was not dispatched):
 * meta_interrupt posts worker_interrupt_softkill_failed, meta_stop posts worker_stop_softkill_failed
 * host_event (the worker may still be running, letting Meta retry / switch to stop_worker).
 */
function wrapAgentControl(
  base: HostAgentControl,
  bus: MessagingBus,
  state: DaemonState,
  paths: TaskCapsulePaths,
  windowDispatcher: WindowDispatcher,
): HostAgentControl {
  return {
    hasActiveWorker: () => base.hasActiveWorker(),
    hasActiveReviewer: () => base.hasActiveReviewer(),
    requestWorkerStart: (reason) => {
      base.requestWorkerStart(reason);
      state.wantWorkerStart = true; // positive signal: next tick ensure_running_agents actually starts the worker session
      state.workerStartFailedPending = false; // explicit Meta start_worker → clear the start-failure waiting state, continue/restart
      state.workerStartFailedBaselineEnvIds = null; // leaving the failure state → clear baseline
    },
    triggerReviewer: (opts) => base.triggerReviewer(opts),
    stopWorker: async (reason, restartAfter) => {
      // Unified closeout mutex: with a real adapter this tool handler is called by the MCP bridge
      // within a Meta turn, concurrently closing out the same worker as the tick main loop's
      // monitorActiveWorker→finalizeWorker and cleanupAndExit. If an in-flight owner exists
      // (workerFinalizing set) → this stop is a true noop: the worker is already being closed out (the
      // in-flight owner writes worker_session_end + ENDED + transitions the continuation flag), so stop
      // is meaningless (idempotent). Do not call base physical close, do not transition any flag, do not
      // write end/ENDED — otherwise (1) a second physical close of the same worker; (2) base, per
      // restartAfter=false, would wrongly set metaStopNoRestart, bypassing the wrapper's default-continue
      // correction for meta_interrupt (a race mis-transitioning meta_interrupt into metaStopNoRestart).
      // The dispatch intent of the concurrent stop is explicitly discarded: the worker is already
      // exiting, and the continuation flag is settled uniformly by the in-flight owner per the "first exit reason".
      if (state.workerFinalizing) {
        return {
          ok: true,
          errorKind: null,
          errorMessage: null,
          sessionId: state.workerSessionId,
          stopDispatched: false,
          noop: true,
        };
      }
      // Capture sessionId/seq before clearing (referenced by worker_session_end / ENDED)
      const sid = state.workerSessionId;
      const seq = state.workerSessionSeq;
      const hadActiveHandle = state.workerHandle !== null;
      // With an active worker → hold the in-flight guard, covering base.stopWorker's physical close and
      // the subsequent finalization await throughout, blocking a concurrent tick's finalizeWorker from a second closeout.
      if (hadActiveHandle) state.workerFinalizing = true;
      // Capture the closeout owner epoch (same as finalizeWorker). base.stopWorker's physical close
      // await may cross cleanup's 10s timeout-takeover bound → cleanup bumps the epoch and backfills the
      // host_shutdown ENDED; this owner, completing late, compares and abandons its write on mismatch to avoid duplicate ENDED.
      const myEpoch = state.workerFinalizeEpoch;
      try {
        const outcome = await base.stopWorker(reason, restartAfter);
        // Taken over by cleanup timeout → abandon handle cleanup / worker_session_end / ENDED /
        // continuation flag transition (cleanup already backfilled the host_shutdown ENDED + cleared the
        // handle). Still return the outcome to the tool (the worker is physically closed, stop semantics hold).
        if (state.workerFinalizeEpoch !== myEpoch) return outcome;
        // Winner path: base.stopWorker physical close succeeded (stopDispatched) → runtime closed the
        // worker. First unsubscribe + clear the active worker handle/watchdog/toolHistory/turnEnded/injectFailed
        // (using the captured sid/seq), then await writing worker_session_end + ENDED +
        // onWorkerSessionEnded. So a concurrent tick entering monitorActiveWorker during the await window
        // sees workerHandle===null and returns directly, not entering finalizeWorker (in-flight guard +
        // handle clear, double protection). Keep workerSessionId/Seq as the "last worker".
        if (outcome.stopDispatched) {
          state.workerUnsub?.();
          state.workerUnsub = null;
          state.workerHandle = null;
          state.workerToolHistory = null;
          state.workerTurnEnded = false;
          state.workerWatchdog = null;
          state.workerInjectFailed = false;
        }
        const softKillFailed = !outcome.ok || (!outcome.stopDispatched && !outcome.noop);
        if (softKillFailed) {
          if (reason === "meta_interrupt") {
            await enqueueInterruptSoftkillFailed(bus, {
              workerSessionId: outcome.sessionId,
              errorMessage: outcome.errorMessage,
            });
          } else {
            // meta_stop soft-kill failed: surface — the worker may still be running, Meta retries per
            // the host_event. Use worker_stop_softkill_failed (stop semantics, parallel to meta_interrupt's worker_interrupt_softkill_failed).
            await enqueueHostEvent(
              bus,
              AgentBehaviorErrorKind.workerStopSoftkillFailed,
              `worker stop (${reason}) soft-kill failed: ${outcome.errorMessage ?? "unknown"}`,
              { workerSessionId: outcome.sessionId, reason },
            ).catch(() => {});
          }
        } else if (outcome.stopDispatched && sid !== null && seq !== null) {
          // Active close (meta_interrupt / meta_stop) soft-kill succeeded → unified finalization.
          // exitReason derived from the trigger (a passive-exit class, not the host_internal_error/host_shutdown exception) → enqueue worker_session_end + ENDED.
          const exitReason: WorkerExitReason = reason === "meta_interrupt" ? "meta_interrupt" : "meta_stop";
          try {
            await enqueueWorkerSessionEnd(bus, {
              workerSessionId: sid,
              sessionSeq: seq,
              exitReason,
              // An active interrupt (meta_stop / meta_interrupt) does not run done_criteria evaluate,
              // outcome is always null: an active interrupt ≠ completion (the canonical completion path
              // is worker declare_done → finalizeWorker then evaluate). This is correct behavior.
              doneCriteriaOutcome: null,
              body: `worker session ${sid} (seq ${seq}) closed by Meta (${exitReason})`,
            });
          } catch (err) {
            // A worker_session_end enqueue failure does not block closeout: the worker is physically
            // closed; at least warn. The fallback relies on the events.jsonl ENDED (appendSessionEnded
            // below) + recovery's repairHalfCompletedWorker on the next host restart (though an active
            // interrupt has no worker_completion_claim/escalation signal → no synthesis; Meta won't
            // receive this end again, but the events.jsonl ENDED already closes the STARTED/ENDED pairing
            // and the continuation flag was correctly transitioned so the host does not stall).
            console.warn(
              `[daemon] worker_session_end enqueue failed for session ${sid} (seq ${seq}, ${exitReason}); ` +
                `relying on events.jsonl ENDED: ${(err as Error).message}`,
            );
          }
          // The worker paired ENDED uses an idempotent compare-and-append (physically exactly one). The
          // epoch fence is retained: recheck the epoch before writing (the enqueueWorkerSessionEnd await
          // may cross cleanup's takeover bound bumping the epoch) → a mismatch means cleanup took over,
          // abandon to avoid duplication. workerEndedWritten is set true only after durable (scanOk);
          // scanOk=false (scan corrupt, not written) → do not set + surface, leaving cleanup / recovery idempotent backfill.
          if (state.workerFinalizeEpoch === myEpoch) {
            const endedRes = await appendWorkerEndedIdempotent(paths, { stage: "running", sessionId: sid, sessionSeq: seq, exitReason }).catch(() => ({ appended: false, scanOk: false }));
            if (endedRes.scanOk) {
              state.workerEndedWritten = true;
            } else {
              console.warn(`[daemon] worker ENDED idempotent append failed/scan-failed (seq ${seq}, ${exitReason}); relying on cleanup/recovery backfill`);
            }
            await windowDispatcher.onWorkerSessionEnded({ workerSessionId: sid, workerSessionSeq: seq }).catch(() => {});
          }
        }
        // Continuation state transition — handled uniformly for both success paths stopDispatched +
        // noop (no active worker); transition only on soft-kill success (softKillFailed already
        // surfaced, the worker may still be running, do not change the continuation state). Does not
        // enter workerCompletionPending (Meta knows itself, no reminder needed). `reason` trigger
        // convention: interrupt_worker passes the literal "meta_interrupt"; stop_worker passes the
        // Meta-provided audit reason → judged by `reason !== "meta_interrupt"` (consistent with exitReason derivation).
        //  - meta_interrupt (passive class) → metaInterruptDefaultContinue (the host default-continues by starting a new worker on Meta silence; cleared by send_to_worker / a dispatch tool).
        //  - stop_worker + restartAfter=true (Meta authorizes restart) → set wantWorkerStart to start a new worker (base already cleared metaStopNoRestart).
        //  - stop_worker + restartAfter=false → keep metaStopNoRestart (base already set it): do not start a new worker until Meta calls any worker-dispatch tool / send_to_worker (inbox gate) again.
        if (!softKillFailed && (outcome.stopDispatched || outcome.noop)) {
          const o = state.orchestration;
          if (reason === "meta_interrupt") {
            // interrupt_worker calls in via base.stopWorker("meta_interrupt", false) → base, per
            // restartAfter=false, sets metaStopNoRestart=true, but meta_interrupt semantics is
            // default-continue (not no-restart) → correct it here: clear metaStopNoRestart, set
            // metaInterruptDefaultContinue (the key distinction between the passive class and stop(false)).
            o.metaStopNoRestart = false;
            o.metaInterruptDefaultContinue = true;
          } else if (restartAfter) {
            o.sessionEndPending = false;
            state.wantWorkerStart = true;
          }
          // restartAfter=false: base already set metaStopNoRestart, no extra action needed (do not set sessionEndPending — metaStopNoRestart governs).
        }
        return outcome;
      } finally {
        // Unified closeout mutex: closeout flow ended → release the guard (only when this call held it; an in-flight noop returns early before the try, so unaffected).
        if (hadActiveHandle) state.workerFinalizing = false;
      }
    },
  };
}

/**
 * enqueue a worker_interrupt_softkill_failed host_event (orchestration-layer signal).
 */
export async function enqueueInterruptSoftkillFailed(
  bus: MessagingBus,
  details: { workerSessionId: string | null; errorMessage: string | null },
): Promise<EnvelopeId | null> {
  try {
    return await enqueueHostEvent(
      bus,
      AgentBehaviorErrorKind.workerInterruptSoftkillFailed,
      `worker interrupt soft-kill failed (worker may still be running): ${details.errorMessage ?? "unknown"}`,
      { workerSessionId: details.workerSessionId },
    );
  } catch {
    return null;
  }
}

export type { DaemonState };
