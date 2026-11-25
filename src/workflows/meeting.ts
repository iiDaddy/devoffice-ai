/**
 * Three-round meeting orchestration (LLD 7).
 *
 * This is the deterministic part. It decides who speaks, what each role is
 * allowed to see, when the meeting stops, and what gets persisted. The model
 * only fills in contributions; it never drives control flow. That is the whole
 * point of HLD 4: "Orchestrator bukan seorang AI employee."
 *
 * Three properties worth knowing about before reading the code:
 *
 * CONTEXT IS NARROWED ON PURPOSE (LLD 7 "Efficiency"). A role never receives a
 * replay of every raw message. Round 2 gets compact digests of OTHER roles'
 * proposals. With a per-minute token ceiling as low as 8K, replaying the whole
 * transcript to eight roles would spend the budget on quotation.
 *
 * EVERY MODEL CALL IS CHECKPOINTED BEFORE THE NEXT ONE STARTS, and keyed. Kill
 * the process mid-meeting, run it again with the same runId, and completed
 * contributions are replayed from the log instead of re-bought from the
 * provider (LLD 10, test T14).
 *
 * QUOTA EXHAUSTION IS NOT A CRASH. It ends the run as BLOCKED with everything
 * completed so far intact and resumable (LLD 4.3 item 5, test T13).
 */
import { DevOfficeError, isDevOfficeError } from '../shared/errors.js';
import type { AppConfig } from '../shared/config.js';
import type { EventLog, RunEvent } from '../shared/events.js';
import type { AgentContributionV1 } from '../shared/schemas.js';
import {
  ArchitectureDecisionV1,
  type AgentRole,
  type ProjectBriefV1,
  type RequirementSetV1,
  RequirementSetV1 as RequirementSetSchema,
  type TechLeadSynthesisV1,
} from '../shared/schemas.js';
import { defineContract } from '../providers/contracts.js';
import type { ModelProvider } from '../providers/types.js';
import { ROLE_DEFINITIONS, selectRoster } from '../agents/roles.js';
import { buildSystemInstruction, buildUserPayload } from '../agents/prompts.js';
import {
  PROPOSAL_CONTRACT,
  reactionContract,
  synthesisContract,
} from '../agents/contribution-contracts.js';

/* ------------------------------------------------------------------ *
 * Output contracts, built once (the strict-mode guard runs here)
 * ------------------------------------------------------------------ */

const REQUIREMENTS_CONTRACT = defineContract<RequirementSetV1>(
  'RequirementSetV1',
  RequirementSetSchema,
  RequirementSetSchema,
);

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/**
 * Terminal states reachable in M0. SPEC_READY belongs to M3.
 *
 * NEEDS_OWNER_DECISION is separate from BLOCKED on purpose. BLOCKED means the
 * machinery stopped - quota, provider, a crash - and resuming continues. This
 * one means the team did its work and concluded the project should not go
 * ahead as scoped. Nothing technical is wrong, and resuming would change
 * nothing: a person has to decide.
 */
export type MeetingState =
  | 'MEETING_COMPLETED'
  | 'NEEDS_INPUT'
  | 'NEEDS_OWNER_DECISION'
  | 'BLOCKED';

export interface MeetingResult {
  readonly state: MeetingState;
  readonly runId: string;
  readonly meetingId: string;
  readonly projectId: string;
  readonly roster: readonly AgentRole[];
  readonly rosterReasoning: readonly string[];
  readonly requirements: RequirementSetV1 | null;
  readonly proposals: readonly AgentContributionV1[];
  readonly reactions: readonly AgentContributionV1[];
  readonly synthesis: TechLeadSynthesisV1 | null;
  readonly blockingQuestions: readonly string[];
  /** The team's verdict on the project, when round 3 ran. */
  readonly verdict: TechLeadSynthesisV1['verdict'] | null;
  readonly verdictJustification: string | null;
  readonly verdictConditions: readonly string[];
  /** Roles that recommended against the project in rounds 1 or 2. */
  readonly recommendedAgainstBy: readonly AgentRole[];
  /** Model calls that returned a valid contribution. */
  readonly modelCalls: number;
  /**
   * Model calls actually made, successful or not. Reported separately because
   * "0 calls" after a failed resume read as if nothing had been tried, when one
   * call had been made, had failed, and had spent quota.
   */
  readonly modelAttempts: number;
  readonly replayedFromLog: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /** True when ANY contribution came from a simulated provider. */
  readonly simulated: boolean;
}

export interface MeetingOptions {
  readonly provider: ModelProvider;
  readonly eventLog: EventLog;
  readonly config: AppConfig;
  readonly brief: ProjectBriefV1;
  readonly projectId: string;
  readonly meetingId: string;
  readonly runId: string;
  readonly onProgress?: (line: string) => void;
}

/* ------------------------------------------------------------------ *
 * Context digests - what each role is allowed to see
 * ------------------------------------------------------------------ */

function digestProposal(contribution: AgentContributionV1): Record<string, unknown> {
  return {
    proposal_id: contribution.proposal_id,
    agent_role: contribution.agent_role,
    topic: contribution.topic,
    summary: contribution.summary,
    rationale: contribution.rationale,
    risks: contribution.risks,
    severity: contribution.severity,
  };
}

function digestReaction(contribution: AgentContributionV1): Record<string, unknown> {
  return {
    agent_role: contribution.agent_role,
    contribution_type: contribution.contribution_type,
    related_proposal_id: contribution.related_proposal_id,
    summary: contribution.summary,
    recommended_change: contribution.recommended_change,
    severity: contribution.severity,
  };
}

function digestRequirements(requirements: RequirementSetV1): Record<string, unknown> {
  return {
    goals: requirements.goals,
    requirements: requirements.requirements.map((r) => ({
      id: r.id,
      statement: r.statement,
      priority: r.priority,
    })),
    in_scope: requirements.in_scope,
    out_of_scope: requirements.out_of_scope,
    open_questions: requirements.missing_questions,
  };
}

function uniqueQuestions(questions: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const question of questions) {
    const key = question.trim().toLowerCase().replace(/\s+/g, ' ');
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(question.trim());
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The runner
 * ------------------------------------------------------------------ */

export async function runMeeting(options: MeetingOptions): Promise<MeetingResult> {
  const { provider, eventLog, config, brief, projectId, meetingId, runId } = options;
  const say = options.onProgress ?? ((): void => {});

  // Replay index: idempotency key -> already-persisted event.
  const replay = new Map<string, RunEvent>();
  for (const event of eventLog.readAll()) {
    if (event.idempotency_key !== null) replay.set(event.idempotency_key, event);
  }
  let replayedFromLog = 0;
  let modelCalls = 0;
  let modelAttempts = 0;
  let simulated = provider.simulated;

  const callsByRole = new Map<AgentRole, number>();

  const { roles: roster, reasoning: rosterReasoning } = selectRoster(brief);

  eventLog.append({
    event_type: 'meeting_started',
    role: null,
    round: null,
    meeting_id: meetingId,
    idempotency_key: `${runId}:meeting_started`,
    payload_json: {
      roster,
      roster_reasoning: rosterReasoning,
      provider: provider.name,
      model_id: provider.modelId,
      simulated: provider.simulated,
      max_rounds: config.MEETING_MAX_ROUNDS,
    },
    display_text: `Meeting started with ${roster.length} agents (${provider.name}/${provider.modelId})`,
  });

  const proposals: AgentContributionV1[] = [];
  const reactions: AgentContributionV1[] = [];
  let requirements: RequirementSetV1 | null = null;
  let synthesis: TechLeadSynthesisV1 | null = null;

  /**
   * Run one model call, or replay it from the log.
   *
   * Everything funnels through here so that checkpointing, call budgeting,
   * usage logging and replay cannot be forgotten at a call site.
   */
  async function contribute<T>(params: {
    key: string;
    role: AgentRole;
    round: 1 | 2 | 3;
    purpose: 'requirements' | 'proposal' | 'cross_review' | 'decision';
    contract: { readonly schemaName: string };
    input: unknown;
    describe: (data: T) => string;
  }): Promise<T> {
    const existing = replay.get(params.key);
    if (existing !== undefined) {
      replayedFromLog += 1;
      const stored = existing.payload_json as { data?: unknown; simulated?: boolean };
      if (stored.simulated === true) simulated = true;
      say(`  [replayed] ${params.role} round ${params.round} (already in event log)`);
      return stored.data as T;
    }

    const definition = ROLE_DEFINITIONS[params.role];
    const used = callsByRole.get(params.role) ?? 0;
    if (used >= definition.max_calls_per_meeting) {
      throw new DevOfficeError(
        'CONFIG_INVALID',
        `${params.role} would exceed max_calls_per_meeting (${definition.max_calls_per_meeting}).`,
      );
    }
    callsByRole.set(params.role, used + 1);

    const correlationId = `${runId}:${params.key}`;
    const startedAt = Date.now();
    let validationRetries = 0;

    modelAttempts += 1;
    try {
      const response = await provider.generateStructured<T>({
        purpose: params.purpose,
        agentRole: params.role,
        systemInstruction: buildSystemInstruction({
          role: params.role,
          round: params.round,
          projectId,
          meetingId,
        }),
        input: params.input,
        // Untrusted brief text is fenced here, not in the provider.
        userContent: buildUserPayload(params.input),
        contract: params.contract as never,
        maxOutputTokens: config.MODEL_MAX_OUTPUT_TOKENS,
        correlationId,
        temperature: config.MODEL_TEMPERATURE,
      });

      modelCalls += 1;
      validationRetries = response.validationRetries;
      if (response.simulated) simulated = true;

      eventLog.recordUsage({
        role: params.role,
        purpose: params.purpose,
        provider: response.provider,
        model_id: response.modelId,
        prompt_tokens: response.usage.inputTokens,
        completion_tokens: response.usage.outputTokens,
        total_tokens: response.usage.totalTokens,
        latency_ms: response.latencyMs,
        transport_attempts: response.transportAttempts,
        validation_retries: response.validationRetries,
        status: 'succeeded',
        error_code: null,
        correlation_id: correlationId,
        cost_reported: null,
      });

      // Checkpoint BEFORE the next call is made (LLD 4.3 item 4).
      eventLog.append({
        event_type: 'agent_contribution',
        role: params.role,
        round: params.round,
        meeting_id: meetingId,
        idempotency_key: params.key,
        payload_json: {
          purpose: params.purpose,
          schema_name: params.contract.schemaName,
          provider: response.provider,
          model_id: response.modelId,
          simulated: response.simulated,
          usage: response.usage,
          validation_retries: response.validationRetries,
          data: response.data,
        },
        display_text: params.describe(response.data),
      });

      say(`  [${provider.simulated ? 'SIMULATED' : 'model'}] ${params.describe(response.data)}`);
      return response.data;
    } catch (error) {
      const wrapped = isDevOfficeError(error)
        ? error
        : new DevOfficeError('PROVIDER_UNAVAILABLE', String((error as Error)?.message ?? error));

      eventLog.recordUsage({
        role: params.role,
        purpose: params.purpose,
        provider: provider.name,
        model_id: provider.modelId,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        latency_ms: Date.now() - startedAt,
        transport_attempts: 1,
        validation_retries: validationRetries,
        status: 'failed',
        error_code: wrapped.code,
        correlation_id: correlationId,
        cost_reported: null,
      });

      eventLog.append({
        event_type: 'provider_error',
        role: params.role,
        round: params.round,
        meeting_id: meetingId,
        idempotency_key: `${params.key}:error:${Date.now()}`,
        payload_json: wrapped.toPublicJSON(),
        display_text: `${params.role} failed: ${wrapped.code}`,
      });

      throw wrapped;
    }
  }

  try {
    /* ---------------- Round 1: independent proposals ---------------- */
    eventLog.append({
      event_type: 'round_started',
      role: null,
      round: 1,
      meeting_id: meetingId,
      idempotency_key: `${runId}:round:1`,
      payload_json: { round: 1, name: 'independent_proposals' },
      display_text: 'Round 1 - independent proposals',
    });
    say('Round 1 - independent proposals');

    requirements = await contribute<RequirementSetV1>({
      key: `${runId}:r1:requirements:pm`,
      role: 'pm',
      round: 1,
      purpose: 'requirements',
      contract: REQUIREMENTS_CONTRACT,
      input: { brief },
      describe: (data) =>
        `PM produced ${data.requirements.length} requirements, ` +
        `${data.missing_questions.length} open questions`,
    });

    const specialists = roster.filter((role) => role !== 'pm' && role !== 'tech_lead');
    for (const role of specialists) {
      const contribution = await contribute<AgentContributionV1>({
        key: `${runId}:r1:proposal:${role}`,
        role,
        round: 1,
        purpose: 'proposal',
        contract: PROPOSAL_CONTRACT,
        input: { brief, requirements: digestRequirements(requirements) },
        describe: (data) => `${role} proposal: ${data.summary}`,
      });
      proposals.push(contribution);
    }

    /* ---------------- Round 2: cross-review ---------------- */
    if (config.MEETING_MAX_ROUNDS >= 2) {
      eventLog.append({
        event_type: 'round_started',
        role: null,
        round: 2,
        meeting_id: meetingId,
        idempotency_key: `${runId}:round:2`,
        payload_json: { round: 2, name: 'cross_review' },
        display_text: 'Round 2 - cross-review',
      });
      say('Round 2 - cross-review');

      for (const role of specialists) {
        // A role reviews OTHERS' work, never its own.
        const others = proposals.filter((p) => p.agent_role !== role);
        if (others.length === 0) continue;

        const contribution = await contribute<AgentContributionV1>({
          key: `${runId}:r2:review:${role}`,
          role,
          round: 2,
          purpose: 'cross_review',
          // Built from the ids that actually exist this meeting, so a dangling
          // citation is repaired by the provider rather than recorded.
          contract: reactionContract(others.map((p) => p.proposal_id)),
          input: {
            brief_summary: { title: brief.title, objective: brief.objective, constraints: brief.constraints },
            requirements: digestRequirements(requirements),
            target_proposals: others.map(digestProposal),
          },
          describe: (data) =>
            `${role} ${data.contribution_type} -> ${data.related_proposal_id ?? 'n/a'}: ${data.summary}`,
        });
        reactions.push(contribution);
      }
    }

    /* ---------------- Round 3: decision synthesis ---------------- */
    if (config.MEETING_MAX_ROUNDS >= 3) {
      eventLog.append({
        event_type: 'round_started',
        role: null,
        round: 3,
        meeting_id: meetingId,
        idempotency_key: `${runId}:round:3`,
        payload_json: { round: 3, name: 'decision_synthesis' },
        display_text: 'Round 3 - decision synthesis',
      });
      say('Round 3 - decision synthesis');

      // Every requirement the PM raised must come back with a disposition.
      // Built from this meeting's actual ids so a skipped one fails validation
      // rather than passing unnoticed.
      const requirementIds = requirements.requirements.map((r) => r.id);

      synthesis = await contribute<TechLeadSynthesisV1>({
        key: `${runId}:r3:synthesis:tech_lead`,
        role: 'tech_lead',
        round: 3,
        purpose: 'decision',
        contract: synthesisContract(requirementIds),
        input: {
          brief_summary: { title: brief.title, objective: brief.objective, constraints: brief.constraints },
          requirements: digestRequirements(requirements),
          requirement_ids: requirementIds,
          proposals: proposals.map(digestProposal),
          reactions: reactions.map(digestReaction),
        },
        describe: (data) =>
          `Tech Lead verdict: ${data.verdict.toUpperCase()} - ${data.decisions.length} decisions, ` +
          `${data.requirement_dispositions.length} requirements accounted for, ` +
          `${data.unresolved_blockers.filter((b) => b.blocking).length} blocking questions`,
      });

      for (const decision of synthesis.decisions) {
        // Validate each ADR with the refined schema, which enforces
        // "at least two alternatives" and "selected must be one of them".
        const checked = ArchitectureDecisionV1.safeParse(decision);
        eventLog.append({
          event_type: 'decision_recorded',
          role: 'tech_lead',
          round: 3,
          meeting_id: meetingId,
          idempotency_key: `${runId}:adr:${decision.decision_id}`,
          payload_json: {
            decision,
            valid: checked.success,
            issues: checked.success
              ? []
              : checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
          },
          display_text: `ADR ${decision.decision_id}: ${decision.selected}${
            checked.success ? '' : ' (FAILS VALIDATION)'
          }`,
        });
      }
    }

    /* ---------------- Completion gate (HLD 6.3) ---------------- */
    // PM raises questions in round 1 and the Tech Lead often carries the same
    // ones forward in round 3. Listing both made every question appear twice
    // in the B1 report, so duplicates are removed (case and spacing ignored,
    // first wording kept).
    const blockingQuestions = uniqueQuestions([
      ...(synthesis?.unresolved_blockers ?? []).filter((b) => b.blocking).map((b) => b.question),
      ...(requirements?.missing_questions ?? []),
    ]);

    const recommendedAgainstBy = [...proposals, ...reactions]
      .filter((c) => c.contribution_type === 'recommend_against')
      .map((c) => c.agent_role);

    const verdict = synthesis?.verdict ?? null;

    // A verdict of do_not_proceed outranks open questions: answering them
    // would not change the team's position, so the owner decides first.
    const state: MeetingState =
      verdict === 'do_not_proceed' || recommendedAgainstBy.length > 0
        ? 'NEEDS_OWNER_DECISION'
        : blockingQuestions.length > 0
          ? 'NEEDS_INPUT'
          : 'MEETING_COMPLETED';

    const terminalEventType =
      state === 'MEETING_COMPLETED' ? 'meeting_completed' : 'needs_input';

    eventLog.append({
      event_type: terminalEventType,
      role: null,
      round: null,
      meeting_id: meetingId,
      idempotency_key: `${runId}:terminal:${state}`,
      payload_json: {
        state,
        verdict,
        verdict_justification: synthesis?.verdict_justification ?? null,
        verdict_conditions: synthesis?.verdict_conditions ?? [],
        recommended_against_by: recommendedAgainstBy,
        blocking_questions: blockingQuestions,
        model_calls: modelCalls,
        model_attempts: modelAttempts,
        replayed_from_log: replayedFromLog,
        simulated,
      },
      display_text:
        state === 'NEEDS_OWNER_DECISION'
          ? `Team recommends AGAINST proceeding as scoped - Product Owner must decide`
          : state === 'NEEDS_INPUT'
            ? `Meeting paused: ${blockingQuestions.length} question(s) need the Product Owner`
            : 'Meeting completed with no blocking questions',
    });

    return {
      state,
      runId,
      meetingId,
      projectId,
      roster,
      rosterReasoning,
      requirements,
      proposals,
      reactions,
      synthesis,
      blockingQuestions,
      verdict,
      verdictJustification: synthesis?.verdict_justification ?? null,
      verdictConditions: synthesis?.verdict_conditions ?? [],
      recommendedAgainstBy,
      modelCalls,
      modelAttempts,
      replayedFromLog,
      errorCode: null,
      errorMessage: null,
      simulated,
    };
  } catch (error) {
    const wrapped = isDevOfficeError(error)
      ? error
      : new DevOfficeError('PROVIDER_UNAVAILABLE', String((error as Error)?.message ?? error));

    // Progress so far is already on disk. This is a pause, not a loss.
    eventLog.append({
      event_type: 'meeting_blocked',
      role: null,
      round: null,
      meeting_id: meetingId,
      idempotency_key: `${runId}:terminal:BLOCKED:${wrapped.code}`,
      payload_json: {
        ...wrapped.toPublicJSON(),
        completed_contributions: proposals.length + reactions.length + (requirements === null ? 0 : 1),
        resumable: true,
        resume_hint: `Re-run with the same runId (${runId}) to continue from the last checkpoint.`,
      },
      display_text: `Meeting BLOCKED (${wrapped.code}) - progress preserved, resumable`,
    });

    return {
      state: 'BLOCKED',
      runId,
      meetingId,
      projectId,
      roster,
      rosterReasoning,
      requirements,
      proposals,
      reactions,
      synthesis,
      blockingQuestions: [],
      verdict: synthesis?.verdict ?? null,
      verdictJustification: synthesis?.verdict_justification ?? null,
      verdictConditions: synthesis?.verdict_conditions ?? [],
      recommendedAgainstBy: [...proposals, ...reactions]
        .filter((c) => c.contribution_type === 'recommend_against')
        .map((c) => c.agent_role),
      modelCalls,
      modelAttempts,
      replayedFromLog,
      errorCode: wrapped.code,
      errorMessage: wrapped.message,
      simulated,
    };
  }
}
