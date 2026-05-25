/**
 * Envelope schema and extras validation.
 *
 * Defines what a valid envelope is: the inner structure of payload.json plus a
 * strict per-kind whitelist for extras. `read` / `responded` are not envelope
 * schema fields but state derived from folding state.jsonl events.
 */
import { InvalidEnvelopeExtras } from "../shared/errors.js";
import type { EnvelopeId, SessionId, UploadId } from "../shared/ids.js";
import type { Iso8601Us } from "../shared/timeUtils.js";

// ---- channel / kind sets ----

export type Channel = "meta" | "worker" | "watcher";

export type EnvelopeKind =
  // -> meta channel
  | "user_feedback"
  | "user_upload"
  | "user_clarify_answer"
  | "worker_escalation"
  | "worker_notification"
  | "worker_completion_claim"
  | "worker_session_end"
  | "watcher_observation"
  | "reviewer_verdict"
  | "host_event"
  // -> worker channel
  | "meta_instruction" // may also be sent to watcher (reused across channels)
  | "meta_interrupt"
  // -> watcher channel
  | "worker_stream_window";

export const ALLOWED_KINDS_FOR_CHANNEL: Readonly<Record<Channel, ReadonlySet<EnvelopeKind>>> = {
  meta: new Set<EnvelopeKind>([
    "user_feedback",
    "user_upload",
    "user_clarify_answer",
    "worker_escalation",
    "worker_notification",
    "worker_completion_claim",
    "worker_session_end",
    "watcher_observation",
    "reviewer_verdict",
    "host_event",
  ]),
  worker: new Set<EnvelopeKind>(["meta_instruction", "meta_interrupt"]),
  watcher: new Set<EnvelopeKind>(["meta_instruction", "worker_stream_window"]),
};

export function isKindAllowedForChannel(channel: Channel, kind: EnvelopeKind): boolean {
  return ALLOWED_KINDS_FOR_CHANNEL[channel].has(kind);
}

// ---- extras schema by kind ----

export interface UserUploadExtras {
  readonly uploadId: UploadId;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly uploadedAt: Iso8601Us;
}

export interface UserClarifyAnswerExtras {
  readonly round: number;
}

export type WorkerExitIntent = "continue" | "declare_deferred";

export interface WorkerEscalationExtras {
  readonly workerSessionId: SessionId;
  readonly sessionSeq: number;
  readonly exitIntent: WorkerExitIntent;
}

export interface WorkerNotificationExtras {
  readonly workerSessionId: SessionId;
  readonly sessionSeq: number;
}

export interface WorkerCompletionClaimExtras {
  readonly workerSessionId: SessionId;
  readonly sessionSeq: number;
}

export interface WorkerSessionEndExtras {
  readonly workerSessionId: SessionId;
  readonly sessionSeq: number;
  readonly exitReason: string;
  readonly doneCriteriaOutcome: Readonly<Record<string, unknown>> | null;
}

export interface WatcherObservationExtras {
  readonly watcherSessionId: SessionId;
  readonly evidenceRefs: ReadonlyArray<string>;
}

export type ReviewerVerdictValue = "pass" | "needs_revision" | "unsafe" | null;

export interface ReviewerVerdictExtras {
  readonly reviewerPhase: string;
  readonly reviewerRound: number;
  readonly verdict: ReviewerVerdictValue;
  readonly issues: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export interface HostEventExtras {
  readonly eventKind: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface WorkerStreamWindowExtras {
  readonly windowStart: Iso8601Us;
  readonly windowEnd: Iso8601Us;
  readonly workerSessionId: SessionId;
  /** Path relative to the task capsule; the host validates it on write, and an absolute path or `..` escape throws PathEscapeError. */
  readonly streamPath: string;
}

export type EnvelopeExtras =
  | UserUploadExtras
  | UserClarifyAnswerExtras
  | WorkerEscalationExtras
  | WorkerNotificationExtras
  | WorkerCompletionClaimExtras
  | WorkerSessionEndExtras
  | WatcherObservationExtras
  | ReviewerVerdictExtras
  | HostEventExtras
  | WorkerStreamWindowExtras;

// Compile-time binding between kind and extras.
export type ExtrasByKind = {
  user_feedback: null;
  user_upload: UserUploadExtras;
  user_clarify_answer: UserClarifyAnswerExtras;
  worker_escalation: WorkerEscalationExtras;
  worker_notification: WorkerNotificationExtras;
  worker_completion_claim: WorkerCompletionClaimExtras;
  worker_session_end: WorkerSessionEndExtras;
  watcher_observation: WatcherObservationExtras;
  reviewer_verdict: ReviewerVerdictExtras;
  host_event: HostEventExtras;
  meta_instruction: null;
  meta_interrupt: null;
  worker_stream_window: WorkerStreamWindowExtras;
};

export type PayloadExtrasFor<K extends EnvelopeKind> = ExtrasByKind[K];

// ---- envelope schema ----

export interface Envelope {
  readonly envId: EnvelopeId;
  readonly channel: Channel;
  readonly kind: EnvelopeKind;
  readonly from: string;
  readonly createdAt: Iso8601Us;
  readonly body: string;
  readonly extras: EnvelopeExtras | null;
}

// ---- extras validation ----

/**
 * Internal field-type descriptors (used only in this module). `iso8601` only
 * checks that the value is a string (strict format is guaranteed by the
 * producer's nowIso8601Us). `int` explicitly rejects non-integer numbers
 * (including NaN and floats).
 */
type FieldSpec =
  | "string"
  | "int"
  | "iso8601"
  | "list[str]"
  | "list"
  | "dict"
  | "dict_or_none"
  | { readonly enum: ReadonlyArray<string> }
  | { readonly enumOrNull: ReadonlyArray<string> };

const EXTRAS_SCHEMAS: Readonly<Record<EnvelopeKind, Readonly<Record<string, FieldSpec>> | null>> = {
  user_feedback: null,
  user_upload: {
    uploadId: "string",
    filename: "string",
    sizeBytes: "int",
    uploadedAt: "iso8601",
  },
  user_clarify_answer: { round: "int" },
  worker_escalation: {
    workerSessionId: "string",
    sessionSeq: "int",
    exitIntent: { enum: ["continue", "declare_deferred"] },
  },
  worker_notification: { workerSessionId: "string", sessionSeq: "int" },
  worker_completion_claim: { workerSessionId: "string", sessionSeq: "int" },
  worker_session_end: {
    workerSessionId: "string",
    sessionSeq: "int",
    exitReason: "string",
    doneCriteriaOutcome: "dict_or_none",
  },
  watcher_observation: { watcherSessionId: "string", evidenceRefs: "list[str]" },
  reviewer_verdict: {
    reviewerPhase: "string",
    reviewerRound: "int",
    verdict: { enumOrNull: ["pass", "needs_revision", "unsafe"] },
    issues: "list",
  },
  host_event: { eventKind: "string", details: "dict" },
  meta_instruction: null,
  meta_interrupt: null,
  worker_stream_window: {
    windowStart: "iso8601",
    windowEnd: "iso8601",
    workerSessionId: "string",
    streamPath: "string",
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): boolean {
  // boolean is not a number; NaN and floats are rejected by Number.isInteger.
  return typeof v === "number" && Number.isInteger(v);
}

function checkField(value: unknown, spec: FieldSpec, field: string): string | null {
  if (spec === "string") {
    if (typeof value !== "string") return `field '${field}' must be string`;
  } else if (spec === "int") {
    if (!isInt(value)) return `field '${field}' must be int`;
  } else if (spec === "iso8601") {
    if (typeof value !== "string") return `field '${field}' must be ISO8601 string`;
  } else if (spec === "list[str]") {
    if (!Array.isArray(value) || !value.every((x) => typeof x === "string"))
      return `field '${field}' must be list[str]`;
  } else if (spec === "list") {
    if (!Array.isArray(value)) return `field '${field}' must be list`;
  } else if (spec === "dict") {
    if (!isPlainObject(value)) return `field '${field}' must be dict`;
  } else if (spec === "dict_or_none") {
    if (value !== null && !isPlainObject(value)) return `field '${field}' must be dict or null`;
  } else if ("enum" in spec) {
    if (typeof value !== "string" || !spec.enum.includes(value))
      return `field '${field}' must be one of ${JSON.stringify(spec.enum)}`;
  } else {
    // enumOrNull
    if (value !== null && (typeof value !== "string" || !spec.enumOrNull.includes(value)))
      return `field '${field}' must be one of ${JSON.stringify(spec.enumOrNull)} or null`;
  }
  return null;
}

/**
 * Strictly validate extras against the per-kind schema; throws
 * `InvalidEnvelopeExtras` on violation.
 * - kind not in the whitelist -> fail (guards against implicit kinds)
 * - schema is null: extras must be null
 * - schema is an object: extras must be an object with an exactly matching key
 *   set (missing, extra, or wrong-type keys are all rejected)
 */
export function validateExtras<K extends EnvelopeKind>(
  kind: K,
  extras: unknown,
): asserts extras is PayloadExtrasFor<K> {
  if (!Object.hasOwn(EXTRAS_SCHEMAS, kind)) {
    throw new InvalidEnvelopeExtras(`kind '${kind}' not in extras schema table`, { details: { kind } });
  }
  const schema = EXTRAS_SCHEMAS[kind];
  if (schema === null) {
    if (extras !== null && extras !== undefined) {
      throw new InvalidEnvelopeExtras(`kind '${kind}' expects extras=null`, {
        details: { kind, got: typeof extras },
      });
    }
    return;
  }
  if (!isPlainObject(extras)) {
    throw new InvalidEnvelopeExtras(`kind '${kind}' expects extras to be object`, {
      details: { kind, got: extras === null ? "null" : typeof extras },
    });
  }
  const expectedKeys = new Set(Object.keys(schema));
  const actualKeys = new Set(Object.keys(extras));
  const missing = [...expectedKeys].filter((k) => !actualKeys.has(k)).sort();
  const extra = [...actualKeys].filter((k) => !expectedKeys.has(k)).sort();
  if (missing.length > 0 || extra.length > 0) {
    throw new InvalidEnvelopeExtras(`extras key mismatch for kind '${kind}'`, {
      details: { kind, missing, extraKeys: extra },
    });
  }
  for (const [field, spec] of Object.entries(schema)) {
    const err = checkField(extras[field], spec, field);
    if (err !== null) {
      throw new InvalidEnvelopeExtras(`extras schema violation for kind '${kind}': ${err}`, {
        details: { kind, field, error: err },
      });
    }
  }
}
