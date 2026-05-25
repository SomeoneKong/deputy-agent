/**
 * inbox tools: sh_inbox__pull / mark_responded / inspect_worker_status.
 *
 * - pull: all roles (each on its own channel); returns unread envelopes and marks read=true (bus side effect).
 * - mark_responded: worker (own inbox) + meta (backfill the worker channel); fail-soft bucketed result.
 * - inspect_worker_status: meta; queries a read/responded status summary of worker-channel envelopes (no body returned).
 */
import type { AgentRole, HostTool, HostToolCallContext, JsonSchema } from "../../wrapper/index.js";
import type { Channel } from "../../messaging/index.js";
import { MessagingStateCorrupted } from "../../shared/errors.js";
import type { EnvelopeId } from "../../shared/ids.js";
import { HostToolCommonErrorKind } from "../errorKinds.js";
import {
  asInputObject,
  busErrorFail,
  callerSessionId,
  checkCallerRole,
  fail,
  ok,
  requireStringArray,
  toCallResult,
  type HostToolDeps,
} from "./common.js";

const ROLE_CHANNEL: Readonly<Record<AgentRole, Channel | null>> = {
  meta: "meta",
  worker: "worker",
  watcher: "watcher",
  reviewer: null,
};

function channelForRole(ctx: HostToolCallContext): Channel | null {
  return ROLE_CHANNEL[ctx.agentRole];
}

const PULL_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    includeRead: {
      type: "boolean",
      description: "Default false (unread only). true returns all envelopes on the channel including already-read.",
    },
  },
  required: [],
  additionalProperties: false,
};

const ENVIDS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    envIds: { type: "array", items: { type: "string" }, minItems: 1, description: "Worker-channel envelope ids (at least one)." },
  },
  required: ["envIds"],
  additionalProperties: false,
};

const INSPECT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    envIds: {
      type: "array",
      items: { type: "string" },
      description: "Optional. Omit to return a status summary of all worker-channel envelopes (default cap 100).",
    },
  },
  required: [],
  additionalProperties: false,
};

export function makeInboxPullTool(deps: HostToolDeps): HostTool {
  return {
    name: "sh_inbox__pull",
    description:
      "Pull the current unconsumed envelopes from your channel inbox (Meta / Worker / Watcher). Returns unread " +
      "envelopes (sorted by createdAt,stateSeq) and marks them read. Set includeRead=true to also see read ones " +
      "for historical review.",
    scope: ["meta", "worker", "watcher"],
    inputSchema: PULL_SCHEMA,
    handler: async (input, ctx) => {
      const roleFail = checkCallerRole("sh_inbox__pull", ctx, ["meta", "worker", "watcher"]);
      if (roleFail !== null) return toCallResult(roleFail);
      const channel = channelForRole(ctx);
      if (channel === null) {
        return toCallResult(fail(HostToolCommonErrorKind.illegalState, `sh_inbox__pull not permitted for role ${ctx.agentRole}`));
      }
      const objR = asInputObject("sh_inbox__pull", input);
      if ("fail" in objR) return toCallResult(objR.fail);
      let includeRead = false;
      if (objR.obj["includeRead"] !== undefined) {
        if (typeof objR.obj["includeRead"] !== "boolean") {
          return toCallResult(fail(HostToolCommonErrorKind.invalidArgument, "field 'includeRead' must be a boolean"));
        }
        includeRead = objR.obj["includeRead"];
      }
      try {
        const result = await deps.bus.pull(channel, { callerSessionId: callerSessionId(ctx), includeRead });
        return toCallResult(
          ok({
            channel: result.channel,
            envelopes: result.envelopes.map((e) => ({
              envId: e.envId,
              kind: e.kind,
              from: e.from,
              createdAt: e.createdAt,
              body: e.body,
              extras: e.extras,
              read: e.read,
              ...(e.responded !== undefined ? { responded: e.responded } : {}),
            })),
          }),
        );
      } catch (err) {
        if (err instanceof MessagingStateCorrupted) {
          void deps.bus.quarantineState().catch(() => {});
          return toCallResult(fail(HostToolCommonErrorKind.hostInternal, `messaging state corrupted: ${(err as Error).message}`));
        }
        return toCallResult(busErrorFail("inbox pull", err));
      }
    },
  };
}

export function makeInboxMarkRespondedTool(deps: HostToolDeps): HostTool {
  return {
    name: "sh_inbox__mark_responded",
    description:
      "Mark a batch of worker-channel envelopes as responded=true (idempotent; not reversible). Worker (own inbox) " +
      "or Meta (backfill the Worker inbox). Non-worker-channel / unknown ids are reported per-item, not fatal.",
    scope: ["meta", "worker"],
    inputSchema: ENVIDS_SCHEMA,
    handler: async (input, ctx) => {
      const roleFail = checkCallerRole("sh_inbox__mark_responded", ctx, ["meta", "worker"]);
      if (roleFail !== null) return toCallResult(roleFail);
      const objR = asInputObject("sh_inbox__mark_responded", input);
      if ("fail" in objR) return toCallResult(objR.fail);
      const idsR = requireStringArray("envIds", objR.obj["envIds"]);
      if ("fail" in idsR) return toCallResult(idsR.fail);
      // Non-empty check (handler backstop beyond schema minItems:1): an empty array is meaningless; reject rather than call the bus with nothing.
      if (idsR.value.length === 0) {
        return toCallResult(fail(HostToolCommonErrorKind.invalidArgument, "field 'envIds' must contain at least one id"));
      }
      const by = `${ctx.agentRole === "meta" ? "meta" : "worker"}_session:${callerSessionId(ctx)}`;
      try {
        const result = await deps.bus.markResponded(idsR.value as EnvelopeId[], by);
        return toCallResult(
          ok({
            marked: result.marked,
            alreadyResponded: result.alreadyResponded,
            notFound: result.notFound,
            notWorkerChannel: result.notWorkerChannel,
          }),
        );
      } catch (err) {
        return toCallResult(busErrorFail("mark_responded", err));
      }
    },
  };
}

export function makeInspectWorkerStatusTool(deps: HostToolDeps): HostTool {
  return {
    name: "sh_inbox__inspect_worker_status",
    description:
      "Inspect read/responded status of envelopes Meta sent to the worker channel (status fields only, no body). " +
      "Meta only. Omit envIds to get a summary of all worker-channel envelopes.",
    scope: ["meta"],
    inputSchema: INSPECT_SCHEMA,
    handler: async (input, ctx) => {
      const roleFail = checkCallerRole("sh_inbox__inspect_worker_status", ctx, ["meta"]);
      if (roleFail !== null) return toCallResult(roleFail);
      const objR = asInputObject("sh_inbox__inspect_worker_status", input);
      if ("fail" in objR) return toCallResult(objR.fail);
      let envIds: EnvelopeId[] | undefined;
      if (objR.obj["envIds"] !== undefined) {
        const idsR = requireStringArray("envIds", objR.obj["envIds"]);
        if ("fail" in idsR) return toCallResult(idsR.fail);
        envIds = idsR.value as EnvelopeId[];
      }
      try {
        const result = await deps.bus.inspectWorkerStatus(envIds !== undefined ? { envIds } : undefined);
        return toCallResult(
          ok({
            envelopes: result.envelopes.map((e) => ({
              envId: e.envId,
              kind: e.kind,
              createdAt: e.createdAt,
              read: e.read,
              responded: e.responded,
              readBySession: e.readBy,
              respondedBySession: e.respondedBy,
            })),
            notFound: result.notFound,
            notWorkerChannel: result.notWorkerChannel,
          }),
        );
      } catch (err) {
        return toCallResult(busErrorFail("inspect_worker_status", err));
      }
    },
  };
}
