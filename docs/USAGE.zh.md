# 使用说明

> **推荐：** 本地 Web GUI（`deputy web`）是使用 Deputy 最便捷的方式 —— 它把任务提交、实时进度、对话、
> 事件 / 输出流，以及全部生命周期控制集中在一处。CLI 提供同样的操作，更适合脚本化与无界面（headless）环境。
> GUI 的 API 表层见 [WEB.zh.md](WEB.zh.md)。

## 环境要求

- Node.js >= 22
- 至少一个受支持 provider 的凭据：
  - **Claude** —— 通过 Claude Agent SDK。默认情况下 Claude 适配器会回退到 `~/.claude`；你也可以在配置中
    指向某个具体的 profile 目录。
  - **Codex** —— 仅当有角色绑定到 `codex` provider 时才需要。

## 安装与构建

```bash
npm install
npm run build       # tsc（build 配置）+ 把 web 静态资源拷贝到 dist/
npm run typecheck   # 仅类型检查，不产出
npm run check       # typecheck + build
```

构建后 CLI 入口是 `dist/cli/bin.js`。下面的示例都使用 `node dist/cli/bin.js <command>`。

## 配置

配置是可选的。如果存在，它位于项目根目录下的 `deputy.config.json`。文件缺失、JSON 非法或字段非法都会回退
到默认值（并告警），不会阻塞启动。字段如下：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `claudeConfigDir` | string | Claude profile 目录（包含 `.credentials.json`）。相对路径相对项目根目录解析。缺省时 Claude 适配器回退到 `~/.claude`。 |
| `codexHome` | string | Codex 账号鉴权来源目录（存放 OpenAI OAuth profile / `auth.json` 的位置）。仅当有角色绑定到 `codex` 时使用。相对路径相对项目根目录解析。 |
| `roles` | object | 按角色的 provider/model 绑定。键为角色名（`meta`、`worker`、`watcher`、`reviewer`）；每个值为 `{ "provider": "...", "modelId": "..." }`。未列出的角色使用默认绑定（Claude + 默认模型）。非法绑定回退到默认并告警。 |

受支持的 provider 为 `claude` 与 `codex`。示例：

```json
{
  "claudeConfigDir": ".claude",
  "roles": {
    "meta":   { "provider": "claude", "modelId": "claude-opus-4-8" },
    "worker": { "provider": "codex",  "modelId": "gpt-5.5" }
  }
}
```

项目根目录按以下顺序解析：全局参数 `--project-root <path>`（每个命令都可用） → 环境变量 `DEPUTY_PROJECT_ROOT` → 当前工作目录中最近的、包含 `tasks/` 目录的祖先目录 → 当前工作目录。

## CLI 命令

### 写命令

- **`submit [<task>] [--file <path>] [--task-id <id>] [--role <role>=<provider>]... [--no-start] [--foreground]`**
  创建一个新任务。任务描述可内联给出，或用 `--file` 指定（二者不可同时）。`--task-id` 设置显式 id；
  `--role meta=claude`（可重复）为本任务把角色绑定到 provider。默认任务会自动启动（启动一个后台 host）。
  `--no-start` 创建任务但不启动；`--foreground` 在当前进程内运行 host 循环，而非 detached。

- **`run <taskId> [--foreground]`**
  为一个已存在、可运行（非 paused / 非终态）的任务启动 host。默认 host 在后台 detached 运行；
  `--foreground` 在当前进程内运行 tick 循环，并把 host 退出码映射为 CLI 退出码。

- **`answer <taskId> [<text>] [--file <path>]`**
  回答当前的澄清问题。仅当任务处于 `clarifying` 阶段时允许。内容内联或通过 `--file` 给出。

- **`feedback <taskId> [<text>] [--file <path>]`**
  向任务发送自由格式的反馈。任务进行中（非 paused、非终态）时允许。内容内联或通过 `--file` 给出。

- **`upload <taskId> <filePath> [--note <text>]`**
  向任务上传一个文件。任务进行中时允许。`--note` 附加一条简短备注。

- **`pause <taskId>`**
  暂停一个进行中的任务（记录它从哪个 stage 暂停）。

- **`resume <taskId> [--foreground]`**
  将一个 paused 任务恢复到它暂停时所在的 stage。`--foreground` 在切换后于当前进程内运行 host 循环。

- **`done <taskId>`**
  将任务标记为完成。仅当任务处于 `awaiting_user`（即正等待你确认）时允许。

- **`cancel <taskId> [--reason <text>]`**
  取消一个进行中或 paused 的任务。`--reason` 记录原因。

- **`rename <taskId> <title>`**
  设置任务标题（不允许控制字符；长度有上限）。

- **`delete <taskId>`**
  删除一个任务。该任务的 host 必须未在运行。

### 读命令

- **`list [--stage <stage>]`**
  以表格形式列出任务（`task_id`、`stage`、`updated_at`、`title`）。`--stage` 按 stage 过滤；未知的
  stage 值会被拒绝并给出有效 stage 列表。

- **`status <taskId> [--full]`**
  打印任务的渲染状态。`--full` 还会附上原始 manifest。

- **`inspect <taskId> [--inbox [<ch>]] [--meta-stream [<sid>]] [--watcher-stream [<sid>]] [--worker-stream [<sid>]] [--events [<n>]] [--last <n>]`**
  对任务胶囊做底层检视。`--inbox` 显示通道收件箱（可指定单个通道）；`--meta-stream` /
  `--watcher-stream` / `--worker-stream` 显示 agent 输出流（可指定某个 session id）；`--events [<n>]`
  显示最近 `n` 条审计事件（默认 30）；`--last <n>` 限制流尾的条数（默认 20）。每个 flag 既可单独给出，也可
  带值。

### Web GUI

- **`web [--host <addr>] [--port <n>]`**
  启动本地 Web GUI 后端。绑定地址默认为 `127.0.0.1`，端口默认为 `4319`。绑定地址会被校验为环回地址。进程
  会保持运行直到被中断（Ctrl-C）。它会打印出在浏览器中打开的 URL。

### 全局参数

- `--project-root <path>` —— 针对当前工作目录以外的项目根目录进行操作。每个命令都可用。

设置 `DEPUTY_DEBUG=1` 可在出错时打印额外的诊断细节。

## 任务胶囊与产物

每个任务都以一个自包含的胶囊形式存放在 tasks 根目录下（`<projectRoot>/tasks/<taskId>`）：

- `workspace/` —— 任务的工作区，worker 在此执行工作。
  - `inputs/` —— 原始任务描述与澄清轮次。
  - `harness/` —— 每个任务的 SOP、工具、脚本与 `done_criteria.yaml`。
  - `memory/`、`artifacts/` —— 中间状态与产物。
  - `output/` —— 最终产物落地的位置。
  - `streams/` —— worker 的原始输出流。
- `control/` —— 编排状态：`manifest.yaml`（任务状态）、`events.jsonl`（审计日志）、`messaging/`
  （消息总线）、各角色的 session 流、上传文件，以及 host PID 锁。

`status` 与 `inspect` 从该胶囊读取；Web GUI 通过 SSE 以只读方式暴露它。

## 端到端示例

```bash
# 1. 提交一个任务。任务被创建，并启动一个后台 host 运行它。
node dist/cli/bin.js submit "调研主题 X 并把总结报告写到 output/"
# -> 打印出新的 <taskId>

# 2. 查看进度。
node dist/cli/bin.js list
node dist/cli/bin.js status <taskId>

# 3. 如果 meta 提出澄清问题（stage 变为 'clarifying'），回答它。
node dist/cli/bin.js status <taskId>          # 读取问题
node dist/cli/bin.js answer <taskId> "聚焦最近 12 个月。"

# 4. 任务运行中。运行期间你可以补充反馈或文件。
node dist/cli/bin.js feedback <taskId> "请加入一个来源（sources）章节。"
node dist/cli/bin.js upload <taskId> ./reference.pdf --note "主要来源"

# 5. 当任务等待你确认（stage 'awaiting_user'）时，把它完成。
node dist/cli/bin.js status <taskId>
node dist/cli/bin.js done <taskId>

# 产物位于任务胶囊的 workspace/output/ 目录。
```

要在浏览器里完成上述所有操作，运行 `node dist/cli/bin.js web` 并打开打印出的环回 URL。
