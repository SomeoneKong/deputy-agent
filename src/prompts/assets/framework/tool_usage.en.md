# Framework Tool Calling Convention

The framework tool names provided by the system are all prefixed with `sh_` (e.g. `sh_stage__advance` / `sh_msg__send_to_worker`), to distinguish them from your built-in tools (Read / Glob / Grep / Bash, etc.).

Each call returns a result whose top level has `ok` / `error_kind` / `error_message` fields:

- When `ok=true`, the remaining fields are the specific result of the action
- When `ok=false`, self-decide remediation based on `error_kind` (most are retryable or fixable by changing parameters)

Three semantic categories:

- **State-mutation tools** (`sh_stage__*` / `sh_harness__*` / `sh_inbox__mark_responded`): immediately synchronous, mostly idempotent — repeat calls return "already applied" in the result without re-triggering side effects
- **Message-delivery tools** (`sh_msg__*`): async semantics. `sh_msg__send_to_worker` / `sh_msg__send_to_reviewer` / `sh_msg__send_to_watcher` / `sh_msg__escalate_to_meta` etc. (agent-to-agent delivery) report "enqueued into inbox" (does not mean the other side has consumed it). `sh_msg__send_to_user` is **the exception** — user is not an inbox consumer; its result reports "appended to `conversation.jsonl`" (does not go through messaging bus / no env_id returned). **Repeat calls re-deliver / re-append**: for agent-to-agent delivery, use `sh_inbox__inspect_worker_status` before retrying to check the prior delivery's status; for `send_to_user`, look at the last few lines of `conversation.jsonl` / `status.md` before retrying to avoid stacking the same message
- **Agent-scheduling tools** (`sh_agent__start_worker` / `sh_agent__stop_worker` / `sh_agent__trigger_reviewer`): actually start / stop LLM sessions; **repeat successful calls start / stop / trigger one more time** (e.g. repeating `sh_agent__trigger_reviewer` will spin up multiple Reviewers each producing its own verdict). Before retrying, judge whether another trigger is needed based on current state / audit signals
