# Architecture

Deputy is a TypeScript runtime that orchestrates multiple AI agent roles to autonomously
execute long-running tasks. A task is submitted (via the CLI or the local Web GUI) and
stored as an on-disk *task capsule*. A single host daemon then ticks repeatedly: it starts
and steers the agent roles, passes messages between them, watches the worker's output, runs
completion checks, and advances the task through its lifecycle until it reaches a terminal
state. Each role can run on a different provider (Claude or Codex) behind a common adapter
layer.

This document is the entry point. It gives the overall shape; the focused companion
documents go deeper:

- **[RUNTIME.md](RUNTIME.md)** — the host daemon tick loop, the four agent roles, the stage
  machine, the message bus, and the concurrency / recovery model.
- **[DATA_FORMATS.md](DATA_FORMATS.md)** — the on-disk schemas: capsule layout,
  `manifest.yaml`, message envelopes, `events.jsonl`, `done_criteria.yaml`, and
  `deputy.config.json`.
- **[PROVIDERS.md](PROVIDERS.md)** — the `AgentRuntime` interface, the capability model, the
  normalized event stream, and the claude / codex / stub adapters.
- **[WEB.md](WEB.md)** — the local Web GUI: REST endpoints, SSE event types, and the
  loopback security model.
- **[LIMITATIONS.md](LIMITATIONS.md)** — known limitations of the current implementation.

(Chinese versions: `*.zh.md`.)

## Subsystem map

| Directory | Responsibility |
| --- | --- |
| `src/shared` | Task-capsule path layout, the `manifest.yaml` task state machine, atomic file writes, locks, ids, time/JSONL helpers, and `status.md` rendering. |
| `src/wrapper` | The provider-neutral surface: the `AgentRuntime` interface and the capability model (`RuntimeCapabilities`). |
| `src/wrapper/adapters` | Concrete provider implementations — `claude` and `codex` — plus a `stub` runtime for offline/non-provider runs. |
| `src/wrapper/types` | Type contracts shared across the wrapper: runtime, capability, session, events, isolation, tool-bridge. |
| `src/messaging` | The message bus: envelope schema, per-channel inboxes, the message-bus state stream, cross-process concurrency, and recovery. |
| `src/prompts` | Assembles system prompts and first-user messages for each role, with localized literals (en/zh) and per-prompt language fallback. |
| `src/host` | The daemon: the tick loop, agent-session orchestration, the stage machine, recovery, watchdogs, and retry. |
| `src/host/tools` | Host-provided tools the agents call (messaging, agent control, harness edits, stage transitions, reviewer verdicts). |
| `src/host/watcher` | Slices the worker's output stream into windows and dispatches them to the observer role. |
| `src/host/done_criteria` | Declarative completion checks (`done_criteria.yaml`) evaluated when a worker session ends. |
| `src/cli` | CLI entry, argument parsing, `deputy.config.json` loading, and launching the daemon (foreground or detached). |
| `src/web` | The local Web GUI backend — a loopback-only HTTP server with SSE streaming. |

## Component overview

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

The CLI and the Web GUI are two front-ends over the same in-process write commands and the
same on-disk capsule. Neither talks to a provider directly; all provider access goes through
the `AgentRuntime` interface, so the host is provider-agnostic.

## Runtime model (summary)

A task is a directory — the *capsule* — with a `workspace/` half (where work happens) and a
`control/` half (orchestration state). The authoritative state is `control/manifest.yaml`;
every orchestration-level event is appended to `control/events.jsonl`.

The host is a **single-instance daemon** (guarded by `control/host.pid.lock`) running a tick
loop. On each tick it reads the manifest and, depending on the current stage, ensures the
right agent sessions are online, delivers unread messages, dispatches the worker's output
windows to the watcher, and evaluates whether the task should advance. It exits when the
task reaches a terminal or paused stage.

Four agent roles cooperate (full detail in [RUNTIME.md](RUNTIME.md)):

- **meta** — long-lived orchestrator: clarifies the task, prepares the per-task harness,
  starts/stops the worker, arbitrates worker outcomes, and decides when the task is done or
  needs the user.
- **worker** — the executor that performs the task inside `workspace/`.
- **watcher** — observes windows of the worker's output stream and reports observations back
  to meta; can trigger context compaction when its own context grows large.
- **reviewer** — a one-shot session that produces a verdict at review points.

Agents never call each other directly; they exchange **envelopes** over three inbox
**channels** (`meta`, `worker`, `watcher`), each with a per-channel kind whitelist. Delivery
state is derived by folding the message-bus state stream, which makes it recoverable across
host restarts. See [DATA_FORMATS.md](DATA_FORMATS.md) for the envelope schema.

## Task lifecycle

The manifest's `stage` field is the source of truth. There are nine stages — five
*in-progress* stages, three *terminal* stages, and `paused`:

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

In-progress stages: `submitted`, `clarifying`, `bootstrapping`, `running`, `awaiting_user`.
Terminal stages: `done`, `failed`, `cancelled`. `paused` records which in-progress stage it
was paused from so `resume` can return to it. Every transition is serialized through a lock
with a compare-and-set guard. Most transitions append a `stage_transition` event to
`events.jsonl`; CLI pause/resume instead record a `user_cli_action`, and some host failure
paths update the manifest without a transition event. The per-stage entry conditions,
active roles, and triggers are tabulated in [RUNTIME.md](RUNTIME.md).

## Provider adapter layer (summary)

The host talks only to an `AgentRuntime`: start / inject / abort / close a session, query
its status, and subscribe to its normalized events — plus optional members (`compact`,
`contextUsage`, `resumeSession`, `isolationSelfCheck`) that exist only when the matching
capability is declared. Each provider publishes a `RuntimeCapabilities` matrix; the host
checks a capability before calling its optional member rather than discovering a gap at
runtime. Roles are bound to providers per task and resolved to a concrete
`(runtime, model, isolation)` triple before any session starts. Full surface in
[PROVIDERS.md](PROVIDERS.md).

## Glossary

| Term | Meaning |
| --- | --- |
| **task capsule** | The per-task directory (`workspace/` + `control/`) holding all state for one task. |
| **manifest** | `control/manifest.yaml` — the authoritative task record, including the current `stage`. |
| **stage** | The task's lifecycle state (one of the nine stages above). |
| **harness** | The per-task `workspace/harness/` content meta prepares — SOP, tools, scripts, and `done_criteria.yaml`. |
| **role** | One of the four agent roles: meta / worker / watcher / reviewer. |
| **envelope** | A typed message on a channel, with a `kind` and optional structured `extras` + a body. |
| **channel** | An inbox — `meta`, `worker`, or `watcher` — with a per-channel kind whitelist. |
| **done criteria** | Declarative checks in `done_criteria.yaml` evaluated (no LLM) when a worker session ends. |
| **window** | A slice of the worker's output stream the watcher consumes. |
| **compaction** | Summarizing an agent's context when it grows large, to continue within the context window. |
| **AgentRuntime** | The provider-neutral session interface every adapter implements. |
| **capability matrix** | `RuntimeCapabilities` — what a provider supports (injection, compaction, etc.). |
