/**
 * Transient retry managed by the host main loop, independent of any wrapper / SDK built-in retry.
 *
 * Parameters: up to 3 retries, exponential backoff 1-2-4 s, ±20% jitter.
 * Only retries wrapper `RuntimeError.kind === "transient"` (including the host watchdog's
 * `sdk_api_timeout` transient semantics); permanent / protocol / cancelled are rethrown
 * immediately. When retries are exhausted, the last error is rethrown (the caller escalates it
 * to a permanent failure signal into the Meta inbox).
 *
 * Time is injectable (sleep / random) for testing.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { isRuntimeError, type RuntimeError } from "../wrapper/types/errors.js";

export interface RetryConfig {
  /** Max retries (excluding the first attempt). Default 3. */
  readonly maxRetries: number;
  /** Base backoff (ms) per retry, indexed by attempt; uses the last entry once exhausted. Default [1000,2000,4000]. */
  readonly backoffMs: ReadonlyArray<number>;
  /** Jitter ratio (±). Default 0.2. */
  readonly jitter: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  backoffMs: [1000, 2000, 4000],
  jitter: 0.2,
};

export interface RetryHooks {
  /** Injectable for testing; defaults to node timers sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable [0,1) random for testing; defaults to Math.random. */
  readonly random?: () => number;
  /** Called before each retry (audit / counting). */
  readonly onRetry?: (attempt: number, delayMs: number, err: RuntimeError) => void;
}

/** Whether an error is transient (retryable). Watchdog-injected timeouts are wrapped into a transient RuntimeError by the caller. */
export function isTransient(err: unknown): err is RuntimeError {
  return isRuntimeError(err) && err.kind === "transient";
}

function computeDelay(cfg: RetryConfig, attemptIndex: number, rand: number): number {
  const base = cfg.backoffMs[Math.min(attemptIndex, cfg.backoffMs.length - 1)] ?? 0;
  // rand in [0,1) → factor in [1-jitter, 1+jitter)
  const factor = 1 - cfg.jitter + rand * (2 * cfg.jitter);
  return Math.round(base * factor);
}

/**
 * Run `fn` with transient retry. A non-transient error is rethrown immediately; a transient
 * error is retried after backoff, and the last error is rethrown once maxRetries is exhausted.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  hooks: RetryHooks = {},
): Promise<T> {
  const cfg: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  const doSleep = hooks.sleep ?? sleep;
  const rand = hooks.random ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === cfg.maxRetries) throw err;
      const delay = computeDelay(cfg, attempt, rand());
      // onRetry is an audit / counting side-effect hook; its exceptions must not interrupt the
      // retry path (fail-soft)
      try {
        hooks.onRetry?.(attempt + 1, delay, err);
      } catch {
        // ignore audit hook exceptions
      }
      await doSleep(delay);
    }
  }
  // Unreachable (the loop always returns or throws); satisfies TS noImplicitReturns.
  throw lastErr;
}
