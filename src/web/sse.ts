/**
 * Realtime observation push: file watching + one-way server-side SSE.
 *
 * Implementation: fs.watch + debounce + a fallback reconcile (periodic stat / re-read). A detail connection tracks
 * each file's offset; on file change → readStreamFrom incremental read → push *_append; line-boundary discipline is
 * guaranteed by the reader (never sends a half-written line). When all connections close, the task's watch group is torn down.
 */
import { existsSync } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { readFile, readdir } from "node:fs/promises";

import type { FastifyReply } from "fastify";

import type { TaskCapsulePaths } from "../shared/index.js";
import { readStreamFrom, tailStreamLines } from "./streamReader.js";
import {
  listStreamFiles,
  listTaskSummaries,
  loadManifest,
  probeHostOnline,
  readConversation,
  readEvents,
  streamFilePath,
  type StreamAgent,
} from "./readService.js";

const DEBOUNCE_MS = 120;
const RECONCILE_MS = 2000;
const SNAPSHOT_TAIL = 200;

/** SSE writer: serializes events into SSE frames. */
export interface SseSink {
  send(event: string, data: unknown): void;
  close(): void;
  /** Register a connection-close callback. */
  onClose(fn: () => void): void;
}

/** Wrap a fastify raw response as an SSE sink. */
export function makeSseSink(reply: FastifyReply): SseSink {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  let closed = false;
  const closeCbs: Array<() => void> = [];
  const fire = (): void => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) {
      try {
        cb();
      } catch {
        // ignore
      }
    }
  };
  res.on("close", fire);
  res.on("error", fire);
  return {
    send(event, data) {
      if (closed) return;
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        fire();
      }
    },
    close() {
      if (closed) return;
      try {
        res.end();
      } catch {
        // ignore
      }
      fire();
    },
    onClose(fn) {
      if (closed) fn();
      else closeCbs.push(fn);
    },
  };
}

/** Simple debounce: coalesce multiple triggers within a short window. */
function debounce(fn: () => void, ms: number): { trigger: () => void; cancel: () => void } {
  let timer: NodeJS.Timeout | null = null;
  return {
    trigger() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

const STREAM_DIR_OF: Readonly<Record<StreamAgent, (p: TaskCapsulePaths) => string>> = {
  meta: (p) => p.metaStreamsDir,
  worker: (p) => p.workerStreamsDir,
  watcher: (p) => p.watcherStreamsDir,
  reviewer: (p) => p.reviewerStreamsDir,
};

/**
 * Task-detail-level push: watch manifest / conversation / events + the stream for the current tab.
 * Watches conversation / events / stream and pushes *_append increments; stage changes are pushed via the manifest watch.
 */
export function startDetailStream(opts: {
  sink: SseSink;
  paths: TaskCapsulePaths;
  agent: StreamAgent;
  /** Currently selected stream filename (the frontend swaps connections when changing tabs). */
  streamFile?: string;
}): void {
  const { sink, paths, agent } = opts;
  const watchers: FSWatcher[] = [];
  const timers: NodeJS.Timeout[] = [];
  let streamOffset = 0;
  let lastEventTs = "";
  let convLen = 0;
  let lastStage = "";
  let lastHostOnline: boolean | null = null;
  let lastStatusMd: string | null = null;
  const knownStreamFiles = new Set<string>();
  let streamFilesInit = false;
  // Connection-closed flag: the hydrate IIFE registers the stream watcher only after several awaits; if the connection
  // already dropped during that window, do not register it (prevents a leaked watcher handle).
  let closed = false;

  // An explicit streamFile goes through streamFilePath for the same path-safety check as the REST read side (prevents
  // ../, backslash, or absolute-path out-of-bounds reads); invalid → ignore and fall back to the "latest stream file"
  // resolution in hydrate below. Unspecified (the stream tab does not send `file` by default) also falls back to latest.
  let streamPath: string | undefined;
  if (opts.streamFile !== undefined && opts.streamFile.length > 0) {
    try {
      streamPath = streamFilePath(paths, agent, opts.streamFile);
    } catch {
      streamPath = undefined; // invalid (empty string also rejected by the check) → fall back to latest resolution
    }
  }

  // Advance the stream offset to the current EOF initially — the frontend fetches initial content via REST when a tab
  // is selected, and SSE only pushes stream_append increments; so no initial snapshot is sent (avoids duplicating the
  // REST initial), but the offset must be initialized or the first increment would resend the entire file.
  async function initStreamOffset(): Promise<void> {
    if (streamPath === undefined) return;
    const res = await tailStreamLines(streamPath, SNAPSHOT_TAIL);
    streamOffset = res.nextOffset;
  }
  async function pushStreamIncrement(): Promise<void> {
    if (streamPath === undefined) return;
    try {
      const res = await readStreamFrom(streamPath, streamOffset);
      if (res.lines.length > 0) {
        streamOffset = res.nextOffset;
        sink.send("stream_append", { tab: agent, lines: res.lines });
      }
    } catch {
      sink.send("lag", {});
    }
  }
  async function pushConversation(initial: boolean): Promise<void> {
    try {
      const rows = await readConversation(paths);
      if (initial) {
        convLen = rows.length; // only initialize the cursor; the frontend fetches initial content via REST
      } else if (rows.length > convLen) {
        const fresh = rows.slice(convLen);
        convLen = rows.length;
        sink.send("conversation_append", { rows: fresh });
      }
    } catch {
      sink.send("lag", {});
    }
  }
  async function pushEvents(initial: boolean): Promise<void> {
    try {
      const rows = await readEvents(paths, initial ? undefined : lastEventTs);
      if (rows.length > 0) {
        const last = rows[rows.length - 1];
        if (last !== undefined) lastEventTs = last.ts;
      }
      // On initial, only advance the cursor (the frontend fetches initial events via REST); push increments only when there are new rows.
      if (!initial && rows.length > 0) sink.send("event_append", { events: rows });
    } catch {
      sink.send("lag", {});
    }
  }
  async function pushStageAndHost(initial: boolean): Promise<void> {
    try {
      const m = await loadManifest(paths);
      if (initial || m.stage !== lastStage) {
        lastStage = m.stage;
        sink.send("stage", { stage: m.stage });
      }
    } catch {
      // fail-soft
    }
    const online = await probeHostOnline(paths);
    if (initial || online !== lastHostOnline) {
      lastHostOnline = online;
      sink.send("host_status", { online });
    }
  }
  // status.md change push: on initial, only set the baseline (the frontend fetches initial statusMd via REST); push status_md only on change.
  async function pushStatusMd(initial: boolean): Promise<void> {
    let content: string;
    try {
      content = await readFile(paths.statusMd, "utf8");
    } catch {
      return; // not yet rendered → fail-soft
    }
    if (initial) {
      lastStatusMd = content;
      return;
    }
    if (content !== lastStatusMd) {
      lastStatusMd = content;
      sink.send("status_md", { content });
    }
  }
  // New stream-file detection: when a new session stream file appears in the agent stream directory → notify the
  // frontend to switch to the latest source. The first pass only registers existing files (not treated as new);
  // afterward only genuinely new files are pushed.
  async function checkNewStreamFiles(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(STREAM_DIR_OF[agent](paths));
    } catch {
      return; // directory missing etc. → fail-soft
    }
    const fresh = files.filter((f) => f.endsWith(".jsonl") && !knownStreamFiles.has(f));
    for (const f of fresh) knownStreamFiles.add(f);
    if (streamFilesInit) for (const f of fresh) sink.send("new_stream_file", { path: f });
    streamFilesInit = true;
  }

  const dStream = debounce(() => void pushStreamIncrement(), DEBOUNCE_MS);
  const dConv = debounce(() => void pushConversation(false), DEBOUNCE_MS);
  const dEvents = debounce(() => void pushEvents(false), DEBOUNCE_MS);
  const dStage = debounce(() => void pushStageAndHost(false), DEBOUNCE_MS);

  function tryWatch(path: string, onChange: () => void): void {
    if (!existsSync(path)) return;
    try {
      const w = watch(path, () => onChange());
      // The watched target may be deleted / inaccessible (e.g. task deletion triggers Windows EPERM) → FSWatcher emits
      // 'error'; must be caught, otherwise an uncaught 'error' event crashes the whole web process. fail-soft: close
      // this watcher and rely on reconcile / lag as the fallback.
      w.on("error", () => {
        try { w.close(); } catch { /* ignore */ }
      });
      watchers.push(w);
    } catch {
      // fail-soft: if watching fails, reconcile is the fallback
    }
  }

  const dStatus = debounce(() => void pushStatusMd(false), DEBOUNCE_MS);

  // Initial hydrate (only sets incremental cursors / baselines; the frontend fetches initial content via REST)
  void (async () => {
    await pushStageAndHost(true);
    await pushConversation(true);
    await pushEvents(true);
    await pushStatusMd(true);
    await checkNewStreamFiles();
    // Resolve the stream file: if not explicitly specified → take this agent's latest (listStreamFiles is mtime ascending, so the last item is newest).
    if (streamPath === undefined) {
      const files = await listStreamFiles(paths, agent);
      const latest = files[files.length - 1];
      if (latest !== undefined) streamPath = streamFilePath(paths, agent, latest.file);
    }
    await initStreamOffset();
    // Register the stream-file watcher only *after* initStreamOffset (offset already at EOF), to avoid the watch firing
    // before offset initialization and triggering pushStreamIncrement with offset=0 (which would resend the whole
    // file). The closed guard: if the connection dropped during hydrate, do not register (otherwise this watcher
    // misses onClose cleanup and leaks); the synchronous check has no await interleaving, so it is safe.
    if (!closed && streamPath !== undefined) tryWatch(streamPath, () => dStream.trigger());
  })().catch(() => {
    // hydrate fail-soft: a non-ENOENT IO error from initStreamOffset etc. must not become an unhandled rejection (a
    // long-running server with --unhandled-rejections=strict could exit); reconcile is the fallback and the frontend
    // re-hydrates via lag.
    sink.send("lag", {});
  });

  // Watchers (the stream-file watcher is registered inside the hydrate IIFE after offset initialization)
  tryWatch(paths.conversationJsonl, () => dConv.trigger());
  tryWatch(paths.eventsPath, () => dEvents.trigger());
  tryWatch(paths.manifestPath, () => dStage.trigger());
  tryWatch(paths.statusMd, () => dStatus.trigger());
  tryWatch(STREAM_DIR_OF[agent](paths), () => void checkNewStreamFiles());

  // Fallback reconcile + heartbeat + host status
  timers.push(
    setInterval(() => {
      void pushStreamIncrement();
      void pushConversation(false);
      void pushEvents(false);
      void pushStageAndHost(false);
      void pushStatusMd(false);
      void checkNewStreamFiles();
      sink.send("ping", {});
    }, RECONCILE_MS),
  );

  sink.onClose(() => {
    closed = true;
    for (const w of watchers) w.close();
    for (const t of timers) clearInterval(t);
    dStream.cancel();
    dConv.cancel();
    dEvents.cancel();
    dStage.cancel();
    dStatus.cancel();
  });
}

/**
 * Task-list-level push: watch the tasks/ directory + periodic re-list.
 * Periodically diffs listTaskSummaries and pushes a list snapshot (no precise incremental diff).
 */
export function startListStream(opts: { sink: SseSink; projectRoot: string; tasksRoot: string }): void {
  const { sink, projectRoot, tasksRoot } = opts;
  const timers: NodeJS.Timeout[] = [];
  const watchers: FSWatcher[] = [];
  let lastSig = "";

  async function pushList(): Promise<void> {
    try {
      const tasks = await listTaskSummaries(projectRoot);
      const sig = tasks.map((t) => `${t.taskId}:${t.stage}:${t.updatedAt}`).join("|");
      if (sig !== lastSig) {
        lastSig = sig;
        sink.send("task_list", { tasks });
      }
    } catch {
      sink.send("lag", {});
    }
  }

  const d = debounce(() => void pushList(), DEBOUNCE_MS);
  void pushList();

  if (existsSync(tasksRoot)) {
    try {
      const w = watch(tasksRoot, () => d.trigger());
      // Catch FSWatcher 'error' (watched target inaccessible etc.) → fail-soft close, rely on periodic reconcile, do not crash the process.
      w.on("error", () => {
        try { w.close(); } catch { /* ignore */ }
      });
      watchers.push(w);
    } catch {
      // fail-soft
    }
  }
  timers.push(
    setInterval(() => {
      void pushList();
      sink.send("ping", {});
    }, RECONCILE_MS),
  );

  sink.onClose(() => {
    for (const w of watchers) w.close();
    for (const t of timers) clearInterval(t);
    d.cancel();
  });
}
