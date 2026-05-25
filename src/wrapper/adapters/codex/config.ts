/**
 * Codex adapter private config (the `providerSpecific` payload) - carries Codex-only vocabulary
 * without leaking into the common contract.
 *
 * `spawnFn` is the dependency-injection point: it defaults to a real spawn of the `codex app-server`
 * subprocess; tests inject a fake app-server (no real subprocess / no live API).
 */
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { ThinkingLevel } from "../../types/index.js";
import type { ReasoningEffort } from "./protocol.js";

/** The spawned subprocess (the adapter only uses stdin/stdout/stderr + kill + exit events, so a structural subset is used to ease fake injection). */
export interface AppServerProcess {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly pid: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

export interface SpawnArgs {
  readonly bin: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

/** Spawn injection point: defaults to a real spawn of `codex app-server`; tests inject a function returning a fake subprocess. */
export type CodexSpawnFn = (args: SpawnArgs) => AppServerProcess;

function defaultSpawn(args: SpawnArgs): AppServerProcess {
  // Windows: the npm-installed `codex` is a codex.cmd/.ps1 shim (not an .exe), which node spawn
  // cannot execute directly without a shell -> shell:true lets cmd.exe resolve codex->codex.cmd via
  // PATHEXT. args is the fixed ["app-server"] (no external input), so there is no shell-injection risk.
  // POSIX: codex is a real executable; no shell needed.
  const isWin = process.platform === "win32";
  const child: ChildProcessWithoutNullStreams = nodeSpawn(args.bin, [...args.args], {
    env: { ...args.env },
    cwd: args.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: isWin,
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  return child as unknown as AppServerProcess;
}

/** The two paths for exposing a host tool to Codex. Defaults to dynamicTools. */
export type CodexToolBridgeMode = "dynamicTools" | "mcp";

/**
 * The full set of thinking levels Codex supports (reasoning effort tiers). This single source is
 * shared by capability.supportedLevels and the session startup validation; effortMap maps the
 * common ThinkingLevel onto ReasoningEffort.
 */
export const CODEX_THINKING_LEVELS: ReadonlyArray<ThinkingLevel> = ["off", "minimal", "low", "medium", "high", "xhigh"];

export const DEFAULT_EFFORT_MAP: Readonly<Record<string, ReasoningEffort>> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

/** The shape of the Codex adapter's `providerSpecific` config. All fields are optional - safe defaults are used when the host omits them. */
export interface CodexProviderConfig {
  /** Path to the `codex` executable (default "codex"). */
  readonly codexBin?: string;
  /** Spawn injection point (for tests). Defaults to a real spawn. */
  readonly spawnFn?: CodexSpawnFn;
  /** The host-tool exposure path. Defaults to dynamicTools. */
  readonly codexToolBridgeMode?: CodexToolBridgeMode;
  /** Override of the ThinkingLevel -> ReasoningEffort mapping (default DEFAULT_EFFORT_MAP). */
  readonly effortMap?: Readonly<Record<string, ReasoningEffort>>;
  /** Value for the stream JSONL `_writer.adapterVersion`. */
  readonly adapterVersion?: string;
  /** JSON-RPC request/response pairing timeout (default 60s). */
  readonly rpcTimeoutMs?: number;
  /** Upper bound for session startup (initialize + thread/start) (default 60s). */
  readonly sessionInitTimeoutMs?: number;
  /** Upper bound for waiting for turn/completed after abortTurn (default 60s). */
  readonly abortCompletionTimeoutMs?: number;
  /** Upper bound for graceful closeSession to wait for idle (default 30s; overridable by CloseOptions.idleTimeoutMs). */
  readonly closeIdleTimeoutMs?: number;
  /** Upper bound for a manual compact to wait for the contextCompaction item (default 120s). */
  readonly compactTimeoutMs?: number;
  /** Host tool handler timeout (default 5min). */
  readonly handlerTimeoutMs?: number;
  /** Handler abort grace (default 30s). */
  readonly abortGraceMs?: number;
  /** Current host epoch (for host-death fencing). */
  readonly hostEpoch?: string;
  /** Reads the current host epoch (dynamic). Falls back to the static hostEpoch when omitted. */
  readonly currentHostEpoch?: () => string | undefined;
}

export interface ResolvedCodexConfig {
  readonly codexBin: string;
  readonly spawnFn: CodexSpawnFn;
  readonly codexToolBridgeMode: CodexToolBridgeMode;
  readonly effortMap: Readonly<Record<string, ReasoningEffort>>;
  readonly adapterVersion: string;
  readonly rpcTimeoutMs: number;
  readonly sessionInitTimeoutMs: number;
  readonly abortCompletionTimeoutMs: number;
  readonly closeIdleTimeoutMs: number;
  readonly compactTimeoutMs: number;
  readonly handlerTimeoutMs: number;
  readonly abortGraceMs: number;
  readonly hostEpoch: string | undefined;
  readonly currentHostEpoch: () => string | undefined;
}

export const CODEX_ADAPTER_VERSION = "codex-0";

export function resolveCodexConfig(providerSpecific: unknown): ResolvedCodexConfig {
  const cfg = (providerSpecific ?? {}) as CodexProviderConfig;
  return {
    codexBin: cfg.codexBin ?? "codex",
    spawnFn: cfg.spawnFn ?? defaultSpawn,
    codexToolBridgeMode: cfg.codexToolBridgeMode ?? "dynamicTools",
    effortMap: cfg.effortMap ?? DEFAULT_EFFORT_MAP,
    adapterVersion: cfg.adapterVersion ?? CODEX_ADAPTER_VERSION,
    rpcTimeoutMs: cfg.rpcTimeoutMs ?? 60_000,
    sessionInitTimeoutMs: cfg.sessionInitTimeoutMs ?? 60_000,
    abortCompletionTimeoutMs: cfg.abortCompletionTimeoutMs ?? 60_000,
    closeIdleTimeoutMs: cfg.closeIdleTimeoutMs ?? 30_000,
    compactTimeoutMs: cfg.compactTimeoutMs ?? 120_000,
    handlerTimeoutMs: cfg.handlerTimeoutMs ?? 300_000,
    abortGraceMs: cfg.abortGraceMs ?? 30_000,
    hostEpoch: cfg.hostEpoch,
    currentHostEpoch: cfg.currentHostEpoch ?? (() => cfg.hostEpoch),
  };
}
