/**
 * Common type aliases for the wrapper's public contract.
 *
 * Ids such as `SessionId` are intentionally plain strings (not branded): the wrapper does not
 * brand session ids at compile time. Path-safe validation is handled where paths are assembled.
 */
export type SessionId = string;
export type ProviderSessionId = string;
export type TurnId = string;
export type EnvelopeId = string;
export type ProviderId = "claude" | "codex" | "opencode" | "pi";
export type AgentRole = "meta" | "worker" | "watcher" | "reviewer";
export type Unsubscribe = () => void;

/**
 * Runtime mirrors of the full role / provider sets (kept in sync with the unions above).
 * Subsystems that need a subset filter it explicitly from the full set in their own modules.
 */
export const ALL_AGENT_ROLES: ReadonlyArray<AgentRole> = ["meta", "worker", "watcher", "reviewer"];
export const ALL_PROVIDER_IDS: ReadonlyArray<ProviderId> = ["claude", "codex", "opencode", "pi"];
