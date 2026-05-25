/**
 * Concrete RuntimeCapabilities values for the Claude provider.
 *
 * When `tsApiUnverified` is true, diagnosticHints are attached so the host does
 * not schedule these capabilities as stable production behavior before live
 * verification.
 */
import type { DiagnosticHint, RuntimeCapabilities } from "../../types/index.js";
import { CLAUDE_THINKING_LEVELS } from "./config.js";

const TS_API_UNVERIFIED_HINTS: ReadonlyArray<DiagnosticHint> = [
  {
    code: "claude_ts_api_unverified",
    description:
      "The Claude adapter's TS SDK surface (in-process MCP / thinking fields / PreCompact and PreToolUse hooks / autoRetry and autoCompact disable channels) " +
      "has not been verified against the live API; run a live smoke test before scheduling these in production. " +
      "autoRetry.canDisable reports false for now (the disable channel is unverified). Set providerSpecific.tsApiUnverified=false to remove this hint.",
    severity: "warn",
  },
];

/**
 * Claude capability baseline. `supportedLevels` is the full set for a typical
 * model; levels a specific model does not support are rejected with
 * not_supported during startSession. Capability here is the provider-level upper bound.
 */
export function buildClaudeCapabilities(tsApiUnverified: boolean): RuntimeCapabilities {
  const base: RuntimeCapabilities = {
    inject: { requireIdle: true, steerIfStreaming: false, followUpIfStreaming: false, interruptThenInject: true },
    streamingDelta: true,
    contextUsage: {
      kind: "categorized",
      supportsManualQuery: true,
      supportsPushSnapshot: true,
      fields: ["tokens", "contextWindow", "percent", "categories"],
    },
    compact: { canTrigger: true, canObserveSummary: true, canCustomizeSummary: true, acceptsCustomInstructions: true },
    sessionResume: { fromProviderId: false, fromFile: false, forkAtEntry: false },
    toolEnforcement: {
      preflightHook: true,
      firstClassBlock: false,
      osSandboxWritableRoots: false,
      canDisableHighRiskBuiltins: true,
    },
    toolStreamingPartial: false,
    providerBuiltinToolsControl: { canDisableAll: true, canAllowList: true },
    thinking: { supportedLevels: CLAUDE_THINKING_LEVELS, supportsReasoningSummary: true },
    // canDisable=false: the TS SDK retry-disable channel is unverified, so report
    // it as non-disableable rather than advertising a capability we cannot honor
    // (host requesting autoRetry:false will fail-fast with not_supported).
    autoRetry: { hasAutoRetry: true, canDisable: false },
    isolationSelfCheck: true,
    jsonSchemaSubset: [
      "primitive_types",
      "enum",
      "const",
      "object",
      "array",
      "string_pattern",
      "minmax_number",
      "minmax_string",
      "minmax_array",
      "nested_object_d3",
    ],
  };
  if (tsApiUnverified) {
    return { ...base, diagnosticHints: TS_API_UNVERIFIED_HINTS };
  }
  return base;
}
