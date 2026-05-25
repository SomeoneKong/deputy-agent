/**
 * Message-delivery tools: async semantics (the result only means "enqueued to the inbox" + envId, not that the target has consumed it).
 *
 * - Meta->Worker: send_to_worker (meta_instruction) / interrupt_worker (meta_interrupt + soft-kill side effect)
 * - Meta->Watcher: send_to_watcher (meta_instruction)
 * - Meta->User: send_to_user (not via the bus; conversation.jsonl is the sole source of truth, a write failure is not fail-soft)
 * - Worker->Meta: escalate_to_meta (exitIntent) / notify_meta / declare_done_to_meta
 * - Watcher->Meta: observe_to_meta (evidenceRefs required and non-empty)
 *
 * For the three worker->meta tools, extras.workerSessionId / sessionSeq are filled by the host from the caller session (the agent does not pass them).
 */
import type { HostTool, HostToolCallContext, JsonSchema } from "../../wrapper/index.js";
import { conversationIO } from "../../shared/conversation.js";
import { LockTimeoutError } from "../../shared/errors.js";
import type { SessionId } from "../../shared/ids.js";
import { manifestIO } from "../../shared/manifest.js";
import { renderStatusMd } from "../../shared/status_md.js";
import { eventsIO } from "../events.js";
import { HostToolCommonErrorKind } from "../errorKinds.js";
import {
  asInputObject,
  busErrorFail,
  callerSessionId,
  checkCallerRole,
  fail,
  ok,
  requireNonBlankString,
  requireStringArray,
  toCallResult,
  type HostToolDeps,
} from "./common.js";

function bodyOnlySchema(desc: string): JsonSchema {
  return {
    type: "object",
    properties: { body: { type: "string", minLength: 1, description: desc } },
    required: ["body"],
    additionalProperties: false,
  };
}

// ---- Meta -> Worker ----

export function makeSendToWorkerTool(deps: HostToolDeps): HostTool {
  return {
    name: "sh_msg__send_to_worker",
    description:
      "Send a non-interrupt instruction to the Worker inbox (async; Worker consumes it at its own pace). Meta only. " +
      "Does not interrupt a running Worker.",
    scope: ["meta"],
    inputSchema: bodyOnlySchema("Instruction text (text-first; structured fields only as needed)."),
    handler: async (input, ctx) => {
      const roleFail = checkCallerRole("sh_msg__send_to_worker", ctx, ["meta"]);
      if (roleFail !== null) return toCallResult(roleFail);
      const bodyR = parseBody("sh_msg__send_to_worker", input);
      if ("fail" in bodyR) return toCallResult(bodyR.fail);
      try {
        const envId = await deps.bus.enqueue({ channel: "worker", kind: "meta_instruction", from: "host", body: bodyR.value });
        return toCallResult(ok({ envId, channel: "worker", kind: "meta_instruction", dispatched: true }));
      } catch (err) {
        return toCallResult(busErrorFail("send_to_worker enqueue", err));
      }
    },
  };
}

export function makeInterruptWorkerTool(deps: HostToolDeps): HostTool {
  return {
    name: "sh_msg__interrupt_worker",
    description:
      "Interrupt the currently running Worker session (delivers a meta_interrupt envelope + soft-kills the Worker). " +
      "Meta only. If no Worker is running this is rejected (use sh_msg__send_to_worker / sh_agent__start_worker " +
      "for queued instructions).",
    scope: ["meta"],
    inputSchema: bodyOnlySchema("Interrupt intent text (the Worker sees it on its next session)."),
    metadata: { concurrent: false },
    handler: async (input, ctx) => {
      const roleFail = checkCallerRole("sh_msg__interrupt_worker", ctx, ["meta"]);
      if (roleFail !== null) return toCallResult(roleFail);
      const bodyR = parseBody("sh_msg__interrupt_worker", input);
      if ("fail" in bodyR) return toCallResult(bodyR.fail);

      // worker not running -> reject enqueue
      if (!deps.agentControl.hasActiveWorker()) {
        return toCallResult(
          fail(
            HostToolCommonErrorKind.illegalState,
            "no active worker subprocess to interrupt; use sh_msg__send_to_worker / sh_agent__start_worker for queued instruction",
          ),
        );
      }
      let envId: string;
      try {
        envId = await deps.bus.enqueue({ channel: "worker", kind: "meta_interrupt", from: "host", body: bodyR.value });
      } catch (err) {
        return toCallResult(busErrorFail("interrupt_worker enqueue", err));
      }
      // soft kill via agentControl.stopWorker (no restart); on failure the orchestration layer posts a host_event and the tool still returns ok (interruptTriggered:false)
      const kill = await deps.agentControl.stopWorker("meta_interrupt", false);
      return toCallResult(
        ok({
          envId,
          channel: "worker",
          kind: "meta_interrupt",
          dispatched: true,
          interruptTriggered: kill.ok && kill.stopDispatched,
          currentWorkerSessionId: kill.sessionId,
        }),
      );
    },
  };
}

// ---- Meta -> Watcher ----

export function makeSendToWatcherTool(deps: HostToolDeps): HostTool {
  return {
    name: "sh_msg__send_to_watcher",
    description:
      "Send a lightweight observation hint / focus suggestion to the Watcher inbox (async; does not modify harness). " +
      "Meta only. For persistent watcher task-prompt changes use sh_harness__write_watcher instead.",
    scope: ["meta"],
    inputSchema: bodyOnlySchema("Observation hint text for the Watcher."),
    handler: async (input, ctx) => {
      const roleFail = checkCallerRole("sh_msg__send_to_watcher", ctx, ["meta"]);
      if (roleFail !== null) return toCallResult(roleFail);
      const bodyR = parseBody("sh_msg__send_to_watcher", input);
      if ("fail" in bodyR) return toCallResult(bodyR.fail);
      try {
        const envId = await deps.bus.enqueue({ channel: "watcher", kind: "meta_instruction", from: "host", body: bodyR.value });
        return toCallResult(ok({ envId, channel: "watcher", kind: "meta_instruction", dispatched: true }));
      } catch (err) {
        return toCallResult(busErrorFail("send_to_watcher enqueue", err));
      }
    },
  };
}

// ---- Meta -> User (not via the bus) ----

export function makeSendToUserTool(deps: HostToolDeps): HostTool {
  return {
    name: "sh_msg__send_to_user",
    description:
      "Send a message to the user (question / delivery report / notification). Meta only. Written to " +
      "conversation.jsonl (the sole source of truth) — NOT a fail-soft delivery. Does NOT auto-transition stage " +
      "(call sh_stage__advance separately for awaiting_user).",
    scope: ["meta"],
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string", minLength: 1, description: "User-facing text (no internal jargon)." },
        intent: { type: "string", enum: ["question", "delivery_report", "notification"], description: "Render category." },
      },
      required: ["body", "intent"],
      additionalProperties: false,
    },
    metadata: { concurrent: false },
    handler: async (input, ctx) => {
      const roleFail = checkCallerRole("sh_msg__send_to_user", ctx, ["meta"]);
      if (roleFail !== null) return toCallResult(roleFail);
      const objR = asInputObject("sh_msg__send_to_user", input);
      if ("fail" in objR) return toCallResult(objR.fail);
      const bodyR = requireNonBlankString("body", objR.obj["body"]);
      if ("fail" in bodyR) return toCallResult(bodyR.fail);
      const intent = objR.obj["intent"];
      if (intent !== "question" && intent !== "delivery_report" && intent !== "notification") {
        return toCallResult(fail(HostToolCommonErrorKind.invalidArgument, "field 'intent' must be question / delivery_report / notification"));
      }
      try {
        await conversationIO.appendMetaToUser({
          paths: deps.paths,
          intent,
          body: bodyR.value,
          fromSessionId: callerSessionId(ctx),
        });
      } catch (err) {
        // conversation.jsonl is the sole source of truth; a write failure here cannot be fail-soft
        if (err instanceof LockTimeoutError) {
          return toCallResult(fail(HostToolCommonErrorKind.concurrentConflict, `conversation.lock wait timed out: ${(err as Error).message}`));
        }
        return toCallResult(fail(HostToolCommonErrorKind.hostInternal, `conversation.jsonl append failed: ${(err as Error).message}`));
      }
      // audit message_to_user -- fail-soft: conversation.jsonl is the source of truth; a missing event is not rolled back.
      try {
        const stage = (await manifestIO.load(deps.paths)).stage;
        await eventsIO.append(deps.paths, {
          type: "message_to_user",
          // audit details {intent, bytes}; bySession added for consistency (same format as harness_changed).
          stage,
          details: { intent, bytes: Buffer.byteLength(bodyR.value, "utf8"), bySession: `${ctx.agentRole}_session:${callerSessionId(ctx)}` },
        });
      } catch (err) {
        console.warn(`[msg] message_to_user event append failed (conversation already written): ${(err as Error).message}`);
      }
      // After writing the conversation, re-render status.md to refresh the "latest Meta message to the user" section (fail-soft).
      await renderStatusMd(deps.paths);
      return toCallResult(ok({ dispatched: true }));
    },
  };
}

// ---- Worker -> Meta ----

export function makeEscalateToMetaTool(deps: HostToolDeps): HostTool {
  return {
    name: "sh_msg__escalate_to_meta",
    description:
      "Worker escalation to Meta (a problem / can't proceed / sub-phase handoff). Worker only. exitIntent=continue " +
      "(notify and keep going) or declare_deferred (declare exit; the Worker should then stop issuing new tool_use " +
      "and let the session end).",
    scope: ["worker"],
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string", minLength: 1, description: "Escalation body (with fallback evidence for blocked cases, or handoff summary)." },
        exitIntent: { type: "string", enum: ["continue", "declare_deferred"], description: "continue / declare_deferred." },
      },
      required: ["body", "exitIntent"],
      additionalProperties: false,
    },
    handler: async (input, ctx) => {
      const roleFail = checkCallerRole("sh_msg__escalate_to_meta", ctx, ["worker"]);
      if (roleFail !== null) return toCallResult(roleFail);
      const objR = asInputObject("sh_msg__escalate_to_meta", input);
      if ("fail" in objR) return toCallResult(objR.fail);
      const bodyR = requireNonBlankString("body", objR.obj["body"]);
      if ("fail" in bodyR) return toCallResult(bodyR.fail);
      const exitIntent = objR.obj["exitIntent"];
      if (exitIntent !== "continue" && exitIntent !== "declare_deferred") {
        return toCallResult(fail(HostToolCommonErrorKind.invalidArgument, "field 'exitIntent' must be continue / declare_deferred"));
      }
      const { sessionId, sessionSeq } = workerIdentity(deps, ctx);
      try {
        const envId = await deps.bus.enqueue({
          channel: "meta",
          kind: "worker_escalation",
          from: "host",
          body: bodyR.value,
          extras: { workerSessionId: sessionId, sessionSeq, exitIntent },
        });
        return toCallResult(ok({ envId, channel: "meta", kind: "worker_escalation", dispatched: true, exitIntentRecorded: exitIntent }));
      } catch (err) {
        return toCallResult(busErrorFail("escalate_to_meta enqueue", err));
      }
    },
  };
}

export function makeNotifyMetaTool(deps: HostToolDeps): HostTool {
  return {
    name: "sh_msg__notify_meta",
    description:
      "Worker proactive notification to Meta (no exit intent, no feedback expected, does not block the Worker). " +
      "Worker only. Typical: plan declared / plan revision summary referencing workspace/progress.md.",
    scope: ["worker"],
    inputSchema: bodyOnlySchema("Markdown self-describing notification (e.g. '## Plan declared' + summary)."),
    handler: async (input, ctx) => {
      const roleFail = checkCallerRole("sh_msg__notify_meta", ctx, ["worker"]);
      if (roleFail !== null) return toCallResult(roleFail);
      const bodyR = parseBody("sh_msg__notify_meta", input);
      if ("fail" in bodyR) return toCallResult(bodyR.fail);
      const { sessionId, sessionSeq } = workerIdentity(deps, ctx);
      try {
        const envId = await deps.bus.enqueue({
          channel: "meta",
          kind: "worker_notification",
          from: "host",
          body: bodyR.value,
          extras: { workerSessionId: sessionId, sessionSeq },
        });
        return toCallResult(ok({ envId, channel: "meta", kind: "worker_notification", dispatched: true }));
      } catch (err) {
        return toCallResult(busErrorFail("notify_meta enqueue", err));
      }
    },
  };
}

export function makeDeclareDoneToMetaTool(deps: HostToolDeps): HostTool {
  return {
    name: "sh_msg__declare_done_to_meta",
    description:
      "Worker explicitly declares the task complete (host marks the worker exit as declare_done). Worker only. " +
      "Hard gate: only call after checking each explicit raw_task constraint + each done_criteria item against " +
      "supporting evidence; if any item fails, use sh_msg__escalate_to_meta(exitIntent=declare_deferred) instead. " +
      "The Worker should then stop issuing new tool_use and let the session end.",
    scope: ["worker"],
    inputSchema: bodyOnlySchema("Self-evaluation body: per-item pass/fail verdict with supporting evidence."),
    handler: async (input, ctx) => {
      const roleFail = checkCallerRole("sh_msg__declare_done_to_meta", ctx, ["worker"]);
      if (roleFail !== null) return toCallResult(roleFail);
      const bodyR = parseBody("sh_msg__declare_done_to_meta", input);
      if ("fail" in bodyR) return toCallResult(bodyR.fail);
      const { sessionId, sessionSeq } = workerIdentity(deps, ctx);
      try {
        const envId = await deps.bus.enqueue({
          channel: "meta",
          kind: "worker_completion_claim",
          from: "host",
          body: bodyR.value,
          extras: { workerSessionId: sessionId, sessionSeq },
        });
        return toCallResult(ok({ envId, channel: "meta", kind: "worker_completion_claim", dispatched: true }));
      } catch (err) {
        return toCallResult(busErrorFail("declare_done_to_meta enqueue", err));
      }
    },
  };
}

// ---- Watcher -> Meta ----

export function makeObserveToMetaTool(deps: HostToolDeps): HostTool {
  return {
    name: "sh_msg__observe_to_meta",
    description:
      "Watcher forwards an observation to Meta. Watcher only. evidenceRefs is required and must be non-empty " +
      "(Watcher must always cite evidence). No severity/urgency labels (Meta synthesizes).",
    scope: ["watcher"],
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string", minLength: 1, description: "Observation text citing specific evidence fragments." },
        evidenceRefs: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "Evidence reference list (stream line / artifact path / worker_stream_window:<envId>#<seq>).",
        },
      },
      required: ["body", "evidenceRefs"],
      additionalProperties: false,
    },
    handler: async (input, ctx) => {
      const roleFail = checkCallerRole("sh_msg__observe_to_meta", ctx, ["watcher"]);
      if (roleFail !== null) return toCallResult(roleFail);
      const objR = asInputObject("sh_msg__observe_to_meta", input);
      if ("fail" in objR) return toCallResult(objR.fail);
      const bodyR = requireNonBlankString("body", objR.obj["body"]);
      if ("fail" in bodyR) return toCallResult(bodyR.fail);
      const refsR = requireStringArray("evidenceRefs", objR.obj["evidenceRefs"]);
      if ("fail" in refsR) return toCallResult(refsR.fail);
      if (refsR.value.length === 0) {
        return toCallResult(fail(HostToolCommonErrorKind.invalidArgument, "evidenceRefs must be non-empty (Watcher must cite evidence)"));
      }
      try {
        const envId = await deps.bus.enqueue({
          channel: "meta",
          kind: "watcher_observation",
          from: "host",
          body: bodyR.value,
          extras: { watcherSessionId: callerSessionId(ctx), evidenceRefs: refsR.value },
        });
        return toCallResult(ok({ envId, channel: "meta", kind: "watcher_observation", dispatched: true }));
      } catch (err) {
        return toCallResult(busErrorFail("observe_to_meta enqueue", err));
      }
    },
  };
}

// ---- helpers ----

function parseBody(toolName: string, input: unknown): { value: string } | { fail: ReturnType<typeof fail> } {
  const objR = asInputObject(toolName, input);
  if ("fail" in objR) return { fail: objR.fail };
  return requireNonBlankString("body", objR.obj["body"]);
}

/** workerSessionId / sessionSeq for worker->meta envelopes (filled by the host). sessionSeq comes from the deps resolver. */
function workerIdentity(deps: HostToolDeps, ctx: HostToolCallContext): { sessionId: SessionId; sessionSeq: number } {
  const sessionId = callerSessionId(ctx);
  const sessionSeq = deps.workerSessionSeqResolver(sessionId);
  return { sessionId, sessionSeq };
}
