/**
 * Subprocess execution for script checks: spawn interpreter + scriptPath, cwd=workspace, controlled
 * env, no shell, timeout kills the process tree, and cancel can forcibly terminate.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { platform } from "node:process";

import { SCRIPT_STDERR_TAIL, SCRIPT_STDOUT_TAIL } from "./types.js";

export type ScriptRunResultKind = "exited" | "timeout" | "interpreter_not_found" | "io_error";

export interface ScriptRunResult {
  readonly kind: ScriptRunResultKind;
  /** Process exit code (non-null when kind="exited"; null otherwise). */
  readonly returnCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** Diagnostic text for kind="io_error" / "interpreter_not_found". */
  readonly errorMessage?: string;
}

/** Spawn options that place the child in a new process group / session, easing whole-group termination. */
function detachedSpawnOpts(): { detached: boolean } | { windowsHide: boolean } {
  if (platform === "win32") {
    // Windows: spawn does not support a detached process group like POSIX; fall back to taskkill /T to kill the tree.
    return { windowsHide: true };
  }
  return { detached: true };
}

/** Terminate the process tree: POSIX kills the process group, Windows uses taskkill /T. Fail-soft. */
function terminateProcessTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (pid === undefined) return;
  try {
    if (platform === "win32") {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { timeout: 5000 });
    } else {
      // detached=true makes pid == pgid; the negative sign kills the whole group (including spawned children).
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  } catch {
    /* fail-soft: best-effort termination */
  }
}

/**
 * Tracks in-flight subprocesses in memory; on cancel (host moving to a terminal state / exiting)
 * forcibly terminates all of them. The async cancel path calls terminateAll; the synchronous
 * per-check evaluate exposes process handles via this registry.
 */
export class ScriptProcessRegistry {
  private readonly procs = new Set<ChildProcess>();
  private terminated = false;

  register(proc: ChildProcess): void {
    if (this.terminated) {
      terminateProcessTree(proc);
      return;
    }
    this.procs.add(proc);
  }

  discard(proc: ChildProcess): void {
    this.procs.delete(proc);
  }

  terminateAll(): void {
    this.terminated = true;
    for (const p of this.procs) {
      terminateProcessTree(p);
    }
    this.procs.clear();
  }

  get isTerminated(): boolean {
    return this.terminated;
  }
}

function tail(s: string, n: number): string {
  return s.length > n ? s.slice(s.length - n) : s;
}

/**
 * Run one script-check subprocess.
 * - No shell (spawn argv form)
 * - Captures stdout/stderr (utf-8, tail-truncated)
 * - Timeout kills the process tree
 * - Registers with the registry so cancel can forcibly terminate it
 */
export function runScript(opts: {
  readonly interpreter: string;
  readonly scriptAbsPath: string;
  readonly workspaceAbs: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutSeconds: number;
  readonly registry?: ScriptProcessRegistry | undefined;
}): Promise<ScriptRunResult> {
  const { interpreter, scriptAbsPath, workspaceAbs, env, timeoutSeconds, registry } = opts;
  const startedNs = process.hrtime.bigint();
  const elapsedMs = (): number => Number((process.hrtime.bigint() - startedNs) / 1_000_000n);

  return new Promise<ScriptRunResult>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(interpreter, [scriptAbsPath], {
        cwd: workspaceAbs,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        ...detachedSpawnOpts(),
      });
    } catch (err) {
      resolve({
        kind: "io_error",
        returnCode: null,
        stdout: "",
        stderr: "",
        durationMs: elapsedMs(),
        errorMessage: (err as Error).message,
      });
      return;
    }

    registry?.register(proc);

    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;
    let timedOut = false;

    const finish = (r: ScriptRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      registry?.discard(proc);
      resolve(r);
    };

    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      // Bound memory: keep only a slightly larger window than the needed tail.
      if (stdoutBuf.length > SCRIPT_STDOUT_TAIL * 2) stdoutBuf = tail(stdoutBuf, SCRIPT_STDOUT_TAIL * 2);
    });
    proc.stderr?.on("data", (chunk: string) => {
      stderrBuf += chunk;
      if (stderrBuf.length > SCRIPT_STDERR_TAIL * 2) stderrBuf = tail(stderrBuf, SCRIPT_STDERR_TAIL * 2);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(proc);
    }, timeoutSeconds * 1000);

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        finish({
          kind: "interpreter_not_found",
          returnCode: null,
          stdout: "",
          stderr: "",
          durationMs: elapsedMs(),
          errorMessage: err.message,
        });
        return;
      }
      finish({
        kind: "io_error",
        returnCode: null,
        stdout: tail(stdoutBuf, SCRIPT_STDOUT_TAIL),
        stderr: tail(stderrBuf, SCRIPT_STDERR_TAIL),
        durationMs: elapsedMs(),
        errorMessage: err.message,
      });
    });

    proc.on("close", (code) => {
      if (timedOut) {
        finish({
          kind: "timeout",
          returnCode: null,
          stdout: tail(stdoutBuf, SCRIPT_STDOUT_TAIL),
          stderr: tail(stderrBuf, SCRIPT_STDERR_TAIL),
          durationMs: elapsedMs(),
        });
        return;
      }
      finish({
        kind: "exited",
        returnCode: code,
        stdout: tail(stdoutBuf, SCRIPT_STDOUT_TAIL),
        stderr: tail(stderrBuf, SCRIPT_STDERR_TAIL),
        durationMs: elapsedMs(),
      });
    });
  });
}
