/**
 * Applies an IsolationProfile to the Codex app-server.
 *
 * - Subprocess env `CODEX_HOME=<capsuleConfigDir>/codex` (per-process env isolation);
 * - The two isolation hard switches (disable user-config / disable rules) are passed via the thread/start config path (transport not yet verified);
 * - sandbox.writableRoots -> TurnStartParams.sandboxPolicy.workspaceWrite.writableRoots;
 * - envAllowList filtering; authSource managed/openai-oauth -> copy auth.json from the account source directory (configDir / default ~/.codex) into the isolation root (credentials only, not config);
 * - self-check compares against InitializeResponse.codexHome.
 */
import { mkdir, writeFile, copyFile, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve as pathResolve, join } from "node:path";

import type {
  IsolationProfile,
  IsolationFinding,
  IsolationSelfCheckResult,
  ProviderId,
} from "../../types/index.js";
import { RuntimeErrorImpl } from "../../types/index.js";
import type { InitializeResponse, JsonValue, SandboxPolicy as CodexSandboxPolicy } from "./protocol.js";

const PROVIDER: ProviderId = "codex";

/** The capsule's isolation-root CODEX_HOME path. */
export function codexHomeOf(profile: IsolationProfile): string {
  return pathResolve(join(profile.capsuleConfigDir, "codex"));
}

/** Build the env for spawning the app-server subprocess (per-process isolation, envAllowList filtering). */
export function buildChildEnv(profile: IsolationProfile): Record<string, string> {
  // The adapter pins CODEX_HOME to the isolation root; envAllowList must not include CODEX_HOME
  // (otherwise it would conflict with / override the isolation root, and "happens to be safe" cannot
  // be relied on) -> fail-fast.
  if ((profile.envAllowList ?? []).includes("CODEX_HOME")) {
    throw new RuntimeErrorImpl({
      kind: "permanent",
      subKind: "isolation_violation_env_conflict",
      providerId: PROVIDER,
      message: "isolation: envAllowList must not include CODEX_HOME (adapter pins it to the per-capsule isolation root)",
      diagnostics: { conflictingVar: "CODEX_HOME", capsuleConfigDir: profile.capsuleConfigDir },
    });
  }
  const env: Record<string, string> = {};
  // Always pass only the required essentials + allowlist (do not inherit all of process.env).
  const essentials = ["PATH", "Path", "SystemRoot", "windir", "TEMP", "TMP", "HOME", "USERPROFILE"];
  for (const k of [...essentials, ...(profile.envAllowList ?? [])]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  // CODEX_HOME: the capsule isolation root (per-process env; does not pollute the host process.env).
  env["CODEX_HOME"] = codexHomeOf(profile);
  // authSource.kind==="env": resolve the reference to the real key and inject it into the subprocess env (use-and-discard; the raw secret is not cached).
  if (profile.authSource.kind === "env") {
    const v = process.env[profile.authSource.varName];
    if (v !== undefined) env[profile.authSource.varName] = v;
  }
  return env;
}

/**
 * The isolation config fragment for thread/start. The two isolation hard switches are passed via the
 * config path (the chosen transport is not yet verified; the current implementation uses the
 * thread/start `config` map). The `config` keys align with codex config.toml field names.
 */
export function isolationConfig(): { [key: string]: JsonValue } {
  return {
    // Disable loading of user-level config (equivalent to ignore-user-config).
    ignore_user_config: true,
    // Disable loading of project/user rules (exec policy) (equivalent to ignore-rules; independent of ignore_user_config).
    ignore_rules: true,
  };
}

/** Approval automation: fully automatic with no prompts (avoids unattended turns hanging). */
export const AUTOMATION_APPROVAL_POLICY = "never" as const;

/**
 * sandbox.writableRoots -> Codex SandboxPolicy.
 * With a sandbox that needs write access -> workspaceWrite + writableRoots (paths normalized via path.resolve for Windows);
 * with no sandbox -> readOnly (tightened by default, network blocked). shellPolicy/networkPolicy affect networkAccess.
 */
export function sandboxPolicyOf(profile: IsolationProfile): CodexSandboxPolicy {
  const sandbox = profile.sandbox;
  if (sandbox === undefined) {
    return { type: "readOnly", networkAccess: false };
  }
  const networkAccess = sandbox.networkPolicy !== "block_all";
  if (sandbox.writableRoots.length === 0 && sandbox.shellPolicy === "block_all") {
    return { type: "readOnly", networkAccess };
  }
  return {
    type: "workspaceWrite",
    writableRoots: sandbox.writableRoots.map((r) => pathResolve(r)),
    networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

/** The codex account credential filename (under CODEX_HOME; holds OpenAI OAuth tokens / API key). */
const CODEX_AUTH_FILE = "auth.json";

/**
 * managed/openai-oauth auth: provision `auth.json` from the account source directory into the capsule
 * isolation-root CODEX_HOME.
 *
 * The source directory is `authSource.configDir` (the host chooses the account via the explicit
 * project-config `codexHome`), falling back to the default `~/.codex`. Only auth.json is copied (no
 * config.toml / rules / MCP), preserving per-capsule isolation - the isolation root holds credentials
 * only and does not leak user-level config. The subprocess then starts with `CODEX_HOME=<isolation root>`
 * and reads the provisioned credentials. A missing source -> fail-fast (not silent).
 *
 * Note on refresh: the codex subprocess refreshes tokens by writing back to the isolation root's
 * auth.json (not the source directory); the capsule is cleaned up when the task is deleted.
 */
export async function provisionAuth(profile: IsolationProfile): Promise<void> {
  const isoHome = codexHomeOf(profile);
  // Ensure the isolation root exists (CODEX_HOME, before the subprocess starts).
  await mkdir(isoHome, { recursive: true });
  const auth = profile.authSource;
  if (auth.kind === "managed" && auth.provider === "openai-oauth") {
    // Account source directory: configDir (project-config codexHome) when set, otherwise ~/.codex.
    const sourceDir = auth.configDir ?? join(homedir(), ".codex");
    const sourceAuth = join(sourceDir, CODEX_AUTH_FILE);
    try {
      await access(sourceAuth);
    } catch {
      throw new RuntimeErrorImpl({
        kind: "permanent",
        subKind: "not_supported",
        providerId: PROVIDER,
        message: `codex auth not found: ${sourceAuth} (run \`codex login\` first, or point the project config codexHome at a directory containing auth.json)`,
        diagnostics: { capabilityPath: "authSource.managed.openai-oauth", sourceDir },
      });
    }
    // Copy the credentials into the isolation root (the source is referenced; the isolation root holds its own copy; credentials only, not config).
    await copyFile(sourceAuth, join(isoHome, CODEX_AUTH_FILE));
    return;
  }
  if (auth.kind === "managed" && auth.provider !== "openai-oauth") {
    throw new RuntimeErrorImpl({
      kind: "permanent",
      subKind: "not_supported",
      providerId: PROVIDER,
      message: `codex does not support managed auth provider ${auth.provider}`,
      diagnostics: { capabilityPath: "authSource.managed", provider: auth.provider },
    });
  }
  // kind: "file" -- the host has already placed auth.json inside CODEX_HOME; the adapter does not copy (reference only).
  // kind: "env" -- OPENAI_API_KEY was already injected by buildChildEnv.
  // kind: "secret_ref" -- resolution is the host's responsibility, beyond the adapter's single concern.
}

/**
 * cwd-level sentinel: place a real-named AGENTS.md (with a unique marker) in the capsule cwd, so the
 * self-check can probe whether walk-up leaks. Never overwrite an existing AGENTS.md (a real user/project
 * file -> data-loss risk): if one exists, skip the write without breaking the ancestor audit (the
 * codexHome comparison still runs) and return `placed:false`. On a successful write, return `placed:true`
 * plus the marker for the self-check to compare against.
 */
export async function placeSentinel(cwd: string): Promise<{ marker: string; placed: boolean }> {
  const marker = `ISOLATION_SENTINEL_${randomToken()}`;
  const body = `<!-- ${marker} -->\nThis file is an isolation sentinel placed by deputy; it must NOT be visible to the agent if isolation is effective.\n`;
  try {
    // wx: throws EEXIST if the file already exists, never overwriting (the real filename AGENTS.md -- Codex walks up looking for AGENTS.md, so a suffixed file would be a false negative).
    await writeFile(join(cwd, "AGENTS.md"), body, { encoding: "utf8", flag: "wx" });
    return { marker, placed: true };
  } catch {
    // Already exists (EEXIST) or write failed -> do not place a sentinel (do not pollute the existing file); the self-check marks this item ignored.
    return { marker, placed: false };
  }
}

function randomToken(): string {
  return randomUUID().replace(/-/g, "");
}

/**
 * Isolation fail-fast check: violations that can be verified immediately during startSession ->
 * throw isolation_violation_*. Compares InitializeResponse.codexHome against the expected isolation
 * root (a config-layer assertion; the cwd-sentinel walk-up probe needs a live LLM and belongs to the
 * self-check / live smoke).
 */
export function verifyIsolation(init: InitializeResponse, profile: IsolationProfile): void {
  const expected = codexHomeOf(profile);
  const reported = pathResolve(init.codexHome);
  if (reported !== expected) {
    throw new RuntimeErrorImpl({
      kind: "permanent",
      subKind: "isolation_violation_user_settings_loaded",
      providerId: PROVIDER,
      message: `isolation: app-server reported CODEX_HOME=${reported}, expected ${expected} (per-capsule isolation root not applied)`,
      diagnostics: { reportedCodexHome: reported, expectedCodexHome: expected, capsuleConfigDir: profile.capsuleConfigDir },
    });
  }
}

/**
 * Isolation self-check. Performs assertion-style checks based on the init response + sentinel marker.
 * The sentinel walk-up probe needs live LLM introspection and belongs to the live smoke; here we do a
 * config-layer assertion (codexHome alignment).
 */
export function isolationSelfCheck(
  init: InitializeResponse | undefined,
  profile: IsolationProfile,
  sentinelMarker: string | undefined,
): IsolationSelfCheckResult {
  const findings: IsolationFinding[] = [];
  if (init === undefined) {
    findings.push({ field: "init", status: "ignored", note: "no initialize response captured yet" });
    return { ok: false, findings };
  }
  const expected = codexHomeOf(profile);
  const reported = pathResolve(init.codexHome);
  findings.push({
    field: "codexHome",
    status: reported === expected ? "applied" : "violated",
    note: `reported=${reported} expected=${expected}`,
  });
  findings.push({
    field: "cwdSentinel",
    status: sentinelMarker !== undefined ? "applied" : "ignored",
    note:
      sentinelMarker !== undefined
        ? `sentinel placed (marker=${sentinelMarker}); walk-up leak detection requires a live LLM probe`
        : "no sentinel placed",
  });
  findings.push({
    field: "authSource",
    status: "applied",
    note: `kind=${profile.authSource.kind} (reference only, no secret in handle)`,
  });
  const ok = findings.every((f) => f.status !== "violated");
  return { ok, findings };
}

/** host-death epoch fencing: if the epoch snapshotted at session creation differs from the current one -> refuse to write. */
export function epochFenceOk(sessionEpoch: string | undefined, currentEpoch: string | undefined): boolean {
  if (sessionEpoch === undefined || currentEpoch === undefined) return true;
  return sessionEpoch === currentEpoch;
}
