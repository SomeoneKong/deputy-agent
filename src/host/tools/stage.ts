/**
 * sh_stage__advance: Meta-only stage transition. Passes through the handleStageAdvance gate result.
 *
 * - targetStage is an enum (excluding submitted / paused); reason is required.
 * - lastError is optional; for cancelled the host forces it to user_cancelled.
 * - Gate failure (reviewer_required) / illegal_state / concurrent_conflict pass through the handleStageAdvance errorKind.
 * - noop: already at targetStage (idempotent).
 */
import type { HostTool, JsonSchema } from "../../wrapper/index.js";
import { manifestIO, type LastError, type Stage } from "../../shared/manifest.js";
import { nowIso8601Us } from "../../shared/timeUtils.js";
import { handleStageAdvance } from "../stage_machine.js";
import { HostToolCommonErrorKind } from "../errorKinds.js";
import {
  asInputObject,
  checkCallerRole,
  fail,
  ok,
  requireNonBlankString,
  toCallResult,
  type HostToolDeps,
} from "./common.js";

const ADVANCE_TARGETS: ReadonlyArray<Stage> = [
  "clarifying",
  "bootstrapping",
  "running",
  "awaiting_user",
  "done",
  "failed",
  "cancelled",
];

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    targetStage: {
      type: "string",
      enum: [...ADVANCE_TARGETS],
      description:
        "Target stage. submitted (initial) and paused (user privilege) are not allowed. cancelled expresses " +
        "user-level abandonment after user feedback.",
    },
    reason: { type: "string", minLength: 1, description: "Transition rationale (written to events.jsonl audit)." },
    lastError: {
      // type includes "null": parseLastError accepts explicit null (clear). additionalProperties:false because the
      // Claude adapter's schema->Zod translation rejects open objects (additionalProperties:true throws
      // schema_translation_failed, failing Meta tool registration); errorKind/message are the only Meta-supplied
      // fields (at is injected by the host), so explicit strict suffices.
      type: ["object", "null"],
      description:
        "Optional. For targetStage=failed, set { errorKind, message }. Pass null to clear an existing lastError " +
        "(e.g. awaiting_user -> running recovery). For targetStage=cancelled host forces errorKind=user_cancelled.",
      properties: {
        errorKind: { type: "string" },
        message: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  required: ["targetStage", "reason"],
  additionalProperties: false,
};

function parseLastError(raw: unknown, targetStage: Stage): { value?: LastError | null } | { fail: ReturnType<typeof fail> } {
  // explicit null -> clear; absent -> leave unchanged (returns empty object; caller distinguishes via Object.hasOwn)
  if (raw === null) {
    if (targetStage === "cancelled") {
      return { value: { errorKind: "user_cancelled", message: "", at: nowIso8601Us() } };
    }
    return { value: null };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { fail: fail(HostToolCommonErrorKind.invalidArgument, "field 'lastError' must be an object or null") };
  }
  const obj = raw as Record<string, unknown>;
  const message = typeof obj["message"] === "string" ? obj["message"] : "";
  if (targetStage === "cancelled") {
    // force: override errorKind to user_cancelled when it is anything else
    return { value: { errorKind: "user_cancelled", message, at: nowIso8601Us() } };
  }
  const errorKind = typeof obj["errorKind"] === "string" ? obj["errorKind"] : "meta_declared_failure";
  return { value: { errorKind, message, at: nowIso8601Us() } };
}

export function makeStageAdvanceTool(deps: HostToolDeps): HostTool {
  return {
    name: "sh_stage__advance",
    description:
      "Advance (or reset) the task stage. Meta only. host validates the transition + runs host gates " +
      "(entering running from any non-running stage needs a bootstrap_self_review reviewer_verdict; running->{awaiting_user,done} " +
      "needs a final_review reviewer_verdict after the latest worker completion claim). Gate failure returns " +
      "errorKind=reviewer_required without writing the manifest; trigger the reviewer then retry.",
    scope: ["meta"],
    inputSchema: SCHEMA,
    metadata: { concurrent: false },
    handler: async (input, ctx) => {
      const roleFail = checkCallerRole("sh_stage__advance", ctx, ["meta"]);
      if (roleFail !== null) return toCallResult(roleFail);
      const objR = asInputObject("sh_stage__advance", input);
      if ("fail" in objR) return toCallResult(objR.fail);
      const obj = objR.obj;

      const target = obj["targetStage"];
      if (typeof target !== "string" || !(ADVANCE_TARGETS as ReadonlyArray<string>).includes(target)) {
        return toCallResult(fail(HostToolCommonErrorKind.invalidArgument, `targetStage must be one of ${ADVANCE_TARGETS.join(", ")}`));
      }
      const targetStage = target as Stage;

      const reasonR = requireNonBlankString("reason", obj["reason"]);
      if ("fail" in reasonR) return toCallResult(reasonR.fail);

      const hasLastError = Object.hasOwn(obj, "lastError");
      let lastError: LastError | null | undefined;
      if (hasLastError) {
        const leR = parseLastError(obj["lastError"], targetStage);
        if ("fail" in leR) return toCallResult(leR.fail);
        lastError = leR.value;
      } else if (targetStage === "cancelled") {
        // cancelled forces a lastError even when none was passed
        lastError = { errorKind: "user_cancelled", message: "", at: nowIso8601Us() };
      }

      // load fromStage (for noop detection + result field)
      let fromStage: Stage;
      try {
        fromStage = (await manifestIO.load(deps.paths)).stage;
      } catch (err) {
        return toCallResult(fail(HostToolCommonErrorKind.hostInternal, `failed to load manifest: ${(err as Error).message}`));
      }
      if (fromStage === targetStage) {
        return toCallResult(ok({ fromStage, toStage: targetStage, noop: true }));
      }

      const result = await handleStageAdvance(
        { paths: deps.paths, bus: deps.bus },
        { targetStage, reason: reasonR.value, ...(lastError !== undefined ? { lastError } : {}) },
      );
      if (!result.ok) {
        return toCallResult(fail(result.errorKind, result.errorMessage));
      }
      return toCallResult(ok({ fromStage, toStage: targetStage, noop: false }));
    },
  };
}
