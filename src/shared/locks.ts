/**
 * OS-level advisory file lock. Backed by `fs-ext`'s flock (POSIX `flock(2)` /
 * Windows `LockFileEx`): bound to a file descriptor and released automatically
 * by the OS when the process crashes — not an application-level lock based on
 * mtime or stale-lock detection.
 *
 * Blocking acquisition with a timeout is implemented via `exnb` (non-blocking)
 * plus async polling, so the event loop is not blocked; on timeout it throws
 * `LockTimeoutError`.
 */
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { flockSync } from "fs-ext";

import { LockTimeoutError } from "./errors.js";

export interface LockHandle {
  readonly lockPath: string;
  release(): Promise<void>;
}

export interface FileLock {
  /** Blocking exclusive lock; throws `LockTimeoutError` on timeout. */
  acquireExclusive(lockPath: string, timeoutMs?: number): Promise<LockHandle>;
  /** Non-blocking exclusive lock; returns null if already held (no throw); other errors propagate. */
  tryAcquireNonblocking(lockPath: string): Promise<LockHandle | null>;
}

export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 25;

function isWouldBlock(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EWOULDBLOCK" || code === "EAGAIN";
}

async function openLockFd(lockPath: string): Promise<Awaited<ReturnType<typeof open>>> {
  await mkdir(dirname(lockPath), { recursive: true });
  // O_RDWR|O_CREAT: create if missing, no truncate, no append. The lock applies to the fd; file content is not used.
  // O_APPEND cannot be used (on Windows fs-ext flock reports EINVAL for an append fd).
  return open(lockPath, constants.O_RDWR | constants.O_CREAT);
}

function makeHandle(lockPath: string, handle: Awaited<ReturnType<typeof open>>): LockHandle {
  let released = false;
  return {
    lockPath,
    async release() {
      if (released) return;
      released = true;
      try {
        flockSync(handle.fd, "un");
      } finally {
        await handle.close();
      }
    },
  };
}

async function acquireExclusive(lockPath: string, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS): Promise<LockHandle> {
  const handle = await openLockFd(lockPath);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      flockSync(handle.fd, "exnb");
      return makeHandle(lockPath, handle);
    } catch (err) {
      if (!isWouldBlock(err)) {
        await handle.close();
        throw err;
      }
      if (Date.now() >= deadline) {
        await handle.close();
        throw new LockTimeoutError(`lock acquire timed out after ${timeoutMs}ms: ${lockPath}`, {
          details: { lockPath, timeoutMs },
        });
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

async function tryAcquireNonblocking(lockPath: string): Promise<LockHandle | null> {
  const handle = await openLockFd(lockPath);
  try {
    flockSync(handle.fd, "exnb");
    return makeHandle(lockPath, handle);
  } catch (err) {
    await handle.close();
    if (isWouldBlock(err)) return null;
    throw err;
  }
}

export const fileLock: FileLock = { acquireExclusive, tryAcquireNonblocking };

/** Runs fn while holding the lock and always releases it (including on error). */
export async function withLock<T>(
  lockPath: string,
  fn: (handle: LockHandle) => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  const handle = await acquireExclusive(lockPath, timeoutMs);
  try {
    return await fn(handle);
  } finally {
    await handle.release();
  }
}

/** Non-blocking variant: runs onLocked when the lock is held (returns undefined by default). */
export async function withTryLock<T>(
  lockPath: string,
  fn: (handle: LockHandle) => Promise<T>,
  onLocked?: () => T | Promise<T>,
): Promise<T | undefined> {
  const handle = await tryAcquireNonblocking(lockPath);
  if (handle === null) return onLocked ? await onLocked() : undefined;
  try {
    return await fn(handle);
  } finally {
    await handle.release();
  }
}
