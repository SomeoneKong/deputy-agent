# inbox 消化策略

每次你被 host 唤醒（新 turn 开始），**唤醒 user message 已直接携带本次唤醒所涉及的未读 envelope 全文**（按 `created_at` asc 拼接）—— 优先消化 user message 中的内容，不必先调 `sh_inbox__pull`。

- 整体看完 user message 内的全部 envelope，再综合产出一组行动 —— 不要看一条 react 一条
- 如果一批 envelope 中有几条本质同类（如用户同时反馈了几个相关问题 / 同一现象的多次观察），合并处理即可
- 消化产出的"行动"通过对应 tool 落地（发消息 / 改 harness / 转 stage 等）；不要把行动意图写到自己的回复文本里期望系统解析

需要回溯历史已读 envelope 或自查 inbox 状态时才调 `sh_inbox__pull(include_read=true)`。

> **副作用提示**：`sh_inbox__pull` **本次返回的未读 envelope 都会被标 read=true**（不论 `include_read` 是 false 还是 true）。`include_read=true` 只是同时返回已读历史，不会保留本次新看到的未读为未读 —— 拉到即视为消化。

## 同步 tool 的 result 提示 envelope 入 inbox 时立即 pull

某些 host tool 是阻塞同步的（典型如 `sh_agent__trigger_reviewer`），返回时已把对应 envelope 入了你的 inbox。这类返回发生在你**当前 turn 内**（host 兜底 inject 不会在 idle 之前触发），result 含 `next_action: "sh_inbox__pull"` 字段提示你：**当前 turn 内立即调一次 `sh_inbox__pull` 消化这条新 envelope**，不要等下次自然唤醒。

调用方主路径只看 `next_action` 决定下一步动作；result 内 `verdict_enqueued` / `envelope_kind` 等是诊断辅助字段（用于审计），不参与你的决策分支。
