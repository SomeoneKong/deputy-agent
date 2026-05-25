# 框架 tool 调用约定

系统提供的框架 tool 名都以 `sh_` 前缀开头（如 `sh_stage__advance` / `sh_msg__send_to_worker`），用以与你的内置工具（Read / Glob / Grep / Bash 等）区分。

每次调用返回的 result 顶层有 `ok` / `error_kind` / `error_message` 字段：

- `ok=true` 时其余字段是动作的具体结果
- `ok=false` 时按 `error_kind` 自决补救（多数可重试或换参数）

三类语义：

- **状态变更类**（`sh_stage__*` / `sh_harness__*` / `sh_inbox__mark_responded`）：即时同步，多为幂等 —— 重复调用 result 反馈"已应用"而不重复触发副作用
- **消息投递类**（`sh_msg__*`）：异步语义。`sh_msg__send_to_worker` / `sh_msg__send_to_reviewer` / `sh_msg__send_to_watcher` / `sh_msg__escalate_to_meta` 等 agent 间投递 result 反馈"已入 inbox"（不代表对方已消化）；`sh_msg__send_to_user` **例外** —— user 不是 inbox 消化方，result 反馈的是已 append 到 `conversation.jsonl`（不入 messaging bus / 不返回 env_id）。**重复调用会重复投递 / 重复落盘**：agent 间投递重试前用 `sh_inbox__inspect_worker_status` 看上一条投递状态；`send_to_user` 重试前看 `conversation.jsonl` / `status.md` 末几行避免堆同一条消息
- **agent 调度类**（`sh_agent__start_worker` / `sh_agent__stop_worker` / `sh_agent__trigger_reviewer`）：会真实启停 LLM session；**重复成功调用会再启一次 / 停一次 / 触发一次**（如重复 `sh_agent__trigger_reviewer` 会启动多个 Reviewer 各自产生 verdict）。重试前依据当前状态 / audit 信号判断是否需要再触发
