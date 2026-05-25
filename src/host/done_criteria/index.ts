/**
 * done_criteria subsystem barrel.
 *
 * done_criteria.yaml schema (6 check kinds) + schema validation (reused by sync validate) +
 * evaluator (staged, fail-soft) + outcome shape + body.md summary rendering + errorKind set
 * (a local namespace).
 *
 * evaluate is host-side synchronous logic (not an LLM); it produces the canonical
 * doneCriteriaOutcome when a worker session exits.
 */
export * from "./errorKinds.js";
export * from "./types.js";
export {
  validateDoneCriteriaContent,
  interpreterAllowed,
  pathUnsafeReason,
  patternUnsafeReason,
} from "./validate.js";
export { evaluateOutcome, type EvaluateOpts } from "./evaluate.js";
export { renderOutcomeSummary } from "./render.js";
export { ScriptProcessRegistry } from "./scriptRunner.js";
