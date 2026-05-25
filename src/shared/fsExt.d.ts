/**
 * Minimal type declarations for `fs-ext` (only the flock interface used here).
 * fs-ext uses `flock(2)` on POSIX and `LockFileEx` on Windows, providing an
 * OS-level advisory lock bound to a file descriptor (the OS releases it
 * automatically when the process crashes).
 */
declare module "fs-ext" {
  export type FlockFlag = "ex" | "sh" | "exnb" | "shnb" | "un";
  export function flockSync(fd: number, flag: FlockFlag): void;
  export function flock(fd: number, flag: FlockFlag, callback: (err: NodeJS.ErrnoException | null) => void): void;
}
