/**
 * Project root resolution + task_id generation.
 *
 * Project root resolution order: (1) explicit --project-root -> (2) DEPUTY_PROJECT_ROOT env -> (3) the
 * nearest ancestor of cwd containing tasks/ -> (4) cwd itself. task_id: user-specified (validation +
 * conflict detection left to createTaskCapsule) or genDefaultTaskId.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { genDefaultTaskId, isValidTaskId, type TaskId } from "../shared/ids.js";
import { cliErrors } from "./errors.js";

export const PROJECT_ROOT_ENV = "DEPUTY_PROJECT_ROOT";

function hasTasksDir(dir: string): boolean {
  try {
    return statSync(join(dir, "tasks")).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve the project root in order 1->4; returns an absolute path. `cwd` is injectable (for tests), defaults to process.cwd(). */
export function resolveProjectRoot(opts?: { explicit?: string; env?: string; cwd?: string }): string {
  const cwd = opts?.cwd ?? process.cwd();
  // 1. Explicit
  if (opts?.explicit !== undefined && opts.explicit.length > 0) {
    return isAbsolute(opts.explicit) ? opts.explicit : resolve(cwd, opts.explicit);
  }
  // 2. Environment variable
  const envVal = opts?.env ?? process.env[PROJECT_ROOT_ENV];
  if (envVal !== undefined && envVal.length > 0) {
    return isAbsolute(envVal) ? envVal : resolve(cwd, envVal);
  }
  // 3. Nearest ancestor of cwd containing tasks/
  let cur = resolve(cwd);
  for (;;) {
    if (hasTasksDir(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // 4. cwd itself
  return resolve(cwd);
}

/** Absolute path of the tasks/ root directory. */
export function tasksRootOf(projectRoot: string): string {
  return join(projectRoot, "tasks");
}

/**
 * Compute the task_id for submit: if user-specified, validate the character set (conflicts are detected via
 * createTaskCapsule's EEXIST); otherwise auto-generate with up to 3 retries to avoid collisions with existing
 * directories (6-char hex collision probability is very low).
 */
export function computeTaskId(opts: { projectRoot: string; explicit?: string }): TaskId {
  if (opts.explicit !== undefined && opts.explicit.length > 0) {
    if (!isValidTaskId(opts.explicit)) {
      throw cliErrors.taskIdInvalid(`invalid task_id: ${JSON.stringify(opts.explicit)}`);
    }
    return opts.explicit;
  }
  const tasksRoot = tasksRootOf(opts.projectRoot);
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = genDefaultTaskId();
    if (!existsSync(join(tasksRoot, candidate))) return candidate;
  }
  // Extremely rare: 3 collisions in a row -> still return a freshly generated id (let createTaskCapsule's EEXIST report the conflict).
  return genDefaultTaskId();
}
