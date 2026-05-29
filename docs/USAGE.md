# Usage

> **Recommended:** the local Web GUI (`deputy web`) is the easiest way to use Deputy — it
> brings task submission, live progress, the conversation, the event/output streams, and
> all lifecycle controls together in one place. The CLI exposes the same operations and is
> best suited to scripting and headless environments. See [WEB.md](WEB.md) for the GUI's
> API surface.

## Requirements

- Node.js >= 22
- Provider credentials for at least one supported provider:
  - **Claude** — via the Claude Agent SDK. By default the Claude adapter falls back to
    `~/.claude`; you can point it at a specific profile directory in the config.
  - **Codex** — only needed for roles bound to the `codex` provider.

## Install and build

```bash
npm install
npm run build       # tsc (build config) + copy web static assets into dist/
npm run typecheck   # type-check only, no emit
npm run check       # typecheck + build
```

The CLI entry after building is `dist/cli/bin.js`. The examples below use
`node dist/cli/bin.js <command>`.

## Configuration

Configuration is optional. If present, it lives in `deputy.config.json` at the project
root. A missing file, invalid JSON, or an invalid field falls back to defaults (with a
warning) and does not block startup. Fields:

| Field | Type | Description |
| --- | --- | --- |
| `claudeConfigDir` | string | Claude profile directory (containing `.credentials.json`). Relative paths resolve against the project root. When absent, the Claude adapter falls back to `~/.claude`. |
| `codexHome` | string | Codex account auth source directory (where the OpenAI OAuth profile / `auth.json` lives). Used only when a role is bound to `codex`. Relative paths resolve against the project root. |
| `roles` | object | Per-role provider/model bindings. Keys are role names (`meta`, `worker`, `watcher`, `reviewer`); each value is `{ "provider": "...", "modelId": "..." }`. Roles left out use the default binding (Claude + the default model). An invalid binding falls back to the default with a warning. |

Supported providers are `claude` and `codex`. Example:

```json
{
  "claudeConfigDir": ".claude",
  "roles": {
    "meta":   { "provider": "claude", "modelId": "claude-opus-4-8" },
    "worker": { "provider": "codex",  "modelId": "gpt-5.5" }
  }
}
```

The project root is resolved in this order: the global `--project-root <path>` flag (available
on every command) → the `DEPUTY_PROJECT_ROOT` environment variable → the nearest ancestor
directory of the current working directory that contains a `tasks/` directory → the current
working directory.

## CLI commands

### Write commands

- **`submit [<task>] [--file <path>] [--task-id <id>] [--role <role>=<provider>]... [--no-start] [--foreground]`**
  Create a new task. Provide the task description inline or with `--file` (not both).
  `--task-id` sets an explicit id; `--role meta=claude` (repeatable) binds roles to
  providers for this task. By default the task starts automatically (a background host is
  launched). `--no-start` creates the task without starting it; `--foreground` runs the
  host loop in this process instead of detaching.

- **`run <taskId> [--foreground]`**
  Start the host for an existing, runnable (not paused/terminal) task. By default the host
  runs detached in the background; `--foreground` runs the tick loop in this process and
  maps the host exit code to the CLI exit code.

- **`answer <taskId> [<text>] [--file <path>]`**
  Answer the current clarification question. Only allowed while the task is in the
  `clarifying` stage. Text inline or via `--file`.

- **`feedback <taskId> [<text>] [--file <path>]`**
  Send free-form feedback to the task. Allowed while the task is in progress (not paused,
  not terminal). Text inline or via `--file`.

- **`upload <taskId> <filePath> [--note <text>]`**
  Upload a file into the task. Allowed while the task is in progress. `--note` attaches a
  short note.

- **`pause <taskId>`**
  Pause an in-progress task (records the stage it was paused from).

- **`resume <taskId> [--foreground]`**
  Resume a paused task back to the stage it was paused from. `--foreground` runs the host
  loop in this process after transitioning.

- **`done <taskId>`**
  Mark the task done. Only allowed when the task is `awaiting_user` (i.e. it is waiting for
  your confirmation).

- **`cancel <taskId> [--reason <text>]`**
  Cancel an in-progress or paused task. `--reason` records why.

- **`rename <taskId> <title>`**
  Set the task's title (no control characters; bounded length).

- **`delete <taskId>`**
  Delete a task. The host must not be running for the task.

### Read commands

- **`list [--stage <stage>]`**
  List tasks as a table (`task_id`, `stage`, `updated_at`, `title`). `--stage` filters by
  stage; an unknown stage value is rejected with the list of valid stages.

- **`status <taskId> [--full]`**
  Print the task's rendered status. `--full` also appends the raw manifest.

- **`inspect <taskId> [--inbox [<ch>]] [--meta-stream [<sid>]] [--watcher-stream [<sid>]] [--worker-stream [<sid>]] [--events [<n>]] [--last <n>]`**
  Low-level inspection of a task capsule. `--inbox` shows channel inboxes (optionally a
  single channel); `--meta-stream` / `--watcher-stream` / `--worker-stream` show the agent
  output streams (optionally a specific session id); `--events [<n>]` shows the last `n`
  audit events (default 30); `--last <n>` limits stream tails (default 20). Each flag may
  be given bare or with a value.

### Web GUI

- **`web [--host <addr>] [--port <n>]`**
  Start the local Web GUI backend. The bind host defaults to `127.0.0.1` and the port to
  `4319`. The bind host is validated to be a loopback address. The process stays alive
  until interrupted (Ctrl-C). It prints the URL to open in a browser.

### Global flag

- `--project-root <path>` — operate against a project root other than the current working
  directory. Available on every command.

Set `DEPUTY_DEBUG=1` to print extra diagnostic detail on errors.

## Task capsule and outputs

Each task is stored as a self-contained capsule under the tasks root
(`<projectRoot>/tasks/<taskId>`):

- `workspace/` — the task's working area. The worker performs its work here.
  - `inputs/` — the raw task description and clarification rounds.
  - `harness/` — the per-task SOP, tools, scripts, and `done_criteria.yaml`.
  - `memory/`, `artifacts/` — intermediate state and artifacts.
  - `output/` — where finished outputs land.
  - `streams/` — the worker's raw output streams.
- `control/` — orchestration state: `manifest.yaml` (task state), `events.jsonl` (audit
  log), `messaging/` (message bus), per-role session streams, uploads, and the host PID
  lock.

`status` and `inspect` read from this capsule; the Web GUI exposes it read-only over SSE.

## End-to-end example

```bash
# 1. Submit a task. It is created and a background host starts running it.
node dist/cli/bin.js submit "Research topic X and write a summary report to output/"
# -> prints the new <taskId>

# 2. Watch progress.
node dist/cli/bin.js list
node dist/cli/bin.js status <taskId>

# 3. If meta asks a clarifying question (stage becomes 'clarifying'), answer it.
node dist/cli/bin.js status <taskId>          # read the question
node dist/cli/bin.js answer <taskId> "Focus on the last 12 months."

# 4. The task runs. You may add feedback or files while it is in progress.
node dist/cli/bin.js feedback <taskId> "Please include a sources section."
node dist/cli/bin.js upload <taskId> ./reference.pdf --note "primary source"

# 5. When the task is awaiting your confirmation (stage 'awaiting_user'), finish it.
node dist/cli/bin.js status <taskId>
node dist/cli/bin.js done <taskId>

# Outputs are in the task capsule's workspace/output/ directory.
```

To do all of the above from a browser instead, run `node dist/cli/bin.js web` and open the
printed loopback URL.
