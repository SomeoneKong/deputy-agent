/**
 * Agent scheduling tools: sh_agent__start_worker / stop_worker / trigger_reviewer. Meta only.
 *
 * - start_worker: async; only sets a start flag (sessionId/seq are null). Requires stage=running and no active worker, else illegal_state.
 * - stop_worker: soft-kills the current worker; on noop still records the restartAfter intent.
 * - trigger_reviewer: blocks until return; phase is deliberately not a strict enum (validated in the handler -> invalid_reviewer_phase);
 *   the verdict envelope is enqueued to the Meta inbox, nextAction=sh_inbox__pull.
 */
import type { HostTool, JsonSchema } from "../../wrapper/index.js";
import { manifestIO } from "../../shared/manifest.js";
import { isValidReviewerPhase } from "../agent_sessions.js";
import type { ReviewerPhase } from "../../prompts/index.js";
import { HostToolCommonErrorKind, ToolReturnErrorKind } from "../errorKinds.js";
import {
  asInputObject,
  checkCallerRole,
  fail,
  ok,
  requireNonBlankString,
  requireStringArray,
  toCallResult,
  type HostToolDeps,
} from "./common.js";

const START_WORKER_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    reason: {
      type: "string",
      minLength: 1,
      description:
        "Why start a Worker now (events.jsonl audit). NOT delivered into the Worker first message — to tell the " +
        "Worker the reason, separately call sh_msg__send_to_worker.",
    },
  },
  required: ["reason"],
  additionalProperties: false,
};

const STOP_WORKER_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    reason: { type: "string", minLength: 1, description: "Why stop the Worker (events.jsonl audit)." },
    restartAfter: {
      type: "boolean",
      description: "true: host auto-starts a new Worker after exit (while running). false (default): wait for Meta.",
    },
  },
  required: ["reason"],
  additionalProperties: false,
};

const TRIGGER_REVIEWER_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    // phase is deliberately not a strict enum -- non-enum values are rejected by the handler as invalid_reviewer_phase
    phase: {
      type: "string",
      description: "One of bootstrap_self_review / final_review / harness_revision_review.",
    },
    round: { type: "number", minimum: 1, description: "Nth round under this phase (Meta-maintained; positive int)." },
    subject: {
      type: "string",
      minLength: 1,
      description:
        "What is under review: description + relevant file paths + review scope/criteria. Do NOT include your own " +
        "preliminary judgment or preferred conclusion (reviewer independence).",
    },
    additionalDirs: {
      type: "array",
      items: { type: "string" },
      description: "Optional extra read-only path hints, restricted to task-root-relative subpaths.",
    },
  },
  required: ["phase", "round", "subject"],
  additionalProperties: false,
};

export function makeStartWorkerTool(deps: HostToolDeps): HostTool {
  return {
    name: "sh_agent__start_worker",
    description:
      "Explicitly request the host to start a new Worker session (async: sets a start flag, the real session " +
      "starts on the next host tick; sessionId/sessionSeq are null here — derive them from events.jsonl). " +
      "Meta only. Requires stage=running and no Worker already running.",
    scope: ["meta"],
    inputSchema: START_WORKER_SCHEMA,
    metadata: { concurrent: false },
    handler: async (input, ctx) => {
      const roleFail = checkCallerRole("sh_agent__start_worker", ctx, ["meta"]);
      if (roleFail !== null) return toCallResult(roleFail);
      const objR = asInputObject("sh_agent__start_worker", input);
      if ("fail" in objR) return toCallResult(objR.fail);
      const reasonR = requireNonBlankString("reason", objR.obj["reason"]);
      if ("fail" in reasonR) return toCallResult(reasonR.fail);

      let stage: string;
      try {
        stage = (await manifestIO.load(deps.paths)).stage;
      } catch (err) {
        return toCallResult(fail(HostToolCommonErrorKind.hostInternal, `failed to load manifest: ${(err as Error).message}`));
      }
      if (stage !== "running") {
        return toCallResult(fail(HostToolCommonErrorKind.illegalState, `start_worker requires stage=running (found ${stage})`));
      }
      if (deps.agentControl.hasActiveWorker()) {
        return toCallResult(
          fail(HostToolCommonErrorKind.illegalState, "a Worker is already running; stop it or interrupt it first"),
        );
      }
      deps.agentControl.requestWorkerStart(reasonR.value);
      return toCallResult(
        ok({
          sessionId: null,
          sessionSeq: null,
          started: true,
          requestedReason: reasonR.value,
          note: "Worker start flag set; real session starts next host tick. Derive sessionId/seq from events.jsonl agent_session_started.",
        }),
      );
    },
  };
}

export function makeStopWorkerTool(deps: HostToolDeps): HostTool {
  return {
    name: "sh_agent__stop_worker",
    description:
      "Explicitly stop the current Worker session (soft kill; no worker-channel envelope is delivered). Meta only. " +
      "restartAfter controls whether the host auto-restarts after exit. If no Worker is running this is a noop but " +
      "still records the restartAfter intent.",
    scope: ["meta"],
    inputSchema: STOP_WORKER_SCHEMA,
    metadata: { concurrent: false },
    handler: async (input, ctx) => {
      const roleFail = checkCallerRole("sh_agent__stop_worker", ctx, ["meta"]);
      if (roleFail !== null) return toCallResult(roleFail);
      const objR = asInputObject("sh_agent__stop_worker", input);
      if ("fail" in objR) return toCallResult(objR.fail);
      const reasonR = requireNonBlankString("reason", objR.obj["reason"]);
      if ("fail" in reasonR) return toCallResult(reasonR.fail);
      let restartAfter = false;
      if (objR.obj["restartAfter"] !== undefined) {
        if (typeof objR.obj["restartAfter"] !== "boolean") {
          return toCallResult(fail(HostToolCommonErrorKind.invalidArgument, "field 'restartAfter' must be a boolean"));
        }
        restartAfter = objR.obj["restartAfter"];
      }
      const outcome = await deps.agentControl.stopWorker(reasonR.value, restartAfter);
      if (!outcome.ok) {
        return toCallResult(fail(outcome.errorKind ?? HostToolCommonErrorKind.hostInternal, outcome.errorMessage ?? "stop failed"));
      }
      return toCallResult(
        ok({ sessionId: outcome.sessionId, stopDispatched: outcome.stopDispatched, noop: outcome.noop, restartAfter }),
      );
    },
  };
}

export function makeTriggerReviewerTool(deps: HostToolDeps): HostTool {
  return {
    name: "sh_agent__trigger_reviewer",
    description:
      "Start an independent Reviewer short session (BLOCKING: returns after the Reviewer exits). Meta only. On " +
      "return, if envelopeKind is non-null an envelope (reviewer_verdict, or a host_event diagnostic if the verdict " +
      "could not be produced) is already in your inbox and nextAction tells you to call sh_inbox__pull; if " +
      "envelopeKind is null all enqueues failed and there is nothing to pull. phase must be one of " +
      "bootstrap_self_review / final_review / harness_revision_review.",
    scope: ["meta"],
    inputSchema: TRIGGER_REVIEWER_SCHEMA,
    metadata: { concurrent: false },
    handler: async (input, ctx) => {
      const roleFail = checkCallerRole("sh_agent__trigger_reviewer", ctx, ["meta"]);
      if (roleFail !== null) return toCallResult(roleFail);
      const objR = asInputObject("sh_agent__trigger_reviewer", input);
      if ("fail" in objR) return toCallResult(objR.fail);
      const obj = objR.obj;

      // phase validation (handler-level: invalid_reviewer_phase)
      const phase = obj["phase"];
      if (typeof phase !== "string" || !isValidReviewerPhase(phase)) {
        return toCallResult(
          fail(
            ToolReturnErrorKind.invalidReviewerPhase,
            `phase must be one of bootstrap_self_review / final_review / harness_revision_review (got ${JSON.stringify(phase)})`,
          ),
        );
      }

      const round = obj["round"];
      if (typeof round !== "number" || !Number.isInteger(round) || round < 1) {
        return toCallResult(fail(HostToolCommonErrorKind.invalidArgument, "field 'round' must be a positive integer"));
      }

      const subjectR = requireNonBlankString("subject", obj["subject"]);
      if ("fail" in subjectR) return toCallResult(subjectR.fail);

      let additionalDirs: string[] | undefined;
      if (obj["additionalDirs"] !== undefined) {
        const dirsR = requireStringArray("additionalDirs", obj["additionalDirs"]);
        if ("fail" in dirsR) return toCallResult(dirsR.fail);
        const badDir = dirsR.value.find((d) => !isTaskRootRelative(d));
        if (badDir !== undefined) {
          return toCallResult(
            fail(HostToolCommonErrorKind.invalidArgument, `additionalDirs entry '${badDir}' must be a task-root-relative subpath`),
          );
        }
        additionalDirs = dirsR.value;
      }

      if (deps.agentControl.hasActiveReviewer()) {
        return toCallResult(fail(HostToolCommonErrorKind.illegalState, "a Reviewer session is already running (no concurrency)"));
      }

      const outcome = await deps.agentControl.triggerReviewer({
        phase: phase as ReviewerPhase,
        round,
        subject: subjectR.value,
        ...(additionalDirs !== undefined ? { additionalDirs } : {}),
      });
      if (!outcome.ok) {
        return toCallResult(fail(outcome.errorKind ?? HostToolCommonErrorKind.hostInternal, outcome.errorMessage ?? "trigger failed"));
      }
      return toCallResult(
        ok({
          sessionId: outcome.sessionId,
          phase,
          round,
          verdictEnqueued: outcome.verdictEnqueued,
          envelopeKind: outcome.envelopeKind,
          // envelopeKind=null means both the verdict and the fallback host_event failed to enqueue, so there is no
          // envelope in the inbox; do not return nextAction:"sh_inbox__pull" (it would mislead Meta into pulling a
          // nonexistent envelope). Only point to pull when envelopeKind is non-null.
          ...(outcome.envelopeKind !== null ? { nextAction: "sh_inbox__pull" } : {}),
        }),
      );
    },
  };
}

function isTaskRootRelative(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  for (let i = 0; i < p.length; i++) {
    if (p.charCodeAt(i) <= 0x1f) return false; // reject NUL / control chars
  }
  if (p.split(/[/\\]/).some((seg) => seg === "..")) return false;
  return true;
}
