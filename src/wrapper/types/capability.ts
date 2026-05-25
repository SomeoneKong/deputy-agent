/**
 * The RuntimeCapabilities matrix plus compact helper types.
 *
 * Capabilities are per-provider (they do not vary by session). A missing capability causes the
 * wrapper to throw not_supported rather than silently degrading; the host checks before calling
 * an optional capability.
 */

export interface InjectCapability {
  readonly requireIdle: true;
  readonly steerIfStreaming: boolean;
  readonly followUpIfStreaming: boolean;
  readonly interruptThenInject: boolean;
}

export interface ContextUsageCapability {
  readonly kind: "none" | "basic" | "categorized";
  readonly supportsManualQuery: boolean;
  readonly supportsPushSnapshot: boolean;
  readonly fields: ReadonlyArray<"tokens" | "contextWindow" | "percent" | "categories">;
}

export interface CompactCapability {
  readonly canTrigger: boolean;
  readonly canObserveSummary: boolean;
  readonly canCustomizeSummary: boolean;
  readonly acceptsCustomInstructions: boolean;
}

export interface SessionResumeCapability {
  readonly fromProviderId: boolean;
  readonly fromFile: boolean;
  readonly forkAtEntry: boolean;
}

export interface ToolEnforcementCapability {
  readonly preflightHook: boolean;
  readonly firstClassBlock: boolean;
  readonly osSandboxWritableRoots: boolean;
  readonly canDisableHighRiskBuiltins: boolean;
}

export interface ProviderBuiltinToolsControlCapability {
  readonly canDisableAll: boolean;
  readonly canAllowList: boolean;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ThinkingCapability {
  readonly supportedLevels: ReadonlyArray<ThinkingLevel>;
  readonly supportsReasoningSummary: boolean;
  readonly reasoningSummaryNote?: string;
}

export interface AutoRetryCapability {
  readonly hasAutoRetry: boolean;
  readonly canDisable: boolean;
}

export type JsonSchemaFeature =
  | "primitive_types"
  | "enum"
  | "const"
  | "object"
  | "array"
  | "string_pattern"
  | "string_format"
  | "minmax_number"
  | "minmax_string"
  | "minmax_array"
  | "oneOf_2to4"
  | "anyOf_2to4"
  | "nested_object_d3";

export interface DiagnosticHint {
  readonly code: string;
  readonly description: string;
  readonly severity: "info" | "warn";
}

export interface RuntimeCapabilities {
  readonly inject: InjectCapability;
  readonly streamingDelta: boolean;
  readonly contextUsage: ContextUsageCapability;
  readonly compact: CompactCapability;
  readonly sessionResume: SessionResumeCapability;
  readonly toolEnforcement: ToolEnforcementCapability;
  readonly toolStreamingPartial: boolean;
  readonly providerBuiltinToolsControl: ProviderBuiltinToolsControlCapability;
  readonly thinking: ThinkingCapability;
  readonly autoRetry: AutoRetryCapability;
  readonly isolationSelfCheck: boolean;
  readonly jsonSchemaSubset: ReadonlyArray<JsonSchemaFeature>;
  readonly diagnosticHints?: ReadonlyArray<DiagnosticHint>;
}

export interface CompactHint {
  readonly customInstructions?: string;
  readonly targetTokens?: number;
  readonly preserveRecentTurns?: number;
}

export interface CompactOutcome {
  readonly success: boolean;
  readonly summary: string | undefined; // required when success === true
  /**
   * Failure discriminant when success === false (a provider-neutral field):
   * - `summary_unobservable`: compaction did happen (token count dropped) but the provider does not
   *   expose an observable summary. This is the only case where the host's lenient path may settle by
   *   synthesizing its own summary without retrying.
   * - `compact_not_performed`: compaction did not happen at all (timeout / RPC reject / provider
   *   refusal). The host should retry in both lenient and strict modes.
   * Undefined when success === true.
   */
  readonly failureKind?: "summary_unobservable" | "compact_not_performed";
  readonly firstKeptEntryId?: string;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly errorMessage?: string;
}
