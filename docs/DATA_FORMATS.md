# Data Formats

This document describes the on-disk data formats Deputy reads and writes. Each task lives in
a self-contained directory — the *task capsule* — and all state is plain files: YAML for the
authoritative manifest, JSON Lines for append-only streams, JSON for config, and Markdown for
human-readable bodies. See [ARCHITECTURE.md](ARCHITECTURE.md) for the overall shape and
[RUNTIME.md](RUNTIME.md) for how the host produces and consumes these files at runtime.

All timestamps are ISO-8601 with microsecond precision (e.g. `2026-05-25T10:30:00.123456Z`).
Physical files use `snake_case` keys; the TypeScript layer uses `camelCase` and converts at
the IO boundary. Field names below are shown as they appear *on disk*.

## 1. Task capsule layout

A task capsule is the directory `<projectRoot>/tasks/<taskId>` (the tasks root is
`<projectRoot>/tasks/`). It has two halves: `workspace/` (where the work happens) and
`control/` (orchestration state).

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

The worker's normalized event stream lives under `workspace/streams/`; the meta, watcher, and
reviewer streams live under `control/streams/`. The reviewer is a one-shot session, so its
stream is keyed by `<phase>_round_<round>` rather than a session id.

## 2. `manifest.yaml`

`control/manifest.yaml` is the authoritative task record. The `stage` field is the source of
truth for the task lifecycle. Writes are serialized through `manifest.yaml.lock`.

| Field (YAML) | Type | Notes |
| --- | --- | --- |
| `schema_version` | string | Always `"1.0"`; a mismatch is rejected on load. |
| `task_id` | string | The task id (matches the capsule directory name). |
| `title` | string | Short task title; may be empty. |
| `created_at` | ISO-8601 | Capsule creation time. |
| `updated_at` | ISO-8601 | Time of the last manifest write. |
| `raw_task_path` | string | Relative path to the submitted task text (`workspace/inputs/raw_task.md`). |
| `stage` | enum | One of `submitted`, `clarifying`, `bootstrapping`, `running`, `awaiting_user`, `done`, `failed`, `cancelled`, `paused`. |
| `stage_history` | list | Append-only list of `{ stage, entered_at }` entries, one per transition. |
| `paused_from` | enum \| null | When `stage` is `paused`, the in-progress stage to resume to; otherwise `null`. |
| `last_error` | object \| null | The most recent error (`{ error_kind, message, at, details? }`), or `null`. |
| `role_bindings` | object | Optional; per-role `{ provider, model? }` bindings the user selected. Omitted when empty. |

The `last_error.details` object and the `role_bindings` provider/model literals are kept
verbatim (their inner keys are not case-converted).

Example:

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

## 3. Message envelopes

Agents communicate by exchanging *envelopes* on one of three inbox *channels*. Each envelope
is stored as `control/messaging/payloads/<envId>/payload.json` (structured header + extras)
alongside `body.md` (the free-text body).

| Field (JSON) | Type | Notes |
| --- | --- | --- |
| `env_id` | string | Envelope id (the payload directory name). |
| `channel` | enum | `meta`, `worker`, or `watcher`. |
| `kind` | enum | The envelope kind (see below). |
| `from` | string | Sender identifier. |
| `created_at` | ISO-8601 | Creation time. |
| `extras` | object \| null | Per-kind structured fields, or `null` for kinds with no extras. |

The body text is stored separately in `body.md`. The `read` / `responded` flags are **not**
part of the envelope — delivery and read state are derived by folding the message-bus state
stream (`control/messaging/state.jsonl`); see [RUNTIME.md](RUNTIME.md).

**Channels and allowed kinds.** Each channel accepts only a whitelisted set of kinds:

| Kind | Allowed on channel(s) | Extras |
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

**Representative extras shapes** (keys shown as serialized in `payload.json`):

`worker_escalation`:

| Field | Type |
| --- | --- |
| `worker_session_id` | string |
| `session_seq` | int |
| `exit_intent` | enum: `continue` \| `declare_deferred` |

`reviewer_verdict`:

| Field | Type |
| --- | --- |
| `reviewer_phase` | enum: `bootstrap_self_review` \| `final_review` \| `harness_revision_review` |
| `reviewer_round` | int |
| `verdict` | enum: `pass` \| `needs_revision` \| `unsafe` \| `null` |
| `issues` | list (opaque objects) |

`watcher_observation`:

| Field | Type |
| --- | --- |
| `watcher_session_id` | string |
| `evidence_refs` | list of strings |

Other extras: `user_upload` → `{ upload_id, filename, size_bytes, uploaded_at }`;
`user_clarify_answer` → `{ round }`; `worker_notification` / `worker_completion_claim` →
`{ worker_session_id, session_seq }`; `worker_session_end` →
`{ worker_session_id, session_seq, exit_reason, done_criteria_outcome }`; `host_event` →
`{ event_kind, details }`; `worker_stream_window` →
`{ window_start, window_end, worker_session_id, stream_path }`. Extras are validated against a
strict per-kind schema: missing, extra, or wrong-typed keys are rejected.

Example `payload.json`:

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

`control/events.jsonl` is the orchestration event log: one JSON object per line, appended
under `events.jsonl.lock`. The file is append-only and tolerant of a partial trailing line
(a partial last line is skipped on read and truncated on recovery; a corrupt middle line is
quarantined).

| Field (JSON) | Type | Notes |
| --- | --- | --- |
| `type` | enum | The event type (see below). |
| `ts` | ISO-8601 | When the event was written. |
| `stage` | enum | The manifest stage at write time. |
| `event_seq` | int | Monotonic sequence, allocated as fold-max+1 under the lock. |
| `details` | object | Event-specific fields; keys are `snake_case`. |

Event types: `host_started`, `host_recovery`, `host_recovery_failed`, `host_stopping`,
`stage_transition`, `agent_session_started`, `agent_session_ended`, `watchdog_triggered`,
`reviewer_triggered`, `worker_stream_window_dispatched`, `user_cli_action`, `harness_changed`,
`message_to_user`, `watcher_compact_triggered`, `watcher_compact_role_reinjected`,
`watcher_compact_failed`, `prompt_lang_fallback`.

Example lines:

```json
{"type":"host_started","ts":"2026-05-25T10:30:01.000000Z","stage":"submitted","event_seq":1,"details":{}}
{"type":"stage_transition","ts":"2026-05-25T10:45:02.000000Z","stage":"running","event_seq":7,"details":{"from_stage":"bootstrapping","triggered_by":"meta_tool"}}
{"type":"agent_session_ended","ts":"2026-05-25T11:30:00.000000Z","stage":"running","event_seq":42,"details":{"role":"worker","session_id":"s-abc","session_seq":3,"exit_reason":"natural_completion"}}
```

In a `stage_transition`, `triggered_by` reflects who advanced the stage: host-driven
transitions (such as `submitted -> clarifying`) use `"host"`, while meta-tool stage advances
use `"meta_tool"`.

## 5. `done_criteria.yaml`

`workspace/harness/done_criteria.yaml` holds declarative completion checks meta prepares.
The checks are evaluated when a worker session ends, with **no LLM** involved. The root is a
mapping with a non-empty `checks` list; each check has a `kind`, a required `description`, and
an optional `id` (the pattern `^check_<n>$` is reserved for host auto-assignment).

| `kind` | Required fields | Meaning |
| --- | --- | --- |
| `file_exists` | `path` | The file exists. |
| `file_min_lines` | `path`, `min_lines` | The file has at least `min_lines` lines. |
| `file_min_bytes` | `path`, `min_bytes` | The file is at least `min_bytes` bytes. |
| `yaml_field_present` | `path`, `field` | The YAML file has the given field. `field` may be a dotted path (`a.b.c`) into nested mappings. |
| `dir_min_files` | `path`, `pattern`, `min_count` | The directory at `path` has at least `min_count` files matching `pattern` (the glob runs with `path` as its working directory, so `pattern` is relative to that directory, not to `workspace/`). |
| `script` | `script_path`, `interpreter`, `timeout_seconds?` | Runs a script and checks its exit code. |

All `path` / `script_path` literals are relative to `workspace/` (a leading
`workspace/`, an absolute path, `..`, or `:` is rejected); a `dir_min_files` `pattern` is
instead relative to that check's resolved `path` directory. For `script` checks, `script_path`
must live under `harness/tools/scripts/`, and `interpreter` must be on an allowlist
(`bash`, `sh`, `zsh`, `python`, `python3`, `py`, `powershell`, `pwsh`, `node`) with an empty
or `.exe` suffix. `timeout_seconds` defaults to 1800 and may not exceed 3600.

Example:

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

The evaluation result (overall `all_pass` / `some_fail` / `error`, plus a per-check summary)
is recorded separately and carried on the `worker_session_end` envelope's
`done_criteria_outcome` extras.

## 6. `deputy.config.json`

`<projectRoot>/deputy.config.json` is project-scoped configuration shared by all tasks under
the same project root. It is read at host startup and is fail-soft: a missing file, parse
failure, or invalid field falls back to defaults. See [USAGE.md](USAGE.md) for usage.

| Field (JSON) | Type | Notes |
| --- | --- | --- |
| `claudeConfigDir` | string | Claude profile directory (holds `.credentials.json`); relative paths resolve against the project root; absent → falls back to `~/.claude`. |
| `codexHome` | string | Codex auth source directory; used only when a role is bound to codex; relative paths resolve against the project root. |
| `roles` | object | Per-role `{ provider, modelId }` bindings; roles left out use the default binding. |

`provider` is one of `claude`, `codex`, `opencode`, `pi`; roles are `meta`, `worker`,
`watcher`, `reviewer`.

Example:

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
