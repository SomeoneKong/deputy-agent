/**
 * CodexRuntime -- the AgentRuntime implementation for the Codex provider.
 *
 * Implements only the common contract; Codex-private vocabulary stays inside this adapter. One
 * app-server subprocess per capsule (capsuleConfigDir) via CapsuleConnection, hosting that capsule's
 * multiple threads / sessions. The runtime holds a session Map + a capsule Map and routes
 * notifications / server-requests to the appropriate session by threadId.
 */
import type {
  AgentRuntime,
  AgentRuntimeFactory,
  AgentRuntimeOptions,
  CloseOptions,
  CompactHint,
  CompactOutcome,
  ContextUsage,
  HostToolRegistry,
  InjectAck,
  InjectInput,
  IsolationSelfCheckResult,
  ProviderId,
  RuntimeCapabilities,
  RuntimeError,
  SessionCloseResult,
  SessionEvent,
  SessionHandle,
  SessionRequest,
  SessionResumeTarget,
  SessionStatus,
  Unsubscribe,
} from "../../types/index.js";
import { RuntimeErrorImpl } from "../../types/index.js";
import { AppServerClient, isApprovalRequest } from "./appServerClient.js";
import { buildCodexCapabilities } from "./capability.js";
import { resolveCodexConfig, type ResolvedCodexConfig } from "./config.js";
import { classifyRpcError, subprocessExitError } from "./errors.js";
import { buildChildEnv, codexHomeOf, placeSentinel, provisionAuth } from "./isolation.js";
import {
  CLIENT_METHODS,
  SERVER_REQUEST_METHODS,
  type DynamicToolCallParams,
  type InitializeParams,
  type InitializeResponse,
  type JsonValue,
} from "./protocol.js";
import { CODEX_ADAPTER_VERSION } from "./config.js";
import { CodexSession, type CapsuleAccess } from "./session.js";

const PROVIDER: ProviderId = "codex";

/** The app-server subprocess connection for one capsule (capsuleConfigDir) (hosts multiple threads). */
class CapsuleConnection {
  readonly client: AppServerClient;
  readonly #threads = new Map<string, CodexSession>();
  #initResponse: InitializeResponse | undefined;
  #exited = false;

  constructor(
    cfg: ResolvedCodexConfig,
    spawnArgs: { bin: string; args: ReadonlyArray<string>; env: Readonly<Record<string, string>>; cwd: string },
    /** Callback for a subprocess crash exit (not an intentional kill): the runtime uses it to escalate the consecutive-exit count per capsuleKey, cascade-finalize, and retire. */
    private readonly onCrash: (info: { code: number | null; signal: NodeJS.Signals | null; error?: Error }, sessions: ReadonlyArray<CodexSession>) => void,
    private readonly onCapsuleEmpty: () => void,
  ) {
    this.client = AppServerClient.spawn(
      cfg.spawnFn,
      spawnArgs,
      {
        onNotification: (method, params) => this.#routeNotification(method, params),
        onServerRequest: (method, params) => this.#routeServerRequest(method, params),
        onExit: (info) => this.#onExit(info),
      },
      cfg.rpcTimeoutMs,
    );
  }

  get initResponse(): InitializeResponse | undefined {
    return this.#initResponse;
  }

  setInitResponse(init: InitializeResponse): void {
    this.#initResponse = init;
  }

  get threadCount(): number {
    return this.#threads.size;
  }

  registerThread(threadId: string, session: CodexSession): void {
    this.#threads.set(threadId, session);
  }

  unregisterThread(threadId: string): void {
    this.#threads.delete(threadId);
  }

  /** When the last thread closes -> shut down the subprocess. */
  maybeShutdown(): void {
    if (this.#threads.size === 0 && !this.#exited) {
      this.#exited = true;
      this.client.kill();
      this.onCapsuleEmpty();
    }
  }

  /**
   * Force-kill path (cascade): triggered by a session's forced close. Force-kills the app-server
   * subprocess and cascade-finalizes all sibling sessions (except the initiator) as fatal_runtime_error;
   * the initiator finalizes itself as host_close_forced. Sets #exited=true so the subsequent process
   * exit event is treated as an intentional kill (not a second crash cascade).
   */
  forceKill(initiator: CodexSession, err: RuntimeError, retire: (id: string, result: SessionCloseResult) => void): void {
    if (this.#exited) return;
    this.#exited = true;
    const siblings = [...this.#threads.values()].filter((s) => s !== initiator);
    this.#threads.clear();
    this.client.kill();
    for (const s of siblings) {
      void s.cascadeClose("fatal_runtime_error", err).then((r) => retire(s.handle.id, r)).catch(() => {});
    }
    this.onCapsuleEmpty();
  }

  #threadIdOf(params: JsonValue): string | undefined {
    const p = params as { threadId?: unknown };
    return typeof p?.threadId === "string" ? p.threadId : undefined;
  }

  #routeNotification(method: string, params: JsonValue): void {
    const threadId = this.#threadIdOf(params);
    if (threadId === undefined) return; // notifications without a top-level threadId (e.g. thread/started) are handled synthetically by the session, not routed
    const session = this.#threads.get(threadId);
    session?.handleNotification(method, params);
  }

  async #routeServerRequest(method: string, params: JsonValue): Promise<JsonValue> {
    // item/tool/call -> route to the host handler.
    if (method === SERVER_REQUEST_METHODS.itemToolCall) {
      const p = params as DynamicToolCallParams;
      const session = this.#threads.get(p.threadId);
      if (session === undefined) {
        throw new Error(`codex item/tool/call for unknown thread ${p.threadId}`);
      }
      return (await session.dispatchTool(p)) as unknown as JsonValue;
    }
    // approvals -> auto-approve per the automation policy (usually not triggered under approvalPolicy=never, but auto-approved as a fallback).
    if (isApprovalRequest(method)) {
      return autoApproveResponse(method, params);
    }
    // requestUserInput / elicitation -> not applicable in unattended mode; return an error.
    // account/chatgptAuthTokens/refresh: defensively throw -- the isolation root already has a complete
    // auth.json (including refresh_token), and codex is expected to self-refresh internally (writing back
    // to the isolation root) rather than sending this server-request. If live verification shows codex
    // actually delegates refresh to the client, a refresh handler would be implemented then (the
    // codex_oauth_provision_unverified warn hint currently covers this uncertainty).
    throw new Error(`codex server request ${method} not supported in unattended mode`);
  }

  #onExit(info: { code: number | null; signal: NodeJS.Signals | null; error?: Error }): void {
    if (this.#exited) return; // an exit triggered by an intentional kill (maybeShutdown / forceKill) is not a crash
    this.#exited = true;
    // The shared subprocess crashed -> delegate to the runtime (escalate the consecutive-exit count per capsuleKey, cascade-finalize, retire).
    const sessions = [...this.#threads.values()];
    this.#threads.clear();
    this.onCrash(info, sessions);
    this.onCapsuleEmpty();
  }
}

/**
 * approval server-request -> auto-approve response (constructed per the method's shape). Auto-approved
 * as a fallback under the unattended policy.
 * permissions/requestApproval: from the requested RequestPermissionProfile, builds a protocol-valid
 * GrantedPermissionProfile + scope "turn" (the PermissionsRequestApprovalResponse shape), granting only
 * the capabilities requested for this turn, rather than returning a structurally invalid
 * { permissions: "granted" }.
 */
function autoApproveResponse(method: string, params: JsonValue): JsonValue {
  switch (method) {
    case SERVER_REQUEST_METHODS.execCommandApproval:
    case SERVER_REQUEST_METHODS.applyPatchApproval:
      return { decision: "approved" };
    case SERVER_REQUEST_METHODS.commandExecutionRequestApproval:
    case SERVER_REQUEST_METHODS.fileChangeRequestApproval:
      return { decision: "accept" };
    case SERVER_REQUEST_METHODS.permissionsRequestApproval:
      // Under unattended approvalPolicy=never this is usually not triggered; when it is, grant as
      // requested (scope "turn", effective only within this turn). Whether to constrain escalation
      // requests by sandbox intersection awaits live verification of whether the request actually fires
      // and of the rejection response shape.
      return grantRequestedPermissions(params);
    default:
      return {};
  }
}

/**
 * Map the requested RequestPermissionProfile ({ network: x|null, fileSystem: y|null }) to a
 * GrantedPermissionProfile ({ network?, fileSystem? }, omitting null fields), assembling a
 * protocol-valid PermissionsRequestApprovalResponse.
 */
function grantRequestedPermissions(params: JsonValue): JsonValue {
  const requested = (params as { permissions?: { network?: JsonValue; fileSystem?: JsonValue } } | null)?.permissions;
  const granted: { network?: JsonValue; fileSystem?: JsonValue } = {};
  if (requested != null && requested.network != null) granted.network = requested.network;
  if (requested != null && requested.fileSystem != null) granted.fileSystem = requested.fileSystem;
  return { permissions: granted, scope: "turn" };
}

class CodexRuntime implements AgentRuntime {
  readonly providerId: ProviderId = PROVIDER;
  readonly capabilities: RuntimeCapabilities;
  readonly #cfg: ResolvedCodexConfig;
  readonly #registry: HostToolRegistry;
  readonly #sessions = new Map<string, CodexSession>();
  /**
   * capsuleKey (CODEX_HOME) -> connection Promise (one subprocess per capsule). Stores a Promise rather
   * than a built instance so concurrent startSessions for the same capsule await the same initialization
   * (avoiding a capsule with an incomplete init / spawning a second subprocess). The promise resolves to
   * a usable capsule only after initialize succeeds; on init failure it is removed from the map (failures
   * are not cached).
   */
  readonly #capsules = new Map<string, Promise<CapsuleConnection>>();
  /** capsuleKey -> consecutive subprocess-exit count (first occurrence transient / repeated permanent). */
  readonly #consecutiveExits = new Map<string, number>();
  readonly #closedResults = new Map<string, SessionCloseResult>();
  static readonly #CLOSED_CACHE_MAX = 256;

  constructor(options: AgentRuntimeOptions) {
    this.#cfg = resolveCodexConfig(options.providerSpecific);
    this.#registry = options.toolRegistry;
    this.capabilities = buildCodexCapabilities();
  }

  #retire(id: string, result: SessionCloseResult): void {
    this.#sessions.delete(id);
    this.#closedResults.set(id, result);
    if (this.#closedResults.size > CodexRuntime.#CLOSED_CACHE_MAX) {
      const oldest = this.#closedResults.keys().next().value;
      if (oldest !== undefined) this.#closedResults.delete(oldest);
    }
  }

  /** Get or create the capsule subprocess + initialize handshake. Concurrent calls for the same capsule await the same connection promise. */
  async #ensureCapsule(key: string, req: SessionRequest): Promise<CapsuleConnection> {
    const existing = this.#capsules.get(key);
    if (existing !== undefined) return existing;
    const promise = this.#buildCapsule(key, req);
    this.#capsules.set(key, promise);
    // On init failure -> remove this promise from the map (failures are not cached; the next startSession rebuilds).
    promise.catch(() => {
      if (this.#capsules.get(key) === promise) this.#capsules.delete(key);
    });
    return promise;
  }

  async #buildCapsule(key: string, req: SessionRequest): Promise<CapsuleConnection> {
    // Provision auth + prepare the isolation-root CODEX_HOME (managed openai-oauth: copy auth.json from configDir/default ~/.codex into the isolation root; env/file are already in place).
    await provisionAuth(req.isolation);

    const env = buildChildEnv(req.isolation);
    const capsule = new CapsuleConnection(
      this.#cfg,
      { bin: this.#cfg.codexBin, args: ["app-server"], env, cwd: req.cwd },
      (info, sessions) => this.#onCapsuleCrash(key, info, sessions),
      () => this.#onCapsuleEmpty(key),
    );

    // initialize handshake. Only after it succeeds does the promise resolve, making the capsule visible and usable to concurrent callers.
    const params: InitializeParams = {
      clientInfo: { name: "deputy", title: null, version: CODEX_ADAPTER_VERSION },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: null },
    };
    try {
      const init = await capsule.client.request<InitializeResponse>(CLIENT_METHODS.initialize, params as unknown as JsonValue);
      capsule.setInitResponse(init);
    } catch (err) {
      capsule.client.kill();
      throw classifyRpcError(err, "init", { sessionId: req.sessionId });
    }
    return capsule;
  }

  /** Capsule subprocess crash: escalate the consecutive count per capsuleKey -> cascade-finalize the affected sessions + retire. */
  #onCapsuleCrash(
    key: string,
    info: { code: number | null; signal: NodeJS.Signals | null; error?: Error },
    sessions: ReadonlyArray<CodexSession>,
  ): void {
    const n = (this.#consecutiveExits.get(key) ?? 0) + 1;
    this.#consecutiveExits.set(key, n);
    const consecutive = n > 1;
    for (const session of sessions) {
      const err = subprocessExitError(consecutive, { sessionId: session.handle.id, exitCode: info.code, signal: info.signal });
      void session
        .cascadeClose("fatal_runtime_error", err)
        .then((r) => this.#retire(session.handle.id, r))
        .catch(() => {});
    }
  }

  #onCapsuleEmpty(key: string): void {
    this.#capsules.delete(key);
  }

  async startSession(req: SessionRequest): Promise<SessionHandle> {
    if (this.#sessions.has(req.sessionId)) {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "invalid_request", providerId: PROVIDER, message: `sessionId already in use: ${req.sessionId}` });
    }
    const key = codexHomeOf(req.isolation);
    const capsule = await this.#ensureCapsule(key, req);
    // Note: resetting the consecutive-exit count is bound to observing a successful turn (onTurnSuccess),
    // not to startSession success here -- otherwise a crash-loop where "init succeeds but the first turn
    // crashes" would be reset on every rebuild, and the permanent escalation could never be reached.
    // cwd-level sentinel: do not overwrite an existing AGENTS.md; only backfill the marker to wire up the self-check when placed.
    const sentinel = await placeSentinel(req.cwd).catch(() => ({ marker: "", placed: false }));
    const access: CapsuleAccess = {
      client: capsule.client,
      registerThread: (threadId, session) => capsule.registerThread(threadId, session),
      unregisterThread: (threadId) => capsule.unregisterThread(threadId),
      onThreadClosed: () => capsule.maybeShutdown(),
      onTurnSuccess: () => this.#consecutiveExits.set(key, 0),
      forceKillCapsule: (initiator, err) => capsule.forceKill(initiator, err, (id, r) => this.#retire(id, r)),
    };
    const session = new CodexSession(req, this.#cfg, this.#registry, access);
    const init = capsule.initResponse;
    if (init !== undefined) session.setInitResponse(init);
    if (sentinel.placed) session.setSentinelMarker(sentinel.marker);
    this.#sessions.set(req.sessionId, session);
    try {
      await session.start();
    } catch (err) {
      // Rollback: if start failed after registerThread (failure after the session_started emit) ->
      // unregister first to prevent a stale entry in the capsule's #threads (otherwise maybeShutdown
      // never fires -> subprocess leak). session.handle.providerSessionId is the registered threadId.
      this.#sessions.delete(req.sessionId);
      const threadId = session.handle.providerSessionId;
      if (threadId !== undefined) capsule.unregisterThread(threadId);
      capsule.maybeShutdown();
      throw err;
    }
    return session.handle;
  }

  async inject(handle: SessionHandle, input: InjectInput): Promise<InjectAck> {
    return this.#must(handle).inject(input);
  }

  async abortTurn(handle: SessionHandle, reason?: string): Promise<void> {
    return this.#must(handle).abortTurn(reason);
  }

  async closeSession(handle: SessionHandle, options?: CloseOptions): Promise<SessionCloseResult> {
    const session = this.#sessions.get(handle.id);
    if (session === undefined) {
      const cached = this.#closedResults.get(handle.id);
      if (cached !== undefined) return cached;
      return { sessionId: handle.id, endedAt: Date.now(), reason: "unknown", stats: { turnCount: 0, toolCallCount: 0, errorCount: 0, tokens: { input: 0, output: 0, total: 0 } }, hadForcedKill: false };
    }
    const result = await session.close(options);
    this.#retire(handle.id, result);
    return result;
  }

  status(handle: SessionHandle): SessionStatus {
    const session = this.#sessions.get(handle.id);
    if (session !== undefined) return session.status;
    const cached = this.#closedResults.get(handle.id);
    return { state: "closed", reason: cached?.reason ?? "unknown" };
  }

  subscribe(handle: SessionHandle, listener: (event: SessionEvent) => void): Unsubscribe {
    const session = this.#sessions.get(handle.id);
    if (session === undefined) return () => {};
    return session.subscribe(listener);
  }

  async compact(handle: SessionHandle, hint?: CompactHint): Promise<CompactOutcome> {
    return this.#must(handle).compact(hint);
  }

  async contextUsage(handle: SessionHandle): Promise<ContextUsage> {
    return this.#must(handle).contextUsage();
  }

  async resumeSession(handle: SessionHandle, target: SessionResumeTarget): Promise<void> {
    return this.#must(handle).resume(target);
  }

  async isolationSelfCheck(handle: SessionHandle): Promise<IsolationSelfCheckResult> {
    return this.#must(handle).isolationSelfCheck();
  }

  #must(handle: SessionHandle): CodexSession {
    const session = this.#sessions.get(handle.id);
    if (session === undefined) {
      throw new RuntimeErrorImpl({ kind: "permanent", subKind: "closed_session", providerId: PROVIDER, sessionId: handle.id });
    }
    return session;
  }
}

export const codexRuntimeFactory: AgentRuntimeFactory = {
  create(options: AgentRuntimeOptions): AgentRuntime {
    return new CodexRuntime(options);
  },
};
