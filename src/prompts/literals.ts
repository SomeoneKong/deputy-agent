/**
 * LITERALS -- inline literal text used in assembly + host-constructed envelope body / Watcher window
 * body literals.
 *
 * Two const maps maintained per lang (`LITERALS_EN` / `LITERALS_ZH`). **Hard key-set consistency
 * constraint**: both maps are declared `Readonly<Record<LiteralsKey, string>>` -- TS enforces at
 * compile time that the key set equals all members of the `LiteralsKey` union (missing any key ->
 * type error; extra key -> type error). Tests assert this again at runtime as a double check.
 *
 * Literals containing placeholders (`{xxx}`) store template strings; the caller runs `formatTemplate`.
 */
import type { Lang } from "./lang.js";

export type LiteralsKey =
  | "worker_completion_reminder_full"
  | "worker_completion_reminder_brief"
  | "worker_session_end_header"
  | "worker_session_end_fallback_body"
  | "worker_session_end_section_referenced_signal"
  | "worker_session_end_section_self_eval"
  | "worker_session_end_pull_hint"
  | "worker_session_end_forced_exit_note"
  | "worker_reminder_related_signal_line"
  | "worker_reminder_wse_line"
  | "worker_reminder_first_env_id_line"
  | "watcher_window_header"
  | "watcher_window_range"
  | "watcher_window_record_count"
  | "watcher_window_worker_session_line"
  | "watcher_window_stream_path_line"
  | "watcher_window_truncation_tail"
  | "watcher_record_session_started"
  | "watcher_record_session_resumed"
  | "watcher_record_session_ended"
  | "watcher_record_compact_started"
  | "watcher_record_compact_ended"
  | "watcher_record_runtime_error"
  | "watcher_record_subagent_started"
  | "watcher_record_subagent_stopped"
  | "watcher_record_provider_raw"
  | "watcher_record_unknown"
  | "worker_taskpart_placeholder"
  | "recovery_note"
  | "meta_first_minimal_fallback"
  | "watcher_section_raw_task"
  | "watcher_section_clarify_history"
  | "watcher_section_taskpart"
  | "raw_task_missing_placeholder"
  | "worker_session_start_fallback"
  | "reviewer_first_minimal_fallback"
  | "reviewer_first_no_additional_dirs_text"
  | "meta_first_no_error_text"
  | "watcher_compact_section_summary"
  | "watcher_compact_summary_in_context"
  | "watcher_compact_summary_host_managed"
  | "watcher_compact_summary_lost"
  | "watcher_compact_section_role"
  | "watcher_compact_section_raw_task"
  | "watcher_compact_section_clarify"
  | "watcher_compact_section_taskpart"
  | "watcher_compact_footer"
  | "wake_inject_header"
  | "wake_inject_intro"
  | "meta_progress_reminder"
  | "clarify_history_none"
  | "clarify_history_round_label"
  | "clarify_history_question_label"
  | "clarify_history_answer_label"
  | "clarify_history_question_missing"
  | "clarify_history_answer_missing"
  | "stage_history_none"
  | "recent_events_none";

export const LITERALS_EN: Readonly<Record<LiteralsKey, string>> = {
  // ---- host-constructed envelope body / Watcher window body ----
  worker_completion_reminder_full:
    "# Worker exited voluntarily; please arbitrate whether to terminate (reminder #{seq})\n\n" +
    "- session_seq: {session_seq}\n" +
    "- exit_reason: `{last_exit}`\n" +
    "{wse_line}" +
    "{related_signal_line}\n" +
    "## Optional decision actions\n" +
    '- `sh_stage__advance(target_stage="done"|"failed"|"cancelled", reason="...")` —— arbitrate task termination (`failed` = system-side unrecoverable; `cancelled` = user-side give-up)\n' +
    '- `sh_agent__start_worker(reason="...")` explicitly start a new Worker session\n' +
    '- `sh_msg__send_to_worker(body="...")` send a new instruction to worker (auto-spawns new session)\n' +
    '- `sh_agent__stop_worker(restart_after=false, reason="...")` explicitly stop without restart\n' +
    '- `sh_harness__write_worker(...)` + `sh_msg__send_to_worker(body="...")` revise harness AND notify worker — write alone does NOT spawn a new worker / clear pending; the paired send is what triggers inbox-gate restart\n\n' +
    "If more information is needed, pull the referenced active-signal envelope for original self-eval.\n" +
    "This reminder is delivered once per Meta idle until pending is cleared.\n",
  worker_completion_reminder_brief:
    "# Worker voluntary-exit reminder #{seq} (brief)\n\n" +
    "Reminder {seq}: last Worker voluntary exit (`{last_exit}`); task not yet in terminal stage, " +
    "please decide promptly. {first_line}\n\n" +
    "Actions: advance / start_worker / send_to_worker / stop_worker (write_worker alone does not arbitrate pending — must be paired with send_to_worker).\n",
  worker_session_end_header: "# Worker session ended",
  worker_session_end_fallback_body:
    "{worker_session_end_header}\n\nsession_seq: {session_seq}\nexit_reason: {exit_reason}\n" +
    "(host failed to render full body; details in events.jsonl)\n",
  worker_session_end_section_referenced_signal: "## Referenced active signal",
  worker_session_end_section_self_eval: "## Self-eval",
  worker_session_end_pull_hint:
    "Meta should pull this envelope to view the original worker self-eval " +
    "(this body does not duplicate the tool body to avoid redundancy).",
  worker_session_end_forced_exit_note:
    "worker exit intent originated from forced exit; no corresponding envelope.",
  worker_reminder_related_signal_line: "- Related active-signal envelope env_id: `{env_id}`\n",
  worker_reminder_wse_line: "- worker_session_end envelope env_id: `{env_id}`\n",
  worker_reminder_first_env_id_line: "(first reminder env_id: `{env_id}`)",
  watcher_window_header: "# Worker stream window",
  watcher_window_range: "- Window range: {window_start} ~ {window_end}",
  watcher_window_record_count: "- Record count in window: {count}",
  watcher_window_worker_session_line: "- Worker session: {worker_session_id} (seq {worker_session_seq})",
  watcher_window_stream_path_line: "- Full stream path: {stream_path}",
  watcher_window_truncation_tail:
    "\n... [Remaining {skipped_count} records in window truncated due to total size > {kb} KB; " +
    "read full content via stream_path]\n",
  watcher_record_session_started: "Worker session started (seq {worker_session_seq})",
  watcher_record_session_resumed: "Worker session resumed (seq {worker_session_seq})",
  watcher_record_session_ended: "Worker session ended; is_error={is_error}",
  watcher_record_compact_started: "Context compaction started",
  watcher_record_compact_ended: "Context compaction ended",
  watcher_record_runtime_error: "Runtime error: {error_kind}",
  watcher_record_subagent_started: "Subagent started: type={subagent_type}, {description}",
  watcher_record_subagent_stopped: "Subagent stopped (agent={agent_id}): status={status}; {summary}",
  watcher_record_provider_raw: "(provider raw record; type={rtype})",
  watcher_record_unknown: "(type={rtype}; not rendered)",
  // ---- assembly first_user_message / system_prompt inline sections ----
  worker_taskpart_placeholder:
    "# Task-side prompt placeholder\n\n" +
    "Meta has not yet written `workspace/harness/worker_prompt_taskpart.md` " +
    "for this task. Explore autonomously based on `inputs/raw_task.md` and " +
    "any existing harness files.\n",
  recovery_note:
    "\n> The host has just restarted your long session via the CLI after a " +
    "crash or paused/awaiting_user state. The messages in your inbox have " +
    "been restored; the full task picture follows.\n",
  meta_first_minimal_fallback:
    "# Task context\n\nstage={current_stage}\n" + "inbox={inbox_count} messages\nlast_error={last_error}\n",
  watcher_section_raw_task: "# Task original requirements (raw_task)",
  watcher_section_clarify_history: "# User clarify history",
  watcher_section_taskpart: "# Watcher-side supplementary focus for this task",
  raw_task_missing_placeholder: "(no raw_task; task may not be initialized yet)",
  worker_session_start_fallback:
    "## Session instance parameters\n\n" +
    "- session_seq: {session_seq}\n" +
    "- prev_session_id: {prev_sid_text}\n\n" +
    "---\n\n" +
    "[fallback: worker_session_start template missing or assembly failed]\n\n" +
    "These are this session's instance parameters; proceed by your role guidance.\n",
  reviewer_first_minimal_fallback: "# Review task\n\nphase={phase}\nround={round_}\nsubject={subject}\n",
  reviewer_first_no_additional_dirs_text: "(no additional directories; task root read-only)",
  meta_first_no_error_text: "none (always clean or explicitly cleared)",
  // ---- watcher_compact_reinject section headers ----
  watcher_compact_section_summary: "## Previous observations summary",
  watcher_compact_summary_in_context:
    "Your previous observations and worker stream history have been condensed into a summary that remains in your context; you can continue directly from it.",
  watcher_compact_summary_host_managed:
    "Your previous observations and worker stream history summary follows (compaction moved the originals out of context; continue from this summary):\n\n{host_managed_summary}",
  watcher_compact_summary_lost:
    "Your earlier observations and worker stream history were condensed out of context and could not be reconstructed into a summary; treat them as lost and re-anchor from the task requirements and current task focus below.",
  watcher_compact_section_role: "## Watcher role",
  watcher_compact_section_raw_task: "## Task original requirements",
  watcher_compact_section_clarify: "## User clarify history",
  watcher_compact_section_taskpart: "## Current task focus",
  watcher_compact_footer:
    "Continue waiting for host-pushed envelopes (delivered as user messages, no need to actively pull).",
  // ---- wake inject ----
  wake_inject_header: "# New messages",
  wake_inject_intro:
    "The unread envelopes below are carried in full and marked as read on delivery (no need to pull them again); process them as you see fit.",
  // ---- meta driver-stage progress reminder ----
  meta_progress_reminder:
    "[host progress reminder] This is the host's fallback nudge. Host-confirmed state: your previous turn in the `{stage}` stage has ended, the stage has not advanced, and your inbox has no pending messages — so the task is not moving forward on its own.\n\n" +
    "In the clarifying / bootstrapping stages you are the sole driver. Until you take a forward action the task is stalled and the user sees no progress — and never sees a question that exists only as text in your stream rather than delivered through a tool. This reminder is a costly safety net, not a normal progress path; do not rely on it — end every turn with a forward action.\n\n" +
    "Take one forward action now:\n" +
    "- If you have a question for the user and have NOT yet delivered it: call sh_msg__send_to_user(intent=\"question\", body=\"...\") to send it, AND sh_stage__advance(target_stage=\"awaiting_user\", reason=\"...\"). Plain text alone never reaches the user.\n" +
    "- If you already sent the user a message but did not switch stage: just call sh_stage__advance(target_stage=\"awaiting_user\", reason=\"...\").\n" +
    "- If this stage's work is done: call sh_stage__advance to the next stage.\n" +
    "- If more steps remain: keep working — you will be nudged again if a turn ends without progress.",
  // ---- clarify history labels ----
  clarify_history_none: "(no clarify rounds; raw_task was clear enough or fast path was taken)",
  clarify_history_round_label: "### Round {n}",
  clarify_history_question_label: "**Question**:",
  clarify_history_answer_label: "**Answer**:",
  clarify_history_question_missing: "(question file missing)",
  clarify_history_answer_missing: "(not yet answered)",
  // ---- empty markers ----
  stage_history_none: "  - (none)",
  recent_events_none: "(none)",
};

export const LITERALS_ZH: Readonly<Record<LiteralsKey, string>> = {
  // ---- host-constructed envelope body / Watcher window body ----
  worker_completion_reminder_full:
    "# Worker 主动退出，请仲裁是否终结（reminder #{seq}）\n\n" +
    "- session_seq: {session_seq}\n" +
    "- exit_reason: `{last_exit}`\n" +
    "{wse_line}" +
    "{related_signal_line}\n" +
    "## 可选决策动作\n" +
    '- `sh_stage__advance(target_stage="done"|"failed"|"cancelled", reason="...")` —— 仲裁任务结束（`failed` 系统侧不可恢复；`cancelled` 用户层放弃）\n' +
    '- `sh_agent__start_worker(reason="...")` 显式拉起新 Worker session\n' +
    '- `sh_msg__send_to_worker(body="...")` 给 worker 新指令（自动拉起新 session 消化）\n' +
    '- `sh_agent__stop_worker(restart_after=false, reason="...")` 显式停止不再重启\n' +
    '- `sh_harness__write_worker(...)` + `sh_msg__send_to_worker(body="...")` 改 harness + 配套告知 worker —— 仅 write_worker 不会自动起 worker / 不清 pending，必须配套 send_to_worker 触发 inbox-gate 起新 session\n\n' +
    "决策需要更多信息时可 pull 关联的主动信号 envelope 读原始 self-eval。\n" +
    "本 reminder 每次 Meta idle 投递一条直至 pending 清除。\n",
  worker_completion_reminder_brief:
    "# Worker 主动退出提醒 #{seq}（精简）\n\n" +
    "第 {seq} 次提醒：上一次 Worker 主动退出（`{last_exit}`），" +
    "task 尚未进入终态，请尽快决策。{first_line}\n\n" +
    "动作：advance / start_worker / send_to_worker / stop_worker（仅 write_worker 不仲裁 pending，须配套 send_to_worker）。\n",
  worker_session_end_header: "# Worker session 退出",
  worker_session_end_fallback_body:
    "{worker_session_end_header}\n\nsession_seq: {session_seq}\nexit_reason: {exit_reason}\n" +
    "（host 未能渲染完整 body；详 events.jsonl）\n",
  worker_session_end_section_referenced_signal: "## 引用主动信号",
  worker_session_end_section_self_eval: "## 自评",
  worker_session_end_pull_hint:
    "Meta 应 pull 该 envelope 查看 worker 原始 self-eval（本 body 不复制 tool body 避免重复）。",
  worker_session_end_forced_exit_note: "worker 退出意图来自 forced exit，无对应 envelope。",
  worker_reminder_related_signal_line: "- 关联主动信号 envelope env_id：`{env_id}`\n",
  worker_reminder_wse_line: "- worker_session_end envelope env_id：`{env_id}`\n",
  worker_reminder_first_env_id_line: "（首条 reminder env_id：`{env_id}`）",
  watcher_window_header: "# Worker stream 窗口",
  watcher_window_range: "- 窗口范围：{window_start} ~ {window_end}",
  watcher_window_record_count: "- 窗口内 record 数：{count}",
  watcher_window_worker_session_line: "- Worker session：{worker_session_id}（seq {worker_session_seq}）",
  watcher_window_stream_path_line: "- 完整 stream 路径：{stream_path}",
  watcher_window_truncation_tail:
    "\n... [窗口余下 {skipped_count} 条 record 因总长超 {kb} KB 被截断，" +
    "可通过 stream_path 读完整内容]\n",
  watcher_record_session_started: "Worker session 启动（seq {worker_session_seq}）",
  watcher_record_session_resumed: "Worker session 续接（seq {worker_session_seq}）",
  watcher_record_session_ended: "Worker session 退出；is_error={is_error}",
  watcher_record_compact_started: "Context 压缩开始",
  watcher_record_compact_ended: "Context 压缩结束",
  watcher_record_runtime_error: "运行期错误：{error_kind}",
  watcher_record_subagent_started: "Subagent 启动：type={subagent_type}，{description}",
  watcher_record_subagent_stopped: "Subagent 结束（agent={agent_id}）：status={status}；{summary}",
  watcher_record_provider_raw: "（provider 原始 record；type={rtype}）",
  watcher_record_unknown: "(type={rtype}；未渲染)",
  // ---- assembly first_user_message / system_prompt inline sections ----
  worker_taskpart_placeholder:
    "# 任务侧 prompt 占位\n\n" +
    "Meta 尚未为本任务写入 `workspace/harness/worker_prompt_taskpart.md`。" +
    "请基于 `inputs/raw_task.md` 与已有的 harness 文件（如有）自决探索。\n",
  recovery_note:
    "\n> host 刚刚从一次 crash 或 paused / awaiting_user 后由 CLI 拉起新进程重启了你的 long session。" +
    " inbox 中的消息已重新就位，下面是任务当前的全貌。\n",
  meta_first_minimal_fallback:
    "# 任务上下文\n\nstage={current_stage}\n" + "inbox={inbox_count} 条\nlast_error={last_error}\n",
  watcher_section_raw_task: "# 本任务原始需求 (raw_task)",
  watcher_section_clarify_history: "# 用户澄清历史",
  watcher_section_taskpart: "# 本任务 Watcher 侧补充关注",
  raw_task_missing_placeholder: "（无 raw_task；任务可能尚未初始化）",
  worker_session_start_fallback:
    "## Session 实例参数\n\n" +
    "- session_seq: {session_seq}\n" +
    "- prev_session_id: {prev_sid_text}\n\n" +
    "---\n\n" +
    "[fallback: worker_session_start 模板缺失或装配失败]\n\n" +
    "以上为本 session 实例参数，按你的角色指引开始工作。\n",
  reviewer_first_minimal_fallback: "# 评判任务\n\nphase={phase}\nround={round_}\nsubject={subject}\n",
  reviewer_first_no_additional_dirs_text: "（无额外目录；只读任务根）",
  meta_first_no_error_text: "无（一直无异常或已显式清空）",
  // ---- watcher_compact_reinject section headers ----
  watcher_compact_section_summary: "## 此前观察 summary",
  watcher_compact_summary_in_context:
    "之前的观察与 worker stream 历史已浓缩为一段 summary 留在你的 context 中，可直接接续。",
  watcher_compact_summary_host_managed:
    "你此前的观察与 worker stream 历史摘要如下（压缩已将原文移出 context，以此摘要接续）：\n\n{host_managed_summary}",
  watcher_compact_summary_lost:
    "你此前的观察与 worker stream 历史已被压缩移出 context 且无法重建为摘要，请视为已丢失，并依据下方任务诉求与当前任务关注点重新锚定接续。",
  watcher_compact_section_role: "## Watcher role",
  watcher_compact_section_raw_task: "## 任务原始诉求",
  watcher_compact_section_clarify: "## 用户澄清历史",
  watcher_compact_section_taskpart: "## 当前任务关注点",
  watcher_compact_footer: "继续等待 host 推送的 envelope（user message 形式直接送达，无需主动 pull）。",
  // ---- wake inject ----
  wake_inject_header: "# 新消息",
  wake_inject_intro: "下列未读 envelope 已随本消息携带完整内容并在送达时标记为 read（无需再 pull），请按你的判断处理。",
  // ---- meta driver-stage progress reminder ----
  meta_progress_reminder:
    "[host 推进提醒] 这是 host 的兜底唤醒。host 已确认的状态：你在 `{stage}` 阶段的上一个 turn 已结束、stage 未推进、且你的 inbox 没有任何待处理消息 —— 任务没有在自行向前推进。\n\n" +
    "在 clarifying / bootstrapping 阶段你是任务的唯一驱动者。在你采取推进动作之前，任务对用户而言是停滞的、用户看不到任何进展 —— 也看不到只以文本停留在你 stream 里、未经 tool 送达的问题。本提醒是代价高昂的安全兜底、不是正常推进路径；不要依赖它 —— 每个 turn 都要以推进动作收尾。\n\n" +
    "请立即采取一个推进动作：\n" +
    "- 若你有问题要问用户、且尚未送出：调 sh_msg__send_to_user(intent=\"question\", body=\"...\") 发送，并配套调 sh_stage__advance(target_stage=\"awaiting_user\", reason=\"...\")；仅输出文本不会送达用户。\n" +
    "- 若你已向用户发过消息、只是漏了切 stage：只需补调 sh_stage__advance(target_stage=\"awaiting_user\", reason=\"...\")。\n" +
    "- 若本阶段工作已完成：调 sh_stage__advance 推进到下一 stage。\n" +
    "- 若还需多步工作：继续工作即可 —— 若某个 turn 结束后仍未推进，你会再次被提醒。",
  // ---- clarify history labels ----
  clarify_history_none: "（无澄清轮次，raw_task 已足够清晰或被 fast path 跳过）",
  clarify_history_round_label: "### 第 {n} 轮",
  clarify_history_question_label: "**问题**：",
  clarify_history_answer_label: "**回答**：",
  clarify_history_question_missing: "（问题文件缺失）",
  clarify_history_answer_missing: "（尚未回答）",
  // ---- empty markers ----
  stage_history_none: "  - （无）",
  recent_events_none: "（无）",
};

/** Select the LITERALS dict by lang; "zh" -> ZH, otherwise (including "en") -> EN. */
export function literals(lang: Lang): Readonly<Record<LiteralsKey, string>> {
  return lang === "zh" ? LITERALS_ZH : LITERALS_EN;
}
