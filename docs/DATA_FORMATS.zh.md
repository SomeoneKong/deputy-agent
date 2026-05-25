# 数据格式

本文档描述 Deputy 读写的磁盘数据格式。每个任务都存放在一个自包含的目录中——即*任务胶囊*（task capsule）——所有状态都是纯文件：YAML 用于权威清单（manifest），JSON Lines 用于仅追加（append-only）的流，JSON 用于配置，Markdown 用于人类可读的正文。整体结构见 [ARCHITECTURE.zh.md](ARCHITECTURE.zh.md)，host 在运行时如何生产和消费这些文件见 [RUNTIME.zh.md](RUNTIME.zh.md)。

所有时间戳均为带微秒精度的 ISO-8601（例如 `2026-05-25T10:30:00.123456Z`）。物理文件使用 `snake_case` 键名；TypeScript 层使用 `camelCase`，并在 IO 边界处进行转换。下文的字段名均按其在*磁盘上*的形式展示。

## 1. 任务胶囊布局

任务胶囊是目录 `<projectRoot>/tasks/<taskId>`（任务根目录为 `<projectRoot>/tasks/`）。它分为两半：`workspace/`（工作实际发生的地方）和 `control/`（编排状态）。

```
<projectRoot>/tasks/<taskId>/
├── status.md                       # human-readable status snapshot
├── conversation.jsonl              # user-facing conversation log
├── conversation.md                 # rendered conversation
├── workspace/
│   ├── inputs/
│   │   ├── raw_task.md             # the submitted task text
│   │   └── clarify/                # round_<n>_questions.md / round_<n>_answers.md
│   ├── harness/                    # per-task harness meta prepares
│   │   ├── sop/
│   │   ├── tools/
│   │   │   ├── skills_local/
│   │   │   ├── mcp_servers_local/
│   │   │   └── scripts/            # scripts referenced by done_criteria `script` checks
│   │   └── done_criteria.yaml      # completion checks (section 5)
│   ├── memory/                     # <topicSlug>.md notes
│   ├── artifacts/                  # intermediate work products
│   ├── output/                     # final deliverables
│   └── streams/                    # worker_<seq>_<sessionId>.jsonl (normalized event streams)
└── control/
    ├── manifest.yaml               # authoritative task record (section 2)
    ├── manifest.yaml.lock
    ├── events.jsonl                # orchestration event log (section 4)
    ├── events.jsonl.lock
    ├── messaging/
    │   ├── state.jsonl             # message-bus state stream (delivery / read state)
    │   ├── .lock
    │   └── payloads/<envId>/
    │       ├── payload.json        # envelope payload (section 3)
    │       └── body.md             # envelope body text
    ├── streams/
    │   ├── meta/<sessionId>.jsonl
    │   ├── watcher/<sessionId>.jsonl
    │   └── reviewer/<phase>_round_<round>.jsonl
    ├── worker/next_seq.json        # next worker sessionSeq allocator
    ├── agent_prompts/              # <sessionId>.md and <sessionId>__first_msg.md
    ├── uploads/<uploadId>/<filename>
    ├── worker_logs/                # worker_<seq>_<sessionId>_stderr.log
    ├── host.pid                    # daemon pid
    └── host.pid.lock               # single-instance host guard
```

worker 的归一化事件流位于 `workspace/streams/` 下；meta、watcher 和 reviewer 的流位于 `control/streams/` 下。reviewer 是一次性（one-shot）会话，因此其流以 `<phase>_round_<round>` 而非会话 id 作为键。

## 2. `manifest.yaml`

`control/manifest.yaml` 是权威的任务记录。`stage` 字段是任务生命周期的真相来源（source of truth）。写入通过 `manifest.yaml.lock` 串行化。

| 字段（YAML） | 类型 | 说明 |
| --- | --- | --- |
| `schema_version` | string | 始终为 `"1.0"`；加载时若不匹配则被拒绝。 |
| `task_id` | string | 任务 id（与胶囊目录名一致）。 |
| `title` | string | 简短的任务标题；可以为空。 |
| `created_at` | ISO-8601 | 胶囊创建时间。 |
| `updated_at` | ISO-8601 | 最近一次清单写入的时间。 |
| `raw_task_path` | string | 指向所提交任务文本的相对路径（`workspace/inputs/raw_task.md`）。 |
| `stage` | enum | `submitted`、`clarifying`、`bootstrapping`、`running`、`awaiting_user`、`done`、`failed`、`cancelled`、`paused` 之一。 |
| `stage_history` | list | 仅追加的 `{ stage, entered_at }` 条目列表，每次转换一条。 |
| `paused_from` | enum \| null | 当 `stage` 为 `paused` 时，表示要恢复到的进行中阶段；否则为 `null`。 |
| `last_error` | object \| null | 最近一次错误（`{ error_kind, message, at, details? }`），或 `null`。 |
| `role_bindings` | object | 可选；用户选择的按角色 `{ provider, model? }` 绑定。为空时省略。 |

`last_error.details` 对象以及 `role_bindings` 中的 provider/model 字面量被原样保留（其内部键名不进行大小写转换）。

示例：

```yaml
schema_version: "1.0"
task_id: "20260525-103000-write-report"
title: "Write the quarterly report"
created_at: "2026-05-25T10:30:00.123456Z"
updated_at: "2026-05-25T11:05:12.654321Z"
raw_task_path: "workspace/inputs/raw_task.md"
stage: running
stage_history:
  - stage: submitted
    entered_at: "2026-05-25T10:30:00.123456Z"
  - stage: clarifying
    entered_at: "2026-05-25T10:30:30.000000Z"
  - stage: bootstrapping
    entered_at: "2026-05-25T10:31:40.000000Z"
  - stage: running
    entered_at: "2026-05-25T10:45:02.000000Z"
paused_from: null
last_error: null
role_bindings:
  worker:
    provider: codex
```

## 3. 消息信封（Message envelopes）

各 Agent 通过在三个收件箱*通道*（channel）之一上交换*信封*（envelope）进行通信。每个信封以 `control/messaging/payloads/<envId>/payload.json`（结构化头部 + extras）的形式存储，并伴随 `body.md`（自由文本正文）。

| 字段（JSON） | 类型 | 说明 |
| --- | --- | --- |
| `env_id` | string | 信封 id（即 payload 目录名）。 |
| `channel` | enum | `meta`、`worker` 或 `watcher`。 |
| `kind` | enum | 信封种类（见下文）。 |
| `from` | string | 发送方标识。 |
| `created_at` | ISO-8601 | 创建时间。 |
| `extras` | object \| null | 按种类划分的结构化字段；对于无 extras 的种类为 `null`。 |

正文文本单独存储在 `body.md` 中。`read` / `responded` 标志**不**属于信封——投递与读取状态由折叠（fold）消息总线状态流（`control/messaging/state.jsonl`）推导得出；见 [RUNTIME.zh.md](RUNTIME.zh.md)。

**通道与允许的种类。** 每个通道仅接受一组白名单内的种类：

| Kind | 允许的通道 | Extras |
| --- | --- | --- |
| `user_feedback` | meta | none |
| `user_upload` | meta | yes |
| `user_clarify_answer` | meta | yes |
| `worker_escalation` | meta | yes |
| `worker_notification` | meta | yes |
| `worker_completion_claim` | meta | yes |
| `worker_session_end` | meta | yes |
| `watcher_observation` | meta | yes |
| `reviewer_verdict` | meta | yes |
| `host_event` | meta | yes |
| `meta_instruction` | worker, watcher | none |
| `meta_interrupt` | worker | none |
| `worker_stream_window` | watcher | yes |

**代表性的 extras 形态**（键名按 `payload.json` 中的序列化形式展示）：

`worker_escalation`：

| 字段 | 类型 |
| --- | --- |
| `worker_session_id` | string |
| `session_seq` | int |
| `exit_intent` | enum: `continue` \| `declare_deferred` |

`reviewer_verdict`：

| 字段 | 类型 |
| --- | --- |
| `reviewer_phase` | enum: `bootstrap_self_review` \| `final_review` \| `harness_revision_review` |
| `reviewer_round` | int |
| `verdict` | enum: `pass` \| `needs_revision` \| `unsafe` \| `null` |
| `issues` | list (opaque objects) |

`watcher_observation`：

| 字段 | 类型 |
| --- | --- |
| `watcher_session_id` | string |
| `evidence_refs` | list of strings |

其他 extras：`user_upload` → `{ upload_id, filename, size_bytes, uploaded_at }`；
`user_clarify_answer` → `{ round }`；`worker_notification` / `worker_completion_claim` →
`{ worker_session_id, session_seq }`；`worker_session_end` →
`{ worker_session_id, session_seq, exit_reason, done_criteria_outcome }`；`host_event` →
`{ event_kind, details }`；`worker_stream_window` →
`{ window_start, window_end, worker_session_id, stream_path }`。Extras 会针对一份严格的按种类划分的 schema 进行校验：缺失、多余或类型错误的键都会被拒绝。

`payload.json` 示例：

```json
{
  "env_id": "env-7c1f2a9b",
  "channel": "meta",
  "kind": "reviewer_verdict",
  "from": "reviewer",
  "created_at": "2026-05-25T11:20:00.000000Z",
  "extras": {
    "reviewer_phase": "final_review",
    "reviewer_round": 1,
    "verdict": "needs_revision",
    "issues": [{ "severity": "major", "where": "output/report.md" }]
  }
}
```

## 4. `events.jsonl`

`control/events.jsonl` 是编排事件日志：每行一个 JSON 对象，在 `events.jsonl.lock` 下追加。该文件仅追加，并对末尾的部分残行（partial trailing line）有容错（读取时跳过末尾残行并在恢复时截断；中间的损坏行则被隔离）。

| 字段（JSON） | 类型 | 说明 |
| --- | --- | --- |
| `type` | enum | 事件类型（见下文）。 |
| `ts` | ISO-8601 | 事件写入的时间。 |
| `stage` | enum | 写入时的清单 stage。 |
| `event_seq` | int | 单调递增的序号，在锁下按 fold-max+1 分配。 |
| `details` | object | 事件特定字段；键名为 `snake_case`。 |

事件类型：`host_started`、`host_recovery`、`host_recovery_failed`、`host_stopping`、
`stage_transition`、`agent_session_started`、`agent_session_ended`、`watchdog_triggered`、
`reviewer_triggered`、`worker_stream_window_dispatched`、`user_cli_action`、`harness_changed`、
`message_to_user`、`watcher_compact_triggered`、`watcher_compact_role_reinjected`、
`watcher_compact_failed`、`prompt_lang_fallback`。

示例行：

```json
{"type":"host_started","ts":"2026-05-25T10:30:01.000000Z","stage":"submitted","event_seq":1,"details":{}}
{"type":"stage_transition","ts":"2026-05-25T10:45:02.000000Z","stage":"running","event_seq":7,"details":{"from_stage":"bootstrapping","triggered_by":"meta_tool"}}
{"type":"agent_session_ended","ts":"2026-05-25T11:30:00.000000Z","stage":"running","event_seq":42,"details":{"role":"worker","session_id":"s-abc","session_seq":3,"exit_reason":"natural_completion"}}
```

在 `stage_transition` 中，`triggered_by` 反映是谁推进了 stage：host 驱动的转换（例如
`submitted -> clarifying`）使用 `"host"`，而 meta 工具推进 stage 则使用 `"meta_tool"`。

## 5. `done_criteria.yaml`

`workspace/harness/done_criteria.yaml` 保存 meta 准备的声明式完成检查。这些检查在 worker 会话结束时进行评估，**不涉及任何 LLM**。根是一个映射，包含一个非空的 `checks` 列表；每个检查都有一个 `kind`、一个必需的 `description`，以及一个可选的 `id`（模式 `^check_<n>$` 保留给 host 自动分配）。

| `kind` | 必需字段 | 含义 |
| --- | --- | --- |
| `file_exists` | `path` | 该文件存在。 |
| `file_min_lines` | `path`, `min_lines` | 该文件至少有 `min_lines` 行。 |
| `file_min_bytes` | `path`, `min_bytes` | 该文件至少有 `min_bytes` 字节。 |
| `yaml_field_present` | `path`, `field` | 该 YAML 文件具有给定的字段。`field` 可以是指向嵌套映射的点分路径（如 `a.b.c`）。 |
| `dir_min_files` | `path`, `pattern`, `min_count` | 位于 `path` 的目录至少有 `min_count` 个匹配 `pattern` 的文件（glob 以 `path` 作为工作目录运行，因此 `pattern` 相对于该目录，而非相对于 `workspace/`）。 |
| `script` | `script_path`, `interpreter`, `timeout_seconds?` | 运行一个脚本并检查其退出码。 |

所有 `path` / `script_path` 字面量都相对于 `workspace/`（前导的 `workspace/`、绝对路径、`..` 或 `:` 都会被拒绝）；而 `dir_min_files` 的 `pattern` 则相对于该检查解析后的 `path` 目录。对于 `script` 检查，`script_path` 必须位于 `harness/tools/scripts/` 之下，且 `interpreter` 必须在白名单内（`bash`、`sh`、`zsh`、`python`、`python3`、`py`、`powershell`、`pwsh`、`node`），后缀为空或为 `.exe`。`timeout_seconds` 默认为 1800，不得超过 3600。

示例：

```yaml
checks:
  - kind: file_exists
    description: "Final report is present"
    path: "output/report.md"
  - kind: file_min_lines
    description: "Report has substantive content"
    path: "output/report.md"
    min_lines: 50
  - kind: dir_min_files
    description: "At least three figures were produced"
    path: "output/figures"
    pattern: "*.png"
    min_count: 3
  - kind: script
    description: "Build passes"
    script_path: "harness/tools/scripts/check_build.sh"
    interpreter: "bash"
    timeout_seconds: 600
```

评估结果（整体的 `all_pass` / `some_fail` / `error`，加上每项检查的摘要）会被单独记录，并随 `worker_session_end` 信封的 `done_criteria_outcome` extras 一同携带。

## 6. `deputy.config.json`

`<projectRoot>/deputy.config.json` 是项目级（project-scoped）配置，由同一项目根下的所有任务共享。它在 host 启动时读取，并采用 fail-soft 策略：文件缺失、解析失败或字段无效都会回退到默认值。用法见 [USAGE.zh.md](USAGE.zh.md)。

| 字段（JSON） | 类型 | 说明 |
| --- | --- | --- |
| `claudeConfigDir` | string | Claude 配置目录（保存 `.credentials.json`）；相对路径相对于项目根解析；缺失 → 回退到 `~/.claude`。 |
| `codexHome` | string | Codex 认证源目录；仅当某角色绑定到 codex 时使用；相对路径相对于项目根解析。 |
| `roles` | object | 按角色的 `{ provider, modelId }` 绑定；未列出的角色使用默认绑定。 |

`provider` 为 `claude`、`codex`、`opencode`、`pi` 之一；角色为 `meta`、`worker`、`watcher`、`reviewer`。

示例：

```json
{
  "claudeConfigDir": ".secrets/claude",
  "codexHome": ".secrets/codex",
  "roles": {
    "worker": { "provider": "codex", "modelId": "gpt-5-codex" },
    "reviewer": { "provider": "claude", "modelId": "claude-opus-4-7" }
  }
}
```
