# Deputy Agent

[English](README.md) | [中文](README.zh.md)

> Deputy — a self-supervising master–worker agent framework that auto-scaffolds a
> task-tailored harness for long, autonomous delivery.

Deputy is a TypeScript framework for long-running, autonomous tasks. You hand it a task
description; it generates a task-tailored harness and drives the work through a structured
lifecycle to completion, syncing with you only at key checkpoints.

It uses a **master–worker** design rather than a peer multi-agent system: a master (the Meta
role) plans, prepares the harness, and arbitrates outcomes, while a worker executes the task —
with a Watcher (live observation) and a Reviewer (verdicts at stage gates) acting as review
agents that audit and correct the worker. At heart it is a master–worker (2-agent)
architecture. Deputy is exposed both as a command-line tool and as a local Web GUI, and is
multi-provider: Claude and Codex are supported behind a common adapter layer.

## Highlights

- **Long, unattended tasks.** Built for jobs that run roughly **1 hour to ~2 days** without a
  human in the loop, not short interactive turns.
- **General (non-coding) focus.** Aimed at everyday white-collar / knowledge work; it is
  deliberately *not* specialized for coding.
- **On-demand harness.** A task-tailored harness (methodology / SOP / tools / completion
  checks) is auto-generated per task, instead of one fixed harness for everything.
- **Built-in review.** A master (the Meta role) drives a Worker, while a Watcher (live
  observation of the worker's output) and a Reviewer (verdicts at stage gates) audit and
  correct the work.
- **File-system, task-level memory.** Agents coordinate through workspace files and messages;
  the worker's multi-session state persists on disk.
- **Per-role provider/model.** Each role can run on a different provider and model — e.g. a
  cheaper model for the Worker.
- **Built on Claude Code / Codex.** Uses the Claude Code and Codex CLI agent kernels, in
  TypeScript.

## Project status

This is the **0.1.0** release, and a *reference implementation* of a higher-level design: the
open-source TypeScript here is essentially the compiled output of that higher-level spec. The
spec and many of the detailed design principles are not part of this repository.

- Because the published code is a compiled artifact, **future versions may change
  substantially** — keep this in mind if you fork and intend to merge later releases.
- Behavior is currently tuned primarily for **Claude**; **Codex / GPT models perform less
  well** today, since harness behavior is model-dependent.
- It is **not yet production-grade** by the author's quality bar and needs further polishing,
  though it may already exceed the tuning of some shipped products.
- Cross-task memory and external know-how injection are **not implemented in 0.1.0** (only
  task-level, file-system memory exists today). See
  [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## Requirements

- Node.js >= 22
- Provider credentials for at least one supported provider:
  - Claude (via the Claude Agent SDK)
  - Codex (optional, for roles bound to the `codex` provider)

## Quickstart

```bash
npm install
npm run build       # tsc + copy web static assets
npm run typecheck   # type-check only
```

After building, the **recommended** way to use Deputy is the local Web GUI:

```bash
node dist/cli/bin.js web    # then open the printed URL (default http://127.0.0.1:4319)
```

The Web GUI is the easiest way to submit a task and watch live progress, the conversation,
and the agent output streams, and to drive the whole task lifecycle from one place.

The CLI exposes the same operations and is better suited to scripting / headless use:

```bash
node dist/cli/bin.js submit "Write a report on X"
node dist/cli/bin.js list
node dist/cli/bin.js status <taskId>
```

## Usage

The local **Web GUI (`deputy web`) is the recommended way to drive tasks**. The CLI exposes
the same operations and is best for scripting / headless use: write commands (`submit`, `run`,
`answer`, `feedback`, `upload`, `pause`, `resume`, `done`, `cancel`, `rename`, `delete`), read
commands (`list`, `status`, `inspect`), and the `web` command itself. See
[docs/USAGE.md](docs/USAGE.md) (中文: [docs/USAGE.zh.md](docs/USAGE.zh.md)) for the full
command reference, the `deputy.config.json` format, and an end-to-end example.

## Project layout

```
src/
  shared/      task capsule layout, manifest (state machine), atomic IO, ids, paths
  wrapper/     provider-neutral AgentRuntime interface + capability model
    adapters/  claude / codex adapters, plus a stub for offline use
    types/     runtime / capability / session / event type contracts
  messaging/   envelope schema + per-channel inbox bus (message passing)
  prompts/     prompt asset assembly for the agent roles
  host/        the daemon: tick loop, agent orchestration, stage machine
    tools/     host-provided tools the agents call
    watcher/   worker-stream windowing + dispatch to the observer role
    done_criteria/  declarative completion checks gating task completion
  cli/         CLI entry, argument parsing, config, daemon launch
  web/         loopback-only HTTP + SSE Web GUI backend
```

## Documentation

Each document has an English version and a Chinese (`*.zh.md`) version.

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — overview: subsystem map, component diagram,
  task lifecycle, glossary, and links into the focused docs below
  (中文: [docs/ARCHITECTURE.zh.md](docs/ARCHITECTURE.zh.md))
- [docs/RUNTIME.md](docs/RUNTIME.md) — host daemon tick loop, agent roles, stage machine,
  message bus, concurrency & recovery
  (中文: [docs/RUNTIME.zh.md](docs/RUNTIME.zh.md))
- [docs/DATA_FORMATS.md](docs/DATA_FORMATS.md) — on-disk schemas: capsule layout,
  `manifest.yaml`, envelopes, `events.jsonl`, `done_criteria.yaml`, `deputy.config.json`
  (中文: [docs/DATA_FORMATS.zh.md](docs/DATA_FORMATS.zh.md))
- [docs/PROVIDERS.md](docs/PROVIDERS.md) — the `AgentRuntime` interface, capability model,
  and the claude / codex / stub adapters
  (中文: [docs/PROVIDERS.zh.md](docs/PROVIDERS.zh.md))
- [docs/WEB.md](docs/WEB.md) — local Web GUI: REST endpoints, SSE events, security model
  (中文: [docs/WEB.zh.md](docs/WEB.zh.md))
- [docs/USAGE.md](docs/USAGE.md) — installation, configuration, CLI and Web GUI usage
  (中文: [docs/USAGE.zh.md](docs/USAGE.zh.md))
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md) — known limitations of the current implementation
  (中文: [docs/LIMITATIONS.zh.md](docs/LIMITATIONS.zh.md))

## License

Licensed under the Apache License, Version 2.0. Commercial use is permitted; you must
retain the copyright and license notices (see the [LICENSE](LICENSE) and [NOTICE](NOTICE)
files), and state any significant changes you make to the files. The Apache-2.0 license
also includes an explicit patent grant. See [LICENSE](LICENSE) for the full terms.

## Contact

Reach out if you:

- want the higher-level spec, development know-how, or customization guidance;
- are building a similar general-purpose long-task agent framework and want to compare notes
  or collaborate;
- want to apply this design in your own product.
