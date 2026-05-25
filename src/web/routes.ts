/**
 * HTTP endpoint registration. All /api/* are protected by the two-layer validation (added in app.ts's onRequest hook).
 *
 * Write endpoints: delegate to cliBridge's in-process CLI invocation → consume CommandResult → JSON;
 *   CliError is mapped to an HTTP status by exitCode via sendError.
 * Read-only endpoints: pure filesystem reads (readService).
 * Streaming endpoints: long-lived SSE connections.
 */
import { createReadStream, existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { sendError } from "./httpError.js";
import { cliErrors, tasksRootOf, UPLOAD_MAX_BYTES, type EnsureHostRunningOpts } from "../cli/index.js";
import { readOrRenderStatusMd } from "../shared/index.js";
import {
  bridgeAnswer,
  bridgeCancel,
  bridgeDelete,
  bridgeDone,
  bridgeFeedback,
  bridgePause,
  bridgeRename,
  bridgeResume,
  bridgeSubmitComposite,
  bridgeUpload,
  type BridgeOpts,
  type SubmitAttachment,
} from "./cliBridge.js";
import {
  hostLogPath,
  isStreamAgent,
  listStreamFiles,
  listTaskSummaries,
  listWorkspaceTree,
  loadManifest,
  probeHostOnline,
  readAgentPrompt,
  readConversation,
  readEvents,
  readHostLogTail,
  resolvePaths,
  resolveUploadFile,
  resolveWorkspaceFile,
  streamFilePath,
} from "./readService.js";
import { readStreamFrom, tailStreamLines } from "./streamReader.js";
import { makeSseSink, startDetailStream, startListStream } from "./sse.js";
import { buildProvidersDto } from "./providers.js";

export interface RouteContext {
  readonly projectRoot: string;
  /** Inject ensureHostRunning (tests use no-spawn). */
  readonly spawnHost?: EnsureHostRunningOpts["spawnHost"];
  /** Upload temp directory prefix (used for orphan cleanup). */
  readonly tmpPrefix: string;
}

function bridgeOpts(ctx: RouteContext): BridgeOpts {
  return { projectRoot: ctx.projectRoot, ...(ctx.spawnHost !== undefined ? { spawnHost: ctx.spawnHost } : {}) };
}

function taskIdOf(req: FastifyRequest): string {
  return (req.params as { id: string }).id;
}

function requireBodyText(req: FastifyRequest): string {
  const b = req.body as { text?: unknown } | undefined;
  const t = b?.text;
  if (typeof t !== "string" || t.trim().length === 0) {
    throw cliErrors.argMissing("Please provide content", "empty text body");
  }
  return t;
}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  // ---- Self diagnostics ----
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/version", async () => ({ kernel: "0.0.0", web: "0.0.0" }));

  // ---- Task management ----
  app.get("/api/tasks", async (_req, reply) => {
    try {
      return await reply.send({ tasks: await listTaskSummaries(ctx.projectRoot) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Provider selection metadata for the new-task form: pure static derivation (reads no task data, depends on no host).
  app.get("/api/providers", async (_req, reply) => {
    try {
      return await reply.send(buildProvidersDto());
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/tasks/:id", async (req, reply) => {
    try {
      const paths = resolvePaths(ctx.projectRoot, taskIdOf(req));
      const manifest = await loadManifest(paths);
      const statusMd = await readOrRenderStatusMd(paths);
      const hostOnline = await probeHostOnline(paths);
      return await reply.send({ manifest, statusMd, hostOnline });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/tasks/:id/status.md", async (req, reply) => {
    try {
      const paths = resolvePaths(ctx.projectRoot, taskIdOf(req));
      const md = await readOrRenderStatusMd(paths);
      void reply.type("text/markdown; charset=utf-8");
      return await reply.send(md);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/tasks", async (req, reply) => {
    try {
      return await handleSubmit(req, reply, ctx);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete("/api/tasks/:id", (req, reply) =>
    writeAction(reply, () => bridgeDelete(bridgeOpts(ctx), taskIdOf(req))),
  );

  // ---- User-interaction writes ----
  app.post("/api/tasks/:id/answer", (req, reply) =>
    writeAction(reply, () => bridgeAnswer(bridgeOpts(ctx), taskIdOf(req), requireBodyText(req))),
  );
  app.post("/api/tasks/:id/feedback", (req, reply) =>
    writeAction(reply, () => bridgeFeedback(bridgeOpts(ctx), taskIdOf(req), requireBodyText(req))),
  );
  app.post("/api/tasks/:id/pause", (req, reply) =>
    writeAction(reply, () => bridgePause(bridgeOpts(ctx), taskIdOf(req))),
  );
  app.post("/api/tasks/:id/resume", (req, reply) =>
    writeAction(reply, () => bridgeResume(bridgeOpts(ctx), taskIdOf(req))),
  );
  app.post("/api/tasks/:id/done", (req, reply) =>
    writeAction(reply, () => bridgeDone(bridgeOpts(ctx), taskIdOf(req))),
  );
  app.post("/api/tasks/:id/cancel", (req, reply) => {
    const reason = (req.body as { reason?: unknown } | undefined)?.reason;
    return writeAction(reply, () =>
      bridgeCancel(bridgeOpts(ctx), taskIdOf(req), typeof reason === "string" ? reason : undefined),
    );
  });
  app.post("/api/tasks/:id/rename", (req, reply) => {
    const title = (req.body as { title?: unknown } | undefined)?.title;
    return writeAction(reply, () => {
      if (typeof title !== "string") throw cliErrors.invalidArgument("Please provide a task name", "missing title");
      return bridgeRename(bridgeOpts(ctx), taskIdOf(req), title);
    });
  });
  app.post("/api/tasks/:id/uploads", async (req, reply) => {
    try {
      return await handleSingleUpload(req, reply, ctx);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- Read-only data fetch ----
  app.get("/api/tasks/:id/conversation", async (req, reply) => {
    try {
      const paths = resolvePaths(ctx.projectRoot, taskIdOf(req));
      return await reply.send({ rows: await readConversation(paths) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/tasks/:id/events", async (req, reply) => {
    try {
      const paths = resolvePaths(ctx.projectRoot, taskIdOf(req));
      const since = (req.query as { since?: string }).since;
      return await reply.send({ events: await readEvents(paths, since) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/tasks/:id/streams/:agent", async (req, reply) => {
    try {
      const paths = resolvePaths(ctx.projectRoot, taskIdOf(req));
      const agent = (req.params as { agent: string }).agent;
      if (!isStreamAgent(agent)) throw cliErrors.taskIdInvalid(`unknown agent: ${agent}`);
      return await reply.send({ files: await listStreamFiles(paths, agent) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/tasks/:id/streams/:agent/:file", async (req, reply) => {
    try {
      const paths = resolvePaths(ctx.projectRoot, taskIdOf(req));
      const { agent, file } = req.params as { agent: string; file: string };
      if (!isStreamAgent(agent)) throw cliErrors.taskIdInvalid(`unknown agent: ${agent}`);
      const p = streamFilePath(paths, agent, file);
      const q = req.query as { tail?: string; beforeOffset?: string };
      const tail = q.tail !== undefined ? Number.parseInt(q.tail, 10) : 1000;
      const beforeOffset = q.beforeOffset !== undefined ? Number.parseInt(q.beforeOffset, 10) : undefined;
      const result =
        beforeOffset !== undefined
          ? await tailStreamLines(p, tail, { beforeOffset })
          : await tailStreamLines(p, tail);
      return await reply.send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/tasks/:id/files", async (req, reply) => {
    try {
      const paths = resolvePaths(ctx.projectRoot, taskIdOf(req));
      const q = req.query as { path?: string; render?: string };
      if (q.path === undefined) {
        return await reply.send({ tree: await listWorkspaceTree(paths) });
      }
      const abs = resolveWorkspaceFile(paths, q.path);
      if (q.render === "markdown") {
        const { readFile } = await import("node:fs/promises");
        void reply.type("text/markdown; charset=utf-8");
        return await reply.send(await readFile(abs, "utf8"));
      }
      return await streamFile(reply, abs);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/tasks/:id/uploads/:uploadId/:filename", async (req, reply) => {
    try {
      const paths = resolvePaths(ctx.projectRoot, taskIdOf(req));
      const { uploadId, filename } = req.params as { uploadId: string; filename: string };
      const abs = resolveUploadFile(paths, uploadId, filename);
      return await streamFile(reply, abs);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/tasks/:id/agent_prompts/:sessionId", async (req, reply) => {
    try {
      const paths = resolvePaths(ctx.projectRoot, taskIdOf(req));
      const sessionId = (req.params as { sessionId: string }).sessionId;
      void reply.type("text/markdown; charset=utf-8");
      return await reply.send(await readAgentPrompt(paths, sessionId));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/tasks/:id/host-log", async (req, reply) => {
    try {
      const paths = resolvePaths(ctx.projectRoot, taskIdOf(req));
      const q = req.query as { tail?: string; download?: string };
      if (q.download === "1") {
        void reply.type("text/plain; charset=utf-8");
        return await streamFile(reply, hostLogPath(paths), { allowMissing: true });
      }
      const tail = q.tail !== undefined ? Number.parseInt(q.tail, 10) : 500;
      void reply.type("text/plain; charset=utf-8");
      return await reply.send(await readHostLogTail(paths, tail));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- Realtime push ----
  app.get("/api/stream/tasks/:id", async (req, reply) => {
    try {
      const paths = resolvePaths(ctx.projectRoot, taskIdOf(req));
      const q = req.query as { agent?: string; file?: string };
      const agent = q.agent !== undefined && isStreamAgent(q.agent) ? q.agent : "meta";
      const sink = makeSseSink(reply);
      startDetailStream({ sink, paths, agent, ...(q.file !== undefined ? { streamFile: q.file } : {}) });
      return reply;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/stream/tasks", async (_req, reply) => {
    const sink = makeSseSink(reply);
    startListStream({ sink, projectRoot: ctx.projectRoot, tasksRoot: tasksRootOf(ctx.projectRoot) });
    return reply;
  });
}

/** Common wrapper for write actions: consume CommandResult → JSON; CliError mapped via sendError. */
async function writeAction(
  reply: FastifyReply,
  fn: () => Promise<{ message: string; warning?: string }>,
): Promise<FastifyReply> {
  try {
    const r = await fn();
    return await reply.send({
      ok: true,
      message: r.message,
      ...(r.warning !== undefined ? { warning: r.warning } : {}),
    });
  } catch (err) {
    return sendError(reply, err);
  }
}

async function streamFile(reply: FastifyReply, abs: string, opts?: { allowMissing?: boolean }): Promise<FastifyReply> {
  if (!existsSync(abs)) {
    if (opts?.allowMissing === true) return reply.send("");
    return sendError(reply, cliErrors.fileNotFound(abs));
  }
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200);
  try {
    await pipeline(createReadStream(abs), res);
  } catch {
    try {
      res.destroy();
    } catch {
      // ignore
    }
  }
  return reply;
}

// ---- multipart handling ----

interface MultipartFilePart {
  readonly type: "file";
  readonly fieldname: string;
  readonly filename: string;
  readonly file: NodeJS.ReadableStream;
}
interface MultipartFieldPart {
  readonly type: "field";
  readonly fieldname: string;
  readonly value: unknown;
}
type MultipartPart = MultipartFilePart | MultipartFieldPart;

interface MultipartSingleFile {
  readonly filename: string;
  readonly file: NodeJS.ReadableStream;
  readonly fields?: Record<string, unknown>;
}

/** Composite new-task submit endpoint: parse multipart (rawTask + optional taskId + files[]) → write temp files → composite bridge. */
async function handleSubmit(req: FastifyRequest, reply: FastifyReply, ctx: RouteContext): Promise<FastifyReply> {
  const tmpDir = await mkdtemp(join(tmpdir(), ctx.tmpPrefix));
  const attachments: SubmitAttachment[] = [];
  const failedInline: Array<{ filename: string; message: string }> = [];
  let rawTask: string | undefined;
  let taskId: string | undefined;
  let roleBindingsRaw: string | undefined;
  try {
    const parts = (req as unknown as { parts: () => AsyncIterableIterator<MultipartPart> }).parts();
    for await (const part of parts) {
      if (part.type === "file") {
        const saved = await saveTempFile(part.filename, part.file, tmpDir);
        if (saved.tooLarge) {
          failedInline.push({ filename: part.filename, message: "File too large; the system accepts at most 500 MB" });
        } else {
          attachments.push({ tempPath: saved.path, filename: sanitizeFilename(part.filename) });
        }
      } else {
        const val = part.value;
        if (part.fieldname === "rawTask") rawTask = typeof val === "string" ? val : String(val);
        else if (part.fieldname === "taskId") taskId = typeof val === "string" ? val : String(val);
        else if (part.fieldname === "roleBindings") roleBindingsRaw = typeof val === "string" ? val : String(val);
      }
    }
    if (rawTask === undefined || rawTask.trim().length === 0) {
      throw cliErrors.argMissing("Please provide a task description", "missing rawTask");
    }
    const roleProviders = parseRoleBindingsField(roleBindingsRaw);
    const result = await bridgeSubmitComposite(bridgeOpts(ctx), {
      rawTask,
      ...(taskId !== undefined && taskId.length > 0 ? { taskId } : {}),
      attachments,
      ...(roleProviders !== undefined ? { roleProviders } : {}),
    });
    void reply.code(201);
    return await reply.send({
      ok: true,
      taskId: result.taskId,
      message: result.message,
      ...(result.warning !== undefined ? { warning: result.warning } : {}),
      uploaded: result.uploaded,
      failed: [...failedInline, ...result.failed],
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Parse the multipart roleBindings text field: JSON `Partial<Record<AgentRole, { provider }>>` →
 * role→provider map (buildRoleBindings validates role / provider legality). Missing / empty → undefined;
 * invalid JSON / wrong shape → throw CliError(invalidArgument) → endpoint 400.
 */
function parseRoleBindingsField(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw cliErrors.invalidArgument("Invalid role provider selection format", "roleBindings JSON parse failed");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw cliErrors.invalidArgument("Invalid role provider selection format", "roleBindings not an object");
  }
  // null-proto: a JSON `{"__proto__":...}` is parsed as an own property and can be rejected by buildRoleBindings
  // validation (a plain object would route the key through the __proto__ setter and swallow it → malformed silently
  // treated as unselected and created with the default provider instead of returning 400).
  const out: Record<string, string> = Object.create(null);
  let any = false;
  for (const [role, cell] of Object.entries(parsed as Record<string, unknown>)) {
    if (cell === null || typeof cell !== "object") {
      throw cliErrors.invalidArgument("Invalid role provider selection format", `roleBindings.${role} not an object`);
    }
    const provider = (cell as Record<string, unknown>)["provider"];
    if (typeof provider !== "string") {
      throw cliErrors.invalidArgument("Invalid role provider selection format", `roleBindings.${role}.provider not a string`);
    }
    out[role] = provider;
    any = true;
  }
  return any ? out : undefined;
}

/** Append a single-file upload to a task: multipart single file → temp file → bridgeUpload. */
async function handleSingleUpload(req: FastifyRequest, reply: FastifyReply, ctx: RouteContext): Promise<FastifyReply> {
  const tmpDir = await mkdtemp(join(tmpdir(), ctx.tmpPrefix));
  try {
    const file = await (req as unknown as { file: () => Promise<MultipartSingleFile | undefined> }).file();
    if (file === undefined) throw cliErrors.argMissing("Please provide a file to upload", "no file in multipart");
    const note = extractFieldValue(file.fields?.["note"]);
    const saved = await saveTempFile(file.filename, file.file, tmpDir);
    if (saved.tooLarge) {
      // Single appended upload over the limit → overall 413
      void reply.code(413);
      return await reply.send({ ok: false, message: "File too large; the system accepts at most 500 MB" });
    }
    const r = await bridgeUpload(
      bridgeOpts(ctx),
      taskIdOf(req),
      saved.path,
      note !== undefined && note.length > 0 ? note : undefined,
    );
    return await reply.send({
      ok: true,
      message: r.message,
      ...(r.warning !== undefined ? { warning: r.warning } : {}),
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function extractFieldValue(field: unknown): string | undefined {
  if (field !== null && typeof field === "object" && "value" in field) {
    const v = (field as { value: unknown }).value;
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

/** Sanitize a filename: strip path separators / .. / control characters. */
function sanitizeFilename(name: string): string {
  let s = name.replace(/[\\/]/g, "_").replace(/\.\.+/g, "_").replace(/[\x00-\x1f\x7f]/g, "_");
  s = s.trim();
  if (s.length === 0 || s === "." || s === "..") s = "upload.bin";
  return s;
}

/**
 * Write a temp file while counting size: exceeding UPLOAD_MAX_BYTES → abort + tooLarge=true.
 * The sanitized filename is used as the temp filename (final path safety is enforced by the upload command).
 */
async function saveTempFile(
  filename: string,
  stream: NodeJS.ReadableStream,
  tmpDir: string,
): Promise<{ path: string; tooLarge: boolean }> {
  const dest = join(tmpDir, sanitizeFilename(filename));
  const ws = createWriteStream(dest);
  let bytes = 0;
  let tooLarge = false;
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > UPLOAD_MAX_BYTES) {
          tooLarge = true;
          (stream as unknown as { destroy: () => void }).destroy();
          ws.destroy();
          resolvePromise();
          return;
        }
        ws.write(chunk);
      });
      stream.on("end", () => {
        ws.end();
        resolvePromise();
      });
      stream.on("error", rejectPromise);
      ws.on("error", rejectPromise);
    });
  } catch {
    tooLarge = tooLarge || false;
  }
  return { path: dest, tooLarge };
}
