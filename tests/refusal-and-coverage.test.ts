/**
 * The three gaps benchmark B3 exposed, and the fixes for them.
 *
 * None of these were failures of the model. Each was a hole in the contract:
 * the team had no way to refuse, no obligation to account for every
 * requirement, and no structure forcing the change log to say anything. The
 * tests below pin the fixes so the holes cannot quietly reopen.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentContributionV1,
  TechLeadSynthesisV1,
  type AgentRole,
} from '../src/shared/schemas.js';
import { PROPOSAL_CONTRACT, reactionContract, synthesisContract } from '../src/agents/contribution-contracts.js';
import { buildSystemInstruction } from '../src/agents/prompts.js';
import { EventLog } from '../src/shared/events.js';
import { MockProvider } from '../src/providers/mock.js';
import type { ModelProvider, ModelRequest, ModelResponse, TextRequest } from '../src/providers/types.js';
import { runMeeting } from '../src/workflows/meeting.js';
import { getBrief } from '../src/benchmarks/briefs.js';
import { computeSignals } from '../src/benchmarks/report.js';
import { testConfig, validProposal } from './helpers.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'devoffice-refusal-'));
}

const refusal = (overrides: Record<string, unknown> = {}) =>
  validProposal({
    agent_role: 'security',
    contribution_type: 'recommend_against',
    related_proposal_id: null,
    severity: 'critical',
    evidence: ['the brief grants finance staff read access to ANY student record'],
    recommended_change:
      'Reduce scope to a read-only summary with no cross-student access until the institution ' +
      'names a data owner.',
    rationale:
      'Real student financial records with no named legal owner cannot be responsibly scoped ' +
      'inside a two-month project.',
    ...overrides,
  });

/* ------------------------------------------------------------------ *
 * Fix 1 - a role can refuse
 * ------------------------------------------------------------------ */

describe('fix 1: recommend_against', () => {
  it('accepts a complete refusal', () => {
    expect(AgentContributionV1.safeParse(refusal()).success).toBe(true);
  });

  it('needs evidence from the brief, not a bare opinion', () => {
    const result = AgentContributionV1.safeParse(refusal({ evidence: [] }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('evidence');
  });

  it('needs to say what should happen instead', () => {
    const result = AgentContributionV1.safeParse(refusal({ recommended_change: null }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('not actionable');
  });

  it('rejects a refusal marked low severity, which contradicts itself', () => {
    for (const severity of ['info', 'low', 'medium']) {
      const result = AgentContributionV1.safeParse(refusal({ severity }));
      expect(result.success, `severity ${severity} must be rejected`).toBe(false);
    }
  });

  it('needs no citation, because it is about the brief not a colleague', () => {
    expect(AgentContributionV1.safeParse(refusal({ related_proposal_id: null })).success).toBe(true);
  });

  it('is allowed in round 1, so a role need not design something first', () => {
    expect(PROPOSAL_CONTRACT.validator.safeParse(refusal()).success).toBe(true);
  });

  it('is allowed in round 2 without citing a proposal', () => {
    const contract = reactionContract(['prop-ui_ux-home-01']);
    expect(contract.validator.safeParse(refusal()).success).toBe(true);
  });

  it('is offered to every role in the prompt, with its conditions', () => {
    const instruction = buildSystemInstruction({
      role: 'security',
      round: 1,
      projectId: 'p1',
      meetingId: 'm1',
    });
    expect(instruction).toContain('recommend_against');
    expect(instruction).toContain('unsafe to scope');
  });
});

/* ------------------------------------------------------------------ *
 * Fix 2 - every requirement is accounted for
 * ------------------------------------------------------------------ */

const decision = {
  decision_id: 'DEC-001',
  problem: 'How should finance staff access be constrained?',
  alternatives: [
    { name: 'Unrestricted staff read', pros: ['Simple'], cons: ['Unbounded insider exposure'] },
    { name: 'Scoped access with audit', pros: ['Limits blast radius'], cons: ['More work'] },
  ],
  selected: 'Scoped access with audit',
  rationale: 'Unbounded read over student financial records is not defensible for a first release.',
  rejected_reasons: ['Unrestricted read cannot be justified'],
  affected_requirements: ['REQ-001'],
  open_questions: [],
};

const synthesis = (overrides: Record<string, unknown> = {}) => ({
  consensus_summary:
    'The team settled on scoped staff access, server-side receipts and an immutable audit log.',
  verdict: 'proceed_with_conditions',
  verdict_justification:
    'The design is workable, but it handles real financial records and needs a named data owner first.',
  verdict_conditions: ['The institution names a legal owner for the records'],
  decisions: [decision],
  requirement_dispositions: [
    { requirement_id: 'REQ-001', status: 'decided', decision_id: 'DEC-001', note: 'Settled by DEC-001 above.' },
    { requirement_id: 'REQ-002', status: 'blocked', decision_id: null, note: 'Waits on the data-owner answer.' },
  ],
  changed_due_to_feedback: [],
  unresolved_blockers: [],
  ...overrides,
});

describe('fix 2: every requirement accounted for', () => {
  it('accepts a synthesis that covers every requirement it was given', () => {
    const contract = synthesisContract(['REQ-001', 'REQ-002']);
    expect(contract.validator.safeParse(synthesis()).success).toBe(true);
  });

  it('REGRESSION B3: rejects a synthesis that silently skips a requirement', () => {
    // REQ-003 is the shape of the one B3 lost: finance staff reading any
    // student's record. It was never mentioned and nothing noticed.
    const contract = synthesisContract(['REQ-001', 'REQ-002', 'REQ-003']);
    const result = contract.validator.safeParse(synthesis());

    expect(result.success).toBe(false);
    const issues = JSON.stringify(result.error?.issues);
    expect(issues).toContain('REQ-003');
    expect(issues).toContain('deferred or');
  });

  it('allows an unsettled requirement, as long as it says so out loud', () => {
    const contract = synthesisContract(['REQ-001', 'REQ-002']);
    const result = contract.validator.safeParse(
      synthesis({
        requirement_dispositions: [
          { requirement_id: 'REQ-001', status: 'decided', decision_id: 'DEC-001', note: 'Settled by DEC-001.' },
          { requirement_id: 'REQ-002', status: 'deferred', decision_id: null, note: 'Not needed for release one.' },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects "decided" with no decision named', () => {
    const contract = synthesisContract(['REQ-001']);
    const result = contract.validator.safeParse(
      synthesis({
        requirement_dispositions: [
          { requirement_id: 'REQ-001', status: 'decided', decision_id: null, note: 'Handled somewhere.' },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a decision id that does not exist', () => {
    const contract = synthesisContract(['REQ-001']);
    const result = contract.validator.safeParse(
      synthesis({
        requirement_dispositions: [
          { requirement_id: 'REQ-001', status: 'decided', decision_id: 'DEC-999', note: 'Points nowhere.' },
        ],
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('DEC-999');
  });

  it('rejects a requirement id invented out of thin air', () => {
    const contract = synthesisContract(['REQ-001']);
    const result = contract.validator.safeParse(
      synthesis({
        requirement_dispositions: [
          { requirement_id: 'REQ-001', status: 'decided', decision_id: 'DEC-001', note: 'Settled by DEC-001.' },
          { requirement_id: 'REQ-404', status: 'deferred', decision_id: null, note: 'This id never existed.' },
        ],
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('REQ-404');
  });
});

/* ------------------------------------------------------------------ *
 * Fix 3 - the change log has to say something
 * ------------------------------------------------------------------ */

describe('fix 3: the change log cannot be padded', () => {
  const change = (overrides: Record<string, unknown> = {}) => ({
    decision_id: 'DEC-001',
    triggered_by_role: 'security' as AgentRole,
    related_proposal_id: null,
    previous_position: 'Finance staff could read any student record',
    revised_position: 'Staff access is scoped and every read is logged',
    why: 'Security showed that unbounded staff read is the largest insider risk in the brief.',
    ...overrides,
  });

  it('accepts an entry that names the before and the after', () => {
    expect(TechLeadSynthesisV1.safeParse(synthesis({ changed_due_to_feedback: [change()] })).success).toBe(true);
  });

  it('REGRESSION B3: the old filler shape no longer fits the contract', () => {
    // What B3 actually produced: "Decision DEC-001 updated based on round-2
    // feedback". It satisfied a 10-character minimum and said nothing. There
    // is now no single field it can be written into.
    const result = TechLeadSynthesisV1.safeParse(
      synthesis({ changed_due_to_feedback: ['Decision DEC-001 updated based on round-2 feedback'] }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an entry where before and after are the same', () => {
    const result = TechLeadSynthesisV1.safeParse(
      synthesis({
        changed_due_to_feedback: [
          change({ previous_position: 'Scoped staff access', revised_position: 'scoped staff access' }),
        ],
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('nothing changed');
  });

  it('rejects a change attributed to a decision that was never recorded', () => {
    const result = TechLeadSynthesisV1.safeParse(
      synthesis({ changed_due_to_feedback: [change({ decision_id: 'DEC-777' })] }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('DEC-777');
  });

  it('accepts an empty log, because sometimes round 2 changes nothing', () => {
    expect(TechLeadSynthesisV1.safeParse(synthesis({ changed_due_to_feedback: [] })).success).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Verdict rules
 * ------------------------------------------------------------------ */

describe('project verdict', () => {
  it('a non-proceed verdict must list its conditions', () => {
    for (const verdict of ['proceed_with_conditions', 'do_not_proceed']) {
      const result = TechLeadSynthesisV1.safeParse(synthesis({ verdict, verdict_conditions: [] }));
      expect(result.success, `${verdict} with no conditions must be rejected`).toBe(false);
    }
  });

  it('a plain proceed needs no conditions', () => {
    expect(
      TechLeadSynthesisV1.safeParse(synthesis({ verdict: 'proceed', verdict_conditions: [] })).success,
    ).toBe(true);
  });

  it('the decisions prompt tells the Tech Lead that refusing is a legitimate output', () => {
    const instruction = buildSystemInstruction({
      role: 'tech_lead',
      round: 3,
      projectId: 'p1',
      meetingId: 'm1',
      outputContract: 'TechLeadDecisionsV1',
    });
    expect(instruction).toContain('do_not_proceed');
    expect(instruction).toContain('not a failure to plan');
  });

  it('the dispositions prompt insists every requirement is accounted for', () => {
    const instruction = buildSystemInstruction({
      role: 'tech_lead',
      round: 3,
      projectId: 'p1',
      meetingId: 'm1',
      outputContract: 'RequirementDispositionSetV1',
    });
    expect(instruction).toContain('ONE ENTRY FOR EVERY REQUIREMENT ID');
    expect(instruction).toContain('Leaving a requirement out is a validation failure');
    // And it is not handed the other call's instructions by mistake.
    expect(instruction).not.toContain('verdict_conditions');
  });
});

/* ------------------------------------------------------------------ *
 * End to end: refusal reaches the owner
 * ------------------------------------------------------------------ */

/** A provider whose Tech Lead refuses the project. */
class RefusingProvider implements ModelProvider {
  readonly name = 'mock';
  readonly simulated = true;
  readonly modelId = 'mock-template-v1';
  private readonly inner = new MockProvider();

  async generateStructured<T>(request: ModelRequest<T>): Promise<ModelResponse<T>> {
    const response = await this.inner.generateStructured(request);
    if (request.contract.schemaName !== 'TechLeadDecisionsV1') return response as ModelResponse<T>;

    const data = response.data as Record<string, unknown>;
    const refused = {
      ...data,
      verdict: 'do_not_proceed',
      verdict_justification:
        'This brief handles real student financial records and no party has been named as ' +
        'legally responsible for them.',
      verdict_conditions: ['The institution names a legal owner before any work starts'],
    };
    const validated = request.contract.validator.parse(refused);
    return { ...response, data: validated } as ModelResponse<T>;
  }

  generateText(request: TextRequest) {
    return this.inner.generateText(request);
  }
  checkAvailability() {
    return this.inner.checkAvailability();
  }
  lastRateLimitSnapshot() {
    return null;
  }
}

describe('a refusal reaches the Product Owner', () => {
  it('ends in NEEDS_OWNER_DECISION, not a quiet NEEDS_INPUT', async () => {
    const dir = freshDir();
    const log = new EventLog({ runsDir: dir, runId: 'run-refuse', projectId: 'p1' });

    const result = await runMeeting({
      provider: new RefusingProvider(),
      eventLog: log,
      config: testConfig(),
      brief: getBrief('b3-payment-portal').brief,
      projectId: 'p1',
      meetingId: 'm1',
      runId: 'run-refuse',
    });

    expect(result.state).toBe('NEEDS_OWNER_DECISION');
    expect(result.verdict).toBe('do_not_proceed');
    expect(result.verdictConditions.length).toBeGreaterThan(0);

    const terminal = log.readAll().at(-1);
    expect(terminal?.display_text).toContain('recommends AGAINST');

    // And it is not confused with a technical failure.
    expect(result.errorCode).toBeNull();
    expect(log.readAll().some((e) => e.event_type === 'meeting_blocked')).toBe(false);
  });

  it('a normal meeting is unaffected and still reaches NEEDS_INPUT', async () => {
    const dir = freshDir();
    const log = new EventLog({ runsDir: dir, runId: 'run-normal', projectId: 'p1' });

    const result = await runMeeting({
      provider: new MockProvider(),
      eventLog: log,
      config: testConfig(),
      brief: getBrief('b1-portfolio').brief,
      projectId: 'p1',
      meetingId: 'm1',
      runId: 'run-normal',
    });

    expect(result.state).toBe('NEEDS_INPUT');
    expect(result.verdict).toBe('proceed_with_conditions');
  });

  it('the report counts requirement coverage, not just ADR mentions', async () => {
    const dir = freshDir();
    const log = new EventLog({ runsDir: dir, runId: 'run-coverage', projectId: 'p1' });

    const result = await runMeeting({
      provider: new MockProvider(),
      eventLog: log,
      config: testConfig(),
      brief: getBrief('b1-portfolio').brief,
      projectId: 'p1',
      meetingId: 'm1',
      runId: 'run-coverage',
    });

    const signals = computeSignals(result, log.readUsage());
    expect(signals.requirementCoverage.unaccountedFor).toEqual([]);
    expect(signals.requirementCoverage.withADisposition).toBe(signals.requirementCoverage.requirements);
    expect(signals.projectVerdict.verdict).toBe('proceed_with_conditions');
  });
});
