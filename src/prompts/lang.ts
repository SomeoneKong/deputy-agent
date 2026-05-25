/**
 * Prompt primary language type + per-prompt whole-role fallback audit hook.
 *
 * - `Lang` supports only `en` / `zh` (subset of ISO 639-1).
 * - `PromptLangResolver` is a host-side runtime primitive contract (the concrete model -> lang mapping lives elsewhere).
 * - On fallback, the callback injected via `setPromptLangFallbackAuditCallback` writes a `prompt_lang_fallback`
 *   event; assembly holds no paths reference (to avoid breaking layering) and only passes details to the caller.
 */
import type { AgentRole } from "../wrapper/types/index.js";

export type Lang = "en" | "zh";

export interface PromptLangResolver {
  promptLangForRole(role: AgentRole): Lang;
}

export type ReviewerPhase = "bootstrap_self_review" | "final_review" | "harness_revision_review";

/**
 * Fallback details -- **no model field** (model ownership belongs to the host / lang resolver and
 * does not enter assembly fallback details; an audit caller that needs the model can add it inside
 * its own callback).
 */
export interface PromptLangFallbackDetails {
  readonly role: AgentRole;
  readonly requestedLang: Lang;
  /** Always "en" (en is the fallback terminal). */
  readonly usedLang: Lang;
  readonly missingAssets: ReadonlyArray<string>;
}

/** Caller may be sync / async; the fallback path awaits the returned Promise but guards it with try/catch. */
export type AuditCallback = (details: PromptLangFallbackDetails) => void | Promise<void>;

let auditCallback: AuditCallback | null = null;

/** Inject the events.jsonl audit callback (called at host startup); pass `null` to clear (for test isolation). */
export function setPromptLangFallbackAuditCallback(cb: AuditCallback | null): void {
  auditCallback = cb;
}

/** Internal: invoke the injected callback on fallback; persistence failure only warns, does not propagate. */
export async function emitPromptLangFallbackAudit(details: PromptLangFallbackDetails): Promise<void> {
  if (auditCallback === null) return;
  try {
    await auditCallback(details);
  } catch (exc) {
    console.warn(`prompt_lang_fallback audit callback failed: ${String(exc)}`);
  }
}
