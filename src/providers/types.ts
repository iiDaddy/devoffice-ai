/**
 * Provider-agnostic model interface (LLD 4.1).
 *
 * Nothing above this file may import a vendor SDK, mention a model ID, or
 * assume a quota. Swapping Groq for another provider must touch only
 * src/providers/* and configuration - never the state machine, the schemas or
 * the agent prompts (HLD 10, principle "Modular providers").
 */
import type { z } from 'zod';
import type { JsonSchemaObject } from '../shared/json-schema.js';

export type ModelPurpose =
  | 'requirements'
  | 'proposal'
  | 'cross_review'
  | 'decision'
  | 'specification'
  | 'summary';

/**
 * A named output contract: the Zod schema is the gate, the JSON Schema is what
 * goes on the wire. Built once per schema and reused (see contracts.ts).
 */
export interface StructuredContract<T> {
  readonly schemaName: string;
  readonly validator: z.ZodType<T>;
  readonly jsonSchema: JsonSchemaObject;
  /** Keywords removed for strict-mode safety; surfaced for transparency. */
  readonly strippedKeywords: readonly string[];
}

export interface ModelRequest<T> {
  readonly purpose: ModelPurpose;
  readonly agentRole: string;
  readonly systemInstruction: string;
  /**
   * Validated, minimal context. Never a replay of every raw meeting message.
   * Kept for the event log and for debugging - this is NOT what goes on the
   * wire.
   */
  readonly input: unknown;
  /**
   * The exact user-message text to send.
   *
   * The orchestrator renders this (see agents/prompts.ts buildUserPayload) so
   * that the untrusted-data fence is applied by the layer that owns the prompt
   * contract. The provider is transport and must send it verbatim: if this were
   * left to the provider, a new call site could forget the fence and nothing
   * would notice.
   */
  readonly userContent: string;
  readonly contract: StructuredContract<T>;
  readonly maxOutputTokens: number;
  readonly correlationId: string;
  readonly temperature?: number;
}

export interface ModelUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface ModelResponse<T> {
  readonly provider: string;
  readonly modelId: string;
  /** Parsed AND runtime-validated against the contract's Zod schema. */
  readonly data: T;
  readonly usage: ModelUsage;
  readonly requestId: string | null;
  readonly latencyMs: number;
  /** How many HTTP attempts it took (1 = first try succeeded). */
  readonly transportAttempts: number;
  /** How many times the model had to be asked to fix its own JSON. */
  readonly validationRetries: number;
  /** True only for deliberately fake providers. Never fake this. */
  readonly simulated: boolean;
}

export interface TextRequest {
  readonly purpose: ModelPurpose;
  readonly agentRole: string;
  readonly systemInstruction: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  readonly correlationId: string;
}

export type ProviderAvailability =
  | { readonly available: true; readonly provider: string; readonly modelId: string; readonly detail: string }
  | { readonly available: false; readonly provider: string; readonly reason: string; readonly detail: string };

/** Rate-limit facts read back from the provider. Never invented. */
export interface RateLimitSnapshot {
  readonly limitRequests: number | null;
  readonly remainingRequests: number | null;
  readonly resetRequestsMs: number | null;
  readonly limitTokens: number | null;
  readonly remainingTokens: number | null;
  readonly resetTokensMs: number | null;
  readonly retryAfterMs: number | null;
}

export interface ModelProvider {
  readonly name: string;
  readonly modelId: string;
  /** True for mock/simulated providers so callers can label output honestly. */
  readonly simulated: boolean;

  generateStructured<T>(request: ModelRequest<T>): Promise<ModelResponse<T>>;
  generateText(request: TextRequest): Promise<ModelResponse<string>>;

  /**
   * Explicit availability check (LLD 4.2). Returns a reason instead of
   * throwing, and NEVER silently substitutes a different or paid provider.
   */
  checkAvailability(): Promise<ProviderAvailability>;

  /** Most recent rate-limit facts observed, for dashboards and pacing. */
  lastRateLimitSnapshot(): RateLimitSnapshot | null;
}
