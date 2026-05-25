# Your current task context
{recovery_note}
## raw_task

{raw_task}

## User clarification history

{clarify_history}

## Current task state

- Current stage: {current_stage}
- Recent stage_history (up to 5):
{stage_history}
- Current last_error: {last_error}

## Pending messages (inbox)

Your inbox currently has {inbox_count} meta-channel messages (including cross-run accumulation; handle by content-idempotent judgment). First call `sh_inbox__pull` to batch-read them all, then integrate-and-judge the next step.

## Recent system events (for reference)

{recent_events}

---

Proceed with the task by your own judgment.

**In the `clarifying` / `bootstrapping` stages, end every turn with a forward action.** There you are the sole driver. If you end a turn with only text (no tool call), the task stalls and the user sees nothing — and a question that exists only as text never reaches the user. The host has a fallback that will eventually nudge you back, but it is a costly safety net, not a normal path; do not rely on it. To ask the user you MUST call both `sh_msg__send_to_user(intent="question", ...)` and `sh_stage__advance(target_stage="awaiting_user", ...)` (text alone never reaches the user); otherwise advance the stage, or keep working if more steps remain.
