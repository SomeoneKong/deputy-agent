/**
 * Codex provider adapter barrel. Public exports: codexRuntimeFactory + the Codex-only config types.
 * Codex-private vocabulary (thread/turn/item/dynamicTools/JSON-RPC protocol types, etc) is not
 * exported here - only the common contract surface + providerSpecific config is exposed, so the host
 * does not depend on Codex-private vocabulary. The adapter internals and tests import from submodules directly.
 */
export { codexRuntimeFactory } from "./runtime.js";
export type { CodexProviderConfig, CodexSpawnFn, CodexToolBridgeMode, AppServerProcess, SpawnArgs } from "./config.js";
