/**
 * host subsystem barrel.
 *
 * Host control layer: errorKind SSoT / events.jsonl / stage machine + two host gates / agent
 * session lifecycle / crash recovery / watchdog layers / transient retry / tick main loop +
 * wake cursor + worker reminder + single-instance lock.
 */
export * from "./errorKinds.js";
export * from "./events.js";
export * from "./stage_machine.js";
export * from "./agent_sessions.js";
export * from "./recovery.js";
export * from "./watchdog.js";
export * from "./retry.js";
export * from "./main_loop.js";
export * from "./agent_control.js";
export * from "./tools/index.js";
export * from "./watcher/index.js";
export * from "./done_criteria/index.js";
export * from "./daemon.js";
