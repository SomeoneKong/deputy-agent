/**
 * sh_reviewer__submit_verdict: the Reviewer submits a structured verdict + issues to the host's internal buffer.
 *
 * - Reviewer only (ACL second line of defense).
 * - The host writes the verdict buffer (key=reviewerSessionId); after the reviewer session exits, trigger_reviewer takes it out and turns it into an envelope.
 * - Repeated calls in the same session: last write wins (fail-soft).
 * - No phase parameter (phase belongs to trigger_reviewer).
 */
import type { HostTool, JsonSchema } from "../../wrapper/index.js";
import type { ReviewerVerdictValue } from "../../messaging/index.js";
import { HostToolCommonErrorKind } from "../errorKinds.js";
import {
  asInputObject,
  callerSessionId,
  checkCallerRole,
  fail,
  ok,
  toCallResult,
  type HostToolDeps,
} from "./common.js";

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "needs_revision", "unsafe"], description: "Review conclusion." },
    issues: {
      type: "array",
      description: "Optional issue list.",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["info", "warn", "critical"] },
          where: { type: "string", minLength: 1, description: "Verifiable location (artifact path / section / line, e.g. workspace/output/report.md:42)." },
          what: { type: "string", minLength: 1 },
          suggestedFix: { type: "string", minLength: 1 },
        },
        required: ["severity", "where", "what", "suggestedFix"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict"],
  additionalProperties: false,
};

const VALID_VERDICTS: ReadonlyArray<string> = ["pass", "needs_revision", "unsafe"];
const VALID_SEVERITY: ReadonlyArray<string> = ["info", "warn", "critical"];

export function makeSubmitVerdictTool(deps: HostToolDeps): HostTool {
  return {
    name: "sh_reviewer__submit_verdict",
    description:
      "Submit your review verdict + issues to the host (call exactly once before ending your review). Reviewer only. " +
      "verdict: pass / needs_revision / unsafe. Each issue: severity (info/warn/critical), where (verifiable " +
      "location), what, suggestedFix.",
    scope: ["reviewer"],
    inputSchema: SCHEMA,
    handler: async (input, ctx) => {
      const roleFail = checkCallerRole("sh_reviewer__submit_verdict", ctx, ["reviewer"]);
      if (roleFail !== null) return toCallResult(roleFail);
      const objR = asInputObject("sh_reviewer__submit_verdict", input);
      if ("fail" in objR) return toCallResult(objR.fail);
      const verdict = objR.obj["verdict"];
      if (typeof verdict !== "string" || !VALID_VERDICTS.includes(verdict)) {
        return toCallResult(fail(HostToolCommonErrorKind.invalidArgument, "field 'verdict' must be pass / needs_revision / unsafe"));
      }
      let issues: Array<Readonly<Record<string, unknown>>> = [];
      const rawIssues = objR.obj["issues"];
      if (rawIssues !== undefined) {
        if (!Array.isArray(rawIssues)) {
          return toCallResult(fail(HostToolCommonErrorKind.invalidArgument, "field 'issues' must be an array"));
        }
        for (const it of rawIssues) {
          if (typeof it !== "object" || it === null || Array.isArray(it)) {
            return toCallResult(fail(HostToolCommonErrorKind.invalidArgument, "each issue must be an object"));
          }
          const issue = it as Record<string, unknown>;
          const sev = issue["severity"];
          if (typeof sev !== "string" || !VALID_SEVERITY.includes(sev)) {
            return toCallResult(fail(HostToolCommonErrorKind.invalidArgument, "issue.severity must be info / warn / critical"));
          }
          for (const f of ["where", "what", "suggestedFix"]) {
            if (typeof issue[f] !== "string" || (issue[f] as string).trim().length === 0) {
              return toCallResult(fail(HostToolCommonErrorKind.invalidArgument, `issue.${f} must be a non-blank string`));
            }
          }
        }
        issues = rawIssues as Array<Readonly<Record<string, unknown>>>;
      }
      deps.verdictBuffer.put(callerSessionId(ctx), { verdict: verdict as ReviewerVerdictValue, issues });
      return toCallResult(ok({ recorded: true }));
    },
  };
}
