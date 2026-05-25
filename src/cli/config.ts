/**
 * Project-level config file `<projectRoot>/deputy.config.json`.
 *
 * Project-scoped (shared by all tasks under the same projectRoot); read by buildProductionDaemonConfig
 * to assemble the DaemonConfig. Fail-soft: missing file / parse failure / invalid field type ->
 * log warn + fall back to defaults (does not block host startup).
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { ALL_AGENT_ROLES, ALL_PROVIDER_IDS, type AgentRole, type ProviderId } from "../wrapper/index.js";

export const PROJECT_CONFIG_FILENAME = "deputy.config.json";

/** Known provider / role sets (for roles validation; sourced from wrapper common). */
const KNOWN_PROVIDERS: ReadonlySet<string> = new Set<string>(ALL_PROVIDER_IDS);
const KNOWN_ROLES: ReadonlySet<string> = new Set<string>(ALL_AGENT_ROLES);

/** per-role provider+model binding (modelId aligns with ModelSelector { provider, modelId }). */
export interface RoleConfig {
  readonly provider: ProviderId;
  readonly modelId: string;
}

export interface ProjectConfig {
  /** Claude profile directory (contains .credentials.json). Relative paths resolve against projectRoot; when absent the adapter falls back to ~/.claude. */
  readonly claudeConfigDir?: string;
  /**
   * Codex account auth source directory (where the OpenAI OAuth profile / auth.json lives), used only
   * when a role is bound to codex. Relative paths resolve against projectRoot. Not the runtime isolation
   * CODEX_HOME (which the codex adapter derives from the capsule isolation root).
   */
  readonly codexHome?: string;
  /** per-role (provider, modelId) bindings; roles left out use the default binding (all Claude + default model). Invalid bindings fall back to the default + warn. */
  readonly roles?: Partial<Record<AgentRole, RoleConfig>>;
}

/**
 * Read and parse the project config, with path fields normalized (relative -> absolute against projectRoot).
 * Missing file / invalid JSON / invalid field type all fail-soft (warn), returning an empty config or one
 * with only the valid fields.
 */
export function loadProjectConfig(projectRoot: string): ProjectConfig {
  const path = join(projectRoot, PROJECT_CONFIG_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {}; // A missing file is normal (most users rely on defaults) -> fall back silently, no warn.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[config] ${PROJECT_CONFIG_FILENAME} JSON parse failed, falling back to defaults: ${(err as Error).message}`);
    return {};
  }
  if (parsed === null || typeof parsed !== "object") {
    console.warn(`[config] ${PROJECT_CONFIG_FILENAME} top level is not an object, falling back to defaults`);
    return {};
  }
  const obj = parsed as Record<string, unknown>;
  const out: { claudeConfigDir?: string; codexHome?: string; roles?: Partial<Record<AgentRole, RoleConfig>> } = {};

  const dir = parsePathField(obj.claudeConfigDir, "claudeConfigDir", projectRoot);
  if (dir !== undefined) out.claudeConfigDir = dir;
  const codex = parsePathField(obj.codexHome, "codexHome", projectRoot);
  if (codex !== undefined) out.codexHome = codex;

  const roles = parseRoles(obj.roles);
  if (roles !== undefined) out.roles = roles;

  return out;
}

function parsePathField(value: unknown, field: string, projectRoot: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.length > 0) {
    return isAbsolute(value) ? value : resolve(projectRoot, value);
  }
  console.warn(`[config] ${PROJECT_CONFIG_FILENAME} ${field} is invalid (must be a non-empty string), ignoring this field`);
  return undefined;
}

/** Parse roles: each binding requires a known provider + non-empty modelId; invalid roles are skipped + warned (no overall failure). */
function parseRoles(value: unknown): Partial<Record<AgentRole, RoleConfig>> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    console.warn(`[config] ${PROJECT_CONFIG_FILENAME} roles is not an object, ignoring`);
    return undefined;
  }
  const out: Partial<Record<AgentRole, RoleConfig>> = {};
  let any = false;
  for (const [role, binding] of Object.entries(value as Record<string, unknown>)) {
    if (!KNOWN_ROLES.has(role)) {
      console.warn(`[config] ${PROJECT_CONFIG_FILENAME} roles contains unknown role "${role}", ignoring`);
      continue;
    }
    if (binding === null || typeof binding !== "object") {
      console.warn(`[config] ${PROJECT_CONFIG_FILENAME} roles.${role} is not an object, falling back to default binding`);
      continue;
    }
    const b = binding as Record<string, unknown>;
    const provider = b.provider;
    const modelId = b.modelId;
    if (typeof provider !== "string" || !KNOWN_PROVIDERS.has(provider)) {
      console.warn(`[config] ${PROJECT_CONFIG_FILENAME} roles.${role}.provider is invalid (unknown provider), falling back to default binding`);
      continue;
    }
    if (typeof modelId !== "string" || modelId.length === 0) {
      console.warn(`[config] ${PROJECT_CONFIG_FILENAME} roles.${role}.modelId is invalid (must be a non-empty string), falling back to default binding`);
      continue;
    }
    out[role as AgentRole] = { provider: provider as ProviderId, modelId };
    any = true;
  }
  return any ? out : undefined;
}
