/**
 * Centralized definitions of Deputy error types.
 *
 * Two distinct uses of `errorKind`:
 * - Class-level `errorKind` (the static and instance field on each class here):
 *   a language-level type label carried by the error object, used for
 *   `instanceof`-style classification in code.
 * - Audit-surface errorKind (written to `manifest.lastError.errorKind`,
 *   `events.jsonl`, `host_event.extras.eventKind`, and tool-result labels):
 *   filled in explicitly by the raise site or caller and not one-to-one with
 *   the error class (a single class can carry several audit kinds).
 */

export interface DeputyErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class DeputyError extends Error {
  /** Class-level type label (snake_case); overridden by subclasses. Not the audit-surface errorKind. */
  static readonly errorKind: string = "deputy_error";

  /** Instance mirror of the static errorKind, so the label can be read without a class reference. */
  readonly errorKind: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message = "", options?: DeputyErrorOptions) {
    super(message, options !== undefined && "cause" in options ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.errorKind = (new.target as typeof DeputyError).errorKind;
    this.details = options?.details ?? {};
  }
}

/** Timed out acquiring an OS-level file lock. */
export class LockTimeoutError extends DeputyError {
  static override readonly errorKind = "lock_timeout";
}

/** A non-final jsonl line is corrupt. A half-written final line does not raise this; the reader skips it. */
export class CorruptJsonlError extends DeputyError {
  static override readonly errorKind = "corrupt_jsonl";
}

/** An identifier or filename was rejected by path-safety checks (contains `..`, a path separator, an absolute path, or is empty). */
export class PathEscapeError extends DeputyError {
  static override readonly errorKind = "path_escape";
}

/** manifest.yaml failed to parse (YAML syntax error or top level is not a mapping). */
export class ManifestYamlParseError extends DeputyError {
  static override readonly errorKind = "manifest_yaml_parse_error";
}

/** manifest schemaVersion does not match what the code expects. */
export class ManifestSchemaMismatch extends DeputyError {
  static override readonly errorKind = "manifest_schema_mismatch";
}

/** manifest atomic write failed (error in the tmp, fsync, or rename step). */
export class ManifestAtomicWriteFailed extends DeputyError {
  static override readonly errorKind = "manifest_atomic_write_failed";
}

/** task_id conflicts with an existing task capsule directory; submit is rejected. */
export class TaskCapsuleConflict extends DeputyError {
  static override readonly errorKind = "task_capsule_conflict";
}

/** Stage-transition CAS guard failed: after reloading under the lock, `stage !== expectedFromStage`. */
export class StageCasMismatch extends DeputyError {
  static override readonly errorKind = "stage_cas_mismatch";
}

/** Base class for messaging subsystem errors. Intermediate base; errorKind stays typed as string so subclasses can override it. */
export class MessagingError extends DeputyError {
  static override readonly errorKind: string = "messaging_error";
}

/** envelope.extras does not match the schema for its kind (strict allowlist). */
export class InvalidEnvelopeExtras extends MessagingError {
  static override readonly errorKind = "messaging_invalid_extras";
}

/** Writing an envelope payload failed (error in the tmp, fsync, rename, or append-event step). */
export class MessagingEnqueueFailed extends MessagingError {
  static override readonly errorKind = "messaging_enqueue_failed";
}

/** A non-final state.jsonl line is corrupt and the quarantine path has been taken. */
export class MessagingStateCorrupted extends MessagingError {
  static override readonly errorKind = "messaging_state_corrupted";
}

/** state.jsonl has an enqueued entry but its payload is missing or corrupt. */
export class MessagingPayloadCorrupted extends MessagingError {
  static override readonly errorKind = "messaging_payload_corrupted";
}
