/**
 * Keep the prompt and the Zod schema telling the model the same story.
 *
 * ADR-0003 strips validation keywords before a schema reaches Groq, because
 * undocumented keywords risk a 400 on the whole request. The schema the model
 * sees therefore describes SHAPE only, and every quantitative rule has to be
 * restated in the prompt in words.
 *
 * That contract was broken silently. On benchmark B3 the Tech Lead wrote
 * decision ids "1" and "2" and Zod rejected them for being under three
 * characters - a rule that existed only in Zod, invisible to the model, and
 * absent from the prompt. It cost two repair attempts and helped push the
 * request over the token ceiling.
 *
 * Six more rules were in the same state. These tests make the gap fail here
 * rather than mid-meeting.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildSystemInstruction, type PromptContext } from '../src/agents/prompts.js';
import { SCHEMA_REGISTRY } from '../src/shared/schemas.js';
import { TechLeadDecisionsV1 } from '../src/shared/schemas.js';

interface ContractUnderTest {
  readonly schemaName: keyof typeof SCHEMA_REGISTRY;
  readonly role: PromptContext['role'];
  readonly round: PromptContext['round'];
}

const CONTRACTS: readonly ContractUnderTest[] = [
  { schemaName: 'RequirementSetV1', role: 'pm', round: 1 },
  { schemaName: 'AgentContributionV1', role: 'security', round: 1 },
  { schemaName: 'TechLeadDecisionsV1', role: 'tech_lead', round: 3 },
  { schemaName: 'RequirementDispositionSetV1', role: 'tech_lead', round: 3 },
];

function promptFor(contract: ContractUnderTest): string {
  return buildSystemInstruction({
    role: contract.role,
    round: contract.round,
    projectId: 'p1',
    meetingId: 'm1',
    outputContract: contract.schemaName,
  });
}

/** Every (field, minLength) pair in the schema, at any nesting depth. */
function minimumsIn(schemaName: keyof typeof SCHEMA_REGISTRY): Array<[string, number]> {
  const raw = z.toJSONSchema(SCHEMA_REGISTRY[schemaName], { io: 'output' }) as Record<string, unknown>;
  const found: Array<[string, number]> = [];

  const walk = (node: unknown, field: string): void => {
    if (typeof node !== 'object' || node === null) return;
    const obj = node as Record<string, unknown>;
    const min = obj['minLength'];
    if (typeof min === 'number') found.push([field, min]);

    const properties = obj['properties'];
    if (typeof properties === 'object' && properties !== null) {
      for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
        walk(value, key);
      }
    }
    if (obj['items'] !== undefined) walk(obj['items'], field);
    for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
      const branches = obj[keyword];
      if (Array.isArray(branches)) branches.forEach((branch) => walk(branch, field));
    }
  };

  walk(raw, '(root)');
  return found;
}

describe('rules the model cannot see must be written in the prompt', () => {
  /**
   * 10 characters is where a limit stops being a sanity bound and starts
   * asking for substance - the range where a model can plausibly under-deliver
   * without knowing it. Identifier fields are covered separately below,
   * because their problem is shape, not length.
   */
  const SUBSTANCE_THRESHOLD = 10;

  for (const contract of CONTRACTS) {
    it(`${contract.schemaName}: every length rule of ${SUBSTANCE_THRESHOLD}+ is stated`, () => {
      const prompt = promptFor(contract);
      const lines = prompt.split('\n');
      const undocumented: string[] = [];

      for (const [field, min] of minimumsIn(contract.schemaName)) {
        if (min < SUBSTANCE_THRESHOLD) continue;
        // The number must appear on a line that also names the field, so a
        // stray digit elsewhere in the prompt cannot pass for documentation.
        const documented = lines.some((line) => line.includes(field) && line.includes(String(min)));
        if (!documented) undocumented.push(`${field} (needs >= ${min} characters)`);
      }

      expect(undocumented, `not stated in the ${contract.schemaName} prompt`).toEqual([]);
    });
  }

  for (const contract of CONTRACTS) {
    it(`${contract.schemaName}: every field is at least named`, () => {
      const prompt = promptFor(contract);
      const fields = minimumsIn(contract.schemaName).map(([field]) => field);
      const missing = [...new Set(fields)].filter((f) => f !== '(root)' && !prompt.includes(f));
      expect(missing).toEqual([]);
    });
  }
});

describe('identifier fields say what shape they should be', () => {
  it('REGRESSION B3: the prompt shows a decision_id example', () => {
    const prompt = promptFor({ schemaName: 'TechLeadDecisionsV1', role: 'tech_lead', round: 3 });
    expect(prompt).toContain('decision_id');
    expect(prompt).toContain('DEC-001');
    // And it warns off the exact shape that failed.
    expect(prompt).toMatch(/bare number like "1" is rejected/i);
  });

  it('the proposal_id pattern is given to specialists', () => {
    const prompt = promptFor({ schemaName: 'AgentContributionV1', role: 'security', round: 1 });
    expect(prompt).toMatch(/prop-<role>-<slug>-NN/);
  });

  it('dispositions are told to reuse ids rather than invent them', () => {
    const prompt = promptFor({
      schemaName: 'RequirementDispositionSetV1',
      role: 'tech_lead',
      round: 3,
    });
    expect(prompt).toMatch(/exactly as listed/i);
    expect(prompt).toMatch(/do not invent ids/i);
  });
});

describe('decision ids must be usable as references', () => {
  const decision = (id: string) => ({
    decision_id: id,
    problem: 'How should finance staff access be constrained?',
    alternatives: [
      { name: 'Unrestricted read', pros: ['Simple'], cons: ['Unbounded exposure'] },
      { name: 'Scoped access', pros: ['Limits blast radius'], cons: ['More work'] },
    ],
    selected: 'Scoped access',
    rationale: 'Unbounded read over student financial records is not defensible for release one.',
    rejected_reasons: ['Unrestricted read cannot be justified'],
    affected_requirements: ['REQ-001'],
    open_questions: [],
  });

  const base = (decisions: Array<ReturnType<typeof decision>>) => ({
    consensus_summary: 'The team settled on scoped staff access and an immutable audit log.',
    verdict: 'proceed_with_conditions',
    verdict_justification:
      'Workable, but it handles real financial records and needs a named data owner first.',
    verdict_conditions: ['The institution names a legal owner for the records'],
    decisions,
    changed_due_to_feedback: [],
    unresolved_blockers: [],
  });

  it('accepts distinct ids', () => {
    expect(TechLeadDecisionsV1.safeParse(base([decision('DEC-001'), decision('DEC-002')])).success).toBe(true);
  });

  it('rejects two decisions sharing an id, which would break every reference', () => {
    const result = TechLeadDecisionsV1.safeParse(base([decision('DEC-001'), decision('DEC-001')]));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('more than one decision');
  });

  it('treats ids as the same when they differ only in case or spacing', () => {
    const result = TechLeadDecisionsV1.safeParse(base([decision('DEC-001'), decision(' dec-001 ')]));
    expect(result.success).toBe(false);
  });

  it('REGRESSION B3: a bare number is still rejected, and says so clearly', () => {
    const result = TechLeadDecisionsV1.safeParse(base([decision('1')]));
    expect(result.success).toBe(false);
    const message = JSON.stringify(result.error?.issues);
    expect(message).toMatch(/decision_id/);
    expect(message).toMatch(/3 characters/);
  });
});
