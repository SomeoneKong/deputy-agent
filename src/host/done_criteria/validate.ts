/**
 * done_criteria.yaml schema validation + path-literal safety + interpreter allowlist.
 *
 * Single source of truth:
 * - `validateDoneCriteriaContent(content)` — sync validate at write time (including the interpreter
 *   allowlist, fail-fast on write); returns null on pass, otherwise a structural diagnostic string.
 * - `parseAndValidateConfig(content, { enforceInterpreterAllowlist })` — parse YAML + structural
 *   schema + path-literal safety. The evaluate validate stage calls it with
 *   `enforceInterpreterAllowlist=false` (structure + path literals only; the interpreter allowlist
 *   moves to a per-check result=error and does not short-circuit the whole evaluate).
 *
 * Short-circuits on the first violation; reject reasons must be specific.
 */
import { parse as parseYaml } from "yaml";

import {
  CHECK_KINDS,
  INTERPRETER_ALLOWLIST,
  MAX_SCRIPT_TIMEOUT_SECONDS,
  SCRIPT_DIR_RELATIVE,
  type DoneCriteriaCheck,
  type DoneCriteriaConfig,
} from "./types.js";

/** Parse + validate result (reused by evaluate). */
export type ParseValidateResult =
  | { readonly ok: true; readonly config: DoneCriteriaConfig }
  | { readonly ok: false; readonly diagnostic: string };

/**
 * Path-literal safety check (shared by path / scriptPath / pattern).
 * Returns null when safe; otherwise a specific reason. The evaluate stage additionally does a resolve() containment re-check.
 */
export function pathUnsafeReason(value: string): string | null {
  if (value.startsWith("/") || value.startsWith("\\")) {
    return "starts with '/' or '\\' (absolute path)";
  }
  // Reject any ':' (Windows drive letter + NTFS ADS).
  if (value.includes(":")) {
    return "contains ':' (drive letter or NTFS ADS)";
  }
  const parts = value.split(/[\\/]+/).filter((seg) => seg.length > 0);
  if (parts.includes("..")) {
    return "contains '..' segment";
  }
  // Collapse no-op '.' segments, then check for a leading workspace/ (prevents ./workspace/... bypass; case-insensitive).
  const significant = parts.filter((seg) => seg !== ".");
  if (significant.length > 0 && significant[0]!.toLowerCase() === "workspace") {
    return "starts with 'workspace/' (path is relative to workspace/ root, drop the 'workspace/' prefix)";
  }
  return null;
}

/** Pattern-literal safety; the leading-workspace/ reason wording is phrased relative to the pattern's base point. */
export function patternUnsafeReason(pattern: string): string | null {
  if (pattern.startsWith("/") || pattern.startsWith("\\")) {
    return "starts with '/' or '\\' (absolute pattern)";
  }
  if (pattern.includes(":")) {
    return "contains ':' (drive letter or NTFS ADS)";
  }
  const parts = pattern.split(/[\\/]+/).filter((seg) => seg.length > 0);
  if (parts.includes("..")) {
    return "contains '..' segment";
  }
  const significant = parts.filter((seg) => seg !== ".");
  if (significant.length > 0 && significant[0]!.toLowerCase() === "workspace") {
    return "starts with 'workspace/' (pattern is relative to the directory named by check.path, not workspace/ root)";
  }
  return null;
}

/**
 * interpreter allowlist check: bare name + case-insensitive stem match; suffix empty or .exe.
 */
export function interpreterAllowed(interpreter: string): boolean {
  if (interpreter.length === 0) return false;
  if (interpreter.includes("/") || interpreter.includes("\\")) return false;
  // Reject any ':' (Windows drive-relative C:python.exe / python:stream).
  if (interpreter.includes(":")) return false;
  // Suffix allowlist: empty or .exe (others such as .py / .anything are rejected).
  const dotIdx = interpreter.lastIndexOf(".");
  let stem = interpreter;
  if (dotIdx > 0) {
    const suffix = interpreter.slice(dotIdx).toLowerCase();
    if (suffix !== ".exe") return false;
    stem = interpreter.slice(0, dotIdx);
  }
  return INTERPRETER_ALLOWLIST.has(stem.toLowerCase());
}

/** scriptPath must start with harness/tools/scripts/. */
function scriptPathUnderScriptsDir(scriptPath: string): boolean {
  const segs = scriptPath.split(/[\\/]+/).filter((s) => s.length > 0);
  const prefix = SCRIPT_DIR_RELATIVE.split("/").filter((s) => s.length > 0);
  if (segs.length <= prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (segs[i] !== prefix[i]) return false;
  }
  return true;
}

function isNonNegativeInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

function nonBlankString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

const CHECK_KIND_SET: ReadonlySet<string> = new Set(CHECK_KINDS);

interface ValidateOpts {
  /** True at write time (sync validate, fail-fast reject); false in the evaluate validate stage (moved to per-check). */
  readonly enforceInterpreterAllowlist: boolean;
}

/**
 * Validate a single check and convert it to camelCase; returns { check } or { diagnostic }.
 * `raw` is the snake_case mapping produced by the YAML parse.
 */
function validateAndConvertCheck(
  raw: Record<string, unknown>,
  idx: number,
  opts: ValidateOpts,
): { readonly check: DoneCriteriaCheck } | { readonly diagnostic: string } {
  const kind = raw["kind"];
  if (typeof kind !== "string") {
    return { diagnostic: `checks[${idx}].kind must be a string` };
  }
  if (!CHECK_KIND_SET.has(kind)) {
    return { diagnostic: `checks[${idx}].kind '${kind}' not in [${CHECK_KINDS.join(", ")}]` };
  }
  if (!nonBlankString(raw["description"])) {
    return { diagnostic: `checks[${idx}].description must be a non-empty string` };
  }
  const description = (raw["description"] as string);

  // id (optional): uniqueness + reserved-pattern checks are done in the outer batch; here only the type is validated.
  let id: string | undefined;
  if (raw["id"] !== undefined && raw["id"] !== null) {
    if (typeof raw["id"] !== "string" || raw["id"].length === 0) {
      return { diagnostic: `checks[${idx}].id must be a non-empty string if provided` };
    }
    id = raw["id"];
  }
  const base = id !== undefined ? { id, description } : { description };

  switch (kind) {
    case "file_exists": {
      const path = raw["path"];
      if (!nonBlankString(path)) return { diagnostic: `checks[${idx}].path must be a non-empty string` };
      const r = pathUnsafeReason(path as string);
      if (r !== null) return { diagnostic: `checks[${idx}].path '${path as string}' invalid: ${r}` };
      return { check: { ...base, kind, path: path as string } };
    }
    case "file_min_lines": {
      const path = raw["path"];
      if (!nonBlankString(path)) return { diagnostic: `checks[${idx}].path must be a non-empty string` };
      const r = pathUnsafeReason(path as string);
      if (r !== null) return { diagnostic: `checks[${idx}].path '${path as string}' invalid: ${r}` };
      const minLines = raw["min_lines"];
      if (!isNonNegativeInt(minLines)) return { diagnostic: `checks[${idx}].min_lines must be a non-negative integer` };
      return { check: { ...base, kind, path: path as string, minLines } };
    }
    case "file_min_bytes": {
      const path = raw["path"];
      if (!nonBlankString(path)) return { diagnostic: `checks[${idx}].path must be a non-empty string` };
      const r = pathUnsafeReason(path as string);
      if (r !== null) return { diagnostic: `checks[${idx}].path '${path as string}' invalid: ${r}` };
      const minBytes = raw["min_bytes"];
      if (!isNonNegativeInt(minBytes)) return { diagnostic: `checks[${idx}].min_bytes must be a non-negative integer` };
      return { check: { ...base, kind, path: path as string, minBytes } };
    }
    case "yaml_field_present": {
      const path = raw["path"];
      if (!nonBlankString(path)) return { diagnostic: `checks[${idx}].path must be a non-empty string` };
      const r = pathUnsafeReason(path as string);
      if (r !== null) return { diagnostic: `checks[${idx}].path '${path as string}' invalid: ${r}` };
      const field = raw["field"];
      if (!nonBlankString(field)) return { diagnostic: `checks[${idx}].field must be a non-empty string` };
      return { check: { ...base, kind, path: path as string, field: field as string } };
    }
    case "dir_min_files": {
      const path = raw["path"];
      if (!nonBlankString(path)) return { diagnostic: `checks[${idx}].path must be a non-empty string` };
      const r = pathUnsafeReason(path as string);
      if (r !== null) return { diagnostic: `checks[${idx}].path '${path as string}' invalid: ${r}` };
      const pattern = raw["pattern"];
      if (!nonBlankString(pattern)) return { diagnostic: `checks[${idx}].pattern must be a non-empty string` };
      const pr = patternUnsafeReason(pattern as string);
      if (pr !== null) return { diagnostic: `checks[${idx}].pattern '${pattern as string}' invalid: ${pr}` };
      const minCount = raw["min_count"];
      if (!isNonNegativeInt(minCount)) return { diagnostic: `checks[${idx}].min_count must be a non-negative integer` };
      return { check: { ...base, kind, path: path as string, pattern: pattern as string, minCount } };
    }
    case "script": {
      const scriptPath = raw["script_path"];
      if (!nonBlankString(scriptPath)) return { diagnostic: `checks[${idx}].script_path must be a non-empty string` };
      const r = pathUnsafeReason(scriptPath as string);
      if (r !== null) return { diagnostic: `checks[${idx}].script_path '${scriptPath as string}' invalid: ${r}` };
      if (!scriptPathUnderScriptsDir(scriptPath as string)) {
        return {
          diagnostic: `checks[${idx}].script_path '${scriptPath as string}' must live under '${SCRIPT_DIR_RELATIVE}/'`,
        };
      }
      const interpreter = raw["interpreter"];
      if (!nonBlankString(interpreter)) return { diagnostic: `checks[${idx}].interpreter must be a non-empty string` };
      if (opts.enforceInterpreterAllowlist && !interpreterAllowed(interpreter as string)) {
        return {
          diagnostic: `checks[${idx}].interpreter '${interpreter as string}' not in allowlist [${[...INTERPRETER_ALLOWLIST].join(", ")}]`,
        };
      }
      const timeoutRaw = raw["timeout_seconds"];
      let timeoutSeconds: number | undefined;
      if (timeoutRaw !== undefined && timeoutRaw !== null) {
        if (typeof timeoutRaw !== "number" || !Number.isInteger(timeoutRaw) || timeoutRaw <= 0) {
          return { diagnostic: `checks[${idx}].timeout_seconds must be a positive integer` };
        }
        if (timeoutRaw > MAX_SCRIPT_TIMEOUT_SECONDS) {
          return {
            diagnostic: `checks[${idx}].timeout_seconds ${timeoutRaw} exceeds upper bound ${MAX_SCRIPT_TIMEOUT_SECONDS}s`,
          };
        }
        timeoutSeconds = timeoutRaw;
      }
      return {
        check:
          timeoutSeconds !== undefined
            ? { ...base, kind, scriptPath: scriptPath as string, interpreter: interpreter as string, timeoutSeconds }
            : { ...base, kind, scriptPath: scriptPath as string, interpreter: interpreter as string },
      };
    }
    /* c8 ignore next */
    default:
      return { diagnostic: `checks[${idx}].kind '${kind}' unknown` };
  }
}

/** Reserved id pattern ^check_\d+$ (reserved for host auto-assignment; user-defined ids may not match it). */
const RESERVED_ID_RE = /^check_\d+$/;

/** YAML parse result (distinguishes the errorKind of a parse error vs a schema error, for the staged load/validate). */
export type ParseYamlResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly diagnostic: string };

/** Parse the YAML string only (no schema validation); lets evaluate distinguish yaml_parse_error. */
export function parseYamlContent(content: string): ParseYamlResult {
  try {
    return { ok: true, data: parseYaml(content) };
  } catch (err) {
    return { ok: false, diagnostic: `yaml parse failed: ${(err as Error).message}` };
  }
}

/**
 * Parse the YAML string + structural schema + path-literal safety (+ optional interpreter allowlist).
 * The conversion is schema-aware (only known fields are converted), returning a camelCase config.
 */
export function parseAndValidateConfig(content: string, opts: ValidateOpts): ParseValidateResult {
  const parsed = parseYamlContent(content);
  if (!parsed.ok) return { ok: false, diagnostic: parsed.diagnostic };
  return validateParsedConfig(parsed.data, opts);
}

/** Validate already-parsed YAML data (schema + path-literal safety); lets evaluate validate separately after parsing. */
export function validateParsedConfig(data: unknown, opts: ValidateOpts): ParseValidateResult {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, diagnostic: "done_criteria.yaml root must be a mapping" };
  }
  const checksRaw = (data as Record<string, unknown>)["checks"];
  if (!Array.isArray(checksRaw) || checksRaw.length === 0) {
    return { ok: false, diagnostic: "checks must be a non-empty list" };
  }

  const checks: DoneCriteriaCheck[] = [];
  const seenIds = new Set<string>();
  for (let idx = 0; idx < checksRaw.length; idx++) {
    const raw = checksRaw[idx];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, diagnostic: `checks[${idx}] must be a mapping` };
    }
    const res = validateAndConvertCheck(raw as Record<string, unknown>, idx, opts);
    if ("diagnostic" in res) return { ok: false, diagnostic: res.diagnostic };
    const check = res.check;
    if (check.id !== undefined) {
      if (RESERVED_ID_RE.test(check.id)) {
        return {
          ok: false,
          diagnostic: `checks[${idx}].id '${check.id}' matches reserved host auto-assigned pattern '^check_<n>$' (pick a different id)`,
        };
      }
      if (seenIds.has(check.id)) {
        return { ok: false, diagnostic: `checks[${idx}].id '${check.id}' duplicated` };
      }
      seenIds.add(check.id);
    }
    checks.push(check);
  }
  return { ok: true, config: { checks } };
}

/**
 * Sync validate entry point: validation at write time, including the interpreter allowlist.
 * Returns null on pass; otherwise a structural diagnostic string (not a fill-in template).
 */
export function validateDoneCriteriaContent(content: string): string | null {
  const res = parseAndValidateConfig(content, { enforceInterpreterAllowlist: true });
  return res.ok ? null : res.diagnostic;
}
