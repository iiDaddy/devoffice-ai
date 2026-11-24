/**
 * Evidence report for a benchmark run.
 *
 * The distinction this file is careful about:
 *
 *   SIGNALS are things a program can check - does an objection cite a
 *   proposal that exists, does an ADR weigh two alternatives, is every
 *   requirement referenced somewhere. They are computed and reported as
 *   numbers.
 *
 *   RUBRIC SCORES (LLD 14.2) are judgements - "specific, evidence-based
 *   objection" versus "generic critique". A program cannot tell those apart
 *   honestly, and the LLD says to "review manually with actual transcripts".
 *   So the score columns are emitted BLANK for a human to fill in.
 *
 * Auto-filling those scores would turn the acceptance gate into a formality,
 * which is exactly the "evidence over theatre" failure the HLD warns about.
 */
import { ArchitectureDecisionV1, type AgentContributionV1 } from '../shared/schemas.js';
import type { UsageRecord } from '../shared/events.js';
import type { MeetingResult } from '../workflows/meeting.js';
import type { BenchmarkBrief } from './briefs.js';

/** Boilerplate that scores 0 on "Security/QA signal" in LLD 14.2. */
const GENERIC_PHRASES = [
  'use https', 'validate input', 'sanitize input', 'follow best practices',
  'keep dependencies updated', 'use strong passwords', 'implement logging',
  'ensure security', 'test thoroughly', 'use a firewall',
];

export interface SignalSet {
  readonly roleSpecialisation: {
    readonly proposals: number;
    readonly maxPairwiseSimilarity: number;
    readonly mostSimilarPair: string | null;
  };
  readonly challengeQuality: {
    readonly reactions: number;
    readonly objections: number;
    readonly citingAKnownProposal: number;
    readonly withEvidence: number;
    readonly withRecommendedChange: number;
    readonly danglingCitations: readonly string[];
  };
  readonly decisionRationale: {
    readonly decisions: number;
    readonly passingAdrValidation: number;
    readonly failures: readonly string[];
  };
  readonly requirementTraceability: {
    readonly requirements: number;
    readonly referencedByAnAdr: number;
    readonly orphanRequirementIds: readonly string[];
  };
  readonly securityQaSignal: {
    readonly securityContributions: number;
    readonly qaContributions: number;
    readonly genericPhrasesDetected: readonly string[];
    readonly severitiesUsed: readonly string[];
  };
  readonly stateCorrectness: {
    readonly terminalState: string;
    readonly buildAttemptsRejected: number;
    readonly approvalEventsFound: number;
  };
  readonly quotaRecovery: {
    readonly blocked: boolean;
    readonly errorCode: string | null;
    readonly contributionsPreserved: number;
    readonly replayedFromLog: number;
  };
  readonly usage: {
    readonly calls: number;
    readonly reportedPromptTokens: number | null;
    readonly reportedCompletionTokens: number | null;
    readonly transportRetries: number;
    readonly validationRetries: number;
    readonly failedCalls: number;
  };
}

function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function computeSignals(result: MeetingResult, usage: readonly UsageRecord[]): SignalSet {
  /* role specialisation: are the proposals actually different documents? */
  let maxSimilarity = 0;
  let mostSimilarPair: string | null = null;
  for (let i = 0; i < result.proposals.length; i += 1) {
    for (let j = i + 1; j < result.proposals.length; j += 1) {
      const left = result.proposals[i] as AgentContributionV1;
      const right = result.proposals[j] as AgentContributionV1;
      const similarity = jaccard(
        tokenise(`${left.summary} ${left.rationale}`),
        tokenise(`${right.summary} ${right.rationale}`),
      );
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
        mostSimilarPair = `${left.agent_role} vs ${right.agent_role}`;
      }
    }
  }

  /* challenge quality */
  const knownProposalIds = new Set(result.proposals.map((p) => p.proposal_id));
  const objections = result.reactions.filter((r) => r.contribution_type === 'objection');
  const dangling: string[] = [];
  let citing = 0;
  for (const reaction of result.reactions) {
    if (reaction.related_proposal_id === null) continue;
    if (knownProposalIds.has(reaction.related_proposal_id)) citing += 1;
    else dangling.push(`${reaction.agent_role} cited unknown id "${reaction.related_proposal_id}"`);
  }

  /* decision rationale */
  const decisions = result.synthesis?.decisions ?? [];
  const adrFailures: string[] = [];
  let adrPassing = 0;
  for (const decision of decisions) {
    const checked = ArchitectureDecisionV1.safeParse(decision);
    if (checked.success) adrPassing += 1;
    else {
      adrFailures.push(
        `${decision.decision_id}: ${checked.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
  }

  /* requirement traceability */
  const requirementIds = (result.requirements?.requirements ?? []).map((r) => r.id);
  const referenced = new Set(decisions.flatMap((d) => d.affected_requirements));
  const orphans = requirementIds.filter((id) => !referenced.has(id));

  /* security / QA signal */
  const allContributions = [...result.proposals, ...result.reactions];
  const securityText = allContributions
    .filter((c) => c.agent_role === 'security')
    .map((c) => `${c.summary} ${c.rationale} ${c.risks.join(' ')}`)
    .join(' ')
    .toLowerCase();
  const generic = GENERIC_PHRASES.filter((phrase) => securityText.includes(phrase));

  /* usage, reported only - never estimated */
  const reportedPrompt = usage.reduce<number | null>(
    (sum, record) => (record.prompt_tokens === null ? sum : (sum ?? 0) + record.prompt_tokens),
    null,
  );
  const reportedCompletion = usage.reduce<number | null>(
    (sum, record) => (record.completion_tokens === null ? sum : (sum ?? 0) + record.completion_tokens),
    null,
  );

  return {
    roleSpecialisation: {
      proposals: result.proposals.length,
      maxPairwiseSimilarity: Number(maxSimilarity.toFixed(3)),
      mostSimilarPair,
    },
    challengeQuality: {
      reactions: result.reactions.length,
      objections: objections.length,
      citingAKnownProposal: citing,
      withEvidence: objections.filter((o) => o.evidence.length > 0).length,
      withRecommendedChange: objections.filter(
        (o) => o.recommended_change !== null && o.recommended_change.trim() !== '',
      ).length,
      danglingCitations: dangling,
    },
    decisionRationale: {
      decisions: decisions.length,
      passingAdrValidation: adrPassing,
      failures: adrFailures,
    },
    requirementTraceability: {
      requirements: requirementIds.length,
      referencedByAnAdr: requirementIds.length - orphans.length,
      orphanRequirementIds: orphans,
    },
    securityQaSignal: {
      securityContributions: allContributions.filter((c) => c.agent_role === 'security').length,
      qaContributions: allContributions.filter((c) => c.agent_role === 'qa').length,
      genericPhrasesDetected: generic,
      severitiesUsed: [...new Set(allContributions.map((c) => c.severity))],
    },
    stateCorrectness: {
      terminalState: result.state,
      buildAttemptsRejected: 0,
      approvalEventsFound: 0,
    },
    quotaRecovery: {
      blocked: result.state === 'BLOCKED',
      errorCode: result.errorCode,
      contributionsPreserved:
        result.proposals.length + result.reactions.length + (result.requirements === null ? 0 : 1),
      replayedFromLog: result.replayedFromLog,
    },
    usage: {
      calls: usage.length,
      reportedPromptTokens: reportedPrompt,
      reportedCompletionTokens: reportedCompletion,
      transportRetries: usage.reduce((sum, r) => sum + Math.max(0, r.transport_attempts - 1), 0),
      validationRetries: usage.reduce((sum, r) => sum + r.validation_retries, 0),
      failedCalls: usage.filter((r) => r.status === 'failed').length,
    },
  };
}

/** The eight rubric rows from LLD 14.2, left blank for a human. */
const RUBRIC_ROWS: ReadonlyArray<{ metric: string; signalHint: string }> = [
  { metric: 'Role specialization', signalHint: 'max pairwise similarity of proposals' },
  { metric: 'Challenge quality', signalHint: 'objections citing a real proposal, with evidence + fix' },
  { metric: 'Decision rationale', signalHint: 'ADRs passing the two-alternatives rule' },
  { metric: 'Requirement traceability', signalHint: 'requirements referenced by an ADR' },
  { metric: 'Security/QA signal', signalHint: 'generic phrases detected; severities used' },
  { metric: 'Spec completeness', signalHint: 'NOT APPLICABLE AT M0 - spec generation is M3' },
  { metric: 'State/approval correctness', signalHint: 'terminal state; build attempts rejected' },
  { metric: 'Quota/recovery handling', signalHint: 'blocked-but-resumable; contributions preserved' },
];

export function renderMarkdownReport(options: {
  readonly brief: BenchmarkBrief;
  readonly result: MeetingResult;
  readonly signals: SignalSet;
  readonly usage: readonly UsageRecord[];
  readonly eventCount: number;
  readonly eventsPath: string;
  readonly startedAt: string;
  readonly durationMs: number;
}): string {
  const { brief, result, signals } = options;
  const lines: string[] = [];

  lines.push(`# M0 benchmark evidence - ${brief.label}`);
  lines.push('');

  if (result.simulated) {
    lines.push('> ## THIS RUN IS SIMULATED');
    lines.push('>');
    lines.push('> It used the template provider in `src/providers/mock.ts`, not a language model.');
    lines.push('> The text below is filled-in boilerplate with no reasoning behind it.');
    lines.push('> It demonstrates that the wiring works - schemas, event log, sequence numbers,');
    lines.push('> throttle, state transitions - and NOTHING about agent discussion quality.');
    lines.push('> The LLD 14.2 rubric MUST NOT be scored from this run.');
    lines.push('');
  }

  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Brief | \`${brief.id}\` |`);
  lines.push(`| Run id | \`${result.runId}\` |`);
  lines.push(`| Started | ${options.startedAt} |`);
  lines.push(`| Duration | ${(options.durationMs / 1000).toFixed(1)}s |`);
  lines.push(`| Terminal state | **${result.state}** |`);
  lines.push(`| Provider | ${result.simulated ? 'mock (SIMULATED)' : 'groq'} |`);
  lines.push(`| Model calls made | ${result.modelCalls} |`);
  lines.push(`| Replayed from log | ${result.replayedFromLog} |`);
  lines.push(`| Events persisted | ${options.eventCount} |`);
  lines.push(`| Event log | \`${options.eventsPath}\` |`);
  if (result.errorCode !== null) {
    lines.push(`| Error | \`${result.errorCode}\` - ${result.errorMessage ?? ''} |`);
  }
  lines.push('');

  lines.push('## Roster decision (deterministic, not a model call)');
  lines.push('');
  lines.push(`Selected: ${result.roster.map((r) => `\`${r}\``).join(', ')}`);
  lines.push('');
  for (const reason of result.rosterReasoning) lines.push(`- ${reason}`);
  lines.push('');

  lines.push('## Machine-checkable signals');
  lines.push('');
  lines.push('These are counted by code, not judged. They do not score the rubric.');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(signals, null, 2));
  lines.push('```');
  lines.push('');

  lines.push('## Transcript');
  lines.push('');
  if (result.requirements !== null) {
    lines.push('### Round 1 - Product Manager requirements');
    lines.push('');
    for (const requirement of result.requirements.requirements) {
      lines.push(
        `- \`${requirement.id}\` **${requirement.priority}** (${requirement.source}): ${requirement.statement}`,
      );
    }
    if (result.requirements.missing_questions.length > 0) {
      lines.push('');
      lines.push('Open questions raised:');
      for (const question of result.requirements.missing_questions) lines.push(`- ${question}`);
    }
    lines.push('');
  }

  if (result.proposals.length > 0) {
    lines.push('### Round 1 - specialist proposals');
    lines.push('');
    for (const proposal of result.proposals) {
      lines.push(`#### ${proposal.agent_role} - \`${proposal.proposal_id}\` (${proposal.severity})`);
      lines.push('');
      lines.push(`**${proposal.topic}**`);
      lines.push('');
      lines.push(proposal.summary);
      lines.push('');
      lines.push(`*Rationale:* ${proposal.rationale}`);
      if (proposal.risks.length > 0) lines.push(`*Risks:* ${proposal.risks.join('; ')}`);
      lines.push('');
    }
  }

  if (result.reactions.length > 0) {
    lines.push('### Round 2 - cross-review');
    lines.push('');
    for (const reaction of result.reactions) {
      lines.push(
        `#### ${reaction.agent_role} - **${reaction.contribution_type}** on ` +
          `\`${reaction.related_proposal_id ?? 'n/a'}\` (${reaction.severity})`,
      );
      lines.push('');
      lines.push(reaction.summary);
      lines.push('');
      lines.push(`*Why:* ${reaction.rationale}`);
      if (reaction.evidence.length > 0) lines.push(`*Evidence:* ${reaction.evidence.join('; ')}`);
      if (reaction.recommended_change !== null) {
        lines.push(`*Recommended change:* ${reaction.recommended_change}`);
      }
      lines.push('');
    }
  }

  if (result.synthesis !== null) {
    lines.push('### Round 3 - decision synthesis');
    lines.push('');
    lines.push(result.synthesis.consensus_summary);
    lines.push('');
    for (const decision of result.synthesis.decisions) {
      lines.push(`#### ADR \`${decision.decision_id}\` - selected: **${decision.selected}**`);
      lines.push('');
      lines.push(`*Problem:* ${decision.problem}`);
      lines.push('');
      for (const alternative of decision.alternatives) {
        lines.push(
          `- **${alternative.name}** - pros: ${alternative.pros.join(', ') || '(none given)'} | ` +
            `cons: ${alternative.cons.join(', ') || '(none given)'}`,
        );
      }
      lines.push('');
      lines.push(`*Rationale:* ${decision.rationale}`);
      lines.push(`*Affects:* ${decision.affected_requirements.join(', ') || '(nothing named)'}`);
      lines.push('');
    }
    if (result.synthesis.changed_due_to_feedback.length > 0) {
      lines.push('**Changed because of round-2 feedback:**');
      lines.push('');
      for (const change of result.synthesis.changed_due_to_feedback) lines.push(`- ${change}`);
      lines.push('');
    }
  }

  if (result.blockingQuestions.length > 0) {
    lines.push('### Blocking questions (state NEEDS_INPUT)');
    lines.push('');
    for (const question of result.blockingQuestions) lines.push(`- ${question}`);
    lines.push('');
  }

  lines.push('## What a competent team had to do on this brief');
  lines.push('');
  for (const expectation of brief.expectations) lines.push(`- [ ] ${expectation}`);
  lines.push('');
  lines.push('## Red flags - tick means the run FAILED, however polished it reads');
  lines.push('');
  for (const flag of brief.red_flags) lines.push(`- [ ] ${flag}`);
  lines.push('');

  lines.push('## Rubric (LLD 14.2) - TO BE SCORED BY A HUMAN');
  lines.push('');
  lines.push('Scores are deliberately blank. Fill them in from the transcript above.');
  lines.push('Gate proposed by the LLD: at least 13/16 on two of three briefs, with no zero on');
  lines.push('"State/approval correctness".');
  lines.push('');
  lines.push('| Metric | Score (0/1/2) | Supporting signal | Note |');
  lines.push('|---|---|---|---|');
  for (const row of RUBRIC_ROWS) {
    lines.push(`| ${row.metric} | _ | ${row.signalHint} | |`);
  }
  lines.push('');
  lines.push(`**Total: _ / 16**  (scored by: ______________  date: __________)`);
  lines.push('');

  return lines.join('\n');
}
