/**
 * Watchdog detection + thresholds + signature computation.
 *
 * Scopes:
 * - Worker session: no_progress (idle 30 min since last tool_use) + tool_loop (5 consecutive
 *   identical (toolName, hash(input)))
 * - Reviewer session: total run time (30 min)
 * - Meta push: single inject/await duration (60 min)
 * - tool level: a single host tool handler call (30 s, Promise.race)
 * - API level: a single host→wrapper await (60 min)
 *
 * The unified trigger action (close the monitored target + events.jsonl + host_event) is
 * orchestrated by main_loop; this module only handles detection (pure functions / injectable
 * time) + threshold constants + the tool-level race wrapper + signature computation.
 */
import { createHash } from "node:crypto";

import { RuntimeErrorImpl } from "../wrapper/types/errors.js";
import type { ProviderId } from "../wrapper/types/common.js";
import type { SessionEvent } from "../wrapper/types/index.js";
import { WatchdogKind } from "./errorKinds.js";

// ---- thresholds ----

export interface WatchdogThresholds {
  /** Main tick interval (ms). */
  readonly mainTickMs: number;
  /** Watchdog tick interval (ms). */
  readonly watchdogTickMs: number;
  /** Worker no_progress threshold. */
  readonly workerNoProgressMs: number;
  /** Worker tool_loop consecutive-identical count. */
  readonly workerToolLoopCount: number;
  /** host tool handler timeout. */
  readonly hostToolCallMs: number;
  /** SDK API single-await timeout. */
  readonly sdkApiMs: number;
  /** Reviewer session total duration. */
  readonly reviewerSessionMs: number;
  /** Meta push single inject/await. */
  readonly metaPushMs: number;
}

export const DEFAULT_WATCHDOG_THRESHOLDS: WatchdogThresholds = {
  mainTickMs: 1_000,
  watchdogTickMs: 5_000,
  workerNoProgressMs: 1_800_000, // 30 min
  workerToolLoopCount: 5,
  hostToolCallMs: 30_000, // 30 s
  sdkApiMs: 3_600_000, // 60 min
  reviewerSessionMs: 1_800_000, // 30 min
  metaPushMs: 3_600_000, // 60 min
};

// ---- tool_use signature: first 16 hex of sha1(toolName + ":" + JSON.stringify(input, sorted keys)) ----

function stableStringify(value: unknown): string {
  // Normalize undefined (top-level or nested) to "null", since JSON.stringify(undefined) returns
  // undefined and would make the signature unstable
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

export function toolUseSignature(toolName: string, input: unknown): string {
  const h = createHash("sha1");
  h.update(`${toolName}:${stableStringify(input)}`);
  return h.digest("hex").slice(0, 16);
}

// ---- Worker session watchdog detection ----

export interface WorkerWatchdogState {
  /** Time of the last tool_use (epoch ms); falls back to the session start time. */
  readonly lastToolUseAt: number;
  /** Signatures of the most recent tool_use calls (ascending by time). */
  readonly recentSignatures: ReadonlyArray<string>;
}

export type WorkerWatchdogTrigger =
  | { readonly kind: typeof WatchdogKind.workerNoProgress; readonly idleMs: number }
  | { readonly kind: typeof WatchdogKind.workerToolLoop; readonly signature: string; readonly count: number };

/** Detect whether a Worker session trips the watchdog (pure; now is injectable). Returns null if not tripped. */
export function checkWorkerWatchdog(
  state: WorkerWatchdogState,
  now: number,
  thresholds: WatchdogThresholds = DEFAULT_WATCHDOG_THRESHOLDS,
): WorkerWatchdogTrigger | null {
  // tool_loop takes priority (more specific)
  const n = thresholds.workerToolLoopCount;
  const sigs = state.recentSignatures;
  if (n >= 1 && sigs.length >= n) {
    const tail = sigs.slice(-n);
    const first = tail[0]!;
    if (tail.every((s) => s === first)) {
      return { kind: WatchdogKind.workerToolLoop, signature: first, count: n };
    }
  }
  const idleMs = now - state.lastToolUseAt;
  if (idleMs >= thresholds.workerNoProgressMs) {
    return { kind: WatchdogKind.workerNoProgress, idleMs };
  }
  return null;
}

/** Worker watchdog mutable cross-tick state (accumulated by daemon; read as a read-only WorkerWatchdogState view). */
export interface WorkerWatchdogMutState {
  lastToolUseAt: number;
  recentSignatures: string[];
}

/**
 * Reflect one worker SessionEvent into the watchdog cross-tick state:
 * - main-agent `tool_invoked` (empty `parentToolUseId`) → refresh `lastToolUseAt` + record the
 *   tool_loop signature (capped at toolLoopCap);
 * - subagent-internal `tool_invoked` (non-empty `parentToolUseId`, inlined into the main stream)
 *   → only refresh `lastToolUseAt`, do not record the signature (concurrent subagents' internal
 *   tools must not pollute the main agent's tool_loop detection);
 * - subagent lifecycle (`subagent_started/progress/stopped`) → refresh `lastToolUseAt` (subagent
 *   activity counts as worker progress, preventing a long subagent from triggering no_progress
 *   while the main session makes no tool calls), but do not record a signature;
 * - other kinds leave the state unchanged.
 */
export function recordWorkerActivity(state: WorkerWatchdogMutState, ev: SessionEvent, now: number, toolLoopCap: number): void {
  if (ev.kind === "tool_invoked") {
    state.lastToolUseAt = now;
    if (ev.parentToolUseId !== undefined) return; // subagent-internal tool: counts as activity, no signature
    state.recentSignatures.push(toolUseSignature(ev.toolName, ev.input));
    if (state.recentSignatures.length > toolLoopCap) {
      state.recentSignatures.splice(0, state.recentSignatures.length - toolLoopCap);
    }
  } else if (ev.kind === "subagent_started" || ev.kind === "subagent_progress" || ev.kind === "subagent_stopped") {
    state.lastToolUseAt = now;
  }
}

/** Detect whether the Reviewer session total duration exceeds the threshold. Returns true on timeout. */
export function checkReviewerTimeout(
  startedAt: number,
  now: number,
  thresholds: WatchdogThresholds = DEFAULT_WATCHDOG_THRESHOLDS,
): boolean {
  return now - startedAt >= thresholds.reviewerSessionMs;
}

// ---- tool-level timeout (Promise.race) ----

export class HostTimeoutError extends Error {
  readonly watchdogKind: WatchdogKind;
  constructor(watchdogKind: WatchdogKind, message: string) {
    super(message);
    this.name = "HostTimeoutError";
    this.watchdogKind = watchdogKind;
  }
}

/**
 * Wrap a Promise with a timeout (shared across tool / push / API levels). On timeout throws
 * `HostTimeoutError` (carrying watchdogKind). Based on setTimeout (unref'd so it does not block exit).
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  watchdogKind: WatchdogKind,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HostTimeoutError(watchdogKind, message)), timeoutMs);
    timer.unref?.();
  });
  // Promise.resolve().then(fn) normalizes a synchronous throw from fn into a rejected promise
  // (so a synchronous throw can't bypass the finally below and leak the timer).
  const work = Promise.resolve().then(fn);
  // After the timeout branch wins, work keeps running in the background with no awaiter — if it
  // later rejects it would trigger an unhandledRejection (which can terminate the process by
  // default). Swallow the late rejection (the original work reference still races, return value unchanged).
  work.catch(() => {});
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Wrap a watchdog-detected SDK API timeout into a transient `RuntimeError` (the host main loop
 * retries it as transient). subKind uses `io_transient` as a placeholder (host audit labels it
 * sdk_transient_timeout).
 */
export function sdkApiTimeoutAsTransient(providerId: ProviderId, message: string): RuntimeErrorImpl {
  return new RuntimeErrorImpl({
    kind: "transient",
    subKind: "io_transient",
    providerId,
    message,
    diagnostics: { watchdogKind: WatchdogKind.sdkApiTimeout },
  });
}
