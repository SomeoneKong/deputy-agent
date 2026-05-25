/**
 * JSON-RPC-over-stdio subprocess client for the Codex app-server.
 *
 * Spawns `codex app-server` (spawn is injectable; defaults to a real spawn); reads/writes
 * newline-delimited JSON; pairs requests to responses by `id`; dispatches notifications
 * (to the session normalizer) and server-requests (which require a response: item/tool/call is
 * routed to the host tool handler, approvals are auto-approved per the automation policy).
 *
 * One client maps to one app-server subprocess, reused across multiple threads in the same
 * capsule. Subprocess exit / signal / broken stdio is surfaced to the session via onExit.
 */
import type { AppServerProcess, SpawnArgs, CodexSpawnFn } from "./config.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonValue,
  RequestId,
  ServerInbound,
} from "./protocol.js";
import { SERVER_REQUEST_METHODS } from "./protocol.js";

export interface AppServerClientHooks {
  /** server-to-client notification (thread/turn/item events, etc). Routing by threadId to the session normalizer happens at a higher layer. */
  readonly onNotification: (method: string, params: JsonValue) => void;
  /**
   * server-to-client request that requires a response. Return a result (resolve) or throw (becomes a JSON-RPC error response).
   * item/tool/call is routed to the host handler; approvals are auto-approved; others default to a not-applicable error.
   */
  readonly onServerRequest: (method: string, params: JsonValue) => Promise<JsonValue>;
  /** Subprocess exit / signal / broken stdio. code/signal are provided for diagnostics. */
  readonly onExit: (info: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => void;
}

interface PendingCall {
  resolve: (result: JsonValue) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AppServerClient {
  readonly #child: AppServerProcess;
  readonly #hooks: AppServerClientHooks;
  readonly #rpcTimeoutMs: number;
  readonly #pending = new Map<RequestId, PendingCall>();
  #nextId = 1;
  #buf = "";
  #exited = false;
  /** Ring buffer of the stderr tail. stderr must be consumed, otherwise the pipe fills up and the subprocess deadlocks on write(2); the tail is retained for exit diagnostics. */
  #stderrTail = "";
  static readonly #STDERR_TAIL_MAX = 8 * 1024;

  private constructor(child: AppServerProcess, hooks: AppServerClientHooks, rpcTimeoutMs: number) {
    this.#child = child;
    this.#hooks = hooks;
    this.#rpcTimeoutMs = rpcTimeoutMs;
    this.#wire();
  }

  /** Spawn the app-server subprocess and create a client. Spawn errors (e.g. ENOENT) are caught and classified by the caller. */
  static spawn(spawnFn: CodexSpawnFn, args: SpawnArgs, hooks: AppServerClientHooks, rpcTimeoutMs: number): AppServerClient {
    const child = spawnFn(args);
    return new AppServerClient(child, hooks, rpcTimeoutMs);
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get exited(): boolean {
    return this.#exited;
  }

  /** The stderr tail (bounded; for exit diagnostics). */
  get stderrTail(): string {
    return this.#stderrTail;
  }

  #wire(): void {
    this.#child.stdout.setEncoding?.("utf8");
    this.#child.stdout.on("data", (chunk: string | Buffer) => {
      this.#buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.#drainLines();
    });
    // stderr must be consumed (otherwise the OS pipe buffer fills, the subprocess blocks, stops
    // producing stdout, and all RPCs deadlock on timeout). Collect a bounded tail for exit
    // diagnostics; skip when there is no stderr (a fake may inject null).
    const stderr = this.#child.stderr;
    if (stderr !== null) {
      stderr.setEncoding?.("utf8");
      stderr.on("data", (chunk: string | Buffer) => {
        this.#stderrTail += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (this.#stderrTail.length > AppServerClient.#STDERR_TAIL_MAX) {
          this.#stderrTail = this.#stderrTail.slice(this.#stderrTail.length - AppServerClient.#STDERR_TAIL_MAX);
        }
      });
      stderr.on("error", () => {
        /* stderr stream errors are non-fatal (diagnostic only; the main routing does not depend on it) */
      });
    }
    this.#child.on("exit", (code, signal) => {
      this.#onExit({ code, signal });
    });
    this.#child.on("error", (err) => {
      this.#onExit({ code: null, signal: null, error: err });
    });
  }

  #onExit(info: { code: number | null; signal: NodeJS.Signals | null; error?: Error }): void {
    if (this.#exited) return;
    this.#exited = true;
    // Reject all pending calls (the subprocess is dead; requests will never return).
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`codex app-server exited before response (code=${info.code} signal=${info.signal})`));
    }
    this.#pending.clear();
    this.#hooks.onExit(info);
  }

  static readonly #BUF_MAX = 64 * 1024 * 1024;

  #drainLines(): void {
    // Guard against unbounded single-frame growth: an oversized stream with no newline (>64MB) is
    // treated as a protocol violation -> kill + onExit (which rejects pending calls).
    if (this.#buf.length > AppServerClient.#BUF_MAX) {
      this.#buf = "";
      this.kill();
      this.#onExit({ code: null, signal: null, error: new Error("codex app-server stdout frame exceeded 64MB without newline") });
      return;
    }
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (line.length === 0) continue;
      let msg: ServerInbound;
      try {
        msg = JSON.parse(line) as ServerInbound;
      } catch {
        // Non-JSON line (e.g. app-server occasionally leaking stderr into stdout) -> ignore, do not pollute pairing.
        continue;
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg: ServerInbound): void {
    // Response (has id + result/error, no method).
    if ("id" in msg && !("method" in msg) && ("result" in msg || "error" in msg)) {
      this.#resolveResponse(msg as JsonRpcResponse);
      return;
    }
    // server-to-client request (has id + method) -> requires a response.
    if ("id" in msg && "method" in msg) {
      void this.#handleServerRequest(msg as JsonRpcRequest);
      return;
    }
    // Notification (method, no id).
    if ("method" in msg) {
      const n = msg as JsonRpcNotification;
      this.#hooks.onNotification(n.method, n.params ?? null);
      return;
    }
    // Malformed frame: has an id matching a pending call but neither result nor error -> reject that pending call immediately (do not wait for the timeout).
    if ("id" in msg) {
      const m = msg as { id: RequestId };
      const pending = this.#pending.get(m.id);
      if (pending !== undefined) {
        this.#pending.delete(m.id);
        clearTimeout(pending.timer);
        pending.reject(new Error(`codex malformed response frame (id=${String(m.id)}; no result/error)`));
      }
      return;
    }
    // Unrecognized frame: ignore (does not affect pairing).
  }

  #resolveResponse(res: JsonRpcResponse): void {
    const pending = this.#pending.get(res.id);
    if (pending === undefined) return;
    this.#pending.delete(res.id);
    clearTimeout(pending.timer);
    if ("error" in res) {
      const e = res.error;
      pending.reject(Object.assign(new Error(e.message), { code: e.code, data: e.data }));
    } else {
      pending.resolve(res.result);
    }
  }

  async #handleServerRequest(req: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.#hooks.onServerRequest(req.method, req.params ?? null);
      this.#send({ jsonrpc: "2.0", id: req.id, result });
    } catch (err) {
      const e = err as { message?: string };
      this.#send({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: e.message ?? "server request handler error" } });
    }
  }

  /** Send a request and await its response (paired by id; rejects on timeout). */
  request<R = JsonValue>(method: string, params?: JsonValue): Promise<R> {
    if (this.#exited) {
      return Promise.reject(new Error(`codex app-server already exited; cannot send ${method}`));
    }
    const id = this.#nextId++;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`codex rpc timeout for ${method} (id=${id})`));
      }, this.#rpcTimeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve: resolve as (r: JsonValue) => void, reject, timer });
      this.#send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  #send(obj: JsonRpcRequest | JsonRpcResponse): void {
    if (this.#exited) return;
    try {
      this.#child.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch {
      // stdin write failed (subprocess dead) -> the exit path will reject pending calls.
    }
  }

  /** Force-kill the subprocess. */
  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    try {
      this.#child.kill(signal);
    } catch {
      /* best-effort */
    }
  }
}

/** Whether a server-request method is an approval (auto-approved per the automation policy). */
export function isApprovalRequest(method: string): boolean {
  return (
    method === SERVER_REQUEST_METHODS.execCommandApproval ||
    method === SERVER_REQUEST_METHODS.applyPatchApproval ||
    method === SERVER_REQUEST_METHODS.commandExecutionRequestApproval ||
    method === SERVER_REQUEST_METHODS.fileChangeRequestApproval ||
    method === SERVER_REQUEST_METHODS.permissionsRequestApproval
  );
}
