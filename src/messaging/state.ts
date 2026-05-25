/**
 * state.jsonl event types and the state derived by folding them.
 *
 * Events are persisted as snake_case JSON (env_id / state_seq / error_kind /
 * error_message) and use camelCase in TS; the naming conversion is contained
 * within the bus IO layer.
 */
import type { Channel, EnvelopeKind } from "./envelope.js";
import type { EnvelopeId } from "../shared/ids.js";
import type { Iso8601Us } from "../shared/timeUtils.js";

export type StateEventType = "enqueued" | "read" | "responded" | "failed";

interface StateEventCommon {
  readonly type: StateEventType;
  readonly ts: Iso8601Us;
  readonly envId: EnvelopeId;
  readonly stateSeq: number;
}

export interface EnqueuedEvent extends StateEventCommon {
  readonly type: "enqueued";
  readonly channel: Channel;
  readonly kind: EnvelopeKind;
  readonly from: string;
}

export interface ReadEvent extends StateEventCommon {
  readonly type: "read";
  readonly by: string; // "host_inject:<role>_session:<sid>" | "<role>_session:<sid>"
}

export interface RespondedEvent extends StateEventCommon {
  readonly type: "responded";
  readonly by: string; // "worker_session:<sid>" | "meta_session:<sid>"
}

export interface FailedEvent extends StateEventCommon {
  readonly type: "failed";
  readonly errorKind: string;
  readonly errorMessage: string;
}

export type StateEvent = EnqueuedEvent | ReadEvent | RespondedEvent | FailedEvent;

/**
 * In-memory state of a single envelope derived by folding. The source of truth
 * is always state.jsonl + payloads/. `stateSeq` is taken from the envelope's
 * enqueued event.
 */
export interface EnvelopeState {
  readonly envId: EnvelopeId;
  readonly channel: Channel;
  readonly kind: EnvelopeKind;
  readonly from: string;
  readonly createdAt: Iso8601Us;
  readonly stateSeq: number;
  read: boolean;
  readBy: string | null;
  responded: boolean;
  respondedBy: string | null;
  failed: boolean;
}

/** Unified envelope sort key: ascending composite of (createdAt, stateSeq). */
export function envelopeOrderKey(state: EnvelopeState): readonly [Iso8601Us, number] {
  return [state.createdAt, state.stateSeq];
}

/** Compare composite sort keys: a < b -> negative; a > b -> positive; equal -> 0. */
export function compareOrderKey(
  a: readonly [Iso8601Us, number],
  b: readonly [Iso8601Us, number],
): number {
  if (a[0] < b[0]) return -1;
  if (a[0] > b[0]) return 1;
  return a[1] - b[1];
}
