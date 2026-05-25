# Runtime

This document covers the host runtime: the single host daemon and its tick loop, the four
agent roles, the stage machine, the message bus, the watcher pipeline, and the concurrency /
recovery model. It assumes the overall shape from [ARCHITECTURE.md](ARCHITECTURE.md); on-disk
schemas live in [DATA_FORMATS.md](DATA_FORMATS.md) and the provider layer in
[PROVIDERS.md](PROVIDERS.md).

## Host daemon

The host is a **single-instance daemon**. On startup it acquires an OS advisory file lock on
`control/host.pid.lock` (see [Concurrency & recovery](#concurrency--recovery)); if another live
host already holds it, the new process exits immediately with a single-instance exit code.
After acquiring the lock it writes `control/host.pid` (`{ pid, startedAt }`), runs startup
recovery, then enters the tick loop.

The daemon runs either in the **foreground** (inside the CLI process, with `--foreground`; host
logs go to the CLI's stdout/stderr) or **detached** (the CLI spawns it as a background child
that detaches from the launching shell's session, with stdout/stderr redirected to
`control/host.log`). Both paths run the same loop with identical semantics.

Each tick reads the manifest and dispatches by the current stage:

| Step | Action |
| --- | --- |
| 1. Read manifest | Load `control/manifest.yaml`. A read failure is fatal (exit code 2). |
| 2. Terminal / paused check | If the stage is terminal (`done` / `failed` / `cancelled`) or `paused`, clean up sessions and exit. |
| 3. Ensure sessions | Start / keep online the agent sessions required by the stage (meta always; watcher in `running`). |
| 4. Deliver messages | Fold each relevant inbox for unread envelopes after a per-channel wake cursor and inject them into the target session. |
| 5. Dispatch windows | In `running`, slice the worker's output stream into windows and enqueue them to the watcher inbox. |
| 6. Evaluate advancement | Reconcile worker lifecycle (first start / restart after a worker exit) and post worker-exit reminders to meta. |
| 7. Sleep | Wait the tick interval (default 1000 ms), then loop. |

Stage transitions themselves are made by the agents (meta) or the host, not by the loop body;
the loop only steers sessions and message flow. When the stage becomes terminal or `paused`,
`cleanupAndExit` closes any held sessions, writes their paired session-ended records, appends a
`host_stopping` event, removes `control/host.pid`, and returns an exit code derived from the
stage. The daemon does not auto-restart the worker after it exits (see below).

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | `done` / `paused` / `awaiting_user` yield / stop signal |
| `1` | `failed` terminal, or permanent meta failure |
| `2` | manifest read failure or the host's own fatal error |
| `6` | `host.pid.lock` conflict (another host is running) |
| `130` | SIGINT |

## Agent roles

Four roles cooperate. They never call each other directly; they exchange envelopes over the
message bus.

| Role | Lifetime | What it does |
| --- | --- | --- |
| **meta** | Long-lived. Started in `submitted`/`clarifying` and kept online across stages until the task reaches a terminal/paused stage. | Orchestrator: clarifies the task, prepares the per-task harness, starts/stops the worker, arbitrates worker outcomes, drives stage transitions, and decides when the task is done or needs the user. Only meta can end the meta session. |
| **worker** | Per attempt. Auto-started once on first entering `running`; subsequent starts are requested by meta. Ends when the session ends. | Executor: performs the task inside `workspace/`. |
| **watcher** | Long-lived during `running`. | Observes windows of the worker's output stream (see [Watcher pipeline](#watcher-pipeline)) and reports observations to meta; can trigger context compaction when its own context grows large. |
| **reviewer** | One-shot. Started on demand by meta at a review point; ends after submitting its verdict. | Produces a single `reviewer_verdict` (`pass` / `needs_revision` / `unsafe`, or a `verdict_missing` fallback) for a review phase (`bootstrap_self_review` or `final_review`). |

When the worker session ends, the host writes a `worker_session_end` envelope to the meta
inbox and waits — it does **not** self-restart the worker. Continuation (start a new worker,
stop, advance the stage, or send an instruction) is decided by meta. While meta has not yet
acted on an outstanding `worker_session_end`, the host re-posts a worker-completion reminder to
the meta inbox once per meta idle turn.

A watchdog monitors several session-level conditions and, on a trip, closes the affected target
and records the outcome (it never self-restarts):

| Scope | Condition | Default threshold |
| --- | --- | --- |
| Worker | No `tool_use` since the last one (`no_progress`) | 30 min |
| Worker | N consecutive identical `(toolName, hash(input))` calls (`tool_loop`) | 5 |
| Reviewer | Total session run time | 30 min |
| Meta push | A single inject/await duration | 60 min |

A worker watchdog trip closes the worker and produces a `worker_session_end` (like an active
exit). Repeated meta-push timeouts, and a count of consecutive meta start failures, feed a
force-`failed` path that terminates the task if meta cannot be kept online.

## Stage machine

The manifest's `stage` field is the source of truth. There are nine stages:

| Stage | Class | Active roles |
| --- | --- | --- |
| `submitted` | in-progress | — (host transitions it to `clarifying`) |
| `clarifying` | in-progress | meta |
| `bootstrapping` | in-progress | meta |
| `running` | in-progress | meta, worker, watcher (reviewer on demand) |
| `awaiting_user` | in-progress | meta |
| `done` | terminal | — |
| `failed` | terminal | — |
| `cancelled` | terminal | — |
| `paused` | (neither) | — |

Transitions are classified by trigger — `host`, `meta_tool`, or `user_cli`:

- `submitted → clarifying` is host-autonomous.
- The in-progress advances (`clarifying → bootstrapping`, `bootstrapping → running`,
  `running → {awaiting_user, done}`, `awaiting_user → {running, done}`, and resets between
  in-progress stages) are driven by meta via the stage-advance tool.
- `done` from `awaiting_user`, `cancelled` from any in-progress or `paused` stage, and
  `paused` from any in-progress stage are driven by the user via the CLI.
- The host can force any in-progress stage to `failed`.

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

Each transition is serialized through the manifest lock with a **compare-and-set guard**: the
caller passes the expected-from stage, and the write is rejected if the on-disk stage no longer
matches (a concurrent CLI cancel/pause is detected as a CAS conflict). Most applied transitions
append a `stage_transition` entry to `events.jsonl`; CLI `pause`/`resume` instead record a
`user_cli_action` event, and some host failure paths update the manifest without a transition
event. Applying a transition re-renders `status.md`. `paused`
records `pausedFrom` (the in-progress stage it was paused from) so `resume` returns to it.

Two transitions are additionally gated on reviewer verdicts:

- **Entering `running`** (from any non-`running` stage) requires a non-failed
  `bootstrap_self_review` `reviewer_verdict` to have existed during the task lifecycle.
- **`running → {awaiting_user, done}`**, when a `worker_completion_claim` exists, requires a
  non-failed `final_review` `reviewer_verdict` ordered strictly after the latest such claim.

Both gates fail closed if the message bus is uninitialized.

## Message bus

Agents communicate over three inbox **channels**, each with a per-channel **kind whitelist**:

| Channel | Allowed envelope kinds |
| --- | --- |
| `meta` | `user_feedback`, `user_upload`, `user_clarify_answer`, `worker_escalation`, `worker_notification`, `worker_completion_claim`, `worker_session_end`, `watcher_observation`, `reviewer_verdict`, `host_event` |
| `worker` | `meta_instruction`, `meta_interrupt` |
| `watcher` | `meta_instruction`, `worker_stream_window` |

Enqueuing an envelope with a kind not in its channel's whitelist is rejected. The envelope
schema (payload layout, `extras` per kind) is in [DATA_FORMATS.md](DATA_FORMATS.md).

Delivery state — whether an envelope has been **read** or **responded** — is **not** stored on
the envelope. It is derived by folding the message-bus **state stream** (`state.jsonl`): every
mutating operation appends a state record under a bus lock, assigns a monotonic `stateSeq`, and
updates only an in-memory cache. Read APIs fold the full state under the lock. Because read /
responded state lives entirely in the appended stream rather than on the envelope, delivery
state is reconstructable by re-folding after a restart, making it recoverable across host
restarts.

## Watcher pipeline

While the task is `running`, the worker's output stream (a JSONL file written by the provider
adapter) is sliced into time windows and dispatched to the watcher.

A `WindowDispatcher` holds a per-worker-session in-memory `OffsetTracker` recording the byte
offset read so far and the next window's due time (a fixed window, default 180 s, measured from
session start on a monotonic clock). On each tick it catches up all due windows: for each
window it reads the stream increment from the last offset, preprocesses and renders it, and — if
the window is non-empty — enqueues a `worker_stream_window` envelope to the watcher inbox and
appends a `worker_stream_window_dispatched` event. Empty windows advance state without
dispatching. When the worker session ends, the dispatcher catches up the backlog and emits one
final window.

The dispatcher only enqueues envelopes; the physical inject into the watcher session happens via
the tick loop's delivery step. Incremental reads exclude a trailing half-written line (advanced
on the next read) and skip a corrupt interior line (with its bytes still counted in the offset
so it is not re-read). Read / enqueue failures are fail-soft; a degraded final window surfaces a
`host_event` to the meta inbox.

Independently, when the watcher is idle and its reported context usage exceeds a token threshold
(default 500,000), the host runs a context-**compaction** flow in the background: it compacts
the watcher's context and re-injects the role, without blocking the tick. The flow is bounded by
a retry cap; once exhausted it gives up for that watcher session.

## Concurrency & recovery

**Locks.** All cross-process coordination uses OS advisory file locks (`flock(2)` /
`LockFileEx`, via `fs-ext`), bound to a file descriptor and released automatically by the OS if
the process crashes:

| Lock | Guards |
| --- | --- |
| `control/host.pid.lock` | Single host instance (non-blocking acquire). |
| Manifest lock | Serializes all manifest stage transitions (with the CAS guard). |
| Messaging lock | Serializes all message-bus state mutations and folds. |
| File-level locks | Capsule writes such as the worker session-sequence counter. |

Blocking acquisition polls non-blockingly with a timeout and throws on timeout, so the event
loop is never blocked.

**Startup recovery** runs before the tick loop:

- Load the manifest (a read/parse/schema failure is fatal → exit code 2).
- Repair `events.jsonl`: a partial trailing line is truncated; a corrupt interior line is
  quarantined and event-read continues.
- Recover the message bus: clean leftover temp payload directories, **fold the state stream** to
  rebuild delivery state, truncate a partial state tail, mark envelopes whose payload is missing
  as failed, and remove orphan payloads. A state stream that cannot be folded is quarantined and
  a `host_event` is posted to the meta inbox.
- Repair half-completed worker scenarios: a worker `STARTED` with no paired `ENDED` (host
  crashed while the worker ran), or a `worker_session_end` that meta had not yet arbitrated, is
  reconciled so the loop neither mistakes a missing worker for a first start nor self-restarts.

Appends are idempotent where applicable: session-ended records and worker-end envelopes are
written exactly once per session via in-memory closeout guards, and a re-run of recovery skips
envelopes already marked failed.

See [DATA_FORMATS.md](DATA_FORMATS.md) for the `events.jsonl`, manifest, and envelope schemas,
and [PROVIDERS.md](PROVIDERS.md) for the session interface the host drives.
