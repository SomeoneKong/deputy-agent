# Providers

Deputy's host is provider-agnostic: it never talks to Claude or Codex directly. All provider
access goes through a single `AgentRuntime` interface, and each provider publishes a
`RuntimeCapabilities` matrix the host consults before using optional behavior. This document
covers that surface — the interface, the capability model, the normalized event stream, role
→ provider resolution, and the concrete `claude` / `codex` / `stub` adapters.

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the overall shape and **[RUNTIME.md](RUNTIME.md)**
for how the host daemon drives sessions across its tick loop.

## The AgentRuntime interface

An `AgentRuntime` is one instance per provider. It exposes two readonly fields — `providerId`
and `capabilities` — plus the session methods below. A `SessionHandle` (returned by
`startSession`) identifies a session in every later call.

**Core members** (always present):

| Member | Signature | Purpose |
| --- | --- | --- |
| `startSession` | `(req: SessionRequest) => Promise<SessionHandle>` | Start a session for one role with a model, cwd, system prompt, tool names, isolation profile, and stream path. |
| `inject` | `(handle, input: InjectInput) => Promise<InjectAck>` | Deliver content into the session under an `InjectPolicy`; the ack reports how it was accepted (immediate / queued / rejected). |
| `abortTurn` | `(handle, reason?) => Promise<void>` | Interrupt the in-flight turn, if any. |
| `closeSession` | `(handle, options?: CloseOptions) => Promise<SessionCloseResult>` | End the session (optionally force-aborting a running turn); returns final stats and the end reason. |
| `status` | `(handle) => SessionStatus` | Synchronous current state: `initializing` / `idle` / `streaming` / `closing` / `closed`. |
| `subscribe` | `(handle, listener) => Unsubscribe` | Register a listener for the session's normalized `SessionEvent` stream. |

**Optional members** (present only when the matching capability is declared):

| Member | Signature | Gated by |
| --- | --- | --- |
| `compact` | `(handle, hint?: CompactHint) => Promise<CompactOutcome>` | `capabilities.compact.canTrigger` |
| `contextUsage` | `(handle) => Promise<ContextUsage>` | `capabilities.contextUsage.supportsManualQuery` |
| `resumeSession` | `(handle, target: SessionResumeTarget) => Promise<void>` | `capabilities.sessionResume.*` |
| `isolationSelfCheck` | `(handle) => Promise<IsolationSelfCheckResult>` | `capabilities.isolationSelfCheck` |

The host checks the capability before calling the optional member; an adapter that lacks a
capability does not define the corresponding method (and would throw `not_supported` rather
than silently degrade).

## Capability model

`RuntimeCapabilities` is a **per-provider** matrix — it describes the provider's upper bound
and does not vary per session. A capability advertised as `false` means the host must not
request that behavior; requesting it fails fast with `not_supported` rather than degrading.

| Dimension | Shape | Meaning |
| --- | --- | --- |
| `inject` | `requireIdle` (always `true`), `steerIfStreaming`, `followUpIfStreaming`, `interruptThenInject` | Which inject policies the provider supports. `requireIdle` is guaranteed by contract; the other three indicate whether content can steer a running turn, queue as a follow-up, or interrupt-then-inject. |
| `streamingDelta` | `boolean` | Whether the provider emits incremental `assistant_delta` events. |
| `contextUsage` | `kind` (`none`/`basic`/`categorized`), `supportsManualQuery`, `supportsPushSnapshot`, `fields` (`tokens`/`contextWindow`/`percent`/`categories`) | How context usage can be observed: on demand, pushed via snapshots, and which fields are populated. |
| `compact` | `canTrigger`, `canObserveSummary`, `canCustomizeSummary`, `acceptsCustomInstructions` | Whether compaction can be triggered, whether the resulting summary is observable, whether the summary can be customized, and whether custom instructions are accepted. |
| `sessionResume` | `fromProviderId`, `fromFile`, `forkAtEntry` | Which resume targets the provider supports. |
| `toolEnforcement` | `preflightHook`, `firstClassBlock`, `osSandboxWritableRoots`, `canDisableHighRiskBuiltins` | The write-constraint mechanisms available: a pre-tool-use hook, first-class block, an OS sandbox with writable roots, and disabling high-risk built-in tools. |
| `toolStreamingPartial` | `boolean` | Whether partial tool-call input is streamed. |
| `providerBuiltinToolsControl` | `canDisableAll`, `canAllowList` | Whether the provider's built-in tools can be disabled wholesale or restricted to an allow-list. |
| `thinking` | `supportedLevels` (`off`…`xhigh`), `supportsReasoningSummary` | The reasoning effort levels the provider accepts and whether it surfaces a reasoning summary. |
| `autoRetry` | `hasAutoRetry`, `canDisable` | Whether the provider auto-retries upstream failures and whether that can be disabled. |
| `isolationSelfCheck` | `boolean` | Whether the runtime can verify its isolation root at runtime. |
| `jsonSchemaSubset` | `ReadonlyArray<JsonSchemaFeature>` | Which JSON Schema features the provider's tool inputs accept without translation loss. |
| `diagnosticHints` | `ReadonlyArray<DiagnosticHint>` (optional) | `info`/`warn` notes attached when a surface is unverified, so the host does not schedule it as stable production behavior. |

**Gating convention.** Before any code path that depends on optional behavior, the host reads
the relevant capability and only then calls the optional member (or selects a strategy). This
turns a missing capability into a checked, startup-time / pre-call decision rather than a
runtime surprise.

## Normalized event stream

Each adapter is the sole consumer of its provider's native event stream. It normalizes those
native events into a single `SessionEvent` union, persists each event as a line of
`StreamJsonlLine` (the event plus `_writer` metadata: a monotonic `seq` and `adapterVersion`),
and fans them out to subscribers. Every event extends `SessionEventCommon`
(`receivedAt`, `sessionId`, `providerId`).

The union carries these event families:

| Family | Kinds |
| --- | --- |
| Session lifecycle | `session_started`, `session_resumed`, `session_ended`, `synthetic_state_snapshot` |
| Turn boundaries | `turn_started` (with a `TurnCause`), `turn_ended` (with a `StopReason` and `TurnUsage`) |
| Assistant output | `assistant_block` (text / thinking / tool_use), `assistant_delta` (incremental, when `streamingDelta`) |
| Tool calls | `tool_invoked`, `tool_result_recorded` (with `isHostTool` flag) |
| Compaction | `compact_started`, `compact_ended` |
| Retry | `retry_started`, `retry_ended` |
| Subagents | `subagent_started`, `subagent_progress`, `subagent_stopped` (derived from Task/Agent tool calls) |
| Usage | `usage_snapshot` (with `TokenUsage` and optional `ContextUsage`) |
| Inject lifecycle | `host_inject_requested`, `inject_accepted`, `inject_rejected`, `inject_queued`, `inject_delivered`, `inject_cancelled`, `inject_dropped` |
| Error / escape hatch | `runtime_error`, `provider_raw` (a native event with no normalized mapping) |

Output, tool, and delta events carry an optional `parentToolUseId`: when set, the event
originates inside a subagent (the value is the spawning Task/Agent tool-call id); empty for the
main agent's own output. `provider_raw` is the escape hatch for native events the adapter does
not map, preserving them for audit.

## Role → provider binding & resolution

Roles (`meta` / `worker` / `watcher` / `reviewer`) are bound to providers **per task**. The
host holds two pieces of assembly data: a provider → `AgentRuntime` map, and per-role bindings
of `(provider, model)`. By default all roles bind to a single provider and model; the default
provider is `claude`.

Before starting any session, `RoleResolver.resolve(role)` produces a concrete
`ResolvedRoleAssembly` — `(runtime, model, isolation)`:

1. **Lookup** — find the role's binding and the runtime for that provider.
2. **Consistency invariant** — require that the binding provider, the runtime's `providerId`,
   and the model's `provider` all agree. This prevents starting one provider's model on
   another provider's runtime.
3. **Capability gating** — verify the resolved runtime satisfies the role's required
   capabilities (see below). Selection is checked here, not discovered at startup.
4. **Fail-soft fallback** — on an invariant mismatch or a capability miss, fall back to the
   default (`claude`) binding and log a warning. If the default binding itself is missing or
   also misses the capability, throw `RoleAssemblyError` (a clear startup-time config error) —
   there is no silent fallback past the default.

Isolation is resolved per provider (different providers have different credential / sandbox
shapes): each provider's isolation template is injected by the upper layer, and providers
without a template use a fallback.

Per-role required capabilities:

| Role | Required |
| --- | --- |
| `meta` | `inject.interruptThenInject`, `thinking.supportsReasoningSummary`, and (in production mode only) a write-constraint tier: `toolEnforcement.preflightHook` \|\| `firstClassBlock` \|\| `osSandboxWritableRoots`. |
| `watcher` | Proactive compaction by mode: **strict** needs `compact.canObserveSummary` && `compact.canCustomizeSummary`; **lenient** needs only `compact.canTrigger`. |
| `worker` / `reviewer` | No additional hard requirement (`inject.requireIdle` is guaranteed by contract). |

## Adapters

Concrete implementations live in `src/wrapper/adapters/`:

| Adapter | Backed by | Notes |
| --- | --- | --- |
| `claude` | Claude Agent SDK | The default provider. Exposes a public factory (`claudeRuntimeFactory`) and Claude-only config; SDK-private vocabulary stays internal. |
| `codex` | Codex app-server JSON-RPC protocol | Drives `thread/*` and `turn/*` methods over a JSON-RPC transport. Protocol types are aligned to `codex app-server generate-ts --experimental` @ codex-cli 0.133.0 (re-generate to verify). |
| `stub` | none (offline) | A scriptable runtime implementing the full `AgentRuntime` contract for tests and closed-loop driving; `providerId` defaults to masquerading as `claude` and the capability matrix is configurable. Not a real provider. |

### claude vs codex (factual capability differences)

| Capability | `claude` | `codex` |
| --- | --- | --- |
| `inject.steerIfStreaming` | `false` | `true` (`turn/steer`) |
| `inject.interruptThenInject` | `true` | `true` (`turn/interrupt` → wait `turn/completed` → `turn/start`) |
| `contextUsage.kind` | `categorized` | `basic` |
| `contextUsage.fields` | `tokens`, `contextWindow`, `percent`, `categories` | `tokens`, `contextWindow`, `percent` |
| `compact.canObserveSummary` | `true` | `false` |
| `compact.canCustomizeSummary` / `acceptsCustomInstructions` | `true` | `false` |
| `sessionResume.fromProviderId` | `false` | `true` (`thread/resume`) |
| `toolEnforcement.preflightHook` | `true` | `false` |
| `toolEnforcement.osSandboxWritableRoots` | `false` | `true` (`turn/start` `sandboxPolicy.workspaceWrite.writableRoots`) |
| `toolEnforcement.canDisableHighRiskBuiltins` | `true` | `false` |
| `providerBuiltinToolsControl` | `canDisableAll` & `canAllowList` `true` | both `false` |
| `autoRetry.canDisable` | `false` | `true` |
| `jsonSchemaSubset` | restricted subset | full set |

Both providers declare `streamingDelta: true`, `isolationSelfCheck: true`,
`thinking.supportsReasoningSummary: true`, `inject.requireIdle: true`, and `compact.canTrigger:
true`. Both attach `warn` `diagnosticHints` for surfaces not yet verified against a live API
(the claude adapter when its TS SDK surface is unverified; the codex adapter for isolation
transport, OAuth provisioning, and built-in-tools control).
