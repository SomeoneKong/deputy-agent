/**
 * Barrel for the messaging subsystem (message bus).
 *
 * Single entry point for physical layout, envelope schema, the state event
 * stream, cross-process concurrency, and recovery.
 */
export * from "./envelope.js";
export * from "./state.js";
export * from "./bus.js";
export * from "./recovery.js";
