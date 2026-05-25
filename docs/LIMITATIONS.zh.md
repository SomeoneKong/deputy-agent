# 已知限制

本文列出当前 Deputy 实现中具体、可观察到的限制。其范围限定于已交付代码当前实际所做的事
情 —— 而非设计意图或未来方向。

## 范围与成熟度

- **0.1.0 参考实现。** 这是一个参考实现；以作者的品控标准衡量，它尚未达到生产级，仍需进一步打磨。
- **主要针对 Claude 调教。** harness 的表现与模型强相关；本系统目前主要针对 Claude 调教，Codex / GPT
  模型当前表现更弱（具体能力差异见下文 *Providers*）。
- **仅任务级 memory。** 各 Agent 通过 workspace 文件协同、worker 的多 session 状态持久化在磁盘上；但
  跨任务的经验复用，以及 harness 自带之外的外部 know-how / 工具注入，在本版本中尚未实现。

## Providers

- **仅实现了 `claude` 和 `codex`。** `ProviderId` 类型还列出了 `opencode` 和 `pi`，它们也
  出现在 `ALL_PROVIDER_IDS` 中，但并不存在面向它们的运行时 adapter（adapter 集合为
  `claude`、`codex` 和一个 `stub`）。通过 `deputy.config.json` 将某个角色绑定到 `opencode`
  或 `pi` 会沿着角色绑定的优先级链回退，并给出警告；如果某个绑定强制要构建一个未实现
  provider 的运行时，它会抛出明确的 not-implemented 错误而不是启动。

- **各 provider 的能力不同，且这种差异是可观察的。** 每个 provider 都会发布一个
  `RuntimeCapabilities` 矩阵，host 在使用某个可选成员之前会检查它。某些能力在一个 provider
  上存在而在另一个上缺失，因此一个角色的行为取决于它所绑定的 provider：
  - *上下文压缩摘要观察（Context-compaction summary observation）* — Claude 报告
    `compact.canObserveSummary: true`；Codex 报告 `false`。当 watcher 被绑定到一个无法观察
    摘要的 provider 时，watcher 的压缩模式会回退为 `lenient`（由 host 自行管理摘要），而不是
    默认的 `strict`。
  - *自定义压缩指令（Custom compaction instructions）* — Claude 接受自定义摘要指令
    （`acceptsCustomInstructions: true`）；Codex 不接受（`false`），因此在 Codex 下这类指令
    不会被应用。
  - *工具强制（Tool enforcement）* — Claude 通过 preflight hook 强制工具，并能禁用高风险的
    内置工具；Codex 没有 preflight-hook 路径，而是改用一个 OS sandbox（`writableRoots`）来
    限定写入。其结果是，当 Codex 充当 meta 时，Claude 通过 hook 强制的 harness 写保护不会被
    强制，会退化为 prompt 级别的约束。
  - *会话恢复（Session resume）* — Codex 能够从一个 provider 会话 id 恢复
    （`fromProviderId: true`）；Claude 不能（`false`）。两个 adapter 都不会从文件恢复，也不
    会在某个入口处 fork。
  - *禁用自动重试（Auto-retry disable）* — Codex 能够禁用自动重试；Claude adapter 报告
    `canDisable: false`，因此在 Claude 下请求禁用自动重试会以 `not_supported` 快速失败。

- **某些 Codex 能力在验证完成前被报告为不可用。** Codex adapter 附带 `warn` 诊断提示（例
  如 isolation transport、OAuth provisioning、内置工具控制），并保守地将相应能力报告为
  `false`，而不是声称支持。Claude adapter 类似地附带了一个 `claude_ts_api_unverified` 提
  示，覆盖其 TS SDK 表面。

## Web GUI

- **仅限 loopback 且单进程。** 服务器绑定到一个 loopback host（默认 `127.0.0.1:4319`），如
  果被要求绑定到非 loopback 地址会快速失败。它没有认证，并在写入和流上施加 Origin 检查。它
  并不打算用于多用户、远程或对外暴露的部署。

- **写入通过一个进程内 mutex 串行化。** 所有改变状态的操作都在 web 后端中通过单一的进程内写
  入链一次执行一个。在这一层没有跨进程调度；跨进程的并发安全性来自底层的逐文件锁。

- **实时更新使用文件系统监视并周期性对账。** SSE 流由 `fs.watch` 加上一个 debounce 驱动，并
  以一个周期性（2s）的对账 pass 和心跳作为回退。这是一个务实而非推送精确（push-exact）的机
  制：更新可能在对账间隔到来时才送达，而不是即时送达；在读取/监视出错时，流会发出一个 `lag`
  事件，前端则通过 REST 重新补水（re-hydrate）。复合的任务提交端点会报告部分成功（逐文件上
  传失败会被聚合到一个 `failed` 列表中）。

## Host daemon

- **每个任务同一时刻只有一个 host daemon。** host 持有一个单实例锁
  （`control/host.pid.lock`）；为同一任务启动的第二个 host 会以单实例冲突退出。一个任务不能
  同时被两个 host 驱动。

- **某些操作要求 host 未在运行。** 如果锁已被持有，`run` 会被拒绝；`delete` 要求 host 已停
  止 —— 删除一个其 host 仍在运行的任务会被拒绝，并给出消息要求先 `cancel` 或 `pause` 它。

## Testing

- **本开源导出中不包含自动化测试。** 该 package 仅定义了 `typecheck`、`build` 和 `check`
  脚本；这里没有交付任何 test runner 或测试套件。
