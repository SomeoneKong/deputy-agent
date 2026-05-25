/**
 * Production host assembly -- combines the per-role provider->runtime map + production model/thinking/isolation
 * into a DaemonConfig.
 *
 * The background detached entry (daemonEntry), the foreground `--foreground` path (cli.runForeground), and
 * the dogfood smoke script all construct via this single factory, so runtime / model / isolation config
 * doesn't drift across multiple copies. Runtime construction triggers no auth (auth lands per-isolation at
 * session start), so this factory is safe to call in an environment without credentials.
 *
 * Lazy provider creation: first fill in default bindings for all 4 roles (claude + PRODUCTION_MODEL), then
 * create a runtime only for the providers that actually appear after normalization (no codex runtime built /
 * no codexHome read when no role binds codex). All provider runtimes share the same HostToolRegistry (the
 * host tool set is provider-neutral).
 *
 * Per-provider isolation: claude -> managed anthropic-oauth (claudeConfigDir picks the account profile);
 * codex -> managed openai-oauth (configDir=codexHome). Both share capsuleConfigDir = control (the capsule isolation root).
 */
import { createHostToolRegistry, claudeRuntimeFactory, codexRuntimeFactory, ALL_AGENT_ROLES, type AgentRuntime, type AgentRole, type ProviderId, type ModelSelector, type IsolationProfile } from "../wrapper/index.js";
import { runDaemon, PRODUCTION_MODEL, PRODUCTION_CODEX_MODEL, PRODUCTION_THINKING, HostExitCode, type DaemonConfig } from "../host/daemon.js";
import type { RoleBinding, WatcherCompactMode } from "../host/role_assembly.js";
import { manifestIO, type RoleBinding as ManifestRoleBinding, type RoleBindingMap } from "../shared/manifest.js";
import type { TaskCapsulePaths } from "../shared/paths.js";
import { CliExitCode } from "./errors.js";
import { loadProjectConfig, type RoleConfig } from "./config.js";

export { runDaemon };

/**
 * Load a task manifest's `roleBindings` for host assembly (priority chain).
 * Fail-soft: load failure (missing manifest / parse error) -> warn + return undefined, and assembly falls
 * back to project config / defaults (does not block host startup). Shared by the background detached entry
 * (daemonEntry) and the foreground `--foreground` path (cli.runForeground), so both honor per-task selection.
 */
export async function loadManifestRoleBindings(paths: TaskCapsulePaths): Promise<RoleBindingMap | undefined> {
  try {
    return (await manifestIO.load(paths)).roleBindings;
  } catch (err) {
    console.warn(
      `[productionHost] manifest load for roleBindings failed (fallback to project config/default): ${(err as Error).message}`,
    );
    return undefined;
  }
}

const ALL_ROLES: ReadonlyArray<AgentRole> = ALL_AGENT_ROLES;
const DEFAULT_PROVIDER: ProviderId = "claude";
/** Providers with an implemented runtime (currently only claude / codex). Other provider bindings fall back along the priority chain + warn. */
const IMPLEMENTED_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(["claude", "codex"]);

/** provider -> production default model. */
function productionModelForProvider(provider: ProviderId): ModelSelector {
  return provider === "codex" ? PRODUCTION_CODEX_MODEL : PRODUCTION_MODEL;
}

function claudeIsolation(paths: TaskCapsulePaths, claudeConfigDir: string | undefined): IsolationProfile {
  return {
    capsuleConfigDir: paths.control,
    promptLang: "en",
    authSource: { kind: "managed", provider: "anthropic-oauth", ...(claudeConfigDir !== undefined ? { configDir: claudeConfigDir } : {}) },
  };
}

/**
 * codex isolation: managed openai-oauth, configDir=codexHome (when absent the adapter falls back to ~/.codex
 * and copies auth.json into the capsule CODEX_HOME); capsuleConfigDir = control.
 *
 * sandbox.writableRoots=[workspace]: codex uses an OS sandbox (workspace-write) to bound its write scope, so
 * the codex role can write to workspace (otherwise sandboxPolicyOf defaults to readOnly and the worker can't
 * write). codex has no PreToolUse hook and doesn't consume pathGuards, so when codex acts as meta the harness
 * write protection is not enforced (additive writableRoots cannot express the harness's subtractive deny, so
 * under codex the harness path guard is advisory only). shell/network are passed through (equivalent to claude having no OS sandbox and
 * relying on writableRoots to bound writes).
 */
function codexIsolation(paths: TaskCapsulePaths, codexHome: string | undefined): IsolationProfile {
  return {
    capsuleConfigDir: paths.control,
    promptLang: "en",
    authSource: { kind: "managed", provider: "openai-oauth", ...(codexHome !== undefined ? { configDir: codexHome } : {}) },
    sandbox: {
      writableRoots: [paths.workspace],
      readableRoots: [],
      shellPolicy: "passthrough",
      networkPolicy: "passthrough",
    },
  };
}

/** Resolve per-provider isolation. */
function isolationForProvider(provider: ProviderId, paths: TaskCapsulePaths, claudeConfigDir: string | undefined, codexHome: string | undefined): IsolationProfile {
  return provider === "codex" ? codexIsolation(paths, codexHome) : claudeIsolation(paths, claudeConfigDir);
}

/**
 * Assemble a production DaemonConfig.
 *
 * Per-role provider resolution follows a priority chain (independent per role):
 *   `manifest.roleBindings[role]` (per-task, highest) > project config `roles[role]` > default (claude + PRODUCTION_MODEL).
 *
 * - No per-task selection and no roles config: a single claude provider runtime (shared HostToolRegistry) +
 *   PRODUCTION_MODEL/THINKING + capsule managed anthropic-oauth isolation (claudeConfigDir picks the account profile).
 * - Any source has a selection: first fill in all 4 role bindings via the priority chain, then lazily build a
 *   runtime for each provider that appears + assemble roleBindings + runtimes + per-provider isolation
 *   (claude -> anthropic-oauth; codex -> openai-oauth/codexHome).
 *
 * `manifestRoleBindings` is passed in by daemonEntry after loading the manifest. Callers may override test
 * fields on the return value (e.g. dogfood's maxTicks / tickIntervalMs).
 */
export function buildProductionDaemonConfig(
  paths: TaskCapsulePaths,
  projectRoot: string,
  manifestRoleBindings?: RoleBindingMap,
): DaemonConfig {
  const toolRegistry = createHostToolRegistry();
  const { claudeConfigDir, codexHome, roles } = loadProjectConfig(projectRoot);
  const isolation = claudeIsolation(paths, claudeConfigDir);

  const hasManifestBindings =
    manifestRoleBindings !== undefined && Object.keys(manifestRoleBindings).length > 0;

  // No per-task selection and no project roles -> single-provider shorthand.
  if (!hasManifestBindings && roles === undefined) {
    const runtime = claudeRuntimeFactory.create({ toolRegistry, providerSpecific: {} });
    return {
      paths,
      projectRoot,
      productionMode: true,
      runtime,
      toolRegistry,
      model: PRODUCTION_MODEL,
      thinking: PRODUCTION_THINKING,
      isolation,
    };
  }

  // Any source has a selection -> fill in all 4 role bindings via the priority chain, then lazily build runtimes for the providers that appear.
  const roleBindings: Record<AgentRole, RoleBinding> = {} as Record<AgentRole, RoleBinding>;
  for (const role of ALL_ROLES) {
    roleBindings[role] = resolveRoleBinding(role, manifestRoleBindings?.[role], roles?.[role]);
  }
  const usedProviders = new Set<ProviderId>(ALL_ROLES.map((r) => roleBindings[r].provider));

  const runtimes = new Map<ProviderId, AgentRuntime>();
  const isolationByProvider = new Map<ProviderId, IsolationProfile>();
  for (const provider of usedProviders) {
    // Lazily build a runtime for each provider that appears + resolve isolation per provider.
    runtimes.set(provider, createProviderRuntime(provider, toolRegistry));
    isolationByProvider.set(provider, isolationForProvider(provider, paths, claudeConfigDir, codexHome));
  }

  // Derive watcherCompactMode from the watcher-bound provider's capabilities: if the watcher runtime can't
  // observe the summary (e.g. codex) -> lenient (host manages the summary itself), otherwise default strict.
  // This keeps RoleResolver gating consistent with the lenient check at compact execution time (daemon.ts) --
  // otherwise the strict default would gate-miss a watcher provider that can't observe the summary and fall back to claude.
  const watcherRuntime = runtimes.get(roleBindings.watcher.provider);
  const watcherCompactMode: WatcherCompactMode | undefined =
    watcherRuntime !== undefined && watcherRuntime.capabilities.compact.canObserveSummary === false
      ? "lenient"
      : undefined;

  return {
    paths,
    projectRoot,
    productionMode: true,
    roleBindings,
    runtimes,
    isolationByProvider,
    toolRegistry,
    thinking: PRODUCTION_THINKING,
    isolation, // fallback template
    ...(watcherCompactMode !== undefined ? { watcherCompactMode } : {}),
  };
}

/**
 * Resolve a single role binding via the priority chain: manifest (per-task) > project config > default
 * (claude + PRODUCTION_MODEL). If a source's provider has no implemented runtime (not claude / codex) ->
 * warn + continue falling back to the next level.
 *
 * A manifest binding carries only a provider (model is always absent) -> use that provider's production
 * default model; a project config carries an explicit (provider, modelId).
 */
function resolveRoleBinding(
  role: AgentRole,
  manifestBinding: ManifestRoleBinding | undefined,
  projectCfg: RoleConfig | undefined,
): RoleBinding {
  if (manifestBinding !== undefined) {
    if (IMPLEMENTED_PROVIDERS.has(manifestBinding.provider)) {
      const model: ModelSelector =
        manifestBinding.model !== undefined
          ? { provider: manifestBinding.provider, modelId: manifestBinding.model }
          : productionModelForProvider(manifestBinding.provider);
      return { provider: manifestBinding.provider, model };
    }
    console.warn(
      `[productionHost] manifest.roleBindings.${role}.provider "${manifestBinding.provider}" has no runtime; falling back to project config / default`,
    );
  }
  if (projectCfg !== undefined) {
    if (IMPLEMENTED_PROVIDERS.has(projectCfg.provider)) {
      return { provider: projectCfg.provider, model: { provider: projectCfg.provider, modelId: projectCfg.modelId } };
    }
    console.warn(
      `[productionHost] project config roles.${role}.provider "${projectCfg.provider}" has no runtime; falling back to default`,
    );
  }
  return { provider: DEFAULT_PROVIDER, model: PRODUCTION_MODEL };
}

/**
 * Lazily build a provider's runtime. claude / codex share the same HostToolRegistry (the host tool set is
 * provider-neutral). The runtime construction layer triggers no auth (auth lands during startSession via
 * provisionAuth: codex copies auth.json from codexHome into the isolation root), so this factory constructs
 * safely even without credentials. Other providers (opencode / pi) throw a clear not-implemented error.
 */
function createProviderRuntime(
  provider: ProviderId,
  toolRegistry: ReturnType<typeof createHostToolRegistry>,
): AgentRuntime {
  if (provider === "claude") {
    return claudeRuntimeFactory.create({ toolRegistry, providerSpecific: {} });
  }
  if (provider === "codex") {
    return codexRuntimeFactory.create({ toolRegistry, providerSpecific: {} });
  }
  throw new Error(
    `provider "${provider}" runtime is not implemented; currently claude / codex are supported. Adjust the deputy.config.json roles binding, or wait for that adapter to be integrated.`,
  );
}

/**
 * Map a host exit code to a CLI exit code. A foreground host runs inside the CLI process, so the
 * host-perspective exit code must be translated to CLI semantics: host Fatal(2) -> CLI GeneralError(1)
 * (CLI exit code 2 is NOT_FOUND, a different meaning, so it can't be passed through); other codes pass
 * through unchanged. The background detached entry (daemonEntry) calls process.exit(host exit code) directly,
 * bypassing this mapping.
 */
export function hostExitToCliExit(code: HostExitCode): CliExitCode {
  switch (code) {
    case HostExitCode.Ok:
      return CliExitCode.Ok;
    case HostExitCode.SingleInstance:
      return CliExitCode.SingleInstance;
    case HostExitCode.Sigint:
      return CliExitCode.Sigint;
    case HostExitCode.Fatal:
    case HostExitCode.GeneralError:
    default:
      return CliExitCode.GeneralError;
  }
}
