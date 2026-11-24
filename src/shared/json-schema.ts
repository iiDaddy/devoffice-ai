/**
 * Turn a Zod schema into a JSON Schema that Groq's STRICT structured-output
 * mode will actually accept.
 *
 * Verified against https://console.groq.com/docs/structured-outputs
 * (checked 24 Nov 2026). Strict mode rules:
 *   1. every property of every object must be listed in `required`
 *   2. every object must set `additionalProperties: false`
 *   3. optional fields must be expressed as nullable unions, e.g. ["string","null"]
 *
 * Zod 4's z.toJSONSchema() already satisfies (2) and emits `required` for
 * non-optional keys. What it does NOT do is fail when someone writes
 * `.optional()` - that key silently drops out of `required` and Groq rejects
 * the whole schema at request time.
 *
 * assertGroqStrictCompatible() turns that late runtime 400 into an immediate,
 * loud failure at module load, with the exact JSON pointer of the bad field.
 */
import { z } from 'zod';
import { DevOfficeError } from './errors.js';

export type JsonSchemaObject = Record<string, unknown>;

export interface StrictSchemaViolation {
  readonly pointer: string;
  readonly problem: string;
}

/** Walk a JSON Schema and collect every strict-mode violation. */
export function findStrictViolations(
  schema: unknown,
  pointer = '#',
): StrictSchemaViolation[] {
  const violations: StrictSchemaViolation[] = [];
  if (typeof schema !== 'object' || schema === null) return violations;
  const node = schema as JsonSchemaObject;

  const declaredType = node['type'];
  const isObjectNode =
    declaredType === 'object' ||
    (Array.isArray(declaredType) && declaredType.includes('object')) ||
    (declaredType === undefined && typeof node['properties'] === 'object');

  if (isObjectNode && typeof node['properties'] === 'object' && node['properties'] !== null) {
    const properties = node['properties'] as JsonSchemaObject;
    const propertyNames = Object.keys(properties);
    const required = Array.isArray(node['required']) ? (node['required'] as string[]) : [];

    if (node['additionalProperties'] !== false) {
      violations.push({
        pointer,
        problem: 'object must set additionalProperties:false for Groq strict mode',
      });
    }

    for (const name of propertyNames) {
      if (!required.includes(name)) {
        violations.push({
          pointer: `${pointer}/properties/${name}`,
          problem:
            `"${name}" is not in "required". Groq strict mode requires every ` +
            'property. Use .nullable() instead of .optional().',
        });
      }
    }

    for (const name of propertyNames) {
      violations.push(...findStrictViolations(properties[name], `${pointer}/properties/${name}`));
    }
  }

  if (node['items'] !== undefined) {
    violations.push(...findStrictViolations(node['items'], `${pointer}/items`));
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[keyword];
    if (Array.isArray(branches)) {
      branches.forEach((branch, index) => {
        violations.push(...findStrictViolations(branch, `${pointer}/${keyword}/${index}`));
      });
    }
  }
  if (typeof node['$defs'] === 'object' && node['$defs'] !== null) {
    const defs = node['$defs'] as JsonSchemaObject;
    for (const name of Object.keys(defs)) {
      violations.push(...findStrictViolations(defs[name], `${pointer}/$defs/${name}`));
    }
  }

  return violations;
}

/**
 * Keywords we strip before sending a schema to Groq.
 *
 * https://console.groq.com/docs/structured-outputs lists the SUPPORTED feature
 * set (types, enum, anyOf, $defs/$ref) and explicitly says it does not
 * enumerate every unsupported keyword. Validation keywords like `minLength`
 * are therefore undocumented territory: a provider that rejects an unknown
 * keyword fails the whole request with a 400.
 *
 * So the schema we send describes SHAPE only. Every quantitative rule
 * (minimum array length, minimum prose length, id patterns) stays in the Zod
 * schema on our side and is restated in the agent prompt in words. We lose
 * nothing: Zod is the real gate, and a model that ignores a word-based
 * instruction is caught by validation and repaired via targeted retry.
 *
 * Revisit once the docs state these keywords are honoured.
 */
const UNSUPPORTED_STRICT_KEYWORDS = [
  'minLength', 'maxLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'uniqueItems',
  'minProperties', 'maxProperties',
  'default', 'examples', 'const', 'contentEncoding', 'contentMediaType',
] as const;

export interface SanitizeResult {
  readonly schema: JsonSchemaObject;
  /** JSON pointers of every keyword removed, for transparency in logs. */
  readonly stripped: string[];
}

/** Recursively remove keywords Groq does not document as supported. */
export function sanitizeForGroqStrict(schema: unknown, pointer = '#'): SanitizeResult {
  const stripped: string[] = [];

  const walk = (node: unknown, at: string): unknown => {
    if (Array.isArray(node)) {
      return node.map((item, index) => walk(item, `${at}/${index}`));
    }
    if (typeof node !== 'object' || node === null) return node;

    const out: JsonSchemaObject = {};
    for (const [key, value] of Object.entries(node as JsonSchemaObject)) {
      if ((UNSUPPORTED_STRICT_KEYWORDS as readonly string[]).includes(key)) {
        stripped.push(`${at}/${key}`);
        continue;
      }
      out[key] = walk(value, `${at}/${key}`);
    }
    return out;
  };

  return { schema: walk(schema, pointer) as JsonSchemaObject, stripped };
}

export function assertGroqStrictCompatible(schemaName: string, schema: unknown): void {
  const violations = findStrictViolations(schema);
  if (violations.length > 0) {
    const report = violations.map((v) => `  ${v.pointer}: ${v.problem}`).join('\n');
    throw new DevOfficeError(
      'CONFIG_INVALID',
      `Schema "${schemaName}" is not compatible with Groq strict structured output:\n${report}`,
      { details: violations },
    );
  }
}

/**
 * Convert a Zod schema to a strict-mode-ready JSON Schema.
 *
 * `$schema` is stripped because the provider wraps our schema in its own
 * envelope and unknown top-level keywords are a needless rejection risk.
 */
export interface GroqSchemaBuildResult {
  readonly name: string;
  readonly jsonSchema: JsonSchemaObject;
  readonly strippedKeywords: string[];
}

export function buildGroqJsonSchema(
  schemaName: string,
  schema: z.ZodType,
): GroqSchemaBuildResult {
  const generated = z.toJSONSchema(schema, { io: 'output' }) as JsonSchemaObject;
  const { $schema: _ignored, ...rest } = generated;
  const { schema: sanitized, stripped } = sanitizeForGroqStrict(rest);
  assertGroqStrictCompatible(schemaName, sanitized);
  return { name: schemaName, jsonSchema: sanitized, strippedKeywords: stripped };
}

/** Convenience wrapper when the caller only needs the schema body. */
export function toGroqJsonSchema(schemaName: string, schema: z.ZodType): JsonSchemaObject {
  return buildGroqJsonSchema(schemaName, schema).jsonSchema;
}
