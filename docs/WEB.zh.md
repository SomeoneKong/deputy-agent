# Web GUI

`deputy web` 启动一个仅绑定到环回（loopback）地址的 [Fastify](https://fastify.dev/) HTTP 服务器（默认 `127.0.0.1:4319`）。它提供一个静态的单页 UI，外加一个 JSON API 和两条 Server-Sent Events（SSE）流。Web GUI 是构建在与 CLI 相同的进程内写命令、以及相同的磁盘任务胶囊之上的两个前端之一（见 [ARCHITECTURE.zh.md](ARCHITECTURE.zh.md)）；关于如何从命令行启动它，见 [USAGE.zh.md](USAGE.zh.md)。

该服务器是单进程且无状态的：它不持有任何鉴权、cookie 或会话，所有持久状态都存放在磁盘上的任务胶囊中。前端是一个从服务器 `static/` 目录提供的静态 SPA；本文档仅涵盖后端 API。

## REST endpoints

所有端点都位于 `/api/*` 之下，并受下文[安全模型](#security-model)约束。写端点返回 `{ ok, message, warning? }`；读端点返回 *Purpose* 中描述的 JSON 或文件主体。错误以 `{ ok: false, message }` 形式报告，其 HTTP 状态由底层命令映射而来（见[读写分离](#readwrite-split)）。

### Diagnostics

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | 存活检查；返回 `{ ok: true }`。 |
| GET | `/api/version` | 返回 kernel / web 版本字符串。 |
| GET | `/api/providers` | 新建任务表单的 provider 选择元数据（静态推导；不读取任何任务数据，无需 host）。 |

### Task management

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/tasks` | 列出任务摘要（`taskId`、`stage`、`title`、`createdAt`、`updatedAt`），最新的在前。 |
| POST | `/api/tasks` | 创建任务。复合的 multipart 提交（`rawTask`、可选 `taskId`、可选 `roleBindings`、可选 `files[]`）；返回 `201` 及 `{ taskId, message, uploaded[], failed[] }`。 |
| GET | `/api/tasks/:id` | 任务详情：`{ manifest, statusMd, hostOnline }`。 |
| DELETE | `/api/tasks/:id` | 删除任务胶囊。 |
| GET | `/api/tasks/:id/status.md` | 以 `text/markdown` 形式渲染的 `status.md`。 |

### User write actions

这些端点映射用户交互的 CLI 命令。在标注处各自接收一个 JSON 主体，并返回 `{ ok, message, warning? }`。

| Method | Path | Body | Purpose |
| --- | --- | --- | --- |
| POST | `/api/tasks/:id/answer` | `{ text }` | 回答一个澄清问题。 |
| POST | `/api/tasks/:id/feedback` | `{ text }` | 向正在运行的任务发送反馈。 |
| POST | `/api/tasks/:id/pause` | — | 暂停任务。 |
| POST | `/api/tasks/:id/resume` | — | 恢复一个已暂停的任务。 |
| POST | `/api/tasks/:id/done` | — | 将任务标记为完成。 |
| POST | `/api/tasks/:id/cancel` | `{ reason? }` | 取消任务。 |
| POST | `/api/tasks/:id/rename` | `{ title }` | 重命名任务。 |
| POST | `/api/tasks/:id/uploads` | multipart（单个 `file`，可选 `note`） | 向任务追加一次文件上传。 |

### Read endpoints

对任务胶囊的纯文件系统读取。`:agent` 路径片段为 `meta`、`worker`、`watcher`、`reviewer` 之一。

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/tasks/:id/conversation` | 对话行：`{ rows }`。 |
| GET | `/api/tasks/:id/events` | `events.jsonl` 行：`{ events }`；可选 `?since=<ts>` 过滤。 |
| GET | `/api/tasks/:id/streams/:agent` | 列出某 agent 的 stream 文件（`file`、`sizeBytes`、`mtime`），按 mtime 升序。 |
| GET | `/api/tasks/:id/streams/:agent/:file` | 一个 stream 文件的尾部：`?tail=N`（默认 1000），可选 `?beforeOffset=N` 用于向后翻页。 |
| GET | `/api/tasks/:id/files` | 无查询参数时：工作区文件树（`{ tree }`）。带 `?path=<rel>` 时：下载该文件，或 `?render=markdown` 以 `text/markdown` 形式返回它。 |
| GET | `/api/tasks/:id/uploads/:uploadId/:filename` | 下载先前上传的文件。 |
| GET | `/api/tasks/:id/agent_prompts/:sessionId` | 某 session 的已组装 prompt，以 `text/markdown` 形式返回。 |
| GET | `/api/tasks/:id/host-log` | `control/host.log` 的尾部，以 `text/plain` 形式：`?tail=N`（默认 500），或 `?download=1` 以流式传输整个文件。 |

命名单个文件的路径段参数（`:file`、`:filename`、`:sessionId`）会被校验以确保停留在其胶囊子树内；路径分隔符、`..`、NUL 以及绝对路径都会被拒绝。`?path=<rel>` 查询参数则不同：它解析一个相对于工作区的路径，仅拒绝 NUL 字节、绝对路径，以及逃逸到工作区之外的 `..`——允许嵌套的路径分隔符，因此可以浏览子目录中的文件。

## SSE streams

两个端点会升级为长连接的 `text/event-stream` 连接。每个帧由一个 SSE `event:` 名称加上一个 JSON `data:` 载荷组成。连接建立时服务器只发送初始游标；前端通过 REST 读端点获取初始内容，随后该流推送增量。

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/stream/tasks/:id` | 任务详情流。查询参数 `?agent=<agent>`（默认 `meta`）和可选的 `?file=<name>` 选择要跟随哪个 agent 的 stream 文件。 |
| GET | `/api/stream/tasks` | 任务列表流。 |

### Event types

| Event | Stream | Carries |
| --- | --- | --- |
| `stream_append` | detail | `{ tab, lines }` —— 追加到被跟随 agent stream 文件的新行。 |
| `conversation_append` | detail | `{ rows }` —— 新的对话行。 |
| `event_append` | detail | `{ events }` —— 新的 `events.jsonl` 行。 |
| `stage` | detail | `{ stage }` —— 任务的当前 stage（变化时推送）。 |
| `host_status` | detail | `{ online }` —— host 守护进程是否正在运行。 |
| `status_md` | detail | `{ content }` —— 重新渲染的 `status.md`（变化时推送）。 |
| `new_stream_file` | detail | `{ path }` —— 该 agent 出现了一个新的 session stream 文件；前端可以切换到它。 |
| `task_list` | list | `{ tasks }` —— 完整的任务摘要列表快照（列表签名变化时推送）。 |
| `lag` | both | `{}` —— 一次读取失败；前端应通过 REST 重新水合。 |
| `ping` | both | `{}` —— 周期性心跳。 |

每条连接还会运行一个周期性的对账（重新读取 + 比对）作为文件系统 watch 事件的兜底，因此一个被错过的 watch 事件会在下一个间隔时被恢复。当某任务的所有连接都关闭时，其 watch 组会被拆除。

## Security model

不存在任何鉴权、cookie 或会话。安全性建立在两个事实之上：服务器只绑定到环回地址，并且它拒绝跨源请求。两项检查共享同一个环回主机判定谓词。

**绑定校验（快速失败）。** 启动时会校验绑定主机为环回地址（`localhost`、`127.0.0.0/8` 或 `::1`）。`0.0.0.0`、`::` 以及任何非环回地址都会被拒绝，服务器拒绝启动。

**两层请求检查。** 一个 `onRequest` 钩子守护每一个 `/api/*` 路由：

- **Layer 1** —— 适用于所有 `/api/*` 请求，包括只读的 `GET`：`Host` 头必须是环回主机，否则返回 `403`。
- **Layer 2** —— 适用于改变状态的方法（`POST`、`PUT`、`DELETE`、`PATCH`）以及 SSE 流：`Origin`（若不存在则为 `Referer`）的主机必须是环回，否则返回 `403`。当 `Origin` 和 `Referer` 都不存在时，仅适用 Layer 1。

Layer 1 防御 DNS 重绑定；Layer 2 防御跨源请求。

## Read/write split

后端将读与写干净地分离开来。

**写** 调用终端所使用的同一套进程内 CLI 命令逻辑（`source = "user_web"`），因此 Web GUI 与 CLI 共享一条代码路径和同一套胶囊锁。所有写动作都通过一个进程级写互斥锁串行化，因此在 web 进程内同一时刻只有一个写在运行；底层的跨进程安全性仍由胶囊的逐文件锁提供。复合的 `POST /api/tasks` 作为单个临界区运行，依次串联 submit（`--no-start`）→ 逐文件上传循环 → 一次最终的 host-start 尝试；逐文件上传失败会被聚合进 `failed[]` 数组（部分成功），而失败的 submit 则作为错误向上传播。

**读** 是对任务胶囊的纯文件系统读取（`manifest.yaml`、`conversation.jsonl`、`events.jsonl`、agent stream 文件、`status.md`、工作区文件、uploads、`host.log`）。它们既不经过写命令也不经过写互斥锁，且不修改任何文件。损坏或部分写入的行会被宽容地跳过。

**错误映射。** 写命令抛出一个携带 CLI 退出码的类型化错误，端点层将其映射为一个 HTTP 状态：

| Exit code | HTTP |
| --- | --- |
| Ok | 200 |
| NotFound | 404 |
| IllegalState | 409 |
| InvalidArgument | 400 |
| SingleInstance | 409 |
| GeneralError / IoError | 500 |

面向用户的消息会返回给前端；调试细节和堆栈跟踪只进入后端日志。一次过大的上传返回 `413`。
