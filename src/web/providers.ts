/**
 * Provider selection metadata for the new-task form.
 *
 * Pure static derivation for `GET /api/providers`: derives the (role × provider) capability matrix and the
 * provider / fixed-model list from provider capability declarations plus per-role capability gating
 * (checkRoleCapabilities). Reads no task data and depends on no online host, so it can be computed safely
 * inside the web process. Capability gating logic is reused from the host assembly module (single source).
 */
import {
  createHostToolRegistry,
  claudeRuntimeFactory,
  codexRuntimeFactory,
  ALL_AGENT_ROLES,
  type AgentRole,
  type ProviderId,
  type RuntimeCapabilities,
} from "../wrapper/index.js";
import { checkRoleCapabilities } from "../host/role_assembly.js";
import { PRODUCTION_MODEL, PRODUCTION_CODEX_MODEL } from "../host/daemon.js";

const ROLES: ReadonlyArray<AgentRole> = ALL_AGENT_ROLES;
const DEFAULT_PROVIDER: ProviderId = "claude";

const LENIENT_NOTE = "Manual compact in lenient mode only: the host self-manages context summaries (no impact on delivery quality)";
const META_NO_PATH_GUARD_NOTE = "This provider cannot enforce harness path guards; the constraint is advisory only";

interface ProviderDef {
  readonly provider: ProviderId;
  readonly label: string;
  readonly modelId: string;
}

/** Available providers + fixed model (model selection is a reserved capability, fixed in the UI). */
const PROVIDER_DEFS: ReadonlyArray<ProviderDef> = [
  { provider: "claude", label: "Claude", modelId: PRODUCTION_MODEL.modelId },
  { provider: "codex", label: "Codex", modelId: PRODUCTION_CODEX_MODEL.modelId },
];

export interface ModelChoiceDto {
  readonly modelId: string;
  readonly label: string;
  readonly fixed: true;
}

export interface ProviderChoiceDto {
  readonly provider: ProviderId;
  readonly label: string;
  readonly models: ModelChoiceDto[];
}

export interface RoleProviderSupportDto {
  readonly support: "ok" | "limited" | "unsupported";
  readonly note?: string;
}

export interface ProvidersDto {
  readonly roles: AgentRole[];
  readonly defaultProvider: ProviderId;
  readonly providers: ProviderChoiceDto[];
  readonly capabilityMatrix: Record<AgentRole, Record<ProviderId, RoleProviderSupportDto>>;
}

/** Read a provider's capability declaration (runtime construction does not trigger auth, so it is safe to call). */
function capabilitiesOf(provider: ProviderId): RuntimeCapabilities {
  const toolRegistry = createHostToolRegistry();
  const runtime =
    provider === "codex"
      ? codexRuntimeFactory.create({ toolRegistry, providerSpecific: {} })
      : claudeRuntimeFactory.create({ toolRegistry, providerSpecific: {} });
  return runtime.capabilities;
}

/**
 * (role, provider) capability fit (consistent with the gating + watcherCompactMode derivation):
 *  - watcher: provider cannot observe summary → derive lenient; if lenient is satisfied → limited (host self-manages
 *    summaries), else unsupported. Can observe summary → strict; satisfied → ok, else unsupported.
 *  - meta: after strict gating passes, if the provider has no PreToolUse / first-class block (cannot enforce harness
 *    write protection, only an OS sandbox restricts write scope, e.g. codex) → limited; if it can
 *    enforce harness write protection (claude preflightHook) → ok.
 *  - other roles: strict-mode gating; satisfied → ok, else unsupported (with a missing-capability note).
 */
function supportFor(caps: RuntimeCapabilities, role: AgentRole): RoleProviderSupportDto {
  if (role === "watcher") {
    if (!caps.compact.canObserveSummary) {
      const miss = checkRoleCapabilities(caps, "watcher", { watcherCompactMode: "lenient", productionMode: true });
      return miss === null ? { support: "limited", note: LENIENT_NOTE } : { support: "unsupported", note: `Missing capability: ${miss}` };
    }
    const miss = checkRoleCapabilities(caps, "watcher", { watcherCompactMode: "strict", productionMode: true });
    return miss === null ? { support: "ok" } : { support: "unsupported", note: `Missing capability: ${miss}` };
  }
  const miss = checkRoleCapabilities(caps, role, { watcherCompactMode: "strict", productionMode: true });
  if (miss !== null) return { support: "unsupported", note: `Missing capability: ${miss}` };
  if (role === "meta" && !(caps.toolEnforcement.preflightHook || caps.toolEnforcement.firstClassBlock)) {
    return { support: "limited", note: META_NO_PATH_GUARD_NOTE };
  }
  return { support: "ok" };
}

/** Module-level cache: the DTO is a pure static derivation (provider capability declarations + gating, task-independent), so compute it once. */
let cachedDto: ProvidersDto | undefined;

export function buildProvidersDto(): ProvidersDto {
  if (cachedDto !== undefined) return cachedDto;
  cachedDto = computeProvidersDto();
  return cachedDto;
}

function computeProvidersDto(): ProvidersDto {
  const capsByProvider = new Map<ProviderId, RuntimeCapabilities>();
  for (const def of PROVIDER_DEFS) capsByProvider.set(def.provider, capabilitiesOf(def.provider));

  const providers: ProviderChoiceDto[] = PROVIDER_DEFS.map((def) => ({
    provider: def.provider,
    label: def.label,
    models: [{ modelId: def.modelId, label: def.modelId, fixed: true }],
  }));

  const capabilityMatrix = {} as Record<AgentRole, Record<ProviderId, RoleProviderSupportDto>>;
  for (const role of ROLES) {
    const row = {} as Record<ProviderId, RoleProviderSupportDto>;
    for (const def of PROVIDER_DEFS) row[def.provider] = supportFor(capsByProvider.get(def.provider)!, role);
    capabilityMatrix[role] = row;
  }

  return { roles: [...ROLES], defaultProvider: DEFAULT_PROVIDER, providers, capabilityMatrix };
}
