/**
 * MockProvider - a TEMPLATE generator, not a model.
 *
 * Why it exists: M0 must be runnable and testable before anyone has a Groq key,
 * and the wiring (schemas, event log, sequence numbers, throttle, state
 * transitions) is worth proving on its own.
 *
 * Why it is safe: `simulated` is true, every response carries provider "mock",
 * and the CLI refuses to print a rubric score for a mock run. Its text is
 * filled-in templates with no reasoning behind it, so it CANNOT be used to
 * claim the agent-discussion quality bar in HLD 12 / LLD 14 has been met.
 * Only a real run against a real key can do that.
 */
import { DevOfficeError } from '../shared/errors.js';
import type { Clock } from './throttle.js';
import { systemClock } from './throttle.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ProviderAvailability,
  RateLimitSnapshot,
  TextRequest,
} from './types.js';

export interface MockProviderOptions {
  readonly clock?: Clock;
  /** Force a failure for a given schema name, to exercise error paths. */
  readonly failOn?: ReadonlySet<string>;
  readonly latencyMs?: number;
}

export class MockProvider implements ModelProvider {
  readonly name = 'mock';
  readonly simulated = true;
  readonly modelId = 'mock-template-v1';

  private readonly clock: Clock;
  private readonly options: MockProviderOptions;

  constructor(options: MockProviderOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.options = options;
  }

  lastRateLimitSnapshot(): RateLimitSnapshot | null {
    return null;
  }

  async checkAvailability(): Promise<ProviderAvailability> {
    return {
      available: true,
      provider: this.name,
      modelId: this.modelId,
      detail: 'Template generator. Produces schema-valid placeholders, NOT model output.',
    };
  }

  async generateStructured<T>(request: ModelRequest<T>): Promise<ModelResponse<T>> {
    const startedAt = this.clock.now();
    if (this.options.failOn?.has(request.contract.schemaName) === true) {
      throw new DevOfficeError('SCHEMA_INVALID', `MockProvider was told to fail on ${request.contract.schemaName}.`);
    }
    if (this.options.latencyMs !== undefined && this.options.latencyMs > 0) {
      await this.clock.sleep(this.options.latencyMs);
    }

    const candidate = buildTemplate(request);
    const validated = request.contract.validator.safeParse(candidate);
    if (!validated.success) {
      // A mock that silently emits invalid data would hide real schema bugs.
      throw new DevOfficeError(
        'SCHEMA_INVALID',
        `MockProvider template for ${request.contract.schemaName} does not satisfy its own ` +
          `schema. Fix the template in src/providers/mock.ts:\n` +
          validated.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
      );
    }

    return {
      provider: this.name,
      modelId: this.modelId,
      data: validated.data,
      usage: { inputTokens: null, outputTokens: null, totalTokens: null },
      requestId: null,
      latencyMs: this.clock.now() - startedAt,
      transportAttempts: 1,
      validationRetries: 0,
      simulated: true,
    };
  }

  async generateText(request: TextRequest): Promise<ModelResponse<string>> {
    return {
      provider: this.name,
      modelId: this.modelId,
      data: `[SIMULATED TEMPLATE OUTPUT for ${request.agentRole}/${request.purpose}]`,
      usage: { inputTokens: null, outputTokens: null, totalTokens: null },
      requestId: null,
      latencyMs: 0,
      transportAttempts: 1,
      validationRetries: 0,
      simulated: true,
    };
  }
}

interface TemplateInput {
  readonly brief?: { title?: string; objective?: string; requested_features?: string[] };
  readonly brief_summary?: { title?: string; objective?: string };
  readonly target_proposals?: Array<{ proposal_id?: string; agent_role?: string; summary?: string }>;
}

function buildTemplate<T>(request: ModelRequest<T>): unknown {
  const input = (request.input ?? {}) as TemplateInput;
  const title = input.brief?.title ?? input.brief_summary?.title ?? 'Untitled project';
  const features = input.brief?.requested_features ?? ['Home'];
  const role = request.agentRole;

  switch (request.contract.schemaName) {
    case 'RequirementSetV1':
      return {
        goals: [`[SIMULATED] Deliver ${title} with the requested pages.`],
        audience: ['[SIMULATED] stated audience'],
        requirements: features.map((feature, index) => ({
          id: `REQ-${String(index + 1).padStart(3, '0')}`,
          statement: `[SIMULATED] The site must provide a ${feature} section that loads without error.`,
          priority: index === 0 ? 'must' : 'should',
          source: 'brief',
        })),
        assumptions: ['[SIMULATED] No backend is required for the first release.'],
        missing_questions: ['[SIMULATED] Which contact channel should the form deliver to?'],
        in_scope: features,
        out_of_scope: ['[SIMULATED] Authentication', '[SIMULATED] Payments'],
      };

    case 'AgentContributionV1': {
      // Round is inferred the same way a real agent would see it: being shown
      // other people's proposals means this is cross-review, not round 1.
      const target = input.target_proposals?.[0];
      const isReaction = target !== undefined;
      const type = isReaction ? 'objection' : 'proposal';
      return {
        topic: `[SIMULATED] ${role} view on ${title}`,
        proposal_id: `prop-${role}-${type}-01`,
        agent_role: role,
        contribution_type: type,
        summary: `[SIMULATED] ${role} placeholder contribution for ${title}.`,
        rationale:
          `[SIMULATED PLACEHOLDER] This text is generated by a template in mock.ts and carries ` +
          `no reasoning. It exists only to exercise schema validation and the event log.`,
        alternatives: ['[SIMULATED] alternative A', '[SIMULATED] alternative B'],
        risks: ['[SIMULATED] placeholder risk'],
        dependencies: ['[SIMULATED] placeholder dependency'],
        related_proposal_id: isReaction ? (target?.proposal_id ?? null) : null,
        recommended_change: isReaction
          ? '[SIMULATED] placeholder recommended change of at least fifteen characters.'
          : null,
        evidence: isReaction ? ['[SIMULATED] evidence pointer'] : [],
        severity: 'info',
      };
    }

    case 'TechLeadSynthesisV1':
      return {
        consensus_summary:
          '[SIMULATED PLACEHOLDER] Template synthesis produced without model reasoning; ' +
          'present only to validate the round-3 contract and event sequence.',
        decisions: [
          {
            decision_id: 'adr-001',
            problem: `[SIMULATED] Which rendering approach suits ${title}?`,
            alternatives: [
              { name: 'Static HTML', pros: ['[SIMULATED] simple'], cons: ['[SIMULATED] manual'] },
              { name: 'Static site generator', pros: ['[SIMULATED] reusable'], cons: ['[SIMULATED] build step'] },
            ],
            selected: 'Static site generator',
            rationale:
              '[SIMULATED PLACEHOLDER] Selected by template, not by analysis. Do not treat as a ' +
              'real architecture decision.',
            rejected_reasons: ['[SIMULATED] manual editing does not scale'],
            affected_requirements: ['REQ-001'],
            open_questions: [],
          },
        ],
        changed_due_to_feedback: ['[SIMULATED] nothing genuinely changed; this is a template run'],
        unresolved_blockers: [
          {
            question: '[SIMULATED] Which contact channel should the form deliver to?',
            blocking: true,
            raised_by: 'pm',
            affected_requirements: ['REQ-001'],
          },
        ],
      };

    default:
      throw new DevOfficeError(
        'CONFIG_INVALID',
        `MockProvider has no template for schema "${request.contract.schemaName}".`,
      );
  }
}
