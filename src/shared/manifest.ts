/**
 * Task-level state machine source of truth: the manifest.yaml data contract and IO.
 *
 * Naming conversion: YAML stores snake_case on disk and the TS layer uses camelCase.
 * The conversion is schema-aware (only known fields are converted) and happens inside
 * ManifestIO, so callers only see camelCase. `lastError.details` is an opaque
 * `Record<string, unknown>` whose keys are not recursively converted (the writer's
 * original naming is preserved).
 *
 * Writes are serialized via `manifest.yaml.lock`; a lock timeout throws
 * `LockTimeoutError` (unwrapped) and an atomic write failure throws
 * `ManifestAtomicWriteFailed`. Authorized writers are the host and the privileged CLI.
 */
import { readFile } from "node:fs/promises";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { atomicWriter } from "./atomic.js";
import {
  ManifestAtomicWriteFailed,
  ManifestSchemaMismatch,
  ManifestYamlParseError,
  StageCasMismatch,
} from "./errors.js";
import type { TaskId } from "./ids.js";
import { ALL_AGENT_ROLES, ALL_PROVIDER_IDS, type AgentRole, type ProviderId } from "../wrapper/types/common.js";
import { DEFAULT_LOCK_TIMEOUT_MS, withLock } from "./locks.js";
import type { TaskCapsulePaths } from "./paths.js";
import type { Iso8601Us } from "./timeUtils.js";
import { nowIso8601Us, parseIso8601Us } from "./timeUtils.js";

export const MANIFEST_SCHEMA_VERSION = "1.0";

export type Stage =
  | "submitted"
  | "clarifying"
  | "bootstrapping"
  | "running"
  | "awaiting_user"
  | "done"
  | "failed"
  | "cancelled"
  | "paused";

/** Runtime list of all valid stages (runtime mirror of the Stage type; used by the CLI and validation). */
export const STAGES_ALL: ReadonlyArray<Stage> = [
  "submitted",
  "clarifying",
  "bootstrapping",
  "running",
  "awaiting_user",
  "done",
  "failed",
  "cancelled",
  "paused",
];

export type StageInProgress = Extract<
  Stage,
  "submitted" | "clarifying" | "bootstrapping" | "running" | "awaiting_user"
>;

const IN_PROGRESS_STAGES: ReadonlySet<string> = new Set<StageInProgress>([
  "submitted",
  "clarifying",
  "bootstrapping",
  "running",
  "awaiting_user",
]);

export interface StageHistoryEntry {
  readonly stage: Stage;
  readonly enteredAt: Iso8601Us;
}

export interface LastError {
  readonly errorKind: string;
  readonly message: string;
  readonly at: Iso8601Us;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Per-role execution binding: the provider chosen at submit. `model` is currently always absent (the host picks a default model per provider); reserved for future use. */
export interface RoleBinding {
  readonly provider: ProviderId;
  readonly model?: string;
}

/** AgentRole to execution binding; only roles the user explicitly selected are listed. Unlisted roles fall back through the host's resolution chain. */
export type RoleBindingMap = Partial<Record<AgentRole, RoleBinding>>;

/** Known role / provider sets for roleBindings (used by load validation; sourced from the wrapper's ALL_AGENT_ROLES / ALL_PROVIDER_IDS). */
const KNOWN_ROLES: ReadonlySet<string> = new Set<string>(ALL_AGENT_ROLES);
const KNOWN_PROVIDERS: ReadonlySet<string> = new Set<string>(ALL_PROVIDER_IDS);

export interface Manifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly taskId: TaskId;
  title: string;
  readonly createdAt: Iso8601Us;
  updatedAt: Iso8601Us;
  readonly rawTaskPath: string;
  stage: Stage;
  stageHistory: ReadonlyArray<StageHistoryEntry>;
  pausedFrom: StageInProgress | null;
  lastError: LastError | null;
  readonly roleBindings?: RoleBindingMap;
}

export type Mutator = (manifest: Manifest) => void;

export interface MutateOptions {
  readonly lockTimeoutMs?: number;
  readonly nowIso?: Iso8601Us;
}

export interface StageTransitionOptions extends MutateOptions {
  readonly pausedFrom?: StageInProgress | null;
  readonly lastError?: LastError | null;
  readonly expectedFromStage?: Stage;
}

export interface ManifestIO {
  load(paths: TaskCapsulePaths): Promise<Manifest>;
  writeInitial(paths: TaskCapsulePaths, init: Manifest): Promise<void>;
  mutate(paths: TaskCapsulePaths, mutator: Mutator, opts?: MutateOptions): Promise<Manifest>;
  applyStageTransition(
    paths: TaskCapsulePaths,
    targetStage: Stage,
    opts?: StageTransitionOptions,
  ): Promise<Manifest>;
}

// ---- schema-aware conversion ----

function lastErrorToYaml(le: LastError): Record<string, unknown> {
  const out: Record<string, unknown> = { error_kind: le.errorKind, message: le.message, at: le.at };
  if (le.details !== undefined) out["details"] = le.details; // opaque, not recursively converted
  return out;
}

/** roleBindings to YAML: role keys and provider / model literals are lowercase enums and are not case-converted. */
function roleBindingsToYaml(rb: RoleBindingMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [role, binding] of Object.entries(rb)) {
    if (binding === undefined) continue;
    const cell: Record<string, unknown> = { provider: binding.provider };
    if (binding.model !== undefined) cell["model"] = binding.model;
    out[role] = cell;
  }
  return out;
}

function manifestToYaml(m: Manifest): Record<string, unknown> {
  const out: Record<string, unknown> = {
    schema_version: m.schemaVersion,
    task_id: m.taskId,
    title: m.title,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
    raw_task_path: m.rawTaskPath,
    stage: m.stage,
    stage_history: m.stageHistory.map((e) => ({ stage: e.stage, entered_at: e.enteredAt })),
    paused_from: m.pausedFrom,
    last_error: m.lastError === null ? null : lastErrorToYaml(m.lastError),
  };
  // Omit the field when roleBindings is absent or empty.
  if (m.roleBindings !== undefined && Object.keys(m.roleBindings).length > 0) {
    out["role_bindings"] = roleBindingsToYaml(m.roleBindings);
  }
  return out;
}

function lastErrorFromYaml(raw: Record<string, unknown>): LastError {
  const base: LastError = {
    errorKind: String(raw["error_kind"]),
    message: String(raw["message"]),
    at: parseIso8601Us(String(raw["at"])),
  };
  const details = raw["details"];
  if (details !== undefined && details !== null && typeof details === "object") {
    return { ...base, details: details as Readonly<Record<string, unknown>> };
  }
  return base;
}

/**
 * role_bindings from YAML: fail-soft at the schema boundary — drop malformed entries
 * (unknown role, non-object, or unknown provider); dropped roles fall back through the
 * host's resolution chain. Returns undefined (field absent) when the whole field is
 * missing or parses to empty.
 */
function roleBindingsFromYaml(raw: unknown): RoleBindingMap | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, RoleBinding> = {};
  for (const [role, cell] of Object.entries(raw as Record<string, unknown>)) {
    if (!KNOWN_ROLES.has(role)) continue;
    if (cell === null || typeof cell !== "object") continue;
    const c = cell as Record<string, unknown>;
    const provider = c["provider"];
    if (typeof provider !== "string" || !KNOWN_PROVIDERS.has(provider)) continue;
    const binding: RoleBinding = { provider: provider as ProviderId };
    if (typeof c["model"] === "string" && (c["model"] as string).length > 0) {
      out[role] = { ...binding, model: c["model"] as string };
    } else {
      out[role] = binding;
    }
  }
  return Object.keys(out).length > 0 ? (out as RoleBindingMap) : undefined;
}

function manifestFromYaml(o: Record<string, unknown>): Manifest {
  const stageHistoryRaw = Array.isArray(o["stage_history"]) ? (o["stage_history"] as unknown[]) : [];
  const lastErrorRaw = o["last_error"];
  const pausedFromRaw = o["paused_from"];
  const roleBindings = roleBindingsFromYaml(o["role_bindings"]);
  const base: Manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    taskId: String(o["task_id"]) as TaskId,
    title: typeof o["title"] === "string" ? o["title"] : "",
    createdAt: parseIso8601Us(String(o["created_at"])),
    updatedAt: parseIso8601Us(String(o["updated_at"])),
    rawTaskPath: String(o["raw_task_path"]),
    stage: o["stage"] as Stage,
    stageHistory: stageHistoryRaw.map((e) => {
      const entry = e as Record<string, unknown>;
      return { stage: entry["stage"] as Stage, enteredAt: parseIso8601Us(String(entry["entered_at"])) };
    }),
    pausedFrom: pausedFromRaw == null ? null : (pausedFromRaw as StageInProgress),
    lastError:
      lastErrorRaw === undefined || lastErrorRaw === null
        ? null
        : lastErrorFromYaml(lastErrorRaw as Record<string, unknown>),
  };
  return roleBindings === undefined ? base : { ...base, roleBindings };
}

// ---- IO ----

async function writeManifest(paths: TaskCapsulePaths, m: Manifest): Promise<void> {
  try {
    await atomicWriter.writeText(paths.manifestPath, stringifyYaml(manifestToYaml(m)));
  } catch (err) {
    throw new ManifestAtomicWriteFailed(`manifest atomic write failed: ${paths.manifestPath}`, {
      details: { path: paths.manifestPath },
      cause: err,
    });
  }
}

async function load(paths: TaskCapsulePaths): Promise<Manifest> {
  const text = await readFile(paths.manifestPath, "utf8");
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ManifestYamlParseError(`manifest YAML parse failed: ${paths.manifestPath}`, { cause: err });
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestYamlParseError(`manifest top-level is not a mapping: ${paths.manifestPath}`);
  }
  const o = raw as Record<string, unknown>;
  const found = o["schema_version"];
  if (found !== MANIFEST_SCHEMA_VERSION) {
    throw new ManifestSchemaMismatch(`manifest schema_version mismatch`, {
      details: { expected: MANIFEST_SCHEMA_VERSION, found },
    });
  }
  return manifestFromYaml(o);
}

async function writeInitial(paths: TaskCapsulePaths, init: Manifest): Promise<void> {
  // First initialization: the directory was just created with no contention, so no lock is taken.
  await writeManifest(paths, init);
}

async function withManifestWrite(
  paths: TaskCapsulePaths,
  opts: MutateOptions | undefined,
  fn: (m: Manifest, now: Iso8601Us) => void,
): Promise<Manifest> {
  return withLock(
    paths.manifestLock,
    async () => {
      const m = await load(paths);
      const now = opts?.nowIso ?? nowIso8601Us();
      fn(m, now);
      await writeManifest(paths, m);
      return m;
    },
    opts?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
  );
}

async function mutate(paths: TaskCapsulePaths, mutator: Mutator, opts?: MutateOptions): Promise<Manifest> {
  return withManifestWrite(paths, opts, (m, now) => {
    mutator(m);
    m.updatedAt = now; // overwritten automatically after the mutator runs
  });
}

async function applyStageTransition(
  paths: TaskCapsulePaths,
  targetStage: Stage,
  opts?: StageTransitionOptions,
): Promise<Manifest> {
  // Runtime fail-fast: disallow explicit undefined, which would break lastError's three-state semantics.
  if (opts !== undefined && Object.hasOwn(opts, "lastError") && opts.lastError === undefined) {
    throw new TypeError("lastError must be omitted, null, or LastError object; explicit undefined is disallowed");
  }
  if (targetStage === "paused" && (opts?.pausedFrom == null || !IN_PROGRESS_STAGES.has(opts.pausedFrom))) {
    throw new TypeError("pausedFrom (an in-progress stage) is required when targetStage is 'paused'");
  }

  return withManifestWrite(paths, opts, (m, now) => {
    if (opts?.expectedFromStage !== undefined && m.stage !== opts.expectedFromStage) {
      throw new StageCasMismatch(`stage CAS mismatch: expected ${opts.expectedFromStage}, found ${m.stage}`, {
        details: { expected: opts.expectedFromStage, found: m.stage },
      });
    }
    if (opts !== undefined && Object.hasOwn(opts, "lastError")) {
      m.lastError = opts.lastError ?? null;
    }
    m.stage = targetStage;
    m.pausedFrom = targetStage === "paused" ? (opts?.pausedFrom as StageInProgress) : null;
    m.stageHistory = [...m.stageHistory, { stage: targetStage, enteredAt: now }];
    m.updatedAt = now; // same instant as enteredAt
  });
}

export const manifestIO: ManifestIO = { load, writeInitial, mutate, applyStageTransition };
