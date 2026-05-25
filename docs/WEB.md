# Web GUI

`deputy web` starts a [Fastify](https://fastify.dev/) HTTP server bound to a loopback
address only (default `127.0.0.1:4319`). It serves a static single-page UI plus a JSON API
and two Server-Sent Events (SSE) streams. The Web GUI is one of the two front-ends over the
same in-process write commands and the same on-disk task capsule as the CLI (see
[ARCHITECTURE.md](ARCHITECTURE.md)); for launching it from the command line see
[USAGE.md](USAGE.md).

The server is single-process and stateless: it holds no auth, cookies, or sessions, and all
durable state lives in the task capsule on disk. The front-end is a static SPA served from
the server's `static/` directory; this document covers only the backend API.

## REST endpoints

All endpoints live under `/api/*` and are subject to the [security model](#security-model)
below. Write endpoints return `{ ok, message, warning? }`; read endpoints return the JSON or
file body described under *Purpose*. Errors are reported as `{ ok: false, message }` with an
HTTP status mapped from the underlying command (see [Read/write split](#readwrite-split)).

### Diagnostics

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness check; returns `{ ok: true }`. |
| GET | `/api/version` | Returns kernel / web version strings. |
| GET | `/api/providers` | Provider-selection metadata for the new-task form (static derivation; reads no task data, needs no host). |

### Task management

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/tasks` | List task summaries (`taskId`, `stage`, `title`, `createdAt`, `updatedAt`), newest first. |
| POST | `/api/tasks` | Create a task. Composite multipart submit (`rawTask`, optional `taskId`, optional `roleBindings`, optional `files[]`); returns `201` with `{ taskId, message, uploaded[], failed[] }`. |
| GET | `/api/tasks/:id` | Task detail: `{ manifest, statusMd, hostOnline }`. |
| DELETE | `/api/tasks/:id` | Delete the task capsule. |
| GET | `/api/tasks/:id/status.md` | Rendered `status.md` as `text/markdown`. |

### User write actions

These map the user-interaction CLI commands. Each takes a JSON body where noted and returns
`{ ok, message, warning? }`.

| Method | Path | Body | Purpose |
| --- | --- | --- | --- |
| POST | `/api/tasks/:id/answer` | `{ text }` | Answer a clarifying question. |
| POST | `/api/tasks/:id/feedback` | `{ text }` | Send feedback to the running task. |
| POST | `/api/tasks/:id/pause` | — | Pause the task. |
| POST | `/api/tasks/:id/resume` | — | Resume a paused task. |
| POST | `/api/tasks/:id/done` | — | Mark the task done. |
| POST | `/api/tasks/:id/cancel` | `{ reason? }` | Cancel the task. |
| POST | `/api/tasks/:id/rename` | `{ title }` | Rename the task. |
| POST | `/api/tasks/:id/uploads` | multipart (single `file`, optional `note`) | Append one file upload to the task. |

### Read endpoints

Pure filesystem reads of the task capsule. The `:agent` path segment is one of `meta`,
`worker`, `watcher`, `reviewer`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/tasks/:id/conversation` | Conversation rows: `{ rows }`. |
| GET | `/api/tasks/:id/events` | `events.jsonl` rows: `{ events }`; optional `?since=<ts>` filter. |
| GET | `/api/tasks/:id/streams/:agent` | List an agent's stream files (`file`, `sizeBytes`, `mtime`), mtime ascending. |
| GET | `/api/tasks/:id/streams/:agent/:file` | Tail of a stream file: `?tail=N` (default 1000), optional `?beforeOffset=N` for backward paging. |
| GET | `/api/tasks/:id/files` | With no query: workspace file tree (`{ tree }`). With `?path=<rel>`: download that file, or `?render=markdown` to return it as `text/markdown`. |
| GET | `/api/tasks/:id/uploads/:uploadId/:filename` | Download a previously uploaded file. |
| GET | `/api/tasks/:id/agent_prompts/:sessionId` | The assembled prompt for a session as `text/markdown`. |
| GET | `/api/tasks/:id/host-log` | Tail of `control/host.log` as `text/plain`: `?tail=N` (default 500), or `?download=1` to stream the whole file. |

Path-component parameters that name a single file (`:file`, `:filename`, `:sessionId`) are
validated to stay within their capsule subtree; path separators, `..`, NUL, and absolute paths
are rejected. The `?path=<rel>` query is different: it resolves a workspace-relative path and
rejects only NUL bytes, absolute paths, and `..` escapes outside the workspace — nested path
separators are allowed, so subdirectory files can be browsed.

## SSE streams

Two endpoints upgrade to a long-lived `text/event-stream` connection. Each frame is an SSE
`event:` name plus a JSON `data:` payload. On connect the server sends initial cursors only;
the front-end fetches initial content via the REST read endpoints, and the stream then
pushes increments.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/stream/tasks/:id` | Task-detail stream. Query `?agent=<agent>` (default `meta`) and optional `?file=<name>` select which agent stream file to follow. |
| GET | `/api/stream/tasks` | Task-list stream. |

### Event types

| Event | Stream | Carries |
| --- | --- | --- |
| `stream_append` | detail | `{ tab, lines }` — new lines appended to the followed agent stream file. |
| `conversation_append` | detail | `{ rows }` — new conversation rows. |
| `event_append` | detail | `{ events }` — new `events.jsonl` rows. |
| `stage` | detail | `{ stage }` — the task's current stage (pushed on change). |
| `host_status` | detail | `{ online }` — whether the host daemon is running. |
| `status_md` | detail | `{ content }` — re-rendered `status.md` (pushed on change). |
| `new_stream_file` | detail | `{ path }` — a new session stream file appeared for the agent; the front-end can switch to it. |
| `task_list` | list | `{ tasks }` — full task-summary list snapshot (pushed when the list signature changes). |
| `lag` | both | `{}` — a read failed; the front-end should re-hydrate via REST. |
| `ping` | both | `{}` — periodic heartbeat. |

Each connection also runs a periodic reconcile (re-read + diff) as a fallback to filesystem
watch events, so a missed watch event is recovered on the next interval. When all
connections for a task close, its watch group is torn down.

## Security model

There is no authentication, cookies, or sessions. Security rests on two facts: the server
binds only to loopback, and it rejects cross-origin requests. Both checks share one
loopback-host predicate.

**Bind validation (fail-fast).** At startup the bind host is validated to be a loopback
address (`localhost`, `127.0.0.0/8`, or `::1`). `0.0.0.0`, `::`, and any non-loopback
address are rejected and the server refuses to start.

**Two-layer request check.** An `onRequest` hook guards every `/api/*` route:

- **Layer 1** — applies to all `/api/*` requests, including read-only `GET`: the `Host`
  header must be a loopback host, otherwise `403`.
- **Layer 2** — applies to state-changing methods (`POST`, `PUT`, `DELETE`, `PATCH`) and the
  SSE streams: the `Origin` (or, if absent, `Referer`) host must be loopback, otherwise
  `403`. When both `Origin` and `Referer` are absent, Layer 1 alone applies.

Layer 1 defends against DNS rebinding; Layer 2 defends against cross-origin requests.

## Read/write split

The backend cleanly separates reads from writes.

**Writes** invoke the same in-process CLI command logic the terminal uses (with
`source = "user_web"`), so the Web GUI and CLI share one code path and one set of capsule
locks. All write actions are serialized through a process-level write mutex, so only one
write runs at a time within the web process; underlying cross-process safety still comes from
the capsule's per-file locks. The composite `POST /api/tasks` runs as a single critical
section that chains submit (`--no-start`) → a per-file upload loop → one final host-start
attempt; per-file upload failures are aggregated into the `failed[]` array (partial success),
while a failed submit propagates as an error.

**Reads** are pure filesystem reads of the task capsule (`manifest.yaml`,
`conversation.jsonl`, `events.jsonl`, agent stream files, `status.md`, workspace files,
uploads, `host.log`). They go through neither the write commands nor the write mutex, and
modify no files. Corrupt or partially written rows are skipped leniently.

**Error mapping.** Write commands raise a typed error carrying a CLI exit code, which the
endpoint layer maps to an HTTP status:

| Exit code | HTTP |
| --- | --- |
| Ok | 200 |
| NotFound | 404 |
| IllegalState | 409 |
| InvalidArgument | 400 |
| SingleInstance | 409 |
| GeneralError / IoError | 500 |

The user-facing message is returned to the front-end; debug detail and stack traces go only
to the backend log. An oversized upload returns `413`.
