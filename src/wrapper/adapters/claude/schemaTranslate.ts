/**
 * Translates JSON Schema (the single source for a host tool) to a Zod schema (required by the Claude `tool()` factory).
 *
 * Only translates the subset declared as supported in `jsonSchemaSubset` (capability.ts);
 * a lossy / unsupported construct fails fast with `permanent / schema_translation_failed`
 * rather than silently degrading to `z.unknown()`.
 *
 * Does not use json-schema-to-zod directly -- it emits a code string that needs
 * eval to instantiate and does not explicitly fail on lossy input. This translates
 * directly to a live Zod object and throws where something is inexpressible (no silent failure).
 */
import type { JSONSchema7, JSONSchema7Definition } from "json-schema";
import { z, type ZodTypeAny } from "zod";

import type { JsonSchema, ProviderId } from "../../types/index.js";
import { RuntimeErrorImpl } from "../../types/index.js";

const PROVIDER: ProviderId = "claude";

export class SchemaTranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaTranslationError";
  }
}

/** tool() requires a top-level object (provided as a Zod raw shape). Returns the raw shape (field name -> ZodType). */
export type ZodRawShape = Record<string, ZodTypeAny>;

function fail(path: string, why: string): never {
  throw new SchemaTranslationError(`unsupported JSON Schema at ${path || "<root>"}: ${why}`);
}

type Node = JSONSchema7;

function asNode(schema: JSONSchema7Definition, path: string): Node {
  if (typeof schema === "boolean") fail(path, "boolean schema not supported");
  return schema;
}

function singleType(node: Node, path: string): string {
  const t = node.type;
  if (t === undefined) {
    // allow enum/const with no explicit type; otherwise a bare schema is unsupported.
    if (node.enum !== undefined || node.const !== undefined) return "__enum_or_const__";
    fail(path, "missing `type` (and no enum/const)");
  }
  if (Array.isArray(t)) {
    // only the ["X","null"] form is supported (nullable); other multi-type arrays are unsupported.
    const nonNull = t.filter((x) => x !== "null");
    if (t.includes("null") && nonNull.length === 1) return `${nonNull[0]}|null`;
    fail(path, `multi-type ${JSON.stringify(t)} not supported (only ["T","null"] nullable)`);
  }
  return t;
}

// Keywords outside the supported subset (capability.jsonSchemaSubset) -- their presence fails fast rather than being silently ignored.
const UNSUPPORTED_KEYWORDS = [
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "propertyNames",
  "dependencies",
  "dependentSchemas",
  "dependentRequired",
  "uniqueItems",
  "contains",
  "$ref",
  "multipleOf",
] as const;

function assertNoUnsupportedKeywords(node: Node, path: string): void {
  for (const kw of UNSUPPORTED_KEYWORDS) {
    if ((node as Record<string, unknown>)[kw] !== undefined) fail(path, `keyword "${kw}" not in supported subset`);
  }
  // additionalProperties as a schema object (not boolean) = constrained extra properties, not in the subset.
  if (node.additionalProperties !== undefined && typeof node.additionalProperties === "object") {
    fail(path, "additionalProperties as schema object not supported (use explicit properties)");
  }
}

function translateNode(schema: JSONSchema7Definition, path: string): ZodTypeAny {
  const node = asNode(schema, path);
  assertNoUnsupportedKeywords(node, path);

  // enum / const (type may be absent).
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) fail(path, "enum must be non-empty array");
    const literals: ZodTypeAny[] = node.enum.map((v) => z.literal(v as string | number | boolean));
    if (literals.length === 1) return literals[0]!;
    return z.union(literals as unknown as readonly [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
  }
  if (node.const !== undefined) {
    return z.literal(node.const as string | number | boolean);
  }

  let t = singleType(node, path);
  let nullable = false;
  if (t.endsWith("|null")) {
    nullable = true;
    t = t.slice(0, -"|null".length);
  }

  let built: ZodTypeAny;
  switch (t) {
    case "string": {
      let s = z.string();
      if (typeof node.minLength === "number") s = s.min(node.minLength);
      if (typeof node.maxLength === "number") s = s.max(node.maxLength);
      if (typeof node.pattern === "string") s = s.regex(new RegExp(node.pattern));
      // `format` is not in the subset -> ignored without error (not lossy: format is only a hint).
      built = s;
      break;
    }
    case "integer":
    case "number": {
      let n = z.number();
      if (t === "integer") n = n.int();
      if (typeof node.minimum === "number") n = n.min(node.minimum);
      if (typeof node.maximum === "number") n = n.max(node.maximum);
      built = n;
      break;
    }
    case "boolean":
      built = z.boolean();
      break;
    case "null":
      built = z.null();
      break;
    case "array": {
      if (node.items === undefined) fail(path, "array without `items`");
      if (Array.isArray(node.items)) fail(path, "tuple `items` array not supported");
      let a = z.array(translateNode(node.items, `${path}[]`));
      if (typeof node.minItems === "number") a = a.min(node.minItems);
      if (typeof node.maxItems === "number") a = a.max(node.maxItems);
      built = a;
      break;
    }
    case "object":
      built = translateObject(node, path);
      break;
    default:
      fail(path, `type ${t}`);
  }

  return nullable ? built.nullable() : built;
}

function translateObject(node: Node, path: string): ZodTypeAny {
  if (node.additionalProperties === true) {
    fail(path, "additionalProperties:true (open object) not supported — declare explicit properties");
  }
  const props = node.properties ?? {};
  const required = new Set(node.required ?? []);
  const shape: ZodRawShape = {};
  for (const [key, sub] of Object.entries(props)) {
    const field = translateNode(sub, `${path}.${key}`);
    shape[key] = required.has(key) ? field : field.optional();
  }
  // additionalProperties === false or undefined -> strict object (consistent with host-side Ajv).
  return z.object(shape).strict();
}

/**
 * Translates a host tool's top-level inputSchema (must be an object) into a Zod raw shape (for `tool(...)`).
 * Translation failure -> throws permanent / schema_translation_failed (surfaced during startSession).
 */
export function jsonSchemaToZodShape(inputSchema: JsonSchema, toolName: string): ZodRawShape {
  try {
    const node = asNode(inputSchema, "");
    const t = node.type;
    if (t !== "object") {
      throw new SchemaTranslationError(`tool ${toolName} inputSchema top-level must be type:"object" (got ${JSON.stringify(t)})`);
    }
    if (node.additionalProperties === true) {
      throw new SchemaTranslationError(`tool ${toolName} inputSchema additionalProperties:true not supported`);
    }
    assertNoUnsupportedKeywords(node, ""); // the top level also rejects out-of-subset keywords (oneOf/anyOf/allOf/not/... see UNSUPPORTED_KEYWORDS)
    const props = node.properties ?? {};
    const required = new Set(node.required ?? []);
    const shape: ZodRawShape = {};
    for (const [key, sub] of Object.entries(props)) {
      const field = translateNode(sub, key);
      shape[key] = required.has(key) ? field : field.optional();
    }
    return shape;
  } catch (err) {
    const why = err instanceof SchemaTranslationError ? err.message : String((err as Error).message ?? err);
    throw new RuntimeErrorImpl({
      kind: "permanent",
      subKind: "schema_translation_failed",
      providerId: PROVIDER,
      message: `host tool ${toolName} JSON Schema → Zod translation failed: ${why}`,
      diagnostics: { toolName, reason: why },
    });
  }
}
