/**
 * Task capsule creation.
 *
 * Creates the `<taskId>/` directory tree under tasksRoot, writes raw_task.md,
 * writes the initial manifest, and appends the first raw_task conversation row
 * (fail-soft). Does not create status.md / conversation.md placeholders (they
 * are generated on demand).
 */
import { mkdir } from "node:fs/promises";

import { atomicWriter } from "./atomic.js";
import { conversationIO, type ConversationUserSource } from "./conversation.js";
import { TaskCapsuleConflict } from "./errors.js";
import { manifestIO, MANIFEST_SCHEMA_VERSION, type Manifest, type RoleBindingMap } from "./manifest.js";
import { buildTaskCapsulePaths, type TaskCapsulePaths } from "./paths.js";
import { nowIso8601Us, type Iso8601Us } from "./timeUtils.js";

export interface CreateTaskCapsuleInput {
  readonly tasksRoot: string;
  readonly taskId: string; // validated as TaskId inside the function
  readonly rawTaskText: string;
  readonly source: ConversationUserSource; // the `from` of the first raw_task row
  readonly title?: string; // defaults to empty string
  readonly roleBindings?: RoleBindingMap; // provider chosen per role at submit; written to the initial manifest; omitted entirely when absent
  readonly nowIso?: Iso8601Us; // injectable for tests
}

const RAW_TASK_REL_PATH = "workspace/inputs/raw_task.md";

export async function createTaskCapsule(input: CreateTaskCapsuleInput): Promise<TaskCapsulePaths> {
  const paths = buildTaskCapsulePaths(input.tasksRoot, input.taskId); // invalid task_id throws PathEscapeError
  const now = input.nowIso ?? nowIso8601Us();
  const title = input.title ?? "";

  // Create task_root with recursive:false so EEXIST acts as conflict detection (avoids TOCTOU).
  await mkdir(paths.tasksRoot, { recursive: true });
  try {
    await mkdir(paths.taskRoot, { recursive: false });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new TaskCapsuleConflict(`task capsule already exists at ${paths.taskRoot}`, {
        details: { taskId: input.taskId, path: paths.taskRoot },
      });
    }
    throw err;
  }

  const dirs = [
    paths.workspace,
    paths.inputsDir,
    paths.clarifyDir,
    paths.harnessDir,
    paths.harnessSopDir,
    paths.harnessToolsDir,
    paths.harnessSkillsLocalDir,
    paths.harnessMcpServersLocalDir,
    paths.harnessScriptsDir,
    paths.memoryDir,
    paths.artifactsDir,
    paths.outputDir,
    paths.workerStreamsDir,
    paths.control,
    paths.messagingDir,
    paths.messagingPayloads,
    paths.controlStreamsDir,
    paths.metaStreamsDir,
    paths.watcherStreamsDir,
    paths.reviewerStreamsDir,
    paths.workerMetaDir,
    paths.agentPromptsDir,
    paths.uploadsDir,
    paths.workerLogsDir,
  ];
  for (const d of dirs) await mkdir(d, { recursive: true });

  // raw_task.md: body only (no frontmatter; it does not carry source metadata).
  await atomicWriter.writeText(paths.rawTaskPath, input.rawTaskText);

  const manifest: Manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    taskId: paths.taskId,
    title,
    createdAt: now,
    updatedAt: now,
    rawTaskPath: RAW_TASK_REL_PATH,
    stage: "submitted",
    stageHistory: [{ stage: "submitted", enteredAt: now }],
    pausedFrom: null,
    lastError: null,
    // Include roleBindings only when non-empty (manifestToYaml omits empty/absent fields).
    ...(input.roleBindings !== undefined && Object.keys(input.roleBindings).length > 0
      ? { roleBindings: input.roleBindings }
      : {}),
  };
  await manifestIO.writeInitial(paths, manifest);

  // First raw_task conversation row: fail-soft (a write failure does not block creation; raw_task.md is the source of truth).
  try {
    await conversationIO.appendUserToMeta({
      paths,
      kind: "raw_task",
      source: input.source,
      body: input.rawTaskText,
      envId: null,
      extras: { title },
    });
  } catch (err) {
    console.warn(`append conversation.jsonl for raw_task failed: ${(err as Error).message}`);
  }

  return paths;
}
