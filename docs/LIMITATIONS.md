# Known limitations

This lists the concrete, observable limitations of the current Deputy implementation. It is
scoped to what the shipped code does today — not design intent or future direction.

## Scope and maturity

- **0.1.0 reference implementation.** This is a reference implementation; by the author's
  quality bar it is not yet production-grade and benefits from further polishing.
- **Tuned primarily for Claude.** Harness behavior is model-dependent; the system is tuned
  mainly for Claude, and Codex / GPT models currently perform less well (see *Providers* below
  for the concrete capability differences).
- **Task-level memory only.** Agents coordinate through workspace files and the worker's
  multi-session state persists on disk, but reuse of experience across tasks, and injection of
  external know-how / tools beyond what the harness bundles, are not implemented in this
  release.

## Providers

- **Only `claude` and `codex` are implemented.** The `ProviderId` type also lists `opencode`
  and `pi`, and they appear in `ALL_PROVIDER_IDS`, but no runtime adapter exists for them
  (the adapter set is `claude`, `codex`, and a `stub`). Binding a role to `opencode` or `pi`
  via `deputy.config.json` falls back along the role-binding priority chain with a warning; if
  a binding forces an unimplemented provider's runtime to be built, it raises a clear
  not-implemented error rather than starting.

- **Provider capabilities differ, and the difference is observable.** Each provider publishes
  a `RuntimeCapabilities` matrix and the host checks it before using an optional member. Some
  capabilities present on one provider are absent on another, so a role's behavior depends on
  the provider it is bound to:
  - *Context-compaction summary observation* — Claude reports `compact.canObserveSummary:
    true`; Codex reports `false`. When the watcher is bound to a provider that cannot observe
    the summary, the watcher compaction mode falls back to `lenient` (the host manages the
    summary itself) instead of the default `strict`.
  - *Custom compaction instructions* — Claude accepts custom summary instructions
    (`acceptsCustomInstructions: true`); Codex does not (`false`), so such instructions are
    not applied under Codex.
  - *Tool enforcement* — Claude enforces tools via a preflight hook and can disable high-risk
    built-ins; Codex has no preflight-hook path and bounds writes via an OS sandbox
    (`writableRoots`) instead. As a result, when Codex acts as meta, the harness write
    protection that Claude enforces via a hook is not enforced and degrades to a prompt-level
    constraint.
  - *Session resume* — Codex can resume from a provider session id (`fromProviderId: true`);
    Claude cannot (`false`). Neither adapter resumes from a file or forks at an entry.
  - *Auto-retry disable* — Codex can disable auto-retry; the Claude adapter reports
    `canDisable: false`, so a request to disable auto-retry under Claude fails fast with
    `not_supported`.

- **Some Codex capabilities are reported as unavailable pending verification.** The Codex
  adapter attaches `warn` diagnostic hints (e.g. isolation transport, OAuth provisioning,
  built-in tool control) and conservatively reports the corresponding capabilities as `false`
  rather than claiming support. The Claude adapter similarly attaches a
  `claude_ts_api_unverified` hint covering its TS SDK surface.

## Web GUI

- **Loopback-only and single-process.** The server binds to a loopback host (default
  `127.0.0.1:4319`) and fails fast if asked to bind a non-loopback address. It has no
  authentication and applies an Origin check on writes and streams. It is not intended for
  multi-user, remote, or exposed deployment.

- **Writes are serialized through an in-process mutex.** All state-changing actions run one at
  a time through a single in-process write chain in the web backend. There is no cross-process
  scheduling at this layer; concurrency safety across processes comes from the underlying
  per-file locks.

- **Live updates use filesystem watching with periodic reconciliation.** SSE streams are
  driven by `fs.watch` plus a debounce, with a periodic (2s) reconcile pass and heartbeat as
  the fallback. This is a pragmatic, not push-exact, mechanism: updates can arrive on the
  reconcile interval rather than instantly, and on a read/watch error the stream emits a `lag`
  event and the frontend re-hydrates via REST. The composite task-submit endpoint reports
  partial success (per-file upload failures are aggregated into a `failed` list).

## Host daemon

- **One host daemon per task at a time.** The host holds a single-instance lock
  (`control/host.pid.lock`); a second host for the same task exits with a single-instance
  conflict. A task cannot be driven by two hosts simultaneously.

- **Some operations require the host not to be running.** `run` rejects if the lock is already
  held, and `delete` requires the host to be stopped — deleting a task whose host is still
  running is rejected with a message to `cancel` or `pause` it first.

## Testing

- **No automated tests are included in this open-source export.** The package defines only
  `typecheck`, `build`, and `check` scripts; no test runner or test suite is shipped here.
