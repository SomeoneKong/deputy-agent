/**
 * Web backend: fastify instance assembly + startup.
 *
 * - loopback-only bind (fail-fast)
 * - two-layer request validation onRequest hook (all /api/*; writes and streams get extra Origin check)
 * - @fastify/multipart (uploads) + @fastify/static (frontend static assets)
 * - route registration (routes.ts)
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";

import { UPLOAD_MAX_BYTES, type EnsureHostRunningOpts } from "../cli/index.js";
import { registerRoutes, type RouteContext } from "./routes.js";
import { assertLoopbackBindHost, rejectIfUnsafe, STATE_CHANGING_METHODS } from "./security.js";

export interface WebServerOpts {
  readonly projectRoot: string;
  readonly host?: string;
  readonly port?: number;
  /** Inject ensureHostRunning (tests use no-spawn to avoid actually starting a host). */
  readonly spawnHost?: EnsureHostRunningOpts["spawnHost"];
  /** fastify logger toggle (off in tests). */
  readonly logger?: boolean;
}

const TMP_PREFIX = "sh-web-upload-";

/** Frontend static asset directory (src/web/static; dist/web/static after compile — must be copied during build). */
function staticDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "static");
}

/** Build (without listening) a fastify instance — tests use .inject(). */
export async function buildWebApp(opts: WebServerOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });

  await app.register(fastifyMultipart, { limits: { fileSize: UPLOAD_MAX_BYTES, files: 50 } });

  const dir = staticDir();
  if (existsSync(dir)) {
    await app.register(fastifyStatic, { root: dir, prefix: "/" });
  }

  // Two-layer request validation: all /api/* plus streaming long-lived connections.
  app.addHook("onRequest", async (req, reply) => {
    const url = req.url;
    if (!url.startsWith("/api/")) return;
    const isStream = url.startsWith("/api/stream/");
    const originCheck = STATE_CHANGING_METHODS.has(req.method) || isStream;
    if (rejectIfUnsafe(req, reply, { originCheck })) {
      return reply; // 403 already sent
    }
    return;
  });

  const ctx: RouteContext = {
    projectRoot: opts.projectRoot,
    tmpPrefix: TMP_PREFIX,
    ...(opts.spawnHost !== undefined ? { spawnHost: opts.spawnHost } : {}),
  };
  registerRoutes(app, ctx);

  return app;
}

/** Start the web server (loopback-only bind + listen). */
export async function startWebServer(opts: WebServerOpts): Promise<{
  app: FastifyInstance;
  url: string;
  close: () => Promise<void>;
}> {
  const host = opts.host ?? "127.0.0.1";
  assertLoopbackBindHost(host);
  const port = opts.port ?? 4319;

  const app = await buildWebApp({ ...opts, logger: opts.logger ?? true });
  await app.listen({ host, port });
  const addr = app.server.address();
  const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
  return { app, url: `http://${host}:${actualPort}`, close: () => app.close() };
}
