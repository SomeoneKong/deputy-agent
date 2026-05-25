/**
 * Pushable AsyncIterable -- the input queue for streaming input mode.
 *
 * The adapter holds a pushable `AsyncIterable<SDKUserMessage>`: each inject
 * pushes one user message to start a new turn; the single consumer of
 * `query({ prompt: queue })` consumes the SDKMessage stream with `for await`.
 * close() ends the iteration.
 */
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export interface PushableQueue {
  readonly iterable: AsyncIterable<SDKUserMessage>;
  /** Pushes one user message. Returns false if the queue is already closed (the caller treats this as a delivery failure). */
  push(msg: SDKUserMessage): boolean;
  close(): void;
  readonly closed: boolean;
}

export function createPushableQueue(): PushableQueue {
  const buffer: SDKUserMessage[] = [];
  let resolveNext: (() => void) | undefined;
  let closed = false;

  function wake(): void {
    if (resolveNext !== undefined) {
      const r = resolveNext;
      resolveNext = undefined;
      r();
    }
  }

  const iterable: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
      while (true) {
        if (buffer.length > 0) {
          yield buffer.shift()!;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    },
  };

  return {
    iterable,
    push(msg: SDKUserMessage): boolean {
      if (closed) return false;
      buffer.push(msg);
      wake();
      return true;
    },
    close(): void {
      closed = true;
      wake();
    },
    get closed(): boolean {
      return closed;
    },
  };
}
