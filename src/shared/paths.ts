/**
 * Task capsule path computation plus path-safety checks.
 *
 * Only computes and validates paths; does not create any directory or file
 * (creation is the responsibility of the capsule creation entry point).
 * Returns absolute filesystem paths. The relative paths stored inside the
 * manifest (e.g. "workspace/inputs/raw_task.md") are independent fixed strings
 * and are not produced by this module.
 */
import { join } from "node:path";

import type { EnvelopeId, TaskId, TopicSlug, UploadId } from "./ids.js";
import type { SessionId } from "../wrapper/types/common.js";
import { assertTaskId, checkPathComponent, formatSessionSeq } from "./ids.js";

export interface TaskCapsulePaths {
  readonly tasksRoot: string;
  readonly taskId: TaskId;

  // top level
  readonly taskRoot: string;
  readonly statusMd: string;
  readonly conversationJsonl: string;
  readonly conversationMd: string;
  readonly conversationLock: string;

  // workspace/
  readonly workspace: string;
  readonly inputsDir: string;
  readonly rawTaskPath: string;
  readonly clarifyDir: string;
  readonly harnessDir: string;
  readonly harnessSopDir: string;
  readonly harnessToolsDir: string;
  readonly harnessSkillsLocalDir: string;
  readonly harnessMcpServersLocalDir: string;
  readonly harnessScriptsDir: string;
  readonly memoryDir: string;
  readonly artifactsDir: string;
  readonly outputDir: string;
  readonly workerStreamsDir: string;

  // control/
  readonly control: string;
  readonly manifestPath: string;
  readonly manifestLock: string;
  readonly messagingDir: string;
  readonly messagingState: string;
  readonly messagingLock: string;
  readonly messagingPayloads: string;
  readonly controlStreamsDir: string;
  readonly metaStreamsDir: string;
  readonly watcherStreamsDir: string;
  readonly reviewerStreamsDir: string;
  readonly workerMetaDir: string;
  readonly workerNextSeq: string;
  readonly agentPromptsDir: string;
  readonly uploadsDir: string;
  readonly workerLogsDir: string;
  readonly hostPid: string;
  readonly hostPidLock: string;
  readonly eventsPath: string;
  readonly eventsLock: string;

  // derived-path methods
  payloadDir(envId: EnvelopeId): string;
  payloadJson(envId: EnvelopeId): string;
  bodyMd(envId: EnvelopeId): string;

  workerStreamPath(seq: number, sid: SessionId): string;
  workerStderrPath(seq: number, sid: SessionId): string;
  metaStreamPath(sid: SessionId): string;
  watcherStreamPath(sid: SessionId): string;
  reviewerStreamPath(phase: string, round: number): string;

  agentPromptPath(sid: SessionId): string;
  agentFirstMsgPath(sid: SessionId): string;
  uploadPath(uploadId: UploadId, filename: string): string;
  memoryTopicPath(topicSlug: TopicSlug): string;
  clarifyQuestionsPath(round: number): string;
  clarifyAnswersPath(round: number): string;
}

/**
 * Validates task_id and throws `PathEscapeError` on failure.
 * Every derived method that builds a path from a SessionId or filename calls
 * `checkPathComponent` itself, rather than assuming such inputs are path-safe.
 */
export function buildTaskCapsulePaths(tasksRoot: string, taskId: string): TaskCapsulePaths {
  assertTaskId(taskId);
  const taskRoot = join(tasksRoot, taskId);

  const workspace = join(taskRoot, "workspace");
  const inputsDir = join(workspace, "inputs");
  const harnessDir = join(workspace, "harness");
  const harnessToolsDir = join(harnessDir, "tools");
  const memoryDir = join(workspace, "memory");
  const workerStreamsDir = join(workspace, "streams");

  const control = join(taskRoot, "control");
  const messagingDir = join(control, "messaging");
  const messagingPayloads = join(messagingDir, "payloads");
  const controlStreamsDir = join(control, "streams");
  const metaStreamsDir = join(controlStreamsDir, "meta");
  const watcherStreamsDir = join(controlStreamsDir, "watcher");
  const reviewerStreamsDir = join(controlStreamsDir, "reviewer");
  const workerMetaDir = join(control, "worker");
  const agentPromptsDir = join(control, "agent_prompts");
  const uploadsDir = join(control, "uploads");
  const workerLogsDir = join(control, "worker_logs");

  return {
    tasksRoot,
    taskId: taskId as TaskId,

    taskRoot,
    statusMd: join(taskRoot, "status.md"),
    conversationJsonl: join(taskRoot, "conversation.jsonl"),
    conversationMd: join(taskRoot, "conversation.md"),
    conversationLock: join(taskRoot, "conversation.lock"),

    workspace,
    inputsDir,
    rawTaskPath: join(inputsDir, "raw_task.md"),
    clarifyDir: join(inputsDir, "clarify"),
    harnessDir,
    harnessSopDir: join(harnessDir, "sop"),
    harnessToolsDir,
    harnessSkillsLocalDir: join(harnessToolsDir, "skills_local"),
    harnessMcpServersLocalDir: join(harnessToolsDir, "mcp_servers_local"),
    harnessScriptsDir: join(harnessToolsDir, "scripts"),
    memoryDir,
    artifactsDir: join(workspace, "artifacts"),
    outputDir: join(workspace, "output"),
    workerStreamsDir,

    control,
    manifestPath: join(control, "manifest.yaml"),
    manifestLock: join(control, "manifest.yaml.lock"),
    messagingDir,
    messagingState: join(messagingDir, "state.jsonl"),
    messagingLock: join(messagingDir, ".lock"),
    messagingPayloads,
    controlStreamsDir,
    metaStreamsDir,
    watcherStreamsDir,
    reviewerStreamsDir,
    workerMetaDir,
    workerNextSeq: join(workerMetaDir, "next_seq.json"),
    agentPromptsDir,
    uploadsDir,
    workerLogsDir,
    hostPid: join(control, "host.pid"),
    hostPidLock: join(control, "host.pid.lock"),
    eventsPath: join(control, "events.jsonl"),
    eventsLock: join(control, "events.jsonl.lock"),

    payloadDir: (envId) => join(messagingPayloads, envId),
    payloadJson: (envId) => join(messagingPayloads, envId, "payload.json"),
    bodyMd: (envId) => join(messagingPayloads, envId, "body.md"),

    workerStreamPath: (seq, sid) => {
      checkPathComponent(sid, "session_id");
      return join(workerStreamsDir, `worker_${formatSessionSeq(seq)}_${sid}.jsonl`);
    },
    workerStderrPath: (seq, sid) => {
      checkPathComponent(sid, "session_id");
      return join(workerLogsDir, `worker_${formatSessionSeq(seq)}_${sid}_stderr.log`);
    },
    metaStreamPath: (sid) => {
      checkPathComponent(sid, "session_id");
      return join(metaStreamsDir, `${sid}.jsonl`);
    },
    watcherStreamPath: (sid) => {
      checkPathComponent(sid, "session_id");
      return join(watcherStreamsDir, `${sid}.jsonl`);
    },
    reviewerStreamPath: (phase, round) => {
      checkPathComponent(phase, "reviewer_phase");
      return join(reviewerStreamsDir, `${phase}_round_${round}.jsonl`);
    },

    agentPromptPath: (sid) => {
      checkPathComponent(sid, "session_id");
      return join(agentPromptsDir, `${sid}.md`);
    },
    agentFirstMsgPath: (sid) => {
      checkPathComponent(sid, "session_id");
      return join(agentPromptsDir, `${sid}__first_msg.md`);
    },
    uploadPath: (uploadId, filename) => {
      checkPathComponent(filename, "filename");
      return join(uploadsDir, uploadId, filename);
    },
    memoryTopicPath: (topicSlug) => join(memoryDir, `${topicSlug}.md`),
    clarifyQuestionsPath: (round) => join(inputsDir, "clarify", `round_${round}_questions.md`),
    clarifyAnswersPath: (round) => join(inputsDir, "clarify", `round_${round}_answers.md`),
  };
}
