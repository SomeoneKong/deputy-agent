/**
 * Maps IsolationProfile to the Claude SDK Options isolation trio + fail-fast
 * verification + self-check + host-death epoch fencing.
 *
 * The trio: settingSources=[] / strictMcpConfig=true / permissionMode="bypassPermissions"
 * (+ allowDangerouslySkipPermissions=true, which the SDK requires alongside bypassPermissions).
 * Orthogonal to the allowedTools whitelist.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import type { Options, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";

import type { IsolationProfile, ProviderId, IsolationFinding, IsolationSelfCheckResult } from "../../types/index.js";
import { RuntimeErrorImpl } from "../../types/index.js";

const PROVIDER: ProviderId = "claude";

/** Default credentials directory for anthropic-oauth managed auth (fallback when authSource.configDir is omitted). */
function defaultClaudeConfigDir(): string {
  return join(homedir(), ".claude");
}

/** Isolation-related Options fragment (orthogonal to model / tools / hooks, merged by the options builder). */
export function isolationOptions(profile: IsolationProfile): Partial<Options> {
  const opts: Partial<Options> = {
    settingSources: [], // do not read ~/.claude/settings.json, do not walk up CLAUDE.md
    strictMcpConfig: true, // do not surface MCP servers the wrapper is unaware of
    permissionMode: "bypassPermissions", // suppress approval prompts (unattended), without bypassing allowedTools
    allowDangerouslySkipPermissions: true, // required by the SDK alongside bypassPermissions
  };
  // env: always pass only essentials + whitelist, never inherit all of process.env
  // by default -- an omitted envAllowList is treated as an empty whitelist (essentials
  // only), to avoid leaking global token / proxy / profile.
  const env: Record<string, string> = {};
  const essentials = ["PATH", "Path", "SystemRoot", "windir", "TEMP", "TMP", "HOME", "USERPROFILE"];
  for (const k of [...essentials, ...(profile.envAllowList ?? [])]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  // authSource.kind==="env": resolve the reference to the real key and inject it into the child env (use-and-discard, the raw secret is not cached).
  if (profile.authSource.kind === "env") {
    const v = process.env[profile.authSource.varName];
    if (v !== undefined) env[profile.authSource.varName] = v;
  } else if (profile.authSource.kind === "managed" && profile.authSource.provider === "anthropic-oauth") {
    // Claude subscription OAuth auth: the CLI child reads the OAuth token from
    // `$CLAUDE_CONFIG_DIR/.credentials.json`. The account profile is determined by
    // authSource.configDir (passed in explicitly), falling back to ~/.claude --
    // CLAUDE_CONFIG_DIR is set explicitly on the child rather than passively
    // inheriting the host's same-named variable. configDir is a path, not a
    // secret; the real token is read only from the credentials file by the CLI
    // and never enters env/handle.
    env["CLAUDE_CONFIG_DIR"] = profile.authSource.configDir ?? defaultClaudeConfigDir();
  }
  // Resolving other kinds (file / secret_ref) is the host's responsibility, outside the adapter's single concern.
  opts.env = env;
  return opts;
}

/**
 * Performs fail-fast isolation verification on the SDK init system message.
 * If the SDK reports loaded user-level config / a non-empty settingSources -> throws isolation_violation_* (does not silently continue).
 */
export function verifyIsolation(init: SDKSystemMessage, profile: IsolationProfile): void {
  // permissionMode must actually be bypassPermissions (indirect evidence the isolation settings were recognized).
  if (init.permissionMode !== undefined && init.permissionMode !== "bypassPermissions") {
    throw new RuntimeErrorImpl({
      kind: "permanent",
      subKind: "isolation_violation_user_settings_loaded",
      providerId: PROVIDER,
      message: `isolation: SDK reported permissionMode=${init.permissionMode}, expected bypassPermissions (settingSources=[] may not have taken effect)`,
      diagnostics: { reportedPermissionMode: init.permissionMode, capsuleConfigDir: profile.capsuleConfigDir },
    });
  }
  // Only the adapter's `sh` in-process MCP server should be present (indirect evidence strictMcpConfig took effect).
  const unexpected = (init.mcp_servers ?? []).filter((s) => s.name !== "sh");
  if (unexpected.length > 0) {
    throw new RuntimeErrorImpl({
      kind: "permanent",
      subKind: "isolation_violation_user_settings_loaded",
      providerId: PROVIDER,
      message: `isolation: unexpected MCP servers present despite strictMcpConfig: ${unexpected.map((s) => s.name).join(", ")}`,
      diagnostics: { unexpectedMcpServers: unexpected.map((s) => s.name) },
    });
  }
}

/**
 * host-death epoch fencing: compared before each stream JSONL write.
 * If the epoch recorded at session creation differs from the current host epoch -> reject the write (a stale handle's late write is invalidated).
 * Epoch not configured (undefined) -> treated as a single host process, always passes.
 */
export function epochFenceOk(sessionEpoch: string | undefined, currentEpoch: string | undefined): boolean {
  if (sessionEpoch === undefined || currentEpoch === undefined) return true;
  return sessionEpoch === currentEpoch;
}

/**
 * isolation self-check. Performs assertion-style checks based on what the init message reports.
 * The sentinel-file approach requires probing with a live LLM and belongs to live smoke testing; this does the config-layer assertions.
 */
export function isolationSelfCheck(init: SDKSystemMessage | undefined, profile: IsolationProfile): IsolationSelfCheckResult {
  const findings: IsolationFinding[] = [];
  if (init === undefined) {
    findings.push({ field: "init", status: "ignored", note: "no init system message captured yet" });
    return { ok: false, findings };
  }
  findings.push({
    field: "settingSources",
    status: init.permissionMode === "bypassPermissions" ? "applied" : "violated",
    note: `permissionMode=${init.permissionMode ?? "<unset>"}`,
  });
  const unexpected = (init.mcp_servers ?? []).filter((s) => s.name !== "sh");
  findings.push({
    field: "strictMcpConfig",
    status: unexpected.length === 0 ? "applied" : "violated",
    ...(unexpected.length > 0 ? { note: `unexpected: ${unexpected.map((s) => s.name).join(",")}` } : {}),
  });
  // All AuthSource kinds (env/file/secret_ref/managed) carry only a reference and never inline a secret -> applied.
  findings.push({
    field: "authSource",
    status: "applied",
    note: `kind=${profile.authSource.kind} (reference only, no secret in handle)`,
  });
  const ok = findings.every((f) => f.status !== "violated");
  return { ok, findings };
}
