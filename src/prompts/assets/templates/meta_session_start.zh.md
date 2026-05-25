# 你的当前任务上下文
{recovery_note}
## raw_task

{raw_task}

## 用户澄清历史

{clarify_history}

## 当前任务状态

- 当前 stage：{current_stage}
- 最近 stage_history（最多 5 条）：
{stage_history}
- 当前 last_error：{last_error}

## 待处理消息（inbox）

你的 inbox 当前有 {inbox_count} 条 meta 频道消息（含跨 run 累积；按内容幂等判断处理）。先调 `sh_inbox__pull` 批量看完，再综合判断下一步。

## 最近的系统事件（参考用）

{recent_events}

---

请按你的判断推进任务。

**在 `clarifying` / `bootstrapping` 阶段，每个 turn 都要以推进动作收尾。** 这两个阶段你是任务的唯一驱动者。若只输出文本（不调任何 tool）就结束 turn，任务会停滞、用户什么也看不到 —— 只以文本存在的问题永远送不到用户。host 有兜底机制最终会把你唤醒，但那是代价高昂的安全网、不是正常推进路径，不要依赖它。要向用户提问，**必须**同时调 `sh_msg__send_to_user(intent="question", ...)` 和 `sh_stage__advance(target_stage="awaiting_user", ...)`（仅文本不会送达用户）；否则推进 stage，或在还有多步时继续工作。
