/**
 * JSON-Schema → Zod raw-shape converter for the Agent-SDK tool bridge.
 *
 * dai tools carry an Anthropic JSON Schema (`definition.input_schema`). The
 * Agent SDK's `tool()` helper wants a **Zod raw shape** (a record of zod
 * validators keyed by property name). This converts the former into the
 * latter for the subset of JSON Schema dai's ~60 tools actually use:
 * object/string/number/integer/boolean/array/enum, `description`, `required`,
 * `default`, nested objects, and array `items`.
 *
 * Anything it doesn't recognise degrades to `z.any()` (with description/optional
 * preserved) — the value still reaches the underlying dai handler unchanged, so
 * a loose schema never blocks a tool; it only loosens client-side validation.
 *
 * This is part of the Phase-B Agent-SDK spike. It does not touch the existing
 * hand-rolled runner.
 */
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';

type JsonSchema = Record<string, unknown>;

function pickType(schema: JsonSchema): string | undefined {
  const t = schema.type;
  if (typeof t === 'string') return t;
  // JSON Schema unions like ["string","null"] — take the first non-null type.
  if (Array.isArray(t)) {
    const first = t.find((x) => x !== 'null');
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}

/** Convert a single JSON-Schema property node to a Zod type. */
function nodeToZod(schema: JsonSchema): z.ZodTypeAny {
  // String enum → z.enum (zod v4 needs a non-empty string tuple).
  const en = schema.enum;
  if (Array.isArray(en) && en.length > 0 && en.every((v) => typeof v === 'string')) {
    return z.enum(en as [string, ...string[]]);
  }

  switch (pickType(schema)) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'array': {
      const items = schema.items;
      const inner =
        items && typeof items === 'object' && !Array.isArray(items)
          ? nodeToZod(items as JsonSchema)
          : z.any();
      return z.array(inner);
    }
    case 'object': {
      const props = schema.properties as Record<string, JsonSchema> | undefined;
      if (props && Object.keys(props).length > 0) {
        const required = new Set(
          Array.isArray(schema.required) ? (schema.required as string[]) : [],
        );
        const shape: z.ZodRawShape = {};
        for (const [key, child] of Object.entries(props)) {
          shape[key] = applyModifiers(nodeToZod(child), child, required.has(key));
        }
        // Allow extra keys through to the dai handler (it reads what it needs).
        return z.object(shape).passthrough();
      }
      // Free-form object.
      return z.record(z.string(), z.any());
    }
    default:
      return z.any();
  }
}

/** Apply description / default / optional to a base zod type. */
function applyModifiers(
  base: z.ZodTypeAny,
  schema: JsonSchema,
  isRequired: boolean,
): z.ZodTypeAny {
  let out = base;
  if (typeof schema.description === 'string') out = out.describe(schema.description);
  if ('default' in schema) out = out.default(schema.default as never);
  // A property with a default is effectively optional regardless of `required`.
  if (!isRequired && !('default' in schema)) out = out.optional();
  return out;
}

/**
 * Convert an Anthropic tool's `input_schema` into a Zod raw shape suitable for
 * the Agent SDK `tool()` helper. Returns an empty shape for tools that take no
 * structured input (the SDK accepts `{}`).
 */
export function jsonSchemaToZodRawShape(
  inputSchema: Anthropic.Tool['input_schema'],
): z.ZodRawShape {
  const schema = inputSchema as unknown as JsonSchema;
  const props = (schema?.properties as Record<string, JsonSchema> | undefined) ?? {};
  const required = new Set(
    Array.isArray(schema?.required) ? (schema.required as string[]) : [],
  );

  const shape: z.ZodRawShape = {};
  for (const [key, child] of Object.entries(props)) {
    shape[key] = applyModifiers(nodeToZod(child), child, required.has(key));
  }
  return shape;
}
