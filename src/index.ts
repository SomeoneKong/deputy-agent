/**
 * deputy — package entry barrel.
 *
 * Re-exports the public surface of each subsystem (shared / wrapper / messaging / prompts / host / cli / web).
 */

export const PACKAGE_NAME = "deputy";

export * from "./shared/index.js";
export * from "./messaging/index.js";
export * from "./prompts/index.js";
export * from "./host/index.js";
export * from "./cli/index.js";
export * from "./web/index.js";
