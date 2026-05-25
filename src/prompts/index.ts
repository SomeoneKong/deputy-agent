/**
 * Prompt assets subsystem barrel.
 *
 * Three-layer (framework / role / template) prompt asset assembly + LITERALS + per-prompt lang fallback.
 */
export type { Lang, PromptLangResolver, ReviewerPhase, PromptLangFallbackDetails, AuditCallback } from "./lang.js";
export { setPromptLangFallbackAuditCallback } from "./lang.js";

export type { LiteralsKey } from "./literals.js";
export { LITERALS_EN, LITERALS_ZH, literals } from "./literals.js";

export { formatTemplate, checkAssetsOrFallback } from "./assets.js";

export type { PromptAssembler } from "./assembler.js";
export { promptAssembler } from "./assembler.js";

export type { FirstUserMessageAssembler } from "./firstMessage.js";
export { firstUserMessageAssembler } from "./firstMessage.js";

export type { RuntimePromptRenderer } from "./runtime.js";
export { runtimePromptRenderer } from "./runtime.js";

export { readRecentEventsSummaries } from "./events.js";
