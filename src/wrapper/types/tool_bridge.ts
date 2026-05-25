/**
 * Host tool protocol: the registration interface, the call/result contract, and the registry
 * implementation.
 *
 * JSON Schema is the single source of truth for a host tool's parameter schema; the adapter
 * translates it to the provider's form internally. The wrapper ships no built-in host tools; the
 * host registers them all via `HostToolRegistry.register`.
 */
import type { JSONSchema7 } from "json-schema";

import type { AgentRole, ProviderId, TurnId } from "./common.js";
import type { SessionHandle } from "./session.js";
import type { AgentRuntime } from "./runtime.js";

/** The JSON Schema subset the wrapper accepts (a restricted draft-2020-12; the subset constraints are enforced during validation). */
export type JsonSchema = JSONSchema7;

export type HostToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mediaType: string }
  | { type: "resource"; uri: string; mediaType?: string }
  | { type: "json"; value: unknown };

export interface ToolOutputHint {
  readonly description: string;
  readonly exampleContentBlocks?: ReadonlyArray<HostToolContentBlock>;
}

export interface HostToolMetadata {
  readonly concurrent?: boolean;
  readonly supportsStreamingPartial?: boolean;
  readonly tags?: ReadonlyArray<string>;
}

export interface ToolCallLogger {
  /** debug writes only to the host logger, never to the stream JSONL. */
  readonly debug: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
}

export interface HostToolPartialUpdate {
  readonly content: ReadonlyArray<HostToolContentBlock>;
  readonly accumulated: boolean;
}

export interface HostToolCallContext {
  readonly sessionHandle: SessionHandle;
  readonly toolCallId: string;
  readonly turnId: TurnId | undefined;
  readonly agentRole: AgentRole;
  readonly providerId: ProviderId;
  readonly signal: AbortSignal;
  readonly onUpdate?: (partial: HostToolPartialUpdate) => void;
  readonly logger: ToolCallLogger;
}

export interface HostToolCallResult<Output = unknown> {
  readonly content: ReadonlyArray<HostToolContentBlock>;
  readonly isError: boolean;
  readonly structuredOutput?: Output;
  readonly providerExtras?: Readonly<Record<string, unknown>>;
}

export type HostToolHandler<Input, Output> = (
  input: Input,
  ctx: HostToolCallContext,
) => Promise<HostToolCallResult<Output>>;

export interface HostTool<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly description: string;
  readonly scope: ReadonlyArray<AgentRole>;
  readonly inputSchema: JsonSchema;
  readonly outputHint?: ToolOutputHint;
  readonly handler: HostToolHandler<Input, Output>;
  readonly metadata?: HostToolMetadata;
}

export interface HostToolRegistry {
  register<I, O>(tool: HostTool<I, O>): void;
  unregister(name: string): void;
  get(name: string): HostTool | undefined;
  list(role?: AgentRole): ReadonlyArray<HostTool>;
}

export interface AgentRuntimeOptions {
  readonly toolRegistry: HostToolRegistry;
  readonly providerSpecific: unknown;
}

export interface AgentRuntimeFactory {
  create(options: AgentRuntimeOptions): AgentRuntime;
}

/** Registry-level validation error (provider-neutral; the adapter's startSession duplicate/scope checks throw RuntimeError instead). */
export class HostToolRegistryError extends Error {
  readonly code: "duplicate_tool_name" | "invalid_scope" | "invalid_handler" | "invalid_schema";
  constructor(code: HostToolRegistryError["code"], message: string) {
    super(message);
    this.name = "HostToolRegistryError";
    this.code = code;
  }
}

class HostToolRegistryImpl implements HostToolRegistry {
  readonly #tools = new Map<string, HostTool>();

  register<I, O>(tool: HostTool<I, O>): void {
    if (this.#tools.has(tool.name)) {
      throw new HostToolRegistryError("duplicate_tool_name", `tool already registered: ${tool.name}`);
    }
    if (tool.scope.length === 0) {
      throw new HostToolRegistryError("invalid_scope", `tool scope must be non-empty: ${tool.name}`);
    }
    if (typeof tool.handler !== "function") {
      throw new HostToolRegistryError("invalid_handler", `tool handler must be a function: ${tool.name}`);
    }
    if (tool.inputSchema === null || typeof tool.inputSchema !== "object") {
      throw new HostToolRegistryError("invalid_schema", `tool inputSchema must be a JSON Schema object: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool as HostTool);
  }

  unregister(name: string): void {
    this.#tools.delete(name);
  }

  get(name: string): HostTool | undefined {
    return this.#tools.get(name);
  }

  list(role?: AgentRole): ReadonlyArray<HostTool> {
    const all = [...this.#tools.values()];
    return role === undefined ? all : all.filter((t) => t.scope.includes(role));
  }
}

export function createHostToolRegistry(): HostToolRegistry {
  return new HostToolRegistryImpl();
}
