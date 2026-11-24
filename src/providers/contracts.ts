/**
 * Builds and caches StructuredContract objects.
 *
 * Importing this module runs the Groq strict-mode guard over every schema, so
 * a schema mistake fails at startup with a JSON pointer rather than as a 400
 * from the provider halfway through a meeting.
 */
import type { z } from 'zod';
import { buildGroqJsonSchema } from '../shared/json-schema.js';
import type { StructuredContract } from './types.js';

const cache = new Map<string, StructuredContract<unknown>>();

export function defineContract<T>(
  schemaName: string,
  wireSchema: z.ZodType,
  validator: z.ZodType<T>,
): StructuredContract<T> {
  const cached = cache.get(schemaName);
  if (cached !== undefined) return cached as StructuredContract<T>;

  const built = buildGroqJsonSchema(schemaName, wireSchema);
  const contract: StructuredContract<T> = {
    schemaName,
    validator,
    jsonSchema: built.jsonSchema,
    strippedKeywords: built.strippedKeywords,
  };
  cache.set(schemaName, contract as StructuredContract<unknown>);
  return contract;
}
