# Providers

Deputy 的 host 与具体 provider 无关：它从不直接与 Claude 或 Codex 通信。所有对 provider 的访问都通过单一的 `AgentRuntime` 接口进行，并且每个 provider 都发布一份 `RuntimeCapabilities` 矩阵，host 在使用任何可选行为之前都会查阅它。本文档涵盖这一层面——接口、能力模型、归一化事件流、角色 → provider 解析，以及具体的 `claude` / `codex` / `stub` 适配器。

整体结构参见 **[ARCHITECTURE.zh.md](ARCHITECTURE.zh.md)**，host 守护进程如何在其 tick 循环中驱动会话参见 **[RUNTIME.zh.md](RUNTIME.zh.md)**。

## AgentRuntime 接口

每个 provider 对应一个 `AgentRuntime` 实例。它暴露两个只读字段——`providerId` 和 `capabilities`——以及下面的会话方法。`SessionHandle`（由 `startSession` 返回）在之后的每次调用中标识一个会话。

**核心成员**（始终存在）：

| 成员 | 签名 | 用途 |
| --- | --- | --- |
| `startSession` | `(req: SessionRequest) => Promise<SessionHandle>` | 为一个角色启动会话，带有 model、cwd、系统提示词、工具名、隔离 profile 和 stream 路径。 |
| `inject` | `(handle, input: InjectInput) => Promise<InjectAck>` | 在某个 `InjectPolicy` 下将内容投递进会话；ack 报告其被接受的方式（immediate / queued / rejected）。 |
| `abortTurn` | `(handle, reason?) => Promise<void>` | 中断正在进行的 turn（如果有的话）。 |
| `closeSession` | `(handle, options?: CloseOptions) => Promise<SessionCloseResult>` | 结束会话（可选地强制中止正在运行的 turn）；返回最终统计信息和结束原因。 |
| `status` | `(handle) => SessionStatus` | 同步返回当前状态：`initializing` / `idle` / `streaming` / `closing` / `closed`。 |
| `subscribe` | `(handle, listener) => Unsubscribe` | 为该会话归一化的 `SessionEvent` 流注册一个监听器。 |

**可选成员**（仅在声明了对应能力时才存在）：

| 成员 | 签名 | 由谁门控 |
| --- | --- | --- |
| `compact` | `(handle, hint?: CompactHint) => Promise<CompactOutcome>` | `capabilities.compact.canTrigger` |
| `contextUsage` | `(handle) => Promise<ContextUsage>` | `capabilities.contextUsage.supportsManualQuery` |
| `resumeSession` | `(handle, target: SessionResumeTarget) => Promise<void>` | `capabilities.sessionResume.*` |
| `isolationSelfCheck` | `(handle) => Promise<IsolationSelfCheckResult>` | `capabilities.isolationSelfCheck` |

host 在调用可选成员之前会先检查能力；缺少某项能力的适配器不会定义对应的方法（且会抛出 `not_supported` 而非静默降级）。

## 能力模型

`RuntimeCapabilities` 是一份**按 provider** 划分的矩阵——它描述该 provider 的能力上界，不随会话变化。某项能力被声明为 `false` 意味着 host 不得请求该行为；请求它会以 `not_supported` 快速失败，而不是降级。

| 维度 | 形态 | 含义 |
| --- | --- | --- |
| `inject` | `requireIdle`（始终为 `true`）、`steerIfStreaming`、`followUpIfStreaming`、`interruptThenInject` | provider 支持哪些 inject 策略。`requireIdle` 由契约保证；其余三项表示内容是否能 steer 正在运行的 turn、是否能作为 follow-up 排队、是否能 interrupt-then-inject。 |
| `streamingDelta` | `boolean` | provider 是否发出增量的 `assistant_delta` 事件。 |
| `contextUsage` | `kind`（`none`/`basic`/`categorized`）、`supportsManualQuery`、`supportsPushSnapshot`、`fields`（`tokens`/`contextWindow`/`percent`/`categories`） | 如何观测上下文用量：按需获取、通过快照推送，以及哪些字段会被填充。 |
| `compact` | `canTrigger`、`canObserveSummary`、`canCustomizeSummary`、`acceptsCustomInstructions` | 是否能触发 compaction、产出的摘要是否可观测、摘要是否可定制、是否接受自定义指令。 |
| `sessionResume` | `fromProviderId`、`fromFile`、`forkAtEntry` | provider 支持哪些 resume 目标。 |
| `toolEnforcement` | `preflightHook`、`firstClassBlock`、`osSandboxWritableRoots`、`canDisableHighRiskBuiltins` | 可用的写入约束机制：pre-tool-use 钩子、first-class block、带可写根目录的 OS 沙箱，以及禁用高风险内置工具。 |
| `toolStreamingPartial` | `boolean` | 是否流式传输部分工具调用输入。 |
| `providerBuiltinToolsControl` | `canDisableAll`、`canAllowList` | provider 的内置工具是否能被整体禁用，或被限制到一个 allow-list。 |
| `thinking` | `supportedLevels`（`off`…`xhigh`）、`supportsReasoningSummary` | provider 接受的推理努力等级，以及是否呈现推理摘要。 |
| `autoRetry` | `hasAutoRetry`、`canDisable` | provider 是否对上游失败自动重试，以及是否能禁用该行为。 |
| `isolationSelfCheck` | `boolean` | runtime 是否能在运行时校验其隔离根目录。 |
| `jsonSchemaSubset` | `ReadonlyArray<JsonSchemaFeature>` | provider 的工具输入能在无转换损失的情况下接受哪些 JSON Schema 特性。 |
| `diagnosticHints` | `ReadonlyArray<DiagnosticHint>`（可选） | 当某个层面未经验证时附加的 `info`/`warn` 注记，使 host 不会把它当作稳定的生产行为来调度。 |

**门控约定。** 在任何依赖可选行为的代码路径之前，host 先读取相关能力，然后才调用可选成员（或选择某种策略）。这把缺失的能力变成一次受检的、启动时 / 调用前的决策，而非运行时的意外。

## 归一化事件流

每个适配器是其 provider 原生事件流的唯一消费者。它把这些原生事件归一化为单一的 `SessionEvent` 联合类型，将每个事件持久化为一行 `StreamJsonlLine`（事件加上 `_writer` 元数据：一个单调递增的 `seq` 和 `adapterVersion`），并把它们扇出给订阅者。每个事件都扩展自 `SessionEventCommon`（`receivedAt`、`sessionId`、`providerId`）。

该联合类型承载以下事件族：

| 族 | 种类 |
| --- | --- |
| 会话生命周期 | `session_started`、`session_resumed`、`session_ended`、`synthetic_state_snapshot` |
| Turn 边界 | `turn_started`（带 `TurnCause`）、`turn_ended`（带 `StopReason` 和 `TurnUsage`） |
| 助手输出 | `assistant_block`（text / thinking / tool_use）、`assistant_delta`（增量，当 `streamingDelta` 时） |
| 工具调用 | `tool_invoked`、`tool_result_recorded`（带 `isHostTool` 标志） |
| Compaction | `compact_started`、`compact_ended` |
| 重试 | `retry_started`、`retry_ended` |
| 子代理 | `subagent_started`、`subagent_progress`、`subagent_stopped`（从 Task/Agent 工具调用派生） |
| 用量 | `usage_snapshot`（带 `TokenUsage` 和可选的 `ContextUsage`） |
| Inject 生命周期 | `host_inject_requested`、`inject_accepted`、`inject_rejected`、`inject_queued`、`inject_delivered`、`inject_cancelled`、`inject_dropped` |
| 错误 / 逃生舱 | `runtime_error`、`provider_raw`（一个没有归一化映射的原生事件） |

输出、工具和 delta 事件携带一个可选的 `parentToolUseId`：当其被设置时，该事件源自某个子代理内部（其值为派生该子代理的 Task/Agent 工具调用 id）；主代理自身的输出则为空。`provider_raw` 是适配器未映射的原生事件的逃生舱，将它们保留下来以备审计。

## 角色 → provider 绑定与解析

角色（`meta` / `worker` / `watcher` / `reviewer`）**按任务**绑定到 provider。host 持有两份装配数据：一个 provider → `AgentRuntime` 的映射，以及每个角色的 `(provider, model)` 绑定。默认情况下所有角色都绑定到单一的 provider 和 model；默认 provider 是 `claude`。

在启动任何会话之前，`RoleResolver.resolve(role)` 产出一个具体的 `ResolvedRoleAssembly`——`(runtime, model, isolation)`：

1. **查找** — 找到该角色的绑定以及该 provider 对应的 runtime。
2. **一致性不变量** — 要求绑定的 provider、runtime 的 `providerId` 以及 model 的 `provider` 三者一致。这可以防止在一个 provider 的 runtime 上启动另一个 provider 的 model。
3. **能力门控** — 校验解析出的 runtime 满足该角色所需的能力（见下文）。选择在此处被校验，而不是在启动时才被发现。
4. **柔性回退** — 当出现不变量不匹配或能力缺失时，回退到默认（`claude`）绑定并记录一条警告。如果默认绑定本身也缺失，或同样缺少该能力，则抛出 `RoleAssemblyError`（一个清晰的启动时配置错误）——不存在越过默认值之后的静默回退。

隔离按 provider 解析（不同 provider 有不同的凭据 / 沙箱形态）：每个 provider 的隔离模板由上层注入，没有模板的 provider 使用回退。

每个角色所需的能力：

| 角色 | 所需 |
| --- | --- |
| `meta` | `inject.interruptThenInject`、`thinking.supportsReasoningSummary`，以及（仅在生产模式下）一个写入约束层级：`toolEnforcement.preflightHook` \|\| `firstClassBlock` \|\| `osSandboxWritableRoots`。 |
| `watcher` | 按模式进行的主动 compaction：**strict** 需要 `compact.canObserveSummary` && `compact.canCustomizeSummary`；**lenient** 只需要 `compact.canTrigger`。 |
| `worker` / `reviewer` | 没有额外的硬性要求（`inject.requireIdle` 由契约保证）。 |

## 适配器

具体实现位于 `src/wrapper/adapters/`：

| 适配器 | 后端 | 备注 |
| --- | --- | --- |
| `claude` | Claude Agent SDK | 默认 provider。暴露一个公开工厂（`claudeRuntimeFactory`）和仅 Claude 的配置；SDK 私有的词汇保持内部。 |
| `codex` | Codex app-server JSON-RPC 协议 | 在 JSON-RPC 传输之上驱动 `thread/*` 和 `turn/*` 方法。协议类型对齐到 `codex app-server generate-ts --experimental` @ codex-cli 0.133.0（重新生成以校验）。 |
| `stub` | 无（离线） | 一个可脚本化的 runtime，实现完整的 `AgentRuntime` 契约，用于测试和闭环驱动；`providerId` 默认伪装成 `claude`，能力矩阵可配置。不是一个真实的 provider。 |

### claude vs codex（事实性的能力差异）

| 能力 | `claude` | `codex` |
| --- | --- | --- |
| `inject.steerIfStreaming` | `false` | `true`（`turn/steer`） |
| `inject.interruptThenInject` | `true` | `true`（`turn/interrupt` → 等待 `turn/completed` → `turn/start`） |
| `contextUsage.kind` | `categorized` | `basic` |
| `contextUsage.fields` | `tokens`、`contextWindow`、`percent`、`categories` | `tokens`、`contextWindow`、`percent` |
| `compact.canObserveSummary` | `true` | `false` |
| `compact.canCustomizeSummary` / `acceptsCustomInstructions` | `true` | `false` |
| `sessionResume.fromProviderId` | `false` | `true`（`thread/resume`） |
| `toolEnforcement.preflightHook` | `true` | `false` |
| `toolEnforcement.osSandboxWritableRoots` | `false` | `true`（`turn/start` `sandboxPolicy.workspaceWrite.writableRoots`） |
| `toolEnforcement.canDisableHighRiskBuiltins` | `true` | `false` |
| `providerBuiltinToolsControl` | `canDisableAll` 与 `canAllowList` 均为 `true` | 两者均为 `false` |
| `autoRetry.canDisable` | `false` | `true` |
| `jsonSchemaSubset` | 受限子集 | 完整集 |

两个 provider 都声明 `streamingDelta: true`、`isolationSelfCheck: true`、`thinking.supportsReasoningSummary: true`、`inject.requireIdle: true` 以及 `compact.canTrigger: true`。两者都为尚未对照实时 API 验证的层面附加 `warn` 级 `diagnosticHints`（claude 适配器在其 TS SDK 层面未经验证时；codex 适配器针对隔离传输、OAuth 配给和内置工具控制）。
