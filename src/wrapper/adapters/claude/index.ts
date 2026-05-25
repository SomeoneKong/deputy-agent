/**
 * Claude provider adapter barrel. Public exports: claudeRuntimeFactory + Claude-only config types.
 * Claude-private vocabulary (SDKMessage / Options / hooks etc.) is not exported here -- only the public contract surface + providerSpecific config.
 */
export { claudeRuntimeFactory } from "./runtime.js";
export type { ClaudeProviderConfig, ClaudeQueryFn, ClaudeEffort } from "./config.js";
// MCP namespace helpers (mcpToolName / isHostToolName / MCP_NAMESPACE) are
// Claude-private MCP naming details and stay out of the public barrel (so the
// host does not depend on Claude-private vocabulary); the adapter internals and
// tests import them directly from ./toolBridge.js.
