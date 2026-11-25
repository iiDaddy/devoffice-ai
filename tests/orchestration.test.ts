/**
 * Meeting orchestration, roster selection and checkpoint/resume
 * (LLD 7, 10; tests T02, T03-style replay, T06, T07, T13, T14).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventLog } from '../src/shared/events.js';
import { DevOfficeError } from '../src/shared/errors.js';
import { MockProvider } from '../src/providers/mock.js';
import type { ModelProvider, ModelRequest, ModelResponse, TextRequest } from '../src/providers/types.js';
import { selectRoster } from '../src/agents/roles.js';
import { getBrief } from '../src/benchmarks/briefs.js';
import { runMeeting } from '../src/workflows/meeting.js';
import { computeSignals } from '../src/benchmarks/report.js';
import { testConfig } from './helpers.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'devoffice-meeting-'));
}

/** A MockProvider that fails on the Nth structured call, to simulate a crash. */
class FailAfterProvider implements ModelProvider {
  readonly name = 'mock';
  readonly simulated = true;
  readonly modelId = 'mock-template-v1';
  private calls = 0;
  private readonly inner = new MockProvider();

  constructor(
    private readonly failAtCall: number,
    private readonly error: DevOfficeError,
  ) {}

  get callCount(): number {
    return this.calls;
  }

  async generateStructured<T>(request: ModelRequest<T>): Promise<ModelResponse<T>> {
    this.calls += 1;
    if (this.calls === this.failAtCall) throw this.error;
    return this.inner.generateStructured(request);
  }

  generateText(request: TextRequest): Promise<ModelResponse<string>> {
    return this.inner.generateText(request);
  }

  checkAvailability() {
    return this.inner.checkAvailability();
  }

  lastRateLimitSnapshot() {
    return null;
  }
}

describe('roster selection is deterministic (T02)', () => {
  it('does NOT activate Backend for the portfolio brief', () => {
    const roster = selectRoster(getBrief('b1-portfolio').brief);
    expect(roster.roles).not.toContain('backend');
    expect(roster.roles).toEqual(['pm', 'ui_ux', 'frontend', 'security', 'qa', 'tech_lead']);
    expect(roster.reasoning.join(' ')).toContain('explicitly rules out a backend');
  });

  it('DOES activate Backend for the payment-portal brief', () => {
    const roster = selectRoster(getBrief('b3-payment-portal').brief);
    expect(roster.roles).toContain('backend');
    expect(roster.reasoning.join(' ')).toMatch(/login|payment|receipt/);
  });

  it('activates Backend for the event brief, where the fork actually lives', () => {
    const roster = selectRoster(getBrief('b2-event-landing').brief);
    expect(roster.roles).toContain('backend');
  });

  it('matches on word boundaries, not substrings', () => {
    // "official" contains "ci"; "display" contains "pay"; "sandbox" contains "db".
    const roster = selectRoster({
      title: 'Official Display Sandbox',
      objective: 'A page that shows official display content inside a sandbox.',
      requested_features: ['Home'],
      constraints: [],
    });
    expect(roster.roles).not.toContain('devops');
    expect(roster.roles).not.toContain('backend');
  });

  it('always includes the six core planning roles', () => {
    for (const id of ['b1-portfolio', 'b2-event-landing', 'b3-payment-portal']) {
      const roster = selectRoster(getBrief(id).brief);
      for (const core of ['pm', 'ui_ux', 'frontend', 'security', 'qa', 'tech_lead']) {
        expect(roster.roles, `${id} must include ${core}`).toContain(core);
      }
    }
  });
});

describe('three-round meeting (LLD 7)', () => {
  it('runs all three rounds and persists an ordered event log', async () => {
    const dir = freshDir();
    const log = new EventLog({ runsDir: dir, runId: 'run-a', projectId: 'p1' });

    const result = await runMeeting({
      provider: new MockProvider(),
      eventLog: log,
      config: testConfig(),
      brief: getBrief('b1-portfolio').brief,
      projectId: 'p1',
      meetingId: 'm1',
      runId: 'run-a',
    });

    expect(result.requirements).not.toBeNull();
    expect(result.proposals.length).toBe(4); // ui_ux, frontend, security, qa
    expect(result.reactions.length).toBe(4);
    expect(result.synthesis).not.toBeNull();
    expect(result.simulated).toBe(true);

    const events = log.readAll();
    expect(events.map((e) => e.sequence_number)).toEqual(
      Array.from({ length: events.length }, (_, i) => i + 1),
    );
    const types = events.map((e) => e.event_type);
    expect(types[0]).toBe('meeting_started');
    expect(types.filter((t) => t === 'round_started')).toHaveLength(3);
    expect(types).toContain('decision_recorded');
  });

  it('every round-2 contribution is a reaction citing a real proposal', async () => {
    const dir = freshDir();
    const log = new EventLog({ runsDir: dir, runId: 'run-b', projectId: 'p1' });

    const result = await runMeeting({
      provider: new MockProvider(),
      eventLog: log,
      config: testConfig(),
      brief: getBrief('b2-event-landing').brief,
      projectId: 'p1',
      meetingId: 'm1',
      runId: 'run-b',
    });

    const knownIds = new Set(result.proposals.map((p) => p.proposal_id));
    expect(result.reactions.length).toBeGreaterThan(0);
    for (const reaction of result.reactions) {
      expect(reaction.contribution_type).not.toBe('proposal');
      expect(knownIds.has(reaction.related_proposal_id ?? '')).toBe(true);
      // And a role never reviews its own work.
      const cited = result.proposals.find((p) => p.proposal_id === reaction.related_proposal_id);
      expect(cited?.agent_role).not.toBe(reaction.agent_role);
    }
  });

  it('T07: unanswered questions end the meeting in NEEDS_INPUT, not completion', async () => {
    const dir = freshDir();
    const log = new EventLog({ runsDir: dir, runId: 'run-c', projectId: 'p1' });

    const result = await runMeeting({
      provider: new MockProvider(),
      eventLog: log,
      config: testConfig(),
      brief: getBrief('b1-portfolio').brief,
      projectId: 'p1',
      meetingId: 'm1',
      runId: 'run-c',
    });

    expect(result.state).toBe('NEEDS_INPUT');
    expect(result.blockingQuestions.length).toBeGreaterThan(0);
    expect(log.readAll().some((e) => e.event_type === 'needs_input')).toBe(true);
    // A meeting is never "complete" just because the model stopped talking.
    expect(log.readAll().some((e) => e.event_type === 'meeting_completed')).toBe(false);
  });

  it('lists each blocking question once, even when PM and Tech Lead both raise it', async () => {
    const dir = freshDir();
    const log = new EventLog({ runsDir: dir, runId: 'run-dedupe', projectId: 'p1' });

    // The template provider has the PM and the Tech Lead raise the same
    // contact-channel question, which is exactly what happened on real B1.
    const result = await runMeeting({
      provider: new MockProvider(),
      eventLog: log,
      config: testConfig(),
      brief: getBrief('b1-portfolio').brief,
      projectId: 'p1',
      meetingId: 'm1',
      runId: 'run-dedupe',
    });

    const normalised = result.blockingQuestions.map((q) => q.toLowerCase());
    expect(new Set(normalised).size).toBe(normalised.length);
    expect(result.blockingQuestions.length).toBeGreaterThan(0);
  });

  it('counts attempted calls separately from successful ones', async () => {
    const dir = freshDir();
    const log = new EventLog({ runsDir: dir, runId: 'run-attempts', projectId: 'p1' });
    const failing = new FailAfterProvider(
      2,
      new DevOfficeError('OUTPUT_TRUNCATED', 'cut off', { retryable: false }),
    );

    const result = await runMeeting({
      provider: failing,
      eventLog: log,
      config: testConfig(),
      brief: getBrief('b1-portfolio').brief,
      projectId: 'p1',
      meetingId: 'm1',
      runId: 'run-attempts',
    });

    expect(result.state).toBe('BLOCKED');
    expect(result.errorCode).toBe('OUTPUT_TRUNCATED');
    expect(result.modelCalls).toBe(1);
    expect(result.modelAttempts).toBe(2);
  });

  it('honours MEETING_MAX_ROUNDS=1 and skips the later rounds', async () => {
    const dir = freshDir();
    const log = new EventLog({ runsDir: dir, runId: 'run-d', projectId: 'p1' });

    const result = await runMeeting({
      provider: new MockProvider(),
      eventLog: log,
      config: testConfig({ MEETING_MAX_ROUNDS: '1' }),
      brief: getBrief('b1-portfolio').brief,
      projectId: 'p1',
      meetingId: 'm1',
      runId: 'run-d',
    });

    expect(result.reactions).toHaveLength(0);
    expect(result.synthesis).toBeNull();
    expect(log.readAll().filter((e) => e.event_type === 'round_started')).toHaveLength(1);
  });
});

describe('quota exhaustion and resume (T13, T14)', () => {
  const quotaError = new DevOfficeError('QUOTA_EXHAUSTED', 'Daily quota gone', {
    retryable: false,
    retryAfterMs: 7_200_000,
  });

  it('T13: a quota wall blocks the run without losing completed work', async () => {
    const dir = freshDir();
    const log = new EventLog({ runsDir: dir, runId: 'run-e', projectId: 'p1' });

    const result = await runMeeting({
      provider: new FailAfterProvider(4, quotaError),
      eventLog: log,
      config: testConfig(),
      brief: getBrief('b1-portfolio').brief,
      projectId: 'p1',
      meetingId: 'm1',
      runId: 'run-e',
    });

    expect(result.state).toBe('BLOCKED');
    expect(result.errorCode).toBe('QUOTA_EXHAUSTED');
    // Calls 1-3 succeeded, so their output must be on disk.
    expect(result.requirements).not.toBeNull();
    expect(result.proposals).toHaveLength(2);

    const blocked = log.readAll().find((e) => e.event_type === 'meeting_blocked');
    expect(blocked).toBeDefined();
    expect((blocked?.payload_json as { resumable: boolean }).resumable).toBe(true);
    expect((blocked?.payload_json as { code: string }).code).toBe('QUOTA_EXHAUSTED');
  });

  it('T14: resuming the same runId replays checkpoints instead of re-buying them', async () => {
    const dir = freshDir();

    // First attempt dies on the 4th call.
    const firstLog = new EventLog({ runsDir: dir, runId: 'run-f', projectId: 'p1' });
    const failing = new FailAfterProvider(4, quotaError);
    const firstRun = await runMeeting({
      provider: failing,
      eventLog: firstLog,
      config: testConfig(),
      brief: getBrief('b1-portfolio').brief,
      projectId: 'p1',
      meetingId: 'm1',
      runId: 'run-f',
    });
    expect(firstRun.state).toBe('BLOCKED');
    const eventsAfterCrash = firstLog.readAll().length;

    // Second attempt: brand-new log object over the same directory and runId,
    // exactly as a restarted worker would see it.
    const resumedLog = new EventLog({ runsDir: dir, runId: 'run-f', projectId: 'p1' });
    const healthy = new FailAfterProvider(Number.POSITIVE_INFINITY, quotaError);
    const resumed = await runMeeting({
      provider: healthy,
      eventLog: resumedLog,
      config: testConfig(),
      brief: getBrief('b1-portfolio').brief,
      projectId: 'p1',
      meetingId: 'm1',
      runId: 'run-f',
    });

    expect(resumed.state).toBe('NEEDS_INPUT');
    // The three contributions already on disk were replayed, not re-requested.
    expect(resumed.replayedFromLog).toBe(3);
    expect(healthy.callCount).toBe(9 - 3 + 1);

    // No duplicate events: the sequence is still strictly increasing with no
    // repeated idempotency key.
    const all = resumedLog.readAll();
    expect(all.length).toBeGreaterThan(eventsAfterCrash);
    expect(all.map((e) => e.sequence_number)).toEqual(
      Array.from({ length: all.length }, (_, i) => i + 1),
    );
    const keys = all.map((e) => e.idempotency_key).filter((k): k is string => k !== null);
    expect(new Set(keys).size).toBe(keys.length);

    // And the meeting really did finish all three rounds.
    expect(resumed.proposals).toHaveLength(4);
    expect(resumed.reactions).toHaveLength(4);
    expect(resumed.synthesis).not.toBeNull();
  });

  it('records a failed call in the usage log with its error code', async () => {
    const dir = freshDir();
    const log = new EventLog({ runsDir: dir, runId: 'run-g', projectId: 'p1' });

    await runMeeting({
      provider: new FailAfterProvider(2, quotaError),
      eventLog: log,
      config: testConfig(),
      brief: getBrief('b1-portfolio').brief,
      projectId: 'p1',
      meetingId: 'm1',
      runId: 'run-g',
    });

    const usage = log.readUsage();
    const failed = usage.filter((u) => u.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error_code).toBe('QUOTA_EXHAUSTED');
    expect(failed[0]?.cost_reported).toBeNull();
  });
});

describe('evidence signals', () => {
  it('counts what it can check and leaves judgement to a human', async () => {
    const dir = freshDir();
    const log = new EventLog({ runsDir: dir, runId: 'run-h', projectId: 'p1' });

    const result = await runMeeting({
      provider: new MockProvider(),
      eventLog: log,
      config: testConfig(),
      brief: getBrief('b1-portfolio').brief,
      projectId: 'p1',
      meetingId: 'm1',
      runId: 'run-h',
    });

    const signals = computeSignals(result, log.readUsage());

    expect(signals.challengeQuality.reactions).toBe(4);
    expect(signals.challengeQuality.danglingCitations).toHaveLength(0);
    expect(signals.challengeQuality.citingAKnownProposal).toBe(4);
    expect(signals.decisionRationale.decisions).toBe(1);
    expect(signals.decisionRationale.passingAdrValidation).toBe(1);
    // Usage is null throughout because the template provider reports none -
    // the report must not invent numbers to fill the gap.
    expect(signals.usage.reportedPromptTokens).toBeNull();

    // The template provider writes identical boilerplate, so similarity is
    // high. That is the correct signal for output with no reasoning behind it.
    expect(signals.roleSpecialisation.maxPairwiseSimilarity).toBeGreaterThan(0.8);
  });
});
