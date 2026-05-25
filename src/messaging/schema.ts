/**
 * Schema-aware conversion between snake_case physical JSON and camelCase TS.
 *
 * Conversion contract (not blindly deep-recursive):
 * - envelope top-level fields and the known fields of each extras interface are
 *   mapped explicitly per schema
 * - opaque inner dicts are not converted recursively: `HostEventExtras.details`,
 *   `ReviewerVerdictExtras.issues[]`, and `WorkerSessionEndExtras.doneCriteriaOutcome`
 *   keep the writer's original keys
 */
import type {
  Channel,
  EnvelopeExtras,
  EnvelopeKind,
  HostEventExtras,
  ReviewerVerdictExtras,
  UserUploadExtras,
  UserClarifyAnswerExtras,
  WatcherObservationExtras,
  WorkerCompletionClaimExtras,
  WorkerEscalationExtras,
  WorkerNotificationExtras,
  WorkerSessionEndExtras,
  WorkerStreamWindowExtras,
} from "./envelope.js";
import type { EnvelopeId, SessionId, UploadId } from "../shared/ids.js";
import type { Iso8601Us } from "../shared/timeUtils.js";

// ---- extras: camelCase TS → snake_case JSON ----

export function extrasToJson(kind: EnvelopeKind, extras: EnvelopeExtras | null): Record<string, unknown> | null {
  if (extras === null) return null;
  switch (kind) {
    case "user_upload": {
      const e = extras as UserUploadExtras;
      return { upload_id: e.uploadId, filename: e.filename, size_bytes: e.sizeBytes, uploaded_at: e.uploadedAt };
    }
    case "user_clarify_answer": {
      const e = extras as UserClarifyAnswerExtras;
      return { round: e.round };
    }
    case "worker_escalation": {
      const e = extras as WorkerEscalationExtras;
      return { worker_session_id: e.workerSessionId, session_seq: e.sessionSeq, exit_intent: e.exitIntent };
    }
    case "worker_notification":
    case "worker_completion_claim": {
      const e = extras as WorkerNotificationExtras | WorkerCompletionClaimExtras;
      return { worker_session_id: e.workerSessionId, session_seq: e.sessionSeq };
    }
    case "worker_session_end": {
      const e = extras as WorkerSessionEndExtras;
      return {
        worker_session_id: e.workerSessionId,
        session_seq: e.sessionSeq,
        exit_reason: e.exitReason,
        done_criteria_outcome: e.doneCriteriaOutcome, // opaque: not converted recursively
      };
    }
    case "watcher_observation": {
      const e = extras as WatcherObservationExtras;
      return { watcher_session_id: e.watcherSessionId, evidence_refs: [...e.evidenceRefs] };
    }
    case "reviewer_verdict": {
      const e = extras as ReviewerVerdictExtras;
      return {
        reviewer_phase: e.reviewerPhase,
        reviewer_round: e.reviewerRound,
        verdict: e.verdict,
        issues: e.issues.map((i) => ({ ...i })), // opaque elements: inner keys not converted recursively
      };
    }
    case "host_event": {
      const e = extras as HostEventExtras;
      return { event_kind: e.eventKind, details: { ...e.details } }; // details is opaque
    }
    case "worker_stream_window": {
      const e = extras as WorkerStreamWindowExtras;
      return {
        window_start: e.windowStart,
        window_end: e.windowEnd,
        worker_session_id: e.workerSessionId,
        stream_path: e.streamPath,
      };
    }
    default:
      // null-extras kinds (user_feedback / meta_instruction / meta_interrupt) already returned at extras===null
      return null;
  }
}

// ---- extras: snake_case JSON → camelCase TS ----

function asRecordOrNull(v: unknown): Readonly<Record<string, unknown>> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function extrasFromJson(kind: EnvelopeKind, raw: unknown): EnvelopeExtras | null {
  if (raw === null || raw === undefined) return null;
  const o = raw as Record<string, unknown>;
  switch (kind) {
    case "user_upload":
      return {
        uploadId: o["upload_id"] as UploadId,
        filename: o["filename"] as string,
        sizeBytes: o["size_bytes"] as number,
        uploadedAt: o["uploaded_at"] as Iso8601Us,
      } satisfies UserUploadExtras;
    case "user_clarify_answer":
      return { round: o["round"] as number } satisfies UserClarifyAnswerExtras;
    case "worker_escalation":
      return {
        workerSessionId: o["worker_session_id"] as SessionId,
        sessionSeq: o["session_seq"] as number,
        exitIntent: o["exit_intent"] as WorkerEscalationExtras["exitIntent"],
      } satisfies WorkerEscalationExtras;
    case "worker_notification":
      return {
        workerSessionId: o["worker_session_id"] as SessionId,
        sessionSeq: o["session_seq"] as number,
      } satisfies WorkerNotificationExtras;
    case "worker_completion_claim":
      return {
        workerSessionId: o["worker_session_id"] as SessionId,
        sessionSeq: o["session_seq"] as number,
      } satisfies WorkerCompletionClaimExtras;
    case "worker_session_end":
      return {
        workerSessionId: o["worker_session_id"] as SessionId,
        sessionSeq: o["session_seq"] as number,
        exitReason: o["exit_reason"] as string,
        doneCriteriaOutcome: asRecordOrNull(o["done_criteria_outcome"]),
      } satisfies WorkerSessionEndExtras;
    case "watcher_observation":
      return {
        watcherSessionId: o["watcher_session_id"] as SessionId,
        evidenceRefs: (o["evidence_refs"] as string[]) ?? [],
      } satisfies WatcherObservationExtras;
    case "reviewer_verdict":
      return {
        reviewerPhase: o["reviewer_phase"] as string,
        reviewerRound: o["reviewer_round"] as number,
        verdict: o["verdict"] as ReviewerVerdictExtras["verdict"],
        issues: (o["issues"] as Array<Record<string, unknown>>) ?? [],
      } satisfies ReviewerVerdictExtras;
    case "host_event":
      return {
        eventKind: o["event_kind"] as string,
        details: (asRecordOrNull(o["details"]) ?? {}) as Readonly<Record<string, unknown>>,
      } satisfies HostEventExtras;
    case "worker_stream_window":
      return {
        windowStart: o["window_start"] as Iso8601Us,
        windowEnd: o["window_end"] as Iso8601Us,
        workerSessionId: o["worker_session_id"] as SessionId,
        streamPath: o["stream_path"] as string,
      } satisfies WorkerStreamWindowExtras;
    default:
      return null;
  }
}

/**
 * Maps the camelCase keys of `hasEnvelopeWithExtrasAfter.extrasMatch` to the
 * target kind's snake_case keys. Unknown keys (not in the schema table) are kept
 * as-is so comparison resolves to "payload lacks the key -> no match".
 */
const EXTRAS_KEY_MAP: Readonly<Record<EnvelopeKind, Readonly<Record<string, string>>>> = {
  user_feedback: {},
  user_upload: { uploadId: "upload_id", filename: "filename", sizeBytes: "size_bytes", uploadedAt: "uploaded_at" },
  user_clarify_answer: { round: "round" },
  worker_escalation: { workerSessionId: "worker_session_id", sessionSeq: "session_seq", exitIntent: "exit_intent" },
  worker_notification: { workerSessionId: "worker_session_id", sessionSeq: "session_seq" },
  worker_completion_claim: { workerSessionId: "worker_session_id", sessionSeq: "session_seq" },
  worker_session_end: {
    workerSessionId: "worker_session_id",
    sessionSeq: "session_seq",
    exitReason: "exit_reason",
    doneCriteriaOutcome: "done_criteria_outcome",
  },
  watcher_observation: { watcherSessionId: "watcher_session_id", evidenceRefs: "evidence_refs" },
  reviewer_verdict: {
    reviewerPhase: "reviewer_phase",
    reviewerRound: "reviewer_round",
    verdict: "verdict",
    issues: "issues",
  },
  host_event: { eventKind: "event_kind", details: "details" },
  meta_instruction: {},
  meta_interrupt: {},
  worker_stream_window: {
    windowStart: "window_start",
    windowEnd: "window_end",
    workerSessionId: "worker_session_id",
    streamPath: "stream_path",
  },
};

export function extrasMatchToJsonKeys(
  kind: EnvelopeKind,
  match: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const map = EXTRAS_KEY_MAP[kind];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(match)) {
    out[map[k] ?? k] = v;
  }
  return out;
}

// ---- payload.json top level ----

export interface PayloadJson {
  readonly env_id: EnvelopeId;
  readonly channel: Channel;
  readonly kind: EnvelopeKind;
  readonly from: string;
  readonly created_at: Iso8601Us;
  readonly extras: Record<string, unknown> | null;
}

export function buildPayloadJson(
  envId: EnvelopeId,
  channel: Channel,
  kind: EnvelopeKind,
  from: string,
  createdAt: Iso8601Us,
  extras: EnvelopeExtras | null,
): PayloadJson {
  return { env_id: envId, channel, kind, from, created_at: createdAt, extras: extrasToJson(kind, extras) };
}
