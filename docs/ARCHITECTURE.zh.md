# 架构

Deputy 是一个 TypeScript 运行时，编排多个 AI agent 角色以自主执行长时间运行的任务。任务被提交（通过 CLI 或本地 Web GUI）后，以磁盘上的*任务胶囊（task capsule）*形式存储。随后，单个 host 守护进程反复 tick：它启动并引导各 agent 角色、在它们之间传递消息、观察 worker 的输出、运行完成检查，并推动任务穿越其生命周期，直至到达终态。每个角色都可以运行在不同的 provider（Claude 或 Codex）上，背后是统一的 adapter 层。

本文档是入口。它给出整体形态；聚焦的配套文档则深入细节：

- **[RUNTIME.zh.md](RUNTIME.zh.md)** —— host 守护进程的 tick 循环、四个 agent 角色、stage 状态机、消息总线，以及并发 / 恢复模型。
- **[DATA_FORMATS.zh.md](DATA_FORMATS.zh.md)** —— 磁盘上的 schema：胶囊布局、`manifest.yaml`、消息信封、`events.jsonl`、`done_criteria.yaml`，以及 `deputy.config.json`。
- **[PROVIDERS.zh.md](PROVIDERS.zh.md)** —— `AgentRuntime` 接口、能力模型、归一化事件流，以及 claude / codex / stub adapter。
- **[WEB.zh.md](WEB.zh.md)** —— 本地 Web GUI：REST 端点、SSE 事件类型，以及 loopback 安全模型。
- **[LIMITATIONS.zh.md](LIMITATIONS.zh.md)** —— 当前实现的已知局限。

（中文版本：`*.zh.md`。）

## 子系统映射

| 目录 | 职责 |
| --- | --- |
| `src/shared` | 任务胶囊路径布局、`manifest.yaml` 任务状态机、原子文件写入、锁、id、时间 / JSONL 辅助工具，以及 `status.md` 渲染。 |
| `src/wrapper` | provider 无关的表层：`AgentRuntime` 接口和能力模型（`RuntimeCapabilities`）。 |
| `src/wrapper/adapters` | 具体的 provider 实现 —— `claude` 与 `codex` —— 外加用于离线 / 无 provider 运行的 `stub` 运行时。 |
| `src/wrapper/types` | wrapper 内共享的类型契约：runtime、capability、session、events、isolation、tool-bridge。 |
| `src/messaging` | 消息总线：信封 schema、按 channel 划分的收件箱、消息总线状态流、跨进程并发，以及恢复。 |
| `src/prompts` | 为每个角色组装系统提示词和首条用户消息，带有本地化字面量（en/zh）和按提示词的语言回退。 |
| `src/host` | 守护进程：tick 循环、agent 会话编排、stage 状态机、恢复、看门狗，以及重试。 |
| `src/host/tools` | agent 调用的 host 提供的工具（消息、agent 控制、harness 编辑、stage 转换、reviewer 裁决）。 |
| `src/host/watcher` | 将 worker 的输出流切分为窗口，并分发给观察者角色。 |
| `src/host/done_criteria` | 声明式完成检查（`done_criteria.yaml`），在 worker 会话结束时求值。 |
| `src/cli` | CLI 入口、参数解析、`deputy.config.json` 加载，以及启动守护进程（前台或分离）。 |
| `src/web` | 本地 Web GUI 后端 —— 一个仅 loopback 的 HTTP 服务器，带 SSE 流式传输。 |

## 组件概览

```
        CLI                         Web GUI (loopback HTTP + SSE)
         │                                   │
         ▼                                   ▼
  ┌──────────────── write commands (in-process) ────────────────┐
  │                                                              │
  ▼                                                              ▼
  manifest.yaml  ◄────────  task capsule (workspace/ + control/)  ────────► events.jsonl
        ▲                              │                                         ▲
        │                             tick                                       │
        │                              ▼                                         │
   ┌────────────────────────── host daemon ───────────────────────────┐
   │   stage machine · agent orchestration · watchdogs · done checks   │
   └───────────────────────────────────────────────────────────────────┘
        │           │            │             │
        ▼           ▼            ▼             ▼
      meta       worker       watcher       reviewer        (agent roles)
        │           │            │             │
        └───────────┴── message bus (envelopes / channels) ──┘
                              │
                              ▼
                  AgentRuntime  →  claude | codex | stub
```

CLI 和 Web GUI 是同一套进程内 write commands、同一个磁盘上胶囊之上的两个前端。两者都不直接与 provider 对话；所有 provider 访问都经过 `AgentRuntime` 接口，因此 host 与 provider 无关。

## 运行时模型（摘要）

任务是一个目录 —— *胶囊* —— 由一个 `workspace/` 半区（工作在此发生）和一个 `control/` 半区（编排状态）组成。权威状态是 `control/manifest.yaml`；每个编排级别的事件都追加到 `control/events.jsonl`。

host 是一个**单实例守护进程**（由 `control/host.pid.lock` 守护），运行一个 tick 循环。每次 tick 时，它读取 manifest，并根据当前 stage，确保正确的 agent 会话在线、投递未读消息、将 worker 的输出窗口分发给 watcher，并评估任务是否应当推进。当任务到达终态或暂停 stage 时，它退出。

四个 agent 角色协作（完整细节见 [RUNTIME.zh.md](RUNTIME.zh.md)）：

- **meta** —— 长生命周期的编排者：澄清任务、准备每任务的 harness、启动 / 停止 worker、仲裁 worker 的结果，并决定任务何时完成或需要用户介入。
- **worker** —— 在 `workspace/` 内执行任务的执行者。
- **watcher** —— 观察 worker 输出流的窗口，并将观察结果上报给 meta；当其自身 context 增大时可触发 context 压缩（compaction）。
- **reviewer** —— 在 review 点产生裁决的一次性会话。

agent 之间从不直接相互调用；它们通过三个收件箱 **channel**（`meta`、`worker`、`watcher`）交换**信封（envelope）**，每个 channel 都有一个按 channel 的 kind 白名单。投递状态由对消息总线状态流的折叠（fold）推导得出，这使其在 host 重启后可恢复。信封 schema 见 [DATA_FORMATS.zh.md](DATA_FORMATS.zh.md)。

## 任务生命周期

manifest 的 `stage` 字段是事实来源。共有九个 stage —— 五个*进行中（in-progress）* stage、三个*终态（terminal）* stage，以及 `paused`：

```
                 ┌─────────────┐
                 │  submitted  │
                 └──────┬──────┘
                        │
              ┌─────────┴──────────┐
              ▼                    │
        ┌───────────┐              │
        │ clarifying│──────┐       │  (clarification may be skipped)
        └───────────┘      │       │
                           ▼       ▼
                    ┌──────────────────┐
                    │   bootstrapping  │
                    └─────────┬────────┘
                              ▼
                        ┌───────────┐
                        │  running  │
                        └─────┬─────┘
                              ▼
                      ┌────────────────┐
                      │ awaiting_user  │
                      └───────┬────────┘
                              ▼
                           ┌──────┐
                           │ done │
                           └──────┘

  Any in-progress stage ──► failed | cancelled       (terminal)
  Any in-progress stage ◄─► paused                   (resume returns to the paused-from stage)
```

进行中 stage：`submitted`、`clarifying`、`bootstrapping`、`running`、`awaiting_user`。终态 stage：`done`、`failed`、`cancelled`。`paused` 记录它是从哪个进行中 stage 暂停而来的，以便 `resume` 可以返回该 stage。每次转换都通过带 compare-and-set 守护的锁串行化。大多数转换会向 `events.jsonl` 追加一条 `stage_transition` 事件；而 CLI pause/resume 则改为记录一条 `user_cli_action`，部分 host 失败路径会更新 manifest 而不发出转换事件。按 stage 的进入条件、活跃角色和触发器在 [RUNTIME.zh.md](RUNTIME.zh.md) 中以表格列出。

## Provider adapter 层（摘要）

host 只与 `AgentRuntime` 对话：start / inject / abort / close 一个会话、查询其状态、订阅其归一化事件 —— 外加可选成员（`compact`、`contextUsage`、`resumeSession`、`isolationSelfCheck`），它们仅在声明了对应能力时才存在。每个 provider 发布一个 `RuntimeCapabilities` 矩阵；host 在调用其可选成员之前先检查能力，而不是在运行时才发现缺口。角色按任务绑定到 provider，并在任何会话启动之前被解析为一个具体的 `(runtime, model, isolation)` 三元组。完整表层见 [PROVIDERS.zh.md](PROVIDERS.zh.md)。

## 术语表

| 术语 | 含义 |
| --- | --- |
| **task capsule** | 每任务的目录（`workspace/` + `control/`），持有一个任务的全部状态。 |
| **manifest** | `control/manifest.yaml` —— 权威的任务记录，包括当前的 `stage`。 |
| **stage** | 任务的生命周期状态（上述九个 stage 之一）。 |
| **harness** | meta 准备的每任务 `workspace/harness/` 内容 —— SOP、工具、脚本，以及 `done_criteria.yaml`。 |
| **role** | 四个 agent 角色之一：meta / worker / watcher / reviewer。 |
| **envelope** | channel 上的一条带类型的消息，带有一个 `kind` 和可选的结构化 `extras` 以及一个 body。 |
| **channel** | 一个收件箱 —— `meta`、`worker` 或 `watcher` —— 带有按 channel 的 kind 白名单。 |
| **done criteria** | `done_criteria.yaml` 中的声明式检查，在 worker 会话结束时求值（不用 LLM）。 |
| **window** | watcher 消费的 worker 输出流的一个切片。 |
| **compaction** | 当 agent 的 context 增大时对其进行摘要，以便在 context 窗口内继续。 |
| **AgentRuntime** | 每个 adapter 都实现的 provider 无关的会话接口。 |
| **capability matrix** | `RuntimeCapabilities` —— provider 支持什么（注入、压缩等）。 |
