/**
 * done_criteria evaluator: staged load -> parse -> validate -> check -> aggregate, with an outer fail-soft layer.
 *
 * - Host-side synchronous logic (not an LLM); produces the canonical doneCriteriaOutcome when a worker session exits.
 * - A missing file does not fall back to all-pass; any outer exception is wrapped as overall=error (done_criteria_evaluator_internal_error).
 * - evaluateOutcome is async (script checks spawn subprocesses); cancel forcibly terminates in-flight scripts via ScriptProcessRegistry.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { nowIso8601Us, parseIso8601Us, type Iso8601Us } from "../../shared/index.js";

import { evaluateOne } from "./checks.js";
import { DoneCriteriaErrorKind } from "./errorKinds.js";
import { ScriptProcessRegistry } from "./scriptRunner.js";
import {
  DONE_CRITERIA_YAML_RELATIVE,
  type CheckOutcome,
  type DoneCriteriaOutcome,
  type OverallResult,
} from "./types.js";
import { validateParsedConfig, parseYamlContent } from "./validate.js";

export interface EvaluateOpts {
  readonly taskId?: string;
  readonly nowIso?: string;
  /** Cancel handle: the host's async cancel wrapper calls registry.terminateAll() to terminate in-flight scripts. */
  readonly registry?: ScriptProcessRegistry;
}

function startMs(): bigint {
  return process.hrtime.bigint();
}
function elapsedMs(start: bigint): number {
  return Number((process.hrtime.bigint() - start) / 1_000_000n);
}

/**
 * Run done_criteria and produce an outcome.
 * `workspacePath` is the workspace absolute path (done_criteria.yaml lives at harness/done_criteria.yaml under it).
 */
export async function evaluateOutcome(workspacePath: string, opts?: EvaluateOpts): Promise<DoneCriteriaOutcome> {
  const started = startMs();
  let ranAt: Iso8601Us;
  try {
    ranAt = opts?.nowIso !== undefined ? parseIso8601Us(opts.nowIso) : nowIso8601Us();
  } catch {
    ranAt = nowIso8601Us();
  }

  const buildErrorOutcome = (errorKind: DoneCriteriaErrorKind, reason: string): DoneCriteriaOutcome => ({
    overall: "error",
    ranAt,
    durationMs: elapsedMs(started),
    checks: [],
    summary: { total: 0, passed: 0, failed: 0, errored: 0, errorKind, errorReason: reason },
  });

  try {
    const yamlPath = join(workspacePath, DONE_CRITERIA_YAML_RELATIVE);

    // 1) load
    let raw: string;
    try {
      raw = await readFile(yamlPath, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return buildErrorOutcome(DoneCriteriaErrorKind.fileNotFound, "done_criteria.yaml not found");
      }
      return buildErrorOutcome(DoneCriteriaErrorKind.fileIoError, `done_criteria.yaml read error: ${e.message}`);
    }

    // 2a) parse
    const parsed = parseYamlContent(raw);
    if (!parsed.ok) {
      return buildErrorOutcome(DoneCriteriaErrorKind.yamlParseError, parsed.diagnostic);
    }

    // 2b) validate (structural schema + path-literal safety; the interpreter allowlist is not short-circuited here, it is per-check)
    const validated = validateParsedConfig(parsed.data, { enforceInterpreterAllowlist: false });
    if (!validated.ok) {
      // Path-literal escape -> path_escape; other structural problems -> schema_invalid.
      const isPathEscape = /invalid: (starts with|contains|is absolute)/.test(validated.diagnostic);
      const errorKind = isPathEscape ? DoneCriteriaErrorKind.pathEscape : DoneCriteriaErrorKind.schemaInvalid;
      return buildErrorOutcome(errorKind, validated.diagnostic);
    }

    // 3) evaluate each check (each wrapped in its own try/catch so one throwing does not affect the others)
    const registry = opts?.registry;
    const checkOutcomes: CheckOutcome[] = [];
    const config = validated.config;
    for (let idx = 0; idx < config.checks.length; idx++) {
      const check = config.checks[idx]!;
      const checkId = check.id !== undefined && check.id.length > 0 ? check.id : `check_${String(idx + 1).padStart(3, "0")}`;
      let result: CheckOutcome["result"];
      let errorKind: CheckOutcome["errorKind"];
      let detail: Readonly<Record<string, unknown>>;
      try {
        const exec = await evaluateOne(check, workspacePath, {
          taskId: opts?.taskId,
          registry,
        });
        result = exec.result;
        errorKind = exec.errorKind;
        detail = exec.detail;
      } catch (err) {
        // fail-soft: a single check throwing is wrapped as error and does not affect other checks
        result = "error";
        errorKind = DoneCriteriaErrorKind.evaluatorInternalError;
        detail = { reason: `unexpected: ${(err as Error).message}` };
      }
      checkOutcomes.push({ checkId, kind: check.kind, description: check.description, result, errorKind, detail });
    }

    // 4) aggregate
    const passed = checkOutcomes.filter((c) => c.result === "pass").length;
    const failed = checkOutcomes.filter((c) => c.result === "fail").length;
    const errored = checkOutcomes.filter((c) => c.result === "error").length;
    const total = checkOutcomes.length;
    const overall: OverallResult = passed === total && total > 0 ? "all_pass" : "some_fail";
    return {
      overall,
      ranAt,
      durationMs: elapsedMs(started),
      checks: checkOutcomes,
      summary: { total, passed, failed, errored, errorKind: null, errorReason: null },
    };
  } catch (err) {
    // Outer catch-all (fail-soft): any unexpected exception is wrapped as overall=error.
    return buildErrorOutcome(DoneCriteriaErrorKind.evaluatorInternalError, `evaluator_internal_error: ${(err as Error).message}`);
  }
}
