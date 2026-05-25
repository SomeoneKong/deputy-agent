# Deputy Agent

[English](README.md) | [中文](README.zh.md)

> Deputy — a self-supervising master–worker agent framework that auto-scaffolds a
> task-tailored harness for long, autonomous delivery.

Deputy 是一个面向长时、自主任务的 TypeScript 框架。你交给它一段任务描述，它便现场生成定制的 harness，
并驱动工作走完一套结构化的生命周期直至完成，仅在关键节点与你同步。

它采用 **master–worker（主从）** 架构，而非对等的 multi-agent 系统：由 master（Meta 角色）进行规划、
准备 harness 并仲裁结果，worker 负责执行任务 —— 同时 Watcher（实时观察）与 Reviewer（在阶段 gate 给出
裁决）作为审查 agent 对 worker 进行审计与纠偏。本质上它是一个 master–worker（2-agent）架构。它同时以
命令行工具和本地 Web GUI 两种形式提供，并且多 provider：Claude 与 Codex 通过统一的 adapter 层支持。

## 特性

- **长时无人值守任务。** 面向大约 **1 小时到 ~2 天**、无需人工介入的任务，而非短交互回合。
- **非 Coding 通用场景。** 面向日常白领 / 知识工作；刻意**不**为 Coding 场景特化。
- **按需生成 harness。** 每个任务现场生成定制的 harness（方法论 / SOP / 工具 / 完成检查），而非用一套
  固定 harness 应对所有场景。
- **内建审查。** 由 master（Meta 角色）驱动 Worker，同时 Watcher（实时观察 worker 输出）与 Reviewer
  （在阶段 gate 给出裁决）对工作进行审计与纠偏。
- **文件系统任务级 memory。** 各 agent 通过 workspace 文件与消息协同；worker 的多 session 状态持久化
  在磁盘上。
- **按角色选 provider/模型。** 每个角色可运行在不同的 provider 与模型上 —— 例如为 Worker 选用更省的
  模型。
- **基于 Claude Code / Codex。** 使用 Claude Code 与 Codex CLI 的 agent 内核，以 TypeScript 实现。

## 项目状态

这是 **0.1.0** 版本，是一套更高层设计的*参考实现*：此处开源的 TypeScript 本质上是该上层 spec 的编译
产物。spec 以及许多详细的设计原则并不包含在本仓库中。

- 由于发布的代码是编译产物，**后续版本可能有大幅变动** —— 若你 fork 并打算合并后续版本，请留意这点。
- 当前主要针对 **Claude** 调教；**Codex / GPT 模型目前表现更弱**，因为 harness 的表现与模型相关。
- 以作者的品控标准衡量，它**尚未达到生产级**、仍需进一步打磨，不过可能已超过部分已发布产品的调教水平。
- 跨任务 memory 与外部 know-how 注入**在 0.1.0 中尚未实现**（目前仅有任务级、基于文件系统的 memory）。
  参见 [docs/LIMITATIONS.zh.md](docs/LIMITATIONS.zh.md)。

## 环境要求

- Node.js >= 22
- 至少一个受支持 provider 的凭据：
  - Claude（通过 Claude Agent SDK）
  - Codex（可选，用于绑定到 `codex` provider 的角色）

## 快速开始

```bash
npm install
npm run build       # tsc + 拷贝 web 静态资源
npm run typecheck   # 仅类型检查
```

构建后，**推荐**使用本地 Web GUI 来使用 Deputy：

```bash
node dist/cli/bin.js web    # 然后打开打印出的 URL（默认 http://127.0.0.1:4319）
```

Web GUI 是最便捷的方式：在一处即可提交任务、查看实时进度 / 对话 / agent 输出流，并驱动整个任务生命周期。

CLI 提供同样的操作，更适合脚本化 / 无界面（headless）场景：

```bash
node dist/cli/bin.js submit "写一份关于 X 的报告"
node dist/cli/bin.js list
node dist/cli/bin.js status <taskId>
```

## 使用

**推荐用本地 Web GUI（`deputy web`）来驱动任务**。CLI 提供同样的操作，更适合脚本化 / 无界面场景：写命令
（`submit`、`run`、`answer`、`feedback`、`upload`、`pause`、`resume`、`done`、`cancel`、`rename`、
`delete`）、读命令（`list`、`status`、`inspect`），以及 `web` 命令本身。完整命令参考、
`deputy.config.json` 格式与端到端示例见 [docs/USAGE.zh.md](docs/USAGE.zh.md)（English:
[docs/USAGE.md](docs/USAGE.md)）。

## 项目结构

```
src/
  shared/      任务胶囊布局、manifest（状态机）、原子 IO、ids、paths
  wrapper/     provider 无关的 AgentRuntime 接口 + 能力模型
    adapters/  claude / codex 适配器，外加离线用的 stub
    types/     runtime / capability / session / event 类型契约
  messaging/   信封 schema + 按通道的收件箱总线（消息传递）
  prompts/     各 agent 角色的提示词资产组装
  host/        守护进程：tick 循环、agent 编排、stage 状态机
    tools/     agent 调用的 host 提供的工具
    watcher/   worker 流分窗 + 分发给观察者角色
    done_criteria/  门控任务完成的声明式完成检查
  cli/         CLI 入口、参数解析、配置、守护进程启动
  web/         仅环回的 HTTP + SSE Web GUI 后端
```

## 文档

每篇文档都有英文版与中文版（`*.zh.md`）。

- [docs/ARCHITECTURE.zh.md](docs/ARCHITECTURE.zh.md) — 总览：子系统地图、组件图、任务生命周期、术语表，
  以及指向下列聚焦文档的链接（English: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）
- [docs/RUNTIME.zh.md](docs/RUNTIME.zh.md) — host 守护进程 tick 循环、agent 角色、stage 状态机、
  消息总线、并发与恢复（English: [docs/RUNTIME.md](docs/RUNTIME.md)）
- [docs/DATA_FORMATS.zh.md](docs/DATA_FORMATS.zh.md) — 磁盘数据格式：胶囊布局、`manifest.yaml`、
  信封、`events.jsonl`、`done_criteria.yaml`、`deputy.config.json`
  （English: [docs/DATA_FORMATS.md](docs/DATA_FORMATS.md)）
- [docs/PROVIDERS.zh.md](docs/PROVIDERS.zh.md) — `AgentRuntime` 接口、能力模型，以及
  claude / codex / stub 适配器（English: [docs/PROVIDERS.md](docs/PROVIDERS.md)）
- [docs/WEB.zh.md](docs/WEB.zh.md) — 本地 Web GUI：REST 端点、SSE 事件、安全模型
  （English: [docs/WEB.md](docs/WEB.md)）
- [docs/USAGE.zh.md](docs/USAGE.zh.md) — 安装、配置、CLI 与 Web GUI 用法
  （English: [docs/USAGE.md](docs/USAGE.md)）
- [docs/LIMITATIONS.zh.md](docs/LIMITATIONS.zh.md) — 当前实现的已知限制
  （English: [docs/LIMITATIONS.md](docs/LIMITATIONS.md)）

## 许可证

采用 Apache License 2.0。允许商业使用；你必须保留版权与许可证声明（见 [LICENSE](LICENSE) 与
[NOTICE](NOTICE) 文件），并标注你对文件所做的重大改动。Apache-2.0 还包含显式专利授权。完整条款见
[LICENSE](LICENSE)。

## 联系

如果你符合以下之一，欢迎联系：

- 想获取更高层的 spec、开发经验或定制指导；
- 在做类似的通用长任务 agent 框架，希望交流或合作；
- 希望将该设计应用到自己的产品中。
