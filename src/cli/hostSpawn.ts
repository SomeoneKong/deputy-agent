/**
 * Host daemon-mode startup + CLI <-> host coordination.
 *
 * - ensureHostRunning: probe host.pid.lock; if free, detached-spawn a host child process.
 * - detached spawn: the child detaches from the launching shell's process group / session, with
 *   stdout/stderr redirected to control/host.log (POSIX detached:true starts a new session; Windows
 *   detached:true + windowsHide drops the console association).
 *
 * The CLI does not hold host.pid.lock -- it releases right after a successful probe, letting the host
 * child acquire it itself.
 */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { fileLock } from "../shared/locks.js";
import type { TaskCapsulePaths } from "../shared/paths.js";

export type SpawnResult = "spawned" | "already_running" | "spawn_failed";

/**
 * daemon entry script (same directory as this module). Production: compiled dist/cli/daemonEntry.js,
 * run directly by node. Dev: source daemonEntry.ts (when tsx runs the server, import.meta.url ends with
 * .ts), requiring node --import tsx to load the TS loader.
 */
function daemonEntry(): { entry: string; isTs: boolean } {
  const here = dirname(fileURLToPath(import.meta.url));
  const isTs = import.meta.url.endsWith(".ts");
  return { entry: join(here, isTs ? "daemonEntry.ts" : "daemonEntry.js"), isTs };
}

export interface EnsureHostRunningOpts {
  readonly projectRoot: string;
  /** Inject spawn (for tests); defaults to a real detached spawn. */
  readonly spawnHost?: (paths: TaskCapsulePaths, projectRoot: string) => Promise<void> | void;
}

/**
 * If the host isn't running, background detached-spawn one; non-blocking lock probe.
 *
 * Any IO / lock-level exception during probe (as opposed to "lock already held" returning null) is treated
 * conservatively as "host is running" to avoid starting a second host. A failed spawn syscall ->
 * spawn_failed (the caller appends a note after the confirmation message, without changing the main exit code).
 */
export async function ensureHostRunning(
  paths: TaskCapsulePaths,
  opts: EnsureHostRunningOpts,
): Promise<SpawnResult> {
  let handle;
  try {
    handle = await fileLock.tryAcquireNonblocking(paths.hostPidLock);
  } catch {
    // probe IO exception: conservatively treat the host as running.
    return "already_running";
  }
  if (handle === null) return "already_running";
  // Release the lock immediately so the host child acquires it itself.
  await handle.release();

  try {
    if (opts.spawnHost !== undefined) {
      await opts.spawnHost(paths, opts.projectRoot);
    } else {
      await spawnDetachedHost(paths, opts.projectRoot);
    }
    return "spawned";
  } catch {
    return "spawn_failed";
  }
}

/**
 * Detached-spawn a host daemon process. stdout/stderr append to control/host.log; the child detaches from
 * the parent's process group (detached:true + unref), so the short-lived CLI returns immediately without waiting.
 */
export async function spawnDetachedHost(paths: TaskCapsulePaths, projectRoot: string): Promise<void> {
  await mkdir(paths.control, { recursive: true });
  const logPath = join(paths.control, "host.log");
  const out = openSync(logPath, "a");
  const err = openSync(logPath, "a");
  const { entry, isTs } = daemonEntry();
  // Dev-time .ts entry loads the TS loader via node --import tsx; production .js is run directly by node.
  const nodeArgs = isTs ? ["--import", "tsx", entry] : [entry];
  const child = spawn(process.execPath, [...nodeArgs, projectRoot, paths.taskId], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, err],
    env: process.env,
  });
  child.unref();
}
