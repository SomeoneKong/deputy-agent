/**
 * IsolationProfile and isolation self-check types.
 *
 * The default isolation discipline is guaranteed by the adapter implementation and is not exposed
 * as a toggleable field. AuthSource carries only a secret reference, never an inline secret.
 */

export type PromptLanguage = "en" | "zh";

export type ShellPolicy = "block_all" | "allow_workspace_only" | "allow_with_audit" | "passthrough";
export type NetworkPolicy = "block_all" | "allow_listed" | "passthrough";

export interface SandboxPolicy {
  readonly writableRoots: ReadonlyArray<string>;
  readonly readableRoots: ReadonlyArray<string>;
  readonly shellPolicy: ShellPolicy;
  readonly networkPolicy: NetworkPolicy;
}

export type ManagedAuthProvider = "anthropic-oauth" | "openai-oauth" | "github-copilot";

export type AuthSource =
  | { kind: "env"; varName: string }
  | { kind: "file"; path: string }
  | { kind: "secret_ref"; id: string }
  // configDir: the managed provider's credential/config directory (a reference, not a secret).
  // The host passes this in explicitly to select an account profile; when omitted the adapter falls
  // back to the provider's default directory (e.g. anthropic-oauth -> ~/.claude).
  | { kind: "managed"; provider: ManagedAuthProvider; configDir?: string };

export interface IsolationProfile {
  readonly capsuleConfigDir: string;
  readonly promptLang: PromptLanguage;
  readonly sandbox?: SandboxPolicy;
  readonly authSource: AuthSource;
  readonly envAllowList?: ReadonlyArray<string>;
}

export interface IsolationFinding {
  readonly field: string;
  readonly status: "applied" | "ignored" | "violated";
  readonly note?: string;
}

export interface IsolationSelfCheckResult {
  readonly ok: boolean;
  readonly findings: ReadonlyArray<IsolationFinding>;
}
