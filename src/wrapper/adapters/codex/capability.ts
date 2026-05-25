/**
 * The actual RuntimeCapabilities values for Codex (the single source of truth).
 *
 * Uncertain items take conservative values until verified; unverified isolation / oauth provision
 * are surfaced as warn diagnosticHints for consumption by integration dry-runs / production
 * admission checks. jsonSchemaSubset is the full set (Codex dynamicTools / MCP consume JSON Schema
 * directly, with no translation loss).
 */
import type { DiagnosticHint, JsonSchemaFeature, RuntimeCapabilities } from "../../types/index.js";
import { CODEX_THINKING_LEVELS } from "./config.js";

/** The full set of JsonSchemaFeature values (Codex does not restrict any). */
const JSON_SCHEMA_FULL: ReadonlyArray<JsonSchemaFeature> = [
  "primitive_types",
  "enum",
  "const",
  "object",
  "array",
  "string_pattern",
  "string_format",
  "minmax_number",
  "minmax_string",
  "minmax_array",
  "oneOf_2to4",
  "anyOf_2to4",
  "nested_object_d3",
];

/** Isolation warn hints that remain until the corresponding behavior is verified. */
const CODEX_DIAGNOSTIC_HINTS: ReadonlyArray<DiagnosticHint> = [
  {
    code: "codex_isolation_transport_unverified",
    description: "in app-server mode, the transport for the two isolation switches and non-interactive approval is not yet verified",
    severity: "warn",
  },
  {
    code: "codex_oauth_provision_unverified",
    description:
      "the mechanism for copying openai-oauth auth.json into the isolation-root CODEX_HOME is implemented; live behavior (app-server auth acceptance / token refresh / cleanup) is not yet verified against a real account",
    severity: "warn",
  },
  {
    code: "codex_builtin_tools_control_unimplemented",
    description:
      "the app-server has no verified thread/start config path to disable the built-in shell/apply_patch tools or to install a PreToolUse guard; preflightHook / canDisableHighRiskBuiltins / providerBuiltinToolsControl are reported as false rather than silently claiming support",
    severity: "warn",
  },
];

export function buildCodexCapabilities(): RuntimeCapabilities {
  return {
    inject: {
      requireIdle: true,
      steerIfStreaming: true, // turn/steer
      followUpIfStreaming: false, // not yet verified whether thread/inject_items is equivalent to follow-up queueing
      interruptThenInject: true, // turn/interrupt -> wait turn/completed -> turn/start
    },
    streamingDelta: true, // item delta (agentMessage / reasoning delta)
    contextUsage: {
      kind: "basic", // not Claude-style categorized
      supportsManualQuery: true, // returns synchronously from the most recent thread/tokenUsage/updated snapshot
      supportsPushSnapshot: true, // thread/tokenUsage/updated -> UsageSnapshotEvent
      fields: ["tokens", "contextWindow", "percent"],
    },
    compact: {
      canTrigger: true, // thread/compact/start
      canObserveSummary: false, // not yet verified whether the contextCompaction item carries a summary
      canCustomizeSummary: false, // no Claude-style PreCompact / hook customization
      acceptsCustomInstructions: false, // thread/compact/start has no instructions field (not silently dropped)
    },
    sessionResume: {
      fromProviderId: true, // thread/resume
      fromFile: false, // jsonl resume not confirmed in the SDK mainline
      forkAtEntry: false, // fork-at-entry not confirmed
    },
    toolEnforcement: {
      preflightHook: false, // no PreToolUse guard path implemented (see codex_builtin_tools_control_unimplemented)
      firstClassBlock: false,
      osSandboxWritableRoots: true, // implemented via turn/start sandboxPolicy.workspaceWrite.writableRoots
      canDisableHighRiskBuiltins: false, // no verified path to disable the built-in shell/apply_patch tools
    },
    toolStreamingPartial: false, // dynamicTools partial onUpdate pass-through not yet verified
    providerBuiltinToolsControl: { canDisableAll: false, canAllowList: false }, // featureFlags.providerBuiltinTools path not implemented
    thinking: {
      supportedLevels: CODEX_THINKING_LEVELS, // the actual enum subset depends on the model; re-validated at startSession
      supportsReasoningSummary: true, // reasoning item
    },
    autoRetry: { hasAutoRetry: true, canDisable: true },
    isolationSelfCheck: true,
    jsonSchemaSubset: JSON_SCHEMA_FULL,
    diagnosticHints: CODEX_DIAGNOSTIC_HINTS,
  };
}
