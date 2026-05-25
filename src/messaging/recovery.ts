/**
 * Message bus recovery after a crash.
 *
 * Two phases:
 * step 1 (holds messaging/.lock): clean .tmp_* -> try fold ->
 *   truncatePartialTail -> snapshot enqueued + scan for missing payloads ->
 *   clean orphans; on fold corruption, break into the quarantine branch.
 * step 2 (lock released): for missing-payload envelopes, appendFailedEvent +
 *   enqueue a host_event; in the state-quarantine branch, quarantineState +
 *   enqueue a host_event. Each API acquires the lock itself (the file lock is
 *   not reentrant within a process).
 *
 * Fail-soft: a single appendFailedEvent / enqueue failure does not abort the
 * whole recovery pass.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { CorruptJsonlError, MessagingStateCorrupted } from "../shared/errors.js";
import type { EnvelopeId } from "../shared/ids.js";
import { isValidEnvelopeId } from "../shared/ids.js";
import { jsonlIO } from "../shared/jsonl.js";
import { withLock } from "../shared/locks.js";
import type { TaskCapsulePaths } from "../shared/paths.js";

import { MessagingBusImpl } from "./bus.js";

const MESSAGING_STATE_CORRUPTED = "messaging_state_corrupted";
const MESSAGING_PAYLOAD_CORRUPTED = "messaging_payload_corrupted";

export type HostEventFailure =
  | { readonly reason: "state_quarantine" }
  | { readonly reason: "payload_missing"; readonly envId: EnvelopeId };

export interface RecoveryReport {
  readonly cleanedTmpDirs: ReadonlyArray<string>;
  readonly cleanedOrphanPayloads: ReadonlyArray<string>;
  readonly cleanupFailed: ReadonlyArray<string>;
  readonly skippedUnknownDirs: ReadonlyArray<string>;
  readonly stateQuarantined: boolean;
  readonly quarantinePath: string | null;
  readonly payloadCorruptedEnvIds: ReadonlyArray<EnvelopeId>;
  readonly hostEventEnvIds: ReadonlyArray<EnvelopeId>;
  readonly hostEventFailures: ReadonlyArray<HostEventFailure>;
  readonly failedToMarkPayloadCorrupted: ReadonlyArray<EnvelopeId>;
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function recoverAfterCrash(paths: TaskCapsulePaths): Promise<RecoveryReport> {
  const cleanedTmpDirs: string[] = [];
  const cleanedOrphanPayloads: string[] = [];
  const cleanupFailed: string[] = [];
  const skippedUnknownDirs: string[] = [];
  const payloadCorruptedEnvIds: EnvelopeId[] = [];
  const hostEventEnvIds: EnvelopeId[] = [];
  const hostEventFailures: HostEventFailure[] = [];
  const failedToMarkPayloadCorrupted: EnvelopeId[] = [];

  const payloadsRoot = paths.messagingPayloads;
  const bus = new MessagingBusImpl(paths);

  let stateCorrupt = false;
  const payloadMissing: EnvelopeId[] = [];

  // ---- step 1: locked section (clean tmp + fold + scan orphans + delete orphans) ----
  await withLock(paths.messagingLock, async () => {
    let entries: string[];
    try {
      entries = await readdir(payloadsRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") entries = [];
      else throw err;
    }

    // 1a. Clean leftover .tmp_* directories.
    for (const name of entries) {
      const child = join(payloadsRoot, name);
      if (!name.startsWith(".tmp_") || !(await isDir(child))) continue;
      await rm(child, { recursive: true, force: true }).catch(() => {});
      if (await isDir(child)) cleanupFailed.push(name);
      else cleanedTmpDirs.push(name);
    }

    // 1b. Try to fold.
    try {
      await bus.refreshLocked();
    } catch (err) {
      if (err instanceof CorruptJsonlError || err instanceof MessagingStateCorrupted) {
        stateCorrupt = true;
        return;
      }
      throw err;
    }

    // 1b'. Fold succeeded -> truncatePartialTail to stop a partial tail from becoming a corrupt interior line.
    await jsonlIO.truncatePartialTail(paths.messagingState).catch(() => {});

    // 1c. Snapshot enqueued env_ids and scan for missing payloads.
    const snapshot = bus.snapshotLocked();
    const failedEnvIds = new Set<EnvelopeId>();
    const enqueuedEnvIds = new Set<EnvelopeId>();
    for (const [eid, s] of snapshot) {
      enqueuedEnvIds.add(eid);
      if (s.failed) failedEnvIds.add(eid);
    }
    for (const eid of enqueuedEnvIds) {
      const pdir = paths.payloadDir(eid);
      const ok =
        (await isDir(pdir)) && (await isFile(paths.payloadJson(eid))) && (await isFile(paths.bodyMd(eid)));
      if (!ok) {
        // Skip already-failed envelopes so a second recovery stays idempotent.
        if (failedEnvIds.has(eid)) continue;
        payloadMissing.push(eid);
      }
    }

    // 1d. Clean orphan payloads (validly named env_id but not in enqueued state).
    for (const name of entries) {
      const child = join(payloadsRoot, name);
      if (!(await isDir(child))) continue;
      if (name.startsWith(".tmp_")) continue; // already cleaned in 1a
      if (!isValidEnvelopeId(name)) {
        skippedUnknownDirs.push(name);
        continue;
      }
      if (enqueuedEnvIds.has(name as EnvelopeId)) continue; // valid envelope, keep
      await rm(child, { recursive: true, force: true }).catch(() => {});
      if (await isDir(child)) cleanupFailed.push(name);
      else cleanedOrphanPayloads.push(name);
    }
  });

  // ---- step 2a: state-quarantine branch ----
  if (stateCorrupt) {
    const quarantinePath = await bus.quarantineState();
    try {
      const evId = await bus.enqueue({
        channel: "meta",
        kind: "host_event",
        from: "host",
        body:
          `messaging state.jsonl was corrupt and has been quarantined. ` +
          `Original moved to: ${quarantinePath}. ` +
          `Existing payloads/ entries are preserved for audit but will not be re-delivered.`,
        extras: {
          eventKind: MESSAGING_STATE_CORRUPTED,
          details: { quarantinePath: quarantinePath ?? "" },
        },
      });
      hostEventEnvIds.push(evId);
    } catch {
      hostEventFailures.push({ reason: "state_quarantine" });
    }
    return {
      cleanedTmpDirs,
      cleanedOrphanPayloads,
      cleanupFailed,
      skippedUnknownDirs,
      stateQuarantined: true,
      quarantinePath,
      payloadCorruptedEnvIds,
      hostEventEnvIds,
      hostEventFailures,
      failedToMarkPayloadCorrupted,
    };
  }

  // ---- step 2b: missing-payload branch ----
  for (const eid of payloadMissing) {
    try {
      await bus.appendFailedEvent(eid, {
        errorKind: MESSAGING_PAYLOAD_CORRUPTED,
        errorMessage: `payload missing or incomplete for env_id=${eid}`,
      });
    } catch {
      failedToMarkPayloadCorrupted.push(eid);
      continue;
    }
    payloadCorruptedEnvIds.push(eid);
    try {
      const evId = await bus.enqueue({
        channel: "meta",
        kind: "host_event",
        from: "host",
        body: `messaging payload for env_id=${eid} is missing or incomplete; envelope marked failed and will not be re-delivered.`,
        extras: { eventKind: MESSAGING_PAYLOAD_CORRUPTED, details: { envId: eid } },
      });
      hostEventEnvIds.push(evId);
    } catch {
      hostEventFailures.push({ reason: "payload_missing", envId: eid });
    }
  }

  return {
    cleanedTmpDirs,
    cleanedOrphanPayloads,
    cleanupFailed,
    skippedUnknownDirs,
    stateQuarantined: false,
    quarantinePath: null,
    payloadCorruptedEnvIds,
    hostEventEnvIds,
    hostEventFailures,
    failedToMarkPayloadCorrupted,
  };
}
