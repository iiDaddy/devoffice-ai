/**
 * Data-contract tests (LLD 6) and the Groq strict-mode guard.
 *
 * Covers the cross-review rule in LLD 6.2, which is the single most
 * load-bearing anti-theatre rule in the design: if "I agree" counts as a
 * contribution, the whole meeting becomes decoration.
 */
import { describe, expect, it } from 'vitest';
import {
  AgentContributionV1,
  ArchitectureDecisionV1,
  ProjectBriefV1,
  SCHEMA_REGISTRY,
} from '../src/shared/schemas.js';
import { buildGroqJsonSchema, findStrictViolations } from '../src/shared/json-schema.js';
import { PROPOSAL_CONTRACT, reactionContract } from '../src/agents/contribution-contracts.js';
import { BENCHMARK_BRIEFS } from '../src/benchmarks/briefs.js';
import { loadConfig } from '../src/shared/config.js';
import { validProposal } from './helpers.js';

describe('Groq strict-mode schema guard', () => {
  it('accepts every registered contract', () => {
    for (const [name, schema] of Object.entries(SCHEMA_REGISTRY)) {
      expect(() => buildGroqJsonSchema(name, schema), `${name} must be strict-compatible`).not.toThrow();
    }
  });

  it('emits additionalProperties:false and lists every property as required', () => {
    const built = buildGroqJsonSchema('AgentContributionV1', SCHEMA_REGISTRY.AgentContributionV1);
    const schema = built.jsonSchema as { properties: Record<string, unknown>; required: string[]; additionalProperties: unknown };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
  });

  it('strips validation keywords Groq does not document as supported', () => {
    const built = buildGroqJsonSchema('RequirementSetV1', SCHEMA_REGISTRY.RequirementSetV1);
    expect(built.strippedKeywords.length).toBeGreaterThan(0);
    expect(JSON.stringify(built.jsonSchema)).not.toContain('minLength');
    expect(JSON.stringify(built.jsonSchema)).not.toContain('minItems');
  });

  it('removes $schema, which is not part of the provider envelope', () => {
    const built = buildGroqJsonSchema('ProjectBriefV1', ProjectBriefV1);
    expect(Object.keys(built.jsonSchema)).not.toContain('$schema');
  });

  it('catches a property missing from required (the .optional() trap)', () => {
    const bad = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    };
    const violations = findStrictViolations(bad);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.pointer).toBe('#/properties/b');
    expect(violations[0]?.problem).toContain('.nullable()');
  });

  it('catches a nested object that allows additional properties', () => {
    const bad = {
      type: 'object',
      properties: { inner: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } },
      required: ['inner'],
      additionalProperties: false,
    };
    const violations = findStrictViolations(bad);
    expect(violations.some((v) => v.pointer === '#/properties/inner')).toBe(true);
  });
});

describe('AgentContributionV1 cross-review rule (LLD 6.2)', () => {
  it('accepts a well-formed round-1 proposal', () => {
    expect(AgentContributionV1.safeParse(validProposal()).success).toBe(true);
  });

  it('rejects "I agree" as a rationale', () => {
    for (const empty of ['I agree', 'agreed', 'LGTM', 'Sounds good', '+1', 'makes sense']) {
      const result = AgentContributionV1.safeParse(
        validProposal({ contribution_type: 'support', related_proposal_id: 'prop-x-1', rationale: empty }),
      );
      expect(result.success, `"${empty}" must be rejected`).toBe(false);
    }
  });

  it('rejects an objection that cites no proposal', () => {
    const result = AgentContributionV1.safeParse(
      validProposal({
        contribution_type: 'objection',
        related_proposal_id: null,
        recommended_change: 'Serve the hero image as WebP with a width-based srcset.',
        evidence: ['hero image is 4MB'],
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('related_proposal_id');
  });

  it('rejects an objection with no recommended change', () => {
    const result = AgentContributionV1.safeParse(
      validProposal({
        contribution_type: 'objection',
        related_proposal_id: 'prop-ui_ux-home-01',
        recommended_change: null,
        evidence: ['hero image is 4MB'],
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('recommend a concrete change');
  });

  it('rejects an objection with no evidence', () => {
    const result = AgentContributionV1.safeParse(
      validProposal({
        contribution_type: 'objection',
        related_proposal_id: 'prop-ui_ux-home-01',
        recommended_change: 'Serve the hero image as WebP with a width-based srcset.',
        evidence: [],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts a complete objection', () => {
    const result = AgentContributionV1.safeParse(
      validProposal({
        agent_role: 'frontend',
        contribution_type: 'objection',
        related_proposal_id: 'prop-ui_ux-home-01',
        recommended_change: 'Serve the hero image as WebP with a width-based srcset.',
        evidence: ['the proposal specifies a full-bleed 4MB hero image'],
        rationale: 'A 4MB hero blocks largest-contentful-paint well past 2.5s on a mid-range phone.',
        severity: 'medium',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a round-1 proposal that cites another proposal', () => {
    const result = AgentContributionV1.safeParse(
      validProposal({ contribution_type: 'proposal', related_proposal_id: 'prop-other-1' }),
    );
    expect(result.success).toBe(false);
  });
});

describe('round-aware contracts', () => {
  it('round 1 rejects anything that is not a proposal', () => {
    const result = PROPOSAL_CONTRACT.validator.safeParse(
      validProposal({
        contribution_type: 'objection',
        related_proposal_id: 'prop-x-1',
        recommended_change: 'Change the hero to a WebP image with srcset.',
        evidence: ['something'],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('round 2 rejects a fresh proposal masquerading as cross-review', () => {
    const contract = reactionContract(['prop-ui_ux-home-01']);
    const result = contract.validator.safeParse(validProposal({ contribution_type: 'proposal' }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('cross-review');
  });

  it('round 2 rejects a citation to a proposal that does not exist', () => {
    const contract = reactionContract(['prop-ui_ux-home-01']);
    const result = contract.validator.safeParse(
      validProposal({
        contribution_type: 'objection',
        related_proposal_id: 'prop-invented-99',
        recommended_change: 'Change the hero to a WebP image with srcset.',
        evidence: ['something specific'],
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('prop-ui_ux-home-01');
  });

  it('round 2 allows a question without a citation', () => {
    const contract = reactionContract(['prop-ui_ux-home-01']);
    const result = contract.validator.safeParse(
      validProposal({ contribution_type: 'question', related_proposal_id: null }),
    );
    expect(result.success).toBe(true);
  });

  it('both rounds send the identical JSON Schema on the wire', () => {
    expect(reactionContract(['a']).jsonSchema).toEqual(PROPOSAL_CONTRACT.jsonSchema);
  });
});

describe('ArchitectureDecisionV1 (LLD 6.3)', () => {
  const baseDecision = {
    decision_id: 'adr-001',
    problem: 'How should the registration form deliver submissions?',
    alternatives: [
      { name: 'Own backend endpoint', pros: ['Full control'], cons: ['Needs hosting and upkeep'] },
      { name: 'External form service', pros: ['Zero cost'], cons: ['Third-party data processor'] },
    ],
    selected: 'External form service',
    rationale: 'Zero budget and a two-week deadline rule out building and operating an endpoint.',
    rejected_reasons: ['Own backend cannot be operated within the stated budget'],
    affected_requirements: ['REQ-004'],
    open_questions: [],
  };

  it('accepts a complete decision', () => {
    expect(ArchitectureDecisionV1.safeParse(baseDecision).success).toBe(true);
  });

  it('rejects a decision with only one alternative', () => {
    const result = ArchitectureDecisionV1.safeParse({
      ...baseDecision,
      alternatives: [baseDecision.alternatives[0]],
      selected: 'Own backend endpoint',
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('two alternatives');
  });

  it('rejects selecting something that was never listed', () => {
    const result = ArchitectureDecisionV1.safeParse({ ...baseDecision, selected: 'Carrier pigeon' });
    expect(result.success).toBe(false);
  });

  it('rejects an alternative with no downside', () => {
    const result = ArchitectureDecisionV1.safeParse({
      ...baseDecision,
      alternatives: [
        { name: 'Own backend endpoint', pros: ['Full control'], cons: [] },
        baseDecision.alternatives[1],
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('configuration', () => {
  it('treats a blank env var as unset, not as an invalid value', () => {
    // "GROQ_MODEL_PLANNING=" in a .env file is how a human says "not chosen
    // yet". If that were a validation error, `npm run models` - the command
    // that tells you what to choose - could never run.
    const config = loadConfig({
      GROQ_API_KEY: 'test-key-not-a-real-credential',
      GROQ_MODEL_PLANNING: '',
    } as NodeJS.ProcessEnv);
    expect(config.GROQ_MODEL_PLANNING).toBeNull();
    expect(config.GROQ_API_KEY).toBe('test-key-not-a-real-credential');
  });

  it('falls back to defaults when a numeric setting is left blank', () => {
    const config = loadConfig({ MEETING_MAX_ROUNDS: '' } as NodeJS.ProcessEnv);
    expect(config.MEETING_MAX_ROUNDS).toBe(3);
  });

  it('still rejects a value that is present but genuinely wrong', () => {
    expect(() =>
      loadConfig({ MEETING_MAX_ROUNDS: 'banana' } as NodeJS.ProcessEnv),
    ).toThrowError(/Invalid environment configuration/);
  });
});

describe('benchmark fixtures', () => {
  it('all three briefs are valid ProjectBriefV1 documents', () => {
    expect(BENCHMARK_BRIEFS).toHaveLength(3);
    for (const benchmark of BENCHMARK_BRIEFS) {
      expect(ProjectBriefV1.safeParse(benchmark.brief).success, benchmark.id).toBe(true);
      expect(benchmark.expectations.length).toBeGreaterThan(0);
      expect(benchmark.red_flags.length).toBeGreaterThan(0);
    }
  });
});
