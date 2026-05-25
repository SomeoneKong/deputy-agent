/**
 * Per-role provider→runtime assembly + resolution.
 *
 * The host holds two pieces of assembly data:
 *  - **provider → AgentRuntime map** (`runtimes`): one runtime instance per provider in use
 *    (lazily created and assembled by upper layers / tests; this module only consumes it).
 *  - **role → binding (provider, model)** (`roleBindings`): each role's selection; by default all
 *    bind to the same provider + default model.
 *
 * Before starting any agent session, `RoleResolver` resolves `(runtime, model, isolation)`:
 *  - runtime comes from the provider→runtime map;
 *  - consistency invariant: after normalization, `role binding provider === runtime.providerId ===
 *    model.provider` (all three agree); on mismatch, fail-soft (fall back to the default binding +
 *    log warn), never silently starting one provider's model on another provider's runtime.
 *  - capability gating (selection ≠ startup): the resolved runtime must satisfy the role's required
 *    capabilities; on a miss, no silent fallback — fall back to the default binding + warn; if there
 *    is no default to fall back to (the default binding itself lacks the capability), throw a clear error.
 *
 * isolation is resolved per provider (different providers have different credentials / isolation
 * shapes): each provider's isolation template is injected by the upper layer via `isolationByProvider`
 * (claude → anthropic-oauth; codex → openai-oauth + sandbox writableRoots); providers not in the map
 * fall back to `fallbackIsolation`. This module is provider-neutral and only consumes that map.
 */
import {
  ALL_AGENT_ROLES,
  type AgentRole,
  type AgentRuntime,
  type ModelSelector,
  type ProviderId,
  type RuntimeCapabilities,
  type SessionRequest,
} from "../wrapper/index.js";

export type IsolationProfile = SessionRequest["isolation"];

/** A single role's binding (provider, model). */
export interface RoleBinding {
  readonly provider: ProviderId;
  readonly model: ModelSelector;
}

/** Watcher proactive-compact dryrun mode. strict needs observe+customize summary; lenient needs only canTrigger. */
export type WatcherCompactMode = "strict" | "lenient";

/** All agent roles (for gating / resolution iteration); sourced from wrapper common ALL_AGENT_ROLES. */
export const ALL_ROLES: ReadonlyArray<AgentRole> = ALL_AGENT_ROLES;

/** Default provider (when no roleBindings, all roles resolve to a single runtime + model). */
export const DEFAULT_PROVIDER: ProviderId = "claude";

/** A resolved assembly (handed to startSession). */
export interface ResolvedRoleAssembly {
  readonly runtime: AgentRuntime;
  readonly model: ModelSelector;
  readonly isolation: IsolationProfile;
}

/** Single-provider shorthand. */
export interface SingleProviderConfig {
  readonly runtime: AgentRuntime;
  readonly model: ModelSelector;
  readonly isolation: IsolationProfile;
}

/** Per-role assembly config (multi-provider). */
export interface MultiProviderConfig {
  readonly roleBindings: Readonly<Record<AgentRole, RoleBinding>>;
  readonly runtimes: ReadonlyMap<ProviderId, AgentRuntime>;
  /** Per-provider isolation templates (resolving authSource etc. per provider). Missing providers use fallbackIsolation. */
  readonly isolationByProvider?: ReadonlyMap<ProviderId, IsolationProfile>;
}

export interface RoleResolverConfig {
  /** Single-provider shorthand (used when multi is not provided). */
  readonly single?: SingleProviderConfig;
  /** Multi-provider assembly (takes priority). */
  readonly multi?: MultiProviderConfig;
  /** Isolation fallback template (capsule isolation root etc.); used in multi when there is no per-provider template, and may also be omitted in single (provided by single.isolation). */
  readonly fallbackIsolation: IsolationProfile;
  /** Watcher compact dryrun mode (default strict). */
  readonly watcherCompactMode?: WatcherCompactMode;
  /** Whether production mode (affects meta path-guard gating: only production mode requires the path-guard capability). Default false (tests). */
  readonly productionMode?: boolean;
  /** log warn hook (default console.warn). */
  readonly warn?: (msg: string) => void;
}

/** Thrown when capability gating fails and there is no default to fall back to (a clear startup-time config error). */
export class RoleAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleAssemblyError";
  }
}

/**
 * Validate startup-time config: if multi.roleBindings is provided, multi.runtimes must cover all
 * bound providers. On failure throws RoleAssemblyError (a clear startup-time config error). The
 * single shorthand needs no validation.
 */
export function validateRoleAssemblyConfig(config: RoleResolverConfig): void {
  if (config.multi === undefined) {
    if (config.single === undefined) {
      throw new RoleAssemblyError("role assembly: neither single nor multi provider config provided");
    }
    return;
  }
  const { roleBindings, runtimes } = config.multi;
  for (const role of ALL_ROLES) {
    const binding = roleBindings[role];
    if (binding === undefined) {
      throw new RoleAssemblyError(`role assembly: roleBindings missing role "${role}"`);
    }
    if (!runtimes.has(binding.provider)) {
      throw new RoleAssemblyError(
        `role assembly: runtimes missing provider "${binding.provider}" bound by role "${role}"`,
      );
    }
    if (binding.model.provider !== binding.provider) {
      throw new RoleAssemblyError(
        `role assembly: role "${role}" binding model.provider (${binding.model.provider}) !== binding.provider (${binding.provider})`,
      );
    }
  }
}

/**
 * Per-role resolver. The host calls `resolve(role)` before starting any session to get
 * (runtime, model, isolation). Resolution includes the consistency-invariant check + capability
 * gating (fail-soft fallback to the default binding + warn).
 */
export class RoleResolver {
  readonly #config: RoleResolverConfig;
  readonly #warn: (msg: string) => void;
  readonly #watcherCompactMode: WatcherCompactMode;
  readonly #productionMode: boolean;

  constructor(config: RoleResolverConfig) {
    validateRoleAssemblyConfig(config);
    this.#config = config;
    this.#warn = config.warn ?? ((m) => console.warn(m));
    this.#watcherCompactMode = config.watcherCompactMode ?? "strict";
    this.#productionMode = config.productionMode ?? false;
  }

  /** Default binding's runtime (the fallback target for capability-gating fail-soft). single → single.runtime; multi → DEFAULT_PROVIDER in runtimes. */
  #defaultRuntime(): AgentRuntime | null {
    if (this.#config.multi === undefined) return this.#config.single?.runtime ?? null;
    return this.#config.multi.runtimes.get(DEFAULT_PROVIDER) ?? null;
  }

  #defaultModel(): ModelSelector | null {
    if (this.#config.multi === undefined) return this.#config.single?.model ?? null;
    // Default binding model: take the model of any role bound to DEFAULT_PROVIDER; otherwise construct a default claude model.
    for (const role of ALL_ROLES) {
      const b = this.#config.multi.roleBindings[role];
      if (b.provider === DEFAULT_PROVIDER) return b.model;
    }
    return null;
  }

  /** Resolve a role's binding (multi → roleBindings[role]; single → DEFAULT_PROVIDER + single.model). */
  #binding(role: AgentRole): RoleBinding {
    if (this.#config.multi === undefined) {
      const single = this.#config.single!;
      return { provider: single.model.provider, model: single.model };
    }
    return this.#config.multi.roleBindings[role];
  }

  /** Resolve isolation per provider. multi uses the per-provider template if present; otherwise fallbackIsolation. */
  #isolationFor(provider: ProviderId): IsolationProfile {
    if (this.#config.multi === undefined) {
      return this.#config.single?.isolation ?? this.#config.fallbackIsolation;
    }
    // Per-provider templates are injected by the upper layer (claude → anthropic-oauth; codex →
    // openai-oauth + sandbox writableRoots); providers not in the map fall back to fallbackIsolation.
    return this.#config.multi.isolationByProvider?.get(provider) ?? this.#config.fallbackIsolation;
  }

  #runtimeForProvider(provider: ProviderId): AgentRuntime | null {
    if (this.#config.multi === undefined) {
      return this.#config.single?.runtime ?? null;
    }
    return this.#config.multi.runtimes.get(provider) ?? null;
  }

  /**
   * Resolve a role's assembly. Flow: get binding → get runtime → consistency invariant +
   * capability gating; on any miss → fail-soft fallback to the default binding (claude) + warn;
   * if the default binding itself fails → throw RoleAssemblyError.
   */
  resolve(role: AgentRole): ResolvedRoleAssembly {
    const binding = this.#binding(role);
    const runtime = this.#runtimeForProvider(binding.provider);

    // Consistency invariant: runtime exists and providerId === binding.provider === model.provider.
    const invariantOk =
      runtime !== null &&
      runtime.providerId === binding.provider &&
      binding.model.provider === binding.provider;

    if (!invariantOk) {
      this.#warn(
        `[role_assembly] role "${role}" assembly inconsistency (binding provider=${binding.provider}, model.provider=${binding.model.provider}, runtime=${runtime?.providerId ?? "missing"}); falling back to default binding (${DEFAULT_PROVIDER})`,
      );
      return this.#resolveDefaultOrThrow(role, `assembly inconsistency for role "${role}"`);
    }

    const gateMiss = checkRoleCapabilities(runtime.capabilities, role, {
      watcherCompactMode: this.#watcherCompactMode,
      productionMode: this.#productionMode,
    });
    if (gateMiss !== null) {
      this.#warn(
        `[role_assembly] role "${role}" runtime (provider=${runtime.providerId}) missing capability: ${gateMiss}; falling back to default binding (${DEFAULT_PROVIDER})`,
      );
      return this.#resolveDefaultOrThrow(role, `capability gate miss for role "${role}": ${gateMiss}`);
    }

    return { runtime, model: binding.model, isolation: this.#isolationFor(binding.provider) };
  }

  /** Fall back to the default binding (claude); if the default binding is missing / lacks the capability → throw RoleAssemblyError (no silent fallback). */
  #resolveDefaultOrThrow(role: AgentRole, why: string): ResolvedRoleAssembly {
    const runtime = this.#defaultRuntime();
    const model = this.#defaultModel();
    if (runtime === null || model === null) {
      throw new RoleAssemblyError(
        `role assembly: ${why}; no default (${DEFAULT_PROVIDER}) binding available to fall back to`,
      );
    }
    if (runtime.providerId !== DEFAULT_PROVIDER || model.provider !== DEFAULT_PROVIDER) {
      throw new RoleAssemblyError(
        `role assembly: ${why}; default binding inconsistent (runtime=${runtime.providerId}, model=${model.provider})`,
      );
    }
    const gateMiss = checkRoleCapabilities(runtime.capabilities, role, {
      watcherCompactMode: this.#watcherCompactMode,
      productionMode: this.#productionMode,
    });
    if (gateMiss !== null) {
      throw new RoleAssemblyError(
        `role assembly: ${why}; default (${DEFAULT_PROVIDER}) binding also misses capability for role "${role}": ${gateMiss}`,
      );
    }
    return { runtime, model, isolation: this.#isolationFor(DEFAULT_PROVIDER) };
  }
}

export interface CapabilityGateOpts {
  readonly watcherCompactMode: WatcherCompactMode;
  readonly productionMode: boolean;
}

/**
 * Mode-aware role capability gating. Returns null if satisfied; returns a string describing the
 * missing capability (the first miss).
 *
 * Required capabilities per role (selection ≠ startup):
 *  - meta: inject.interruptThenInject (interrupt-then-inject strategy) + a path-guard guardrail
 *    tier (required only in production mode: any write-constraint mechanism
 *    toolEnforcement.preflightHook || firstClassBlock || osSandboxWritableRoots) +
 *    thinking.supportsReasoningSummary. harness-subtree write protection strength varies by
 *    provider (Claude preflightHook enforces a built-in-tool deny; Codex has only workspace-level
 *    OS sandbox with no harness-subtree deny, so the harness path guard is advisory only).
 *  - watcher: proactive compact per dryrun mode — strict needs compact.canObserveSummary &&
 *    canCustomizeSummary; lenient needs only compact.canTrigger.
 *  - worker / reviewer: no additional hard capability requirements (basic inject.requireIdle is
 *    guaranteed always true by contract).
 */
export function checkRoleCapabilities(
  caps: RuntimeCapabilities,
  role: AgentRole,
  opts: CapabilityGateOpts,
): string | null {
  if (role === "meta") {
    if (!caps.inject.interruptThenInject) return "inject.interruptThenInject";
    if (
      opts.productionMode &&
      !(
        caps.toolEnforcement.preflightHook ||
        caps.toolEnforcement.firstClassBlock ||
        caps.toolEnforcement.osSandboxWritableRoots
      )
    ) {
      return "path guard (toolEnforcement.preflightHook || firstClassBlock || osSandboxWritableRoots)";
    }
    if (!caps.thinking.supportsReasoningSummary) return "thinking.supportsReasoningSummary";
    return null;
  }
  if (role === "watcher") {
    if (opts.watcherCompactMode === "strict") {
      if (!(caps.compact.canObserveSummary && caps.compact.canCustomizeSummary)) {
        return "compact.canObserveSummary && compact.canCustomizeSummary (strict watcher compact mode)";
      }
    } else {
      if (!caps.compact.canTrigger) return "compact.canTrigger (lenient watcher compact mode)";
    }
    return null;
  }
  // worker / reviewer: no additional hard capability gating
  return null;
}
