/**
 * Barrel for the CLI entry + user-interaction channel subsystem.
 *
 * - exit codes + CliError
 * - project root + task_id
 * - command exec function layer (shared by CLI + Web) + CommandResult / source pass-through
 * - host daemon-mode spawn coordination
 * - CLI top-level entry runCli + argv parsing + exit code mapping
 * - inspect read-only view
 *
 * status.md rendering lives in shared/status_md (called from a single source by both host and cli).
 */
export * from "./errors.js";
export * from "./projectRoot.js";
export * from "./hostSpawn.js";
export * from "./exec.js";
export * from "./inspect.js";
export { runCli, type CliIo } from "./cli.js";
export { daemonMain } from "./daemonEntry.js";
