/**
 * Message bus implementation.
 *
 * Cross-process consistency: every state-mutating operation runs inside
 * `messaging/.lock`: refresh -> assign stateSeq -> append + fsync -> update the
 * in-memory cache. Read APIs also fold the full state under the lock and
 * assemble the returned snapshot outside it. The in-memory state is only a
 * cache; the source of truth is always state.jsonl + payloads/.
 *
 * stateSeq: folded under the lock as current max -> nextSeq = max + 1; no
 * separate persisted counter.
 */
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriter } from "../shared/atomic.js";
import {
  CorruptJsonlError,
  MessagingEnqueueFailed,
  MessagingPayloadCorrupted,
  MessagingStateCorrupted,
} from "../shared/errors.js";
import type { EnvelopeId, SessionId } from "../shared/ids.js";
import { genEnvelopeId, isValidEnvelopeId } from "../shared/ids.js";
import { jsonlIO } from "../shared/jsonl.js";
import { withLock } from "../shared/locks.js";
import type { TaskCapsulePaths } from "../shared/paths.js";
import type { Iso8601Us } from "../shared/timeUtils.js";
import { nowIso8601Us } from "../shared/timeUtils.js";

import type {
  Channel,
  Envelope,
  EnvelopeExtras,
  EnvelopeKind,
  PayloadExtrasFor,
} from "./envelope.js";
import { isKindAllowedForChannel, validateExtras } from "./envelope.js";
import {
  buildPayloadJson,
  extrasFromJson,
  extrasMatchToJsonKeys,
} from "./schema.js";
import type { EnvelopeState } from "./state.js";
import { compareOrderKey, envelopeOrderKey } from "./state.js";

const MESSAGING_PAYLOAD_CORRUPTED = "messaging_payload_corrupted";

// ---- API option / result types ----

export type EnqueueOptions<K extends EnvelopeKind = EnvelopeKind> = K extends EnvelopeKind
  ? {
      readonly channel: Channel;
      readonly kind: K;
      readonly from: string;
      readonly body: string;
      readonly nowIso?: Iso8601Us;
    } & (PayloadExtrasFor<K> extends null
      ? { readonly extras?: null }
      : { readonly extras: PayloadExtrasFor<K> })
  : never;

export interface PullOptions {
  readonly callerSessionId: SessionId;
  readonly includeRead?: boolean;
}

export interface PullEnvelope {
  readonly envId: EnvelopeId;
  readonly kind: EnvelopeKind;
  readonly from: string;
  readonly createdAt: Iso8601Us;
  readonly body: string;
  readonly extras: EnvelopeExtras | null;
  readonly read: boolean;
  readonly responded?: boolean;
}

export interface PullResult {
  readonly channel: Channel;
  readonly envelopes: ReadonlyArray<PullEnvelope>;
}

export interface MarkRespondedResult {
  readonly marked: ReadonlyArray<EnvelopeId>;
  readonly alreadyResponded: ReadonlyArray<EnvelopeId>;
  readonly notFound: ReadonlyArray<EnvelopeId>;
  readonly notWorkerChannel: ReadonlyArray<EnvelopeId>;
}

export interface InspectOptions {
  readonly envIds?: ReadonlyArray<EnvelopeId>;
  readonly maxEnvelopes?: number;
}

export interface WorkerEnvelopeStatus {
  readonly envId: EnvelopeId;
  readonly channel: Channel;
  readonly kind: EnvelopeKind;
  readonly from: string;
  readonly createdAt: Iso8601Us;
  readonly stateSeq: number;
  readonly read: boolean;
  readonly readBy: string | null;
  readonly responded: boolean;
  readonly respondedBy: string | null;
}

export interface InspectResult {
  readonly envelopes: ReadonlyArray<WorkerEnvelopeStatus>;
  readonly notFound: ReadonlyArray<EnvelopeId>;
  readonly notWorkerChannel: ReadonlyArray<EnvelopeId>;
}

export interface EnvelopeAnchor {
  readonly createdAt: Iso8601Us;
  readonly stateSeq: number;
}

export interface HasEnvelopeWithExtrasAfterOptions {
  readonly kind: EnvelopeKind;
  readonly extrasMatch: Readonly<Record<string, unknown>>;
  readonly since?: EnvelopeAnchor;
}

export interface AppendFailedOptions {
  readonly errorKind: string;
  readonly errorMessage: string;
}

export interface MessagingBus {
  enqueue<K extends EnvelopeKind>(opts: EnqueueOptions<K>): Promise<EnvelopeId>;
  pull(channel: Channel, opts: PullOptions): Promise<PullResult>;
  peekUnread(channel: Channel): Promise<ReadonlyArray<Envelope>>;
  markReadBatch(envIds: ReadonlyArray<EnvelopeId>, by: string): Promise<void>;
  markResponded(envIds: ReadonlyArray<EnvelopeId>, by: string): Promise<MarkRespondedResult>;
  inspectWorkerStatus(opts?: InspectOptions): Promise<InspectResult>;
  fold(): Promise<ReadonlyMap<EnvelopeId, EnvelopeState>>;
  latestEnvelopeId(channel: Channel): Promise<EnvelopeId | null>;
  hasEnvelopeOfKind(kind: EnvelopeKind): Promise<boolean>;
  findLatestEnvelopeAnchorOfKind(kind: EnvelopeKind): Promise<EnvelopeAnchor | null>;
  hasEnvelopeWithExtrasAfter(opts: HasEnvelopeWithExtrasAfterOptions): Promise<boolean>;
  appendFailedEvent(envId: EnvelopeId, opts: AppendFailedOptions): Promise<void>;
  quarantineState(): Promise<string | null>;
}

const READ_BY_PREFIXES = ["meta_session:", "watcher_session:", "worker_session:", "host_inject:"];
const RESPONDED_BY_PREFIXES = ["worker_session:", "meta_session:"];

function hasPrefix(by: string, prefixes: ReadonlyArray<string>): boolean {
  return prefixes.some((p) => by.startsWith(p));
}

export class MessagingBusImpl implements MessagingBus {
  private readonly paths: TaskCapsulePaths;
  /** In-memory fold cache; source of truth is always state.jsonl + payloads/. */
  private envelopes = new Map<EnvelopeId, EnvelopeState>();

  constructor(paths: TaskCapsulePaths) {
    this.paths = paths;
  }

  // ===== Public API =====

  async enqueue<K extends EnvelopeKind>(opts: EnqueueOptions<K>): Promise<EnvelopeId> {
    const o = opts as {
      channel: Channel;
      kind: K;
      from: string;
      body: string;
      nowIso?: Iso8601Us;
      extras?: EnvelopeExtras | null;
    };
    // Argument-contract violations throw TypeError (not recorded as errorKind).
    if (!isKindAllowedForChannel(o.channel, o.kind)) {
      throw new TypeError(`kind '${o.kind}' not allowed on channel '${o.channel}'`);
    }
    if (typeof o.from !== "string" || o.from.length === 0) {
      throw new TypeError(`from must be non-empty string, got ${JSON.stringify(o.from)}`);
    }
    if (typeof o.body !== "string") {
      throw new TypeError(`body must be string, got ${typeof o.body}`);
    }
    const extras = o.extras ?? null;
    validateExtras(o.kind, extras); // throws InvalidEnvelopeExtras on violation

    const envId = genEnvelopeId();
    const createdAt = o.nowIso ?? nowIso8601Us();

    try {
      await withLock(this.paths.messagingLock, async () => {
        await this.refreshLocked();
        const stateSeq = this.maxStateSeq() + 1;
        // Payload write happens inside the lock.
        await this.writePayloadAtomic(envId, o.channel, o.kind, o.from, createdAt, extras, o.body);
        await jsonlIO.appendLine(this.paths.messagingState, {
          type: "enqueued",
          ts: createdAt,
          env_id: envId,
          state_seq: stateSeq,
          channel: o.channel,
          kind: o.kind,
          from: o.from,
        });
        this.envelopes.set(envId, {
          envId,
          channel: o.channel,
          kind: o.kind,
          from: o.from,
          createdAt,
          stateSeq,
          read: false,
          readBy: null,
          responded: false,
          respondedBy: null,
          failed: false,
        });
      });
    } catch (err) {
      if (err instanceof CorruptJsonlError) {
        throw new MessagingStateCorrupted(`state.jsonl corrupt at enqueue: ${err.message}`, {
          details: { path: this.paths.messagingState },
          cause: err,
        });
      }
      if (err instanceof MessagingEnqueueFailed) throw err;
      throw new MessagingEnqueueFailed(`failed to enqueue envelope: ${(err as Error).message}`, {
        details: { envId },
        cause: err,
      });
    }
    return envId;
  }

  async pull(channel: Channel, opts: PullOptions): Promise<PullResult> {
    const includeRead = opts.includeRead ?? false;
    if (typeof opts.callerSessionId !== "string" || opts.callerSessionId.length === 0) {
      throw new TypeError("callerSessionId is required for pull (all channels)");
    }
    const byLabel = `${channel}_session:${opts.callerSessionId}`;

    const out = await withLock(this.paths.messagingLock, async () => {
      await this.refreshAtRead("pull");
      const candidates = this.sortedCandidates(channel, includeRead);
      const result: PullEnvelope[] = [];
      for (const s of candidates) {
        let body: string;
        let extras: EnvelopeExtras | null;
        try {
          body = await this.readBody(s.envId);
          extras = await this.readExtras(s.envId, s.kind);
        } catch (err) {
          if (err instanceof MessagingPayloadCorrupted) {
            if (channel === "worker") {
              await this.appendFailedLocked(s.envId, MESSAGING_PAYLOAD_CORRUPTED, err.message);
              continue;
            }
            throw err; // non-worker channel: propagate
          }
          throw err;
        }
        if (!s.read) {
          await this.appendReadLocked(s.envId, byLabel);
        }
        const env: PullEnvelope = {
          envId: s.envId,
          kind: s.kind,
          from: s.from,
          createdAt: s.createdAt,
          body,
          extras,
          read: s.read,
          ...(channel === "worker" ? { responded: s.responded } : {}),
        };
        result.push(env);
      }
      return result;
    });
    return { channel, envelopes: out };
  }

  async peekUnread(channel: Channel): Promise<ReadonlyArray<Envelope>> {
    return withLock(this.paths.messagingLock, async () => {
      await this.refreshAtRead("peekUnread");
      const candidates = this.sortedCandidates(channel, false);
      const out: Envelope[] = [];
      for (const s of candidates) {
        let body: string;
        let extras: EnvelopeExtras | null;
        try {
          body = await this.readBody(s.envId);
          extras = await this.readExtras(s.envId, s.kind);
        } catch (err) {
          if (err instanceof MessagingPayloadCorrupted) {
            if (channel === "worker") {
              await this.appendFailedLocked(s.envId, MESSAGING_PAYLOAD_CORRUPTED, err.message);
              continue;
            }
            throw err;
          }
          throw err;
        }
        out.push({
          envId: s.envId,
          channel: s.channel,
          kind: s.kind,
          from: s.from,
          createdAt: s.createdAt,
          body,
          extras,
        });
      }
      return out;
    });
  }

  async markReadBatch(envIds: ReadonlyArray<EnvelopeId>, by: string): Promise<void> {
    if (typeof by !== "string" || by.length === 0 || !hasPrefix(by, READ_BY_PREFIXES)) {
      throw new TypeError(`markReadBatch.by must start with one of ${READ_BY_PREFIXES.join(" / ")}, got ${JSON.stringify(by)}`);
    }
    // Silently skip invalid envIds so one bad id does not fail the whole batch.
    const valid = envIds.filter((e) => isValidEnvelopeId(e));
    await withLock(this.paths.messagingLock, async () => {
      await this.refreshAtRead("markReadBatch");
      for (const eid of valid) {
        const s = this.envelopes.get(eid);
        if (s === undefined || s.failed || s.read) continue; // idempotent
        await this.appendReadLocked(eid, by);
      }
    });
  }

  async markResponded(envIds: ReadonlyArray<EnvelopeId>, by: string): Promise<MarkRespondedResult> {
    if (typeof by !== "string" || by.length === 0 || !hasPrefix(by, RESPONDED_BY_PREFIXES)) {
      throw new TypeError(`markResponded.by must start with one of ${RESPONDED_BY_PREFIXES.join(" / ")}, got ${JSON.stringify(by)}`);
    }
    const marked: EnvelopeId[] = [];
    const alreadyResponded: EnvelopeId[] = [];
    const notFound: EnvelopeId[] = [];
    const notWorkerChannel: EnvelopeId[] = [];

    const valid: EnvelopeId[] = [];
    for (const eid of envIds) {
      if (isValidEnvelopeId(eid)) valid.push(eid);
      else notFound.push(eid);
    }

    await withLock(this.paths.messagingLock, async () => {
      await this.refreshAtRead("markResponded");
      const now = nowIso8601Us();
      for (const eid of valid) {
        const s = this.envelopes.get(eid);
        if (s === undefined || s.failed) {
          notFound.push(eid);
          continue;
        }
        if (s.channel !== "worker") {
          notWorkerChannel.push(eid);
          continue;
        }
        if (s.responded) {
          alreadyResponded.push(eid);
          continue;
        }
        const stateSeq = this.maxStateSeq() + 1;
        await jsonlIO.appendLine(this.paths.messagingState, {
          type: "responded",
          ts: now,
          env_id: eid,
          state_seq: stateSeq,
          by,
        });
        s.responded = true;
        s.respondedBy = by;
        marked.push(eid);
      }
    });
    return { marked, alreadyResponded, notFound, notWorkerChannel };
  }

  async inspectWorkerStatus(opts?: InspectOptions): Promise<InspectResult> {
    const maxEnvelopes = opts?.maxEnvelopes ?? 100;
    if (!Number.isInteger(maxEnvelopes) || maxEnvelopes <= 0) {
      throw new TypeError(`maxEnvelopes must be positive int, got ${JSON.stringify(maxEnvelopes)}`);
    }
    const notFound: EnvelopeId[] = [];
    const notWorkerChannel: EnvelopeId[] = [];
    let filterIds: EnvelopeId[] | null = null;
    if (opts?.envIds !== undefined) {
      filterIds = [];
      for (const eid of opts.envIds) {
        if (isValidEnvelopeId(eid)) filterIds.push(eid);
        else notFound.push(eid);
      }
    }

    const statuses = await withLock(this.paths.messagingLock, async () => {
      await this.refreshAtRead("inspectWorkerStatus");
      const out: WorkerEnvelopeStatus[] = [];
      if (filterIds !== null) {
        for (const eid of filterIds) {
          const s = this.envelopes.get(eid);
          if (s === undefined || s.failed) {
            notFound.push(eid);
            continue;
          }
          if (s.channel !== "worker") {
            notWorkerChannel.push(eid);
            continue;
          }
          out.push(this.statusOf(s));
        }
      } else {
        const pool = [...this.envelopes.values()].filter((s) => s.channel === "worker" && !s.failed);
        pool.sort((a, b) => compareOrderKey(envelopeOrderKey(a), envelopeOrderKey(b)));
        for (const s of pool.slice(0, maxEnvelopes)) out.push(this.statusOf(s));
      }
      return out;
    });
    return { envelopes: statuses, notFound, notWorkerChannel };
  }

  async fold(): Promise<ReadonlyMap<EnvelopeId, EnvelopeState>> {
    return withLock(this.paths.messagingLock, async () => {
      await this.refreshAtRead("fold");
      // Replace-not-mutate snapshot: caller edits do not affect the bus cache.
      const snap = new Map<EnvelopeId, EnvelopeState>();
      for (const [k, v] of this.envelopes) snap.set(k, { ...v });
      return snap;
    });
  }

  async latestEnvelopeId(channel: Channel): Promise<EnvelopeId | null> {
    const snap = await this.fold();
    let latestKey: readonly [Iso8601Us, number] | null = null;
    let latestId: EnvelopeId | null = null;
    for (const s of snap.values()) {
      if (s.channel !== channel || s.failed) continue;
      const key = envelopeOrderKey(s);
      if (latestKey === null || compareOrderKey(key, latestKey) > 0) {
        latestKey = key;
        latestId = s.envId;
      }
    }
    return latestId;
  }

  async hasEnvelopeOfKind(kind: EnvelopeKind): Promise<boolean> {
    return withLock(this.paths.messagingLock, async () => {
      await this.refreshAtRead("hasEnvelopeOfKind");
      for (const s of this.envelopes.values()) {
        if (s.kind === kind && !s.failed) return true;
      }
      return false;
    });
  }

  async findLatestEnvelopeAnchorOfKind(kind: EnvelopeKind): Promise<EnvelopeAnchor | null> {
    return withLock(this.paths.messagingLock, async () => {
      await this.refreshAtRead("findLatestEnvelopeAnchorOfKind");
      let latest: EnvelopeAnchor | null = null;
      let latestKey: readonly [Iso8601Us, number] | null = null;
      for (const s of this.envelopes.values()) {
        if (s.kind !== kind || s.failed) continue;
        const key = envelopeOrderKey(s);
        if (latestKey === null || compareOrderKey(key, latestKey) > 0) {
          latestKey = key;
          latest = { createdAt: s.createdAt, stateSeq: s.stateSeq };
        }
      }
      return latest;
    });
  }

  async hasEnvelopeWithExtrasAfter(opts: HasEnvelopeWithExtrasAfterOptions): Promise<boolean> {
    if (typeof opts.extrasMatch !== "object" || opts.extrasMatch === null || Object.keys(opts.extrasMatch).length === 0) {
      throw new TypeError("extrasMatch must be non-empty object");
    }
    const matchJson = extrasMatchToJsonKeys(opts.kind, opts.extrasMatch);
    const sinceKey: readonly [Iso8601Us, number] | null =
      opts.since !== undefined ? [opts.since.createdAt, opts.since.stateSeq] : null;

    // Collect candidate ids and read payloads under the lock for cross-process consistency.
    return withLock(this.paths.messagingLock, async () => {
      await this.refreshAtRead("hasEnvelopeWithExtrasAfter");
      const candidateIds: EnvelopeId[] = [];
      for (const s of this.envelopes.values()) {
        if (s.kind !== opts.kind || s.failed) continue;
        if (sinceKey !== null && compareOrderKey(envelopeOrderKey(s), sinceKey) <= 0) continue;
        candidateIds.push(s.envId);
      }
      for (const envId of candidateIds) {
        let rawExtras: Record<string, unknown> | null;
        try {
          rawExtras = await this.readRawExtras(envId);
        } catch (err) {
          if (err instanceof MessagingPayloadCorrupted) {
            // A single corrupt payload must not block the gate; log a warning for audit.
            console.warn(`hasEnvelopeWithExtrasAfter skipped corrupt payload env_id=${envId} kind=${opts.kind}: ${err.message}`);
            continue;
          }
          throw err;
        }
        if (rawExtras === null) continue;
        if (Object.entries(matchJson).every(([k, v]) => deepEqual(rawExtras[k], v))) return true;
      }
      return false;
    });
  }

  async appendFailedEvent(envId: EnvelopeId, opts: AppendFailedOptions): Promise<void> {
    if (!isValidEnvelopeId(envId)) throw new TypeError(`invalid envId: ${JSON.stringify(envId)}`);
    // Fail-fast on arguments to avoid refreshLocked treating the whole state as corrupt and triggering quarantine.
    if (typeof opts.errorKind !== "string" || opts.errorKind.length === 0) {
      throw new TypeError(`errorKind must be non-empty string, got ${JSON.stringify(opts.errorKind)}`);
    }
    if (typeof opts.errorMessage !== "string" || opts.errorMessage.length === 0) {
      throw new TypeError(`errorMessage must be non-empty string, got ${JSON.stringify(opts.errorMessage)}`);
    }
    await withLock(this.paths.messagingLock, async () => {
      await this.refreshAtRead("appendFailedEvent");
      await this.appendFailedLocked(envId, opts.errorKind, opts.errorMessage);
    });
  }

  async quarantineState(): Promise<string | null> {
    return withLock(this.paths.messagingLock, async () => {
      try {
        const dest = await jsonlIO.quarantine(this.paths.messagingState);
        this.envelopes = new Map();
        return dest;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    });
  }

  // ===== Internal helpers =====

  private maxStateSeq(): number {
    let max = 0;
    for (const s of this.envelopes.values()) if (s.stateSeq > max) max = s.stateSeq;
    return max;
  }

  private statusOf(s: EnvelopeState): WorkerEnvelopeStatus {
    return {
      envId: s.envId,
      channel: s.channel,
      kind: s.kind,
      from: s.from,
      createdAt: s.createdAt,
      stateSeq: s.stateSeq,
      read: s.read,
      readBy: s.readBy,
      responded: s.responded,
      respondedBy: s.respondedBy,
    };
  }

  private sortedCandidates(channel: Channel, includeRead: boolean): EnvelopeState[] {
    let candidates = [...this.envelopes.values()].filter((s) => s.channel === channel && !s.failed);
    // responded does not affect pull filtering; filter only by read.
    if (!includeRead) candidates = candidates.filter((s) => !s.read);
    candidates.sort((a, b) => compareOrderKey(envelopeOrderKey(a), envelopeOrderKey(b)));
    return candidates;
  }

  /** Append a read event and update the cache; caller must hold the lock. */
  private async appendReadLocked(envId: EnvelopeId, by: string): Promise<void> {
    const stateSeq = this.maxStateSeq() + 1;
    await jsonlIO.appendLine(this.paths.messagingState, {
      type: "read",
      ts: nowIso8601Us(),
      env_id: envId,
      state_seq: stateSeq,
      by,
    });
    const s = this.envelopes.get(envId);
    if (s !== undefined && !s.read) {
      s.read = true;
      s.readBy = by;
    }
  }

  /** Append a failed event and mark the envelope failed; caller must hold the lock. */
  private async appendFailedLocked(envId: EnvelopeId, errorKind: string, errorMessage: string): Promise<void> {
    const stateSeq = this.maxStateSeq() + 1;
    await jsonlIO.appendLine(this.paths.messagingState, {
      type: "failed",
      ts: nowIso8601Us(),
      env_id: envId,
      state_seq: stateSeq,
      error_kind: errorKind,
      error_message: errorMessage,
    });
    const s = this.envelopes.get(envId);
    if (s !== undefined) s.failed = true;
  }

  /** Refresh at a read-API entry point; maps CorruptJsonlError to MessagingStateCorrupted with the site name. */
  private async refreshAtRead(site: string): Promise<void> {
    try {
      await this.refreshLocked();
    } catch (err) {
      if (err instanceof CorruptJsonlError) {
        throw new MessagingStateCorrupted(`state.jsonl corrupt at ${site}: ${err.message}`, {
          details: { path: this.paths.messagingState },
          cause: err,
        });
      }
      throw err;
    }
  }

  /**
   * Fold the full state.jsonl to rebuild the in-memory state; caller must hold
   * the lock. A truncated final line is skipped by jsonlIO; a corrupt interior
   * line makes jsonlIO throw CorruptJsonlError.
   */
  async refreshLocked(): Promise<void> {
    const path = this.paths.messagingState;
    const next = new Map<EnvelopeId, EnvelopeState>();
    for await (const obj of jsonlIO.readLines(path)) {
      const ev = obj as Record<string, unknown>;
      const type = ev["type"];
      const envIdRaw = ev["env_id"];
      // env_id must be a valid 8-char hex id, so a corrupt schema fails here rather than later at path assembly.
      if (typeof envIdRaw !== "string" || !isValidEnvelopeId(envIdRaw)) {
        throw new CorruptJsonlError(`state event has invalid env_id: ${JSON.stringify(ev)}`, { details: { path } });
      }
      const envId = envIdRaw as EnvelopeId;
      const seq = ev["state_seq"];
      if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
        throw new CorruptJsonlError(`state event has invalid state_seq: ${JSON.stringify(ev)}`, { details: { path } });
      }
      if (type === "enqueued") {
        const channel = ev["channel"];
        const kind = ev["kind"];
        const ts = ev["ts"];
        const from = ev["from"];
        if (channel !== "meta" && channel !== "worker" && channel !== "watcher") {
          throw new CorruptJsonlError(`state enqueued event has invalid channel: ${JSON.stringify(ev)}`, { details: { path } });
        }
        if (typeof kind !== "string" || typeof ts !== "string" || ts.length === 0 || typeof from !== "string" || from.length === 0) {
          throw new CorruptJsonlError(`state enqueued event missing kind/ts/from: ${JSON.stringify(ev)}`, { details: { path } });
        }
        next.set(envId, {
          envId,
          channel,
          kind: kind as EnvelopeKind,
          from,
          createdAt: ts as Iso8601Us,
          stateSeq: seq,
          read: false,
          readBy: null,
          responded: false,
          respondedBy: null,
          failed: false,
        });
      } else if (type === "read") {
        const by = ev["by"];
        if (typeof by !== "string" || by.length === 0) {
          throw new CorruptJsonlError(`state read event missing by: ${JSON.stringify(ev)}`, { details: { path } });
        }
        const s = next.get(envId);
        if (s !== undefined) {
          s.read = true;
          s.readBy = by; // fold keeps the last event
        }
      } else if (type === "responded") {
        const by = ev["by"];
        if (typeof by !== "string" || by.length === 0) {
          throw new CorruptJsonlError(`state responded event missing by: ${JSON.stringify(ev)}`, { details: { path } });
        }
        const s = next.get(envId);
        if (s !== undefined) {
          s.responded = true;
          s.respondedBy = by;
        }
      } else if (type === "failed") {
        const errorKind = ev["error_kind"];
        const errorMessage = ev["error_message"];
        if (typeof errorKind !== "string" || errorKind.length === 0 || typeof errorMessage !== "string" || errorMessage.length === 0) {
          throw new CorruptJsonlError(`state failed event missing error_kind/error_message: ${JSON.stringify(ev)}`, { details: { path } });
        }
        const s = next.get(envId);
        if (s !== undefined) s.failed = true;
      } else {
        throw new CorruptJsonlError(`unknown state event type: ${JSON.stringify(type)}`, { details: { path } });
      }
    }
    this.envelopes = next;
  }

  /** Return the live in-memory state map by reference; caller must hold the lock (used by recovery step 1). */
  snapshotLocked(): ReadonlyMap<EnvelopeId, EnvelopeState> {
    return this.envelopes;
  }

  private async writePayloadAtomic(
    envId: EnvelopeId,
    channel: Channel,
    kind: EnvelopeKind,
    from: string,
    createdAt: Iso8601Us,
    extras: EnvelopeExtras | null,
    body: string,
  ): Promise<void> {
    const payloadsRoot = this.paths.messagingPayloads;
    const targetDir = this.paths.payloadDir(envId);
    let tmpDir: string | undefined;
    try {
      await mkdir(payloadsRoot, { recursive: true });
      // Use a .tmp_<envId>_ prefix for mkdtemp so recovery can scan for .tmp_*.
      tmpDir = await mkdtemp(join(payloadsRoot, `.tmp_${envId}_`));
      const payload = buildPayloadJson(envId, channel, kind, from, createdAt, extras);
      await atomicWriter.writeText(join(tmpDir, "payload.json"), JSON.stringify(payload));
      await atomicWriter.writeText(join(tmpDir, "body.md"), body);
      await rename(tmpDir, targetDir);
    } catch (err) {
      if (tmpDir !== undefined) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new MessagingEnqueueFailed(`failed to write payload for env_id=${envId}: ${(err as Error).message}`, {
        details: { envId, path: targetDir },
        cause: err,
      });
    }
  }

  private async readBody(envId: EnvelopeId): Promise<string> {
    const path = this.paths.bodyMd(envId);
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      throw new MessagingPayloadCorrupted(`body.md read error for env_id=${envId}: ${(err as Error).message}`, {
        details: { envId, path },
        cause: err,
      });
    }
  }

  private async readRawExtras(envId: EnvelopeId): Promise<Record<string, unknown> | null> {
    const path = this.paths.payloadJson(envId);
    let data: unknown;
    try {
      data = JSON.parse(await readFile(path, "utf8"));
    } catch (err) {
      throw new MessagingPayloadCorrupted(`payload.json read error for env_id=${envId}: ${(err as Error).message}`, {
        details: { envId, path },
        cause: err,
      });
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new MessagingPayloadCorrupted(`payload.json root must be object for env_id=${envId}`, {
        details: { envId, path },
      });
    }
    const extras = (data as Record<string, unknown>)["extras"];
    return extras === null || extras === undefined ? null : (extras as Record<string, unknown>);
  }

  private async readExtras(envId: EnvelopeId, kind: EnvelopeKind): Promise<EnvelopeExtras | null> {
    const raw = await this.readRawExtras(envId);
    return extrasFromJson(kind, raw);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

export function createMessagingBus(paths: TaskCapsulePaths): MessagingBus {
  return new MessagingBusImpl(paths);
}
