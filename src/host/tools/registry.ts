/**
 * host tool suite registration + the role x tool scoping matrix.
 *
 * - buildHostTools(deps): construct all HostTool definitions.
 * - registerHostTools(registry, deps): register every tool into the wrapper HostToolRegistry (duplicate registration throws, handled by the registry).
 * - toolNamesForRole(role): return the tool names available to a role (used to scope before host startSession).
 */
import type { AgentRole, HostTool, HostToolRegistry } from "../../wrapper/index.js";
import type { HostToolDeps } from "./common.js";
import { makeStageAdvanceTool } from "./stage.js";
import { makeReadHarnessTool, makeWriteWatcherTool, makeWriteWorkerTool } from "./harness.js";
import { makeStartWorkerTool, makeStopWorkerTool, makeTriggerReviewerTool } from "./agent.js";
import {
  makeDeclareDoneToMetaTool,
  makeEscalateToMetaTool,
  makeInterruptWorkerTool,
  makeNotifyMetaTool,
  makeObserveToMetaTool,
  makeSendToUserTool,
  makeSendToWatcherTool,
  makeSendToWorkerTool,
} from "./msg.js";
import { makeInboxMarkRespondedTool, makeInboxPullTool, makeInspectWorkerStatusTool } from "./inbox.js";
import { makeSubmitVerdictTool } from "./reviewer.js";

/** Construct all host tool definitions (order-independent; names are globally unique). */
export function buildHostTools(deps: HostToolDeps): ReadonlyArray<HostTool> {
  return [
    makeStageAdvanceTool(deps),
    makeWriteWorkerTool(deps),
    makeWriteWatcherTool(deps),
    makeReadHarnessTool(deps),
    makeStartWorkerTool(deps),
    makeStopWorkerTool(deps),
    makeTriggerReviewerTool(deps),
    makeSendToWorkerTool(deps),
    makeInterruptWorkerTool(deps),
    makeSendToWatcherTool(deps),
    makeSendToUserTool(deps),
    makeEscalateToMetaTool(deps),
    makeNotifyMetaTool(deps),
    makeDeclareDoneToMetaTool(deps),
    makeObserveToMetaTool(deps),
    makeInboxPullTool(deps),
    makeInboxMarkRespondedTool(deps),
    makeInspectWorkerStatusTool(deps),
    makeSubmitVerdictTool(deps),
  ];
}

/** Register all host tools into the registry. Duplicate registration throws HostToolRegistryError from registry.register. */
export function registerHostTools(registry: HostToolRegistry, deps: HostToolDeps): void {
  for (const tool of buildHostTools(deps)) {
    registry.register(tool);
  }
}

/**
 * Role -> available tool-name set. The source of truth is each tool's scope; this derives from scope without
 * depending on registered instances, using a static name + scope table kept in sync with buildHostTools.
 */
const TOOL_SCOPES: ReadonlyArray<{ name: string; scope: ReadonlyArray<AgentRole> }> = [
  { name: "sh_stage__advance", scope: ["meta"] },
  { name: "sh_harness__write_worker", scope: ["meta"] },
  { name: "sh_harness__write_watcher", scope: ["meta"] },
  { name: "sh_harness__read", scope: ["meta", "watcher"] },
  { name: "sh_agent__start_worker", scope: ["meta"] },
  { name: "sh_agent__stop_worker", scope: ["meta"] },
  { name: "sh_agent__trigger_reviewer", scope: ["meta"] },
  { name: "sh_msg__send_to_worker", scope: ["meta"] },
  { name: "sh_msg__interrupt_worker", scope: ["meta"] },
  { name: "sh_msg__send_to_watcher", scope: ["meta"] },
  { name: "sh_msg__send_to_user", scope: ["meta"] },
  { name: "sh_msg__escalate_to_meta", scope: ["worker"] },
  { name: "sh_msg__notify_meta", scope: ["worker"] },
  { name: "sh_msg__declare_done_to_meta", scope: ["worker"] },
  { name: "sh_msg__observe_to_meta", scope: ["watcher"] },
  { name: "sh_inbox__pull", scope: ["meta", "worker", "watcher"] },
  { name: "sh_inbox__mark_responded", scope: ["meta", "worker"] },
  { name: "sh_inbox__inspect_worker_status", scope: ["meta"] },
  { name: "sh_reviewer__submit_verdict", scope: ["reviewer"] },
];

/** Return the tool names available to a role (used to scope before host startSession). */
export function toolNamesForRole(role: AgentRole): ReadonlyArray<string> {
  return TOOL_SCOPES.filter((t) => t.scope.includes(role)).map((t) => t.name);
}

/** All host tool names (for audit / tests). */
export function allHostToolNames(): ReadonlyArray<string> {
  return TOOL_SCOPES.map((t) => t.name);
}
