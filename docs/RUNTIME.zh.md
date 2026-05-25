# Runtime

本文档介绍 host 运行时：单实例 host 守护进程及其 tick 循环、四种 agent 角色、stage 状态机、消息总线、watcher 流水线，以及并发 / 恢复模型。本文假设你已了解 [ARCHITECTURE.zh.md](ARCHITECTURE.zh.md) 中的整体结构；磁盘上的 schema 见 [DATA_FORMATS.zh.md](DATA_FORMATS.zh.md)，provider 层见 [PROVIDERS.zh.md](PROVIDERS.zh.md)。

## Host daemon

host 是一个**单实例守护进程**。启动时它会在 `control/host.pid.lock` 上获取一个 OS 建议性文件锁（见 [并发与恢复](#concurrency--recovery)）；如果另一个存活的 host 已持有该锁，新进程会立即以单实例退出码退出。获取锁之后，它写入 `control/host.pid`（`{ pid, startedAt }`），运行启动恢复，然后进入 tick 循环。

守护进程要么运行在**前台**（在 CLI 进程内，使用 `--foreground`；host 日志输出到 CLI 的 stdout/stderr），要么**分离运行**（CLI 将其作为后台子进程派生，并从启动 shell 的会话中分离，stdout/stderr 重定向到 `control/host.log`）。两条路径运行的是同一套循环，语义完全一致。

每个 tick 读取 manifest，并按当前 stage 进行分派：

| Step | Action |
| --- | --- |
| 1. Read manifest | 加载 `control/manifest.yaml`。读取失败是致命错误（退出码 2）。 |
| 2. Terminal / paused check | 如果 stage 是终态（`done` / `failed` / `cancelled`）或 `paused`，清理 session 并退出。 |
| 3. Ensure sessions | 启动 / 保持在线当前 stage 所需的 agent session（meta 始终在线；watcher 在 `running` 阶段）。 |
| 4. Deliver messages | 对每个相关 inbox，折叠出在每通道 wake 游标之后的未读 envelope，并将其注入目标 session。 |
| 5. Dispatch windows | 在 `running` 阶段，将 worker 的输出流切片成 window 并入队到 watcher inbox。 |
| 6. Evaluate advancement | 协调 worker 生命周期（首次启动 / worker 退出后的重启），并向 meta 发送 worker-exit 提醒。 |
| 7. Sleep | 等待 tick 间隔（默认 1000 ms），然后进入下一轮循环。 |

stage 的转换本身由 agent（meta）或 host 做出，而非由循环体做出；循环只负责操控 session 与消息流。当 stage 变为终态或 `paused` 时，`cleanupAndExit` 会关闭所有持有的 session，写入其配对的 session-ended 记录，追加一条 `host_stopping` 事件，移除 `control/host.pid`，并返回一个由该 stage 推导出的退出码。守护进程在 worker 退出后不会自动重启它（见下文）。

退出码：

| Code | Meaning |
| --- | --- |
| `0` | `done` / `paused` / `awaiting_user` 让出 / stop 信号 |
| `1` | `failed` 终态，或 meta 永久性失败 |
| `2` | manifest 读取失败或 host 自身的致命错误 |
| `6` | `host.pid.lock` 冲突（另有 host 正在运行） |
| `130` | SIGINT |

## Agent roles

四种角色相互协作。它们从不直接相互调用；而是通过消息总线交换 envelope。

| Role | Lifetime | What it does |
| --- | --- | --- |
| **meta** | 长生命周期。在 `submitted`/`clarifying` 阶段启动，并跨各 stage 保持在线，直到任务到达终态/paused stage。 | 编排者：澄清任务、准备每任务的 harness、启动/停止 worker、裁决 worker 结果、驱动 stage 转换，并决定任务何时完成或何时需要用户介入。只有 meta 可以结束 meta session。 |
| **worker** | 每次尝试一个。首次进入 `running` 时自动启动一次；后续启动由 meta 请求。session 结束时结束。 | 执行者：在 `workspace/` 内执行任务。 |
| **watcher** | 在 `running` 期间长生命周期。 | 观察 worker 输出流的 window（见 [Watcher 流水线](#watcher-pipeline)），并向 meta 报告观察结果；当其自身 context 增长过大时可触发 context 压缩。 |
| **reviewer** | 一次性。由 meta 在 review 点按需启动；提交裁决后结束。 | 为一个 review 阶段（`bootstrap_self_review` 或 `final_review`）产出单个 `reviewer_verdict`（`pass` / `needs_revision` / `unsafe`，或 `verdict_missing` 兜底）。 |

当 worker session 结束时，host 会向 meta inbox 写入一个 `worker_session_end` envelope 并等待——它**不会**自行重启 worker。后续动作（启动新 worker、停止、推进 stage，或发送指令）由 meta 决定。在 meta 尚未对一个未处理的 `worker_session_end` 采取行动期间，host 会在每个 meta idle turn 向 meta inbox 重新发送一次 worker 完成提醒。

一个 watchdog 监控若干 session 级别的条件，一旦触发，就关闭受影响的目标并记录结果（它从不自行重启）：

| Scope | Condition | Default threshold |
| --- | --- | --- |
| Worker | 自上一次 `tool_use` 后无新的 `tool_use`（`no_progress`） | 30 min |
| Worker | 连续 N 次相同的 `(toolName, hash(input))` 调用（`tool_loop`） | 5 |
| Reviewer | 整个 session 运行时长 | 30 min |
| Meta push | 单次 inject/await 时长 | 60 min |

worker watchdog 触发会关闭 worker 并产出一个 `worker_session_end`（如同一次主动退出）。反复的 meta-push 超时，以及连续 meta 启动失败的计数，会汇入一条 force-`failed` 路径，在 meta 无法保持在线时终止任务。

## Stage machine

manifest 的 `stage` 字段是唯一可信来源。共有九个 stage：

| Stage | Class | Active roles |
| --- | --- | --- |
| `submitted` | in-progress | —（host 将其转换为 `clarifying`） |
| `clarifying` | in-progress | meta |
| `bootstrapping` | in-progress | meta |
| `running` | in-progress | meta、worker、watcher（reviewer 按需） |
| `awaiting_user` | in-progress | meta |
| `done` | terminal | — |
| `failed` | terminal | — |
| `cancelled` | terminal | — |
| `paused` | （都不是） | — |

转换按触发方分类——`host`、`meta_tool` 或 `user_cli`：

- `submitted → clarifying` 由 host 自主完成。
- in-progress 的推进（`clarifying → bootstrapping`、`bootstrapping → running`、`running → {awaiting_user, done}`、`awaiting_user → {running, done}`，以及 in-progress stage 之间的重置）由 meta 通过 stage-advance 工具驱动。
- 从 `awaiting_user` 进入 `done`、从任意 in-progress 或 `paused` stage 进入 `cancelled`，以及从任意 in-progress stage 进入 `paused`，由用户通过 CLI 驱动。
- host 可以将任意 in-progress stage 强制转为 `failed`。

```
                 ┌─────────────┐
                 │  submitted  │
                 └──────┬──────┘
                        │ host
                        ▼
                 ┌─────────────┐
                 │  clarifying │
                 └──────┬──────┘
                        ▼
                 ┌──────────────┐
                 │ bootstrapping│
                 └──────┬───────┘
                        ▼
                   ┌──────────┐
                   │ running  │
                   └────┬─────┘
                        ▼
                 ┌────────────────┐
                 │ awaiting_user  │
                 └───────┬────────┘
                         ▼
                      ┌──────┐
                      │ done │
                      └──────┘

  Any in-progress ──► failed | cancelled    (terminal)
  Any in-progress ◄─► paused                (resume returns to pausedFrom)
```

每次转换都通过 manifest 锁以**比较并设置（compare-and-set）守卫**串行化：调用方传入期望的来源 stage，若磁盘上的 stage 不再匹配则拒绝写入（并发的 CLI cancel/pause 会被检测为一次 CAS 冲突）。大多数已应用的转换都会向 `events.jsonl` 追加一条 `stage_transition` 条目；而 CLI `pause`/`resume` 则改为记录一条 `user_cli_action` 事件，部分 host 失败路径会更新 manifest 而不发出转换事件。应用转换时会重新渲染 `status.md`。`paused` 会记录 `pausedFrom`（被暂停时所处的 in-progress stage），以便 `resume` 返回到它。

另有两个转换额外受 reviewer 裁决约束：

- **进入 `running`**（从任意非 `running` 的 stage）要求在任务生命周期中曾存在一个非失败的 `bootstrap_self_review` `reviewer_verdict`。
- **`running → {awaiting_user, done}`**，当存在 `worker_completion_claim` 时，要求存在一个非失败的、严格排序在最近一次该 claim 之后的 `final_review` `reviewer_verdict`。

如果消息总线未初始化，这两个 gate 都会 fail closed（默认拒绝）。

## Message bus

agent 通过三个 inbox **channel** 通信，每个 channel 各有一份**按 kind 的白名单**：

| Channel | Allowed envelope kinds |
| --- | --- |
| `meta` | `user_feedback`、`user_upload`、`user_clarify_answer`、`worker_escalation`、`worker_notification`、`worker_completion_claim`、`worker_session_end`、`watcher_observation`、`reviewer_verdict`、`host_event` |
| `worker` | `meta_instruction`、`meta_interrupt` |
| `watcher` | `meta_instruction`、`worker_stream_window` |

入队一个 kind 不在其 channel 白名单中的 envelope 会被拒绝。envelope schema（payload 布局、每个 kind 的 `extras`）见 [DATA_FORMATS.zh.md](DATA_FORMATS.zh.md)。

投递状态——一个 envelope 是否已被**读取**或**响应**——**不**存储在 envelope 上。它是通过折叠消息总线的**状态流**（`state.jsonl`）推导出来的：每个变更操作都会在一个 bus 锁下追加一条状态记录，分配一个单调递增的 `stateSeq`，并只更新一个内存缓存。读取 API 会在锁下折叠完整状态。由于已读 / 已响应状态完全存在于追加的流中而非 envelope 上，投递状态可通过重启后重新折叠来重建，从而可在 host 重启之间恢复。

## Watcher pipeline

当任务处于 `running` 时，worker 的输出流（一个由 provider adapter 写入的 JSONL 文件）会被切分成时间 window 并分派给 watcher。

一个 `WindowDispatcher` 持有一个每 worker-session 的内存 `OffsetTracker`，记录目前已读到的字节 offset 和下一个 window 的到期时间（一个固定 window，默认 180 s，在单调时钟上自 session 启动起测量）。在每个 tick 上，它追赶所有到期的 window：对每个 window，它从上一个 offset 读取流的增量，进行预处理并渲染，并且——若该 window 非空——向 watcher inbox 入队一个 `worker_stream_window` envelope，并追加一条 `worker_stream_window_dispatched` 事件。空 window 推进状态但不分派。当 worker session 结束时，dispatcher 追赶积压并发出最后一个 window。

dispatcher 只负责入队 envelope；向 watcher session 的物理注入发生在 tick 循环的投递步骤中。增量读取会排除结尾处一行尚未写完的半行（在下次读取时推进），并跳过中间损坏的行（其字节仍计入 offset，因此不会被重新读取）。读取 / 入队失败采取 fail-soft 策略；一个降级的最终 window 会向 meta inbox 浮现一个 `host_event`。

独立地，当 watcher 空闲且其报告的 context 用量超过某个 token 阈值（默认 500,000）时，host 会在后台运行一个 context **压缩（compaction）**流程：它压缩 watcher 的 context 并重新注入角色，而不阻塞 tick。该流程受一个重试上限约束；一旦耗尽，就对该 watcher session 放弃。

## Concurrency & recovery

**锁。** 所有跨进程协调都使用 OS 建议性文件锁（`flock(2)` / `LockFileEx`，通过 `fs-ext`），绑定到一个文件描述符，并在进程崩溃时由 OS 自动释放：

| Lock | Guards |
| --- | --- |
| `control/host.pid.lock` | 单 host 实例（非阻塞获取）。 |
| Manifest lock | 串行化所有 manifest stage 转换（带 CAS 守卫）。 |
| Messaging lock | 串行化所有消息总线状态变更与折叠。 |
| File-level locks | capsule 写入，例如 worker session-sequence 计数器。 |

阻塞式获取以非阻塞方式带超时轮询，并在超时时抛出，因此事件循环永远不会被阻塞。

**启动恢复** 在 tick 循环之前运行：

- 加载 manifest（读取/解析/schema 失败是致命错误 → 退出码 2）。
- 修复 `events.jsonl`：截断结尾处的部分行；隔离（quarantine）中间损坏的行，并继续事件读取。
- 恢复消息总线：清理遗留的临时 payload 目录，**折叠状态流**以重建投递状态，截断部分状态尾部，将 payload 缺失的 envelope 标记为失败，并移除孤立 payload。无法折叠的状态流会被隔离，并向 meta inbox 发送一个 `host_event`。
- 修复未完成的 worker 场景：一个 `STARTED` 而无配对 `ENDED` 的 worker（host 在 worker 运行时崩溃），或一个 meta 尚未裁决的 `worker_session_end`，都会被协调，以使循环既不会把缺失的 worker 误判为首次启动，也不会自行重启。

在适用之处，追加操作是幂等的：session-ended 记录和 worker-end envelope 通过内存中的 closeout 守卫，每个 session 恰好写入一次；重新运行恢复时会跳过已标记为失败的 envelope。

`events.jsonl`、manifest 和 envelope schema 见 [DATA_FORMATS.zh.md](DATA_FORMATS.zh.md)，host 所驱动的 session 接口见 [PROVIDERS.zh.md](PROVIDERS.zh.md)。
