/**
 * done_criteria.yaml schema TS types (internal camelCase representation) + outcome shape + protocol constants.
 *
 * The YAML physical form uses snake_case; this file is the internal camelCase representation after
 * reading / validating. The `kind` / `overall` / `result` enum values keep their snake_case literal
 * form (protocol-level enums, consistent across subsystems).
 */
import type { Iso8601Us } from "../../shared/index.js";
import type { DoneCriteriaErrorKind } from "./errorKinds.js";

// ---- Protocol constants ----

/** The 6 check kinds. */
export const CHECK_KINDS = [
  "file_exists",
  "file_min_lines",
  "file_min_bytes",
  "yaml_field_present",
  "dir_min_files",
  "script",
] as const;

export type CheckKind = (typeof CHECK_KINDS)[number];

/** interpreter allowlist (case-insensitive match on the stem). */
export const INTERPRETER_ALLOWLIST: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "python",
  "python3",
  "py",
  "powershell",
  "pwsh",
  "node",
]);

/** script timeout default 1800s / upper bound 3600s. */
export const DEFAULT_SCRIPT_TIMEOUT_SECONDS = 1800;
export const MAX_SCRIPT_TIMEOUT_SECONDS = 3600;

/** script stdout / stderr tail-truncation lengths. */
export const SCRIPT_STDOUT_TAIL = 2000;
export const SCRIPT_STDERR_TAIL = 200;

/** done_criteria.yaml path relative to the workspace. */
export const DONE_CRITERIA_YAML_RELATIVE = "harness/done_criteria.yaml";

/** Required prefix for scriptPath within the workspace. */
export const SCRIPT_DIR_RELATIVE = "harness/tools/scripts";

// ---- config schema (discriminated union by kind) ----

interface CheckBase {
  readonly id?: string;
  readonly description: string;
}

export interface FileExistsCheck extends CheckBase {
  readonly kind: "file_exists";
  readonly path: string;
}

export interface FileMinLinesCheck extends CheckBase {
  readonly kind: "file_min_lines";
  readonly path: string;
  readonly minLines: number;
}

export interface FileMinBytesCheck extends CheckBase {
  readonly kind: "file_min_bytes";
  readonly path: string;
  readonly minBytes: number;
}

export interface YamlFieldPresentCheck extends CheckBase {
  readonly kind: "yaml_field_present";
  readonly path: string;
  readonly field: string;
}

export interface DirMinFilesCheck extends CheckBase {
  readonly kind: "dir_min_files";
  readonly path: string;
  readonly pattern: string;
  readonly minCount: number;
}

export interface ScriptCheck extends CheckBase {
  readonly kind: "script";
  readonly scriptPath: string;
  readonly interpreter: string;
  readonly timeoutSeconds?: number;
}

export type DoneCriteriaCheck =
  | FileExistsCheck
  | FileMinLinesCheck
  | FileMinBytesCheck
  | YamlFieldPresentCheck
  | DirMinFilesCheck
  | ScriptCheck;

export interface DoneCriteriaConfig {
  readonly checks: ReadonlyArray<DoneCriteriaCheck>;
}

// ---- outcome schema ----

export type OverallResult = "all_pass" | "some_fail" | "error";
export type CheckResult = "pass" | "fail" | "error";

export interface CheckOutcome {
  readonly checkId: string;
  readonly kind: string;
  readonly description: string;
  readonly result: CheckResult;
  /** Non-null only when result="error", drawn from the check-level error-kind subset; always null for pass / fail. */
  readonly errorKind: DoneCriteriaErrorKind | null;
  /** Specialized per kind; detail.reason is human-readable text, separate from the machine-readable errorKind label. */
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface OutcomeSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  /** Non-null only when overall="error", drawn from the evaluator/load-level error-kind subset. */
  readonly errorKind: DoneCriteriaErrorKind | null;
  /** Filled only when overall="error" (human-readable text for the evaluator's own error). */
  readonly errorReason: string | null;
}

export interface DoneCriteriaOutcome {
  readonly overall: OverallResult;
  readonly ranAt: Iso8601Us;
  readonly durationMs: number;
  readonly checks: ReadonlyArray<CheckOutcome>;
  readonly summary: OutcomeSummary;
}
