/**
 * Claude adapter private configuration (carried via `providerSpecific`). Holds
 * Claude-only vocabulary and does not leak into the public contract.
 *
 * `queryFn` is a dependency-injection point: it defaults to the real SDK `query`;
 * tests inject a fake that returns a controlled SDKMessage sequence (no live API key).
 */
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ThinkingLevel } from "../../types/index.js";

/** Injectable signature for `query()` (enables DI + mocking without a live LLM). */
export type ClaudeQueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

/**
 * Full set of thinking levels Claude supports (off + effort tiers; no minimal).
 * capability.supportedLevels and the session startup check share this single
 * source; add or remove a tier here only.
 */
export const CLAUDE_THINKING_LEVELS: ReadonlyArray<ThinkingLevel> = ["off", "low", "medium", "high", "xhigh"];

/**
 * Effort tier mapping: public ThinkingLevel -> Claude SDK `effort`.
 * `off` is expressed via thinking type=disabled and maps to no effort. Claude has
 * no `minimal` tier (not in supportedLevels), so the map omits it too -- a host
 * passing minimal gets not_supported at startSession (consistent with capability).
 */
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const DEFAULT_EFFORT_MAP: Readonly<Record<string, ClaudeEffort>> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

/**
 * Shape of the Claude adapter's `providerSpecific`. All fields are optional --
 * the host falls back to safe defaults when omitted.
 */
export interface ClaudeProviderConfig {
  /** `query()` injection point (for tests). Defaults to the real SDK `query`. */
  readonly queryFn?: ClaudeQueryFn;
  /** Override for the ThinkingLevel -> SDK effort tier map (defaults to DEFAULT_EFFORT_MAP). */
  readonly effortMap?: Readonly<Record<string, ClaudeEffort>>;
  /** Value for stream JSONL `_writer.adapterVersion`. */
  readonly adapterVersion?: string;
  /** Upper bound for waiting on turn end after abortTurn (default 60s). */
  readonly abortCompletionTimeoutMs?: number;
  /** Upper bound for waiting on the PostCompact summary after a manual compact (large-context compaction can be slow; default 120s). */
  readonly compactTimeoutMs?: number;
  /** Upper bound for waiting on init during session startup (default 60s). */
  readonly sessionInitTimeoutMs?: number;
  /** Upper bound for the graceful idle wait during closeSession (default 30s; can be overridden by CloseOptions.idleTimeoutMs). */
  readonly closeIdleTimeoutMs?: number;
  /** Host tool handler timeout (default 5min). */
  readonly handlerTimeoutMs?: number;
  /** Handler abort grace period (default 30s). */
  readonly abortGraceMs?: number;
  /**
   * Current host epoch (host-death fencing). Snapshotted at session creation;
   * before each stream JSONL write, `currentHostEpoch()` is re-read and compared
   * against the snapshot, and a mismatch rejects the write (so a stale handle's
   * late writes are invalidated after the host restarts).
   * Passing only `hostEpoch` (no `currentHostEpoch`) is equivalent to a
   * single-process always-pass; omitting both disables fencing.
   */
  readonly hostEpoch?: string;
  /** Reads the current host epoch dynamically, to compare the session-creation snapshot against "now". Falls back to the static hostEpoch when omitted. */
  readonly currentHostEpoch?: () => string | undefined;
  /**
   * The TS SDK surface has not been verified against the live API. When true
   * (the default), the capability report carries diagnosticHints noting that the
   * TS API shape of these capabilities is unverified; the host passes false once verified.
   */
  readonly tsApiUnverified?: boolean;
}

export interface ResolvedClaudeConfig {
  readonly queryFn: ClaudeQueryFn;
  readonly effortMap: Readonly<Record<string, ClaudeEffort>>;
  readonly adapterVersion: string;
  readonly abortCompletionTimeoutMs: number;
  readonly compactTimeoutMs: number;
  readonly sessionInitTimeoutMs: number;
  readonly closeIdleTimeoutMs: number;
  readonly handlerTimeoutMs: number;
  readonly abortGraceMs: number;
  readonly hostEpoch: string | undefined;
  readonly currentHostEpoch: () => string | undefined;
  readonly tsApiUnverified: boolean;
}

export const CLAUDE_ADAPTER_VERSION = "claude-0";

export function resolveConfig(providerSpecific: unknown): ResolvedClaudeConfig {
  const cfg = (providerSpecific ?? {}) as ClaudeProviderConfig;
  return {
    queryFn: cfg.queryFn ?? (sdkQuery as ClaudeQueryFn),
    effortMap: cfg.effortMap ?? DEFAULT_EFFORT_MAP,
    adapterVersion: cfg.adapterVersion ?? CLAUDE_ADAPTER_VERSION,
    abortCompletionTimeoutMs: cfg.abortCompletionTimeoutMs ?? 60_000,
    compactTimeoutMs: cfg.compactTimeoutMs ?? 120_000,
    sessionInitTimeoutMs: cfg.sessionInitTimeoutMs ?? 60_000,
    closeIdleTimeoutMs: cfg.closeIdleTimeoutMs ?? 30_000,
    handlerTimeoutMs: cfg.handlerTimeoutMs ?? 300_000,
    abortGraceMs: cfg.abortGraceMs ?? 30_000,
    hostEpoch: cfg.hostEpoch,
    currentHostEpoch: cfg.currentHostEpoch ?? (() => cfg.hostEpoch),
    tsApiUnverified: cfg.tsApiUnverified ?? true,
  };
}
