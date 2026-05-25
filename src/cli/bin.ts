#!/usr/bin/env node
/**
 * deputy CLI bin entry point.
 *
 * Parse process.argv -> runCli -> process.exit(code). SIGINT -> exit code 130.
 */
import { runCli } from "./cli.js";

let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
  process.exit(130);
});

runCli(process.argv.slice(2))
  .then((code) => {
    process.exit(interrupted ? 130 : code);
  })
  .catch((err) => {
    process.stderr.write(`deputy fatal: ${(err as Error)?.message ?? String(err)}\n`);
    process.exit(1);
  });
