/**
 * Data contracts for DevOffice AI (LLD section 6).
 *
 * TWO RULES that apply to every schema in this file:
 *
 * 1. NEVER use `.optional()`. Groq strict mode requires every property to be
 *    listed in `required`. Express "may be absent" as `.nullable()`, which
 *    becomes ["string","null"] in JSON Schema. A `.optional()` anywhere here
 *    makes assertGroqStrictCompatible() throw at startup.
 *
 * 2. Quantitative rules (min lengths, min array sizes) live in Zod refinements,
 *    not in the JSON Schema we send to the model. See json-schema.ts for why.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Enums
 * ------------------------------------------------------------------ */

export const AgentRole = z.enum([
  'pm',
  'tech_lead',
  'ui_ux',
  'frontend',
  'backend',
  'security',
  'qa',
  'devops',
]);
export type AgentRole = z.infer<typeof AgentRole>;

export const ContributionType = z.enum([
  'proposal',
  'objection',
  'support',
  'revision',
  'question',
  /**
   * "This should not be built as scoped, and here is why."
   *
   * Added after benchmark B3. The student-payment brief was meant to be
   * refused, and the team never refused - but the contract had no way to say
   * it. The only options were propose, object, support, revise and ask. An
   * objection says "fix this part"; nothing said "step back from the whole
   * thing". Roles used the tool they had and used it well, so the gap was in
   * this enum, not in their judgement.
   */
  'recommend_against',
]);
export type ContributionType = z.infer<typeof ContributionType>;

export const Severity = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof Severity>;

export const RequirementPriority = z.enum(['must', 'should', 'could', 'wont']);

/* ------------------------------------------------------------------ *
 * ProjectBriefV1 (LLD 6.1) - the owner's input, not model output
 * ------------------------------------------------------------------ */

export const ProjectBriefV1 = z.object({
  title: z.string().min(3),
  objective: z.string().min(10),
  audience: z.array(z.string().min(2)),
  requested_features: z.array(z.string().min(1)),
  constraints: z.array(z.string().min(1)),
  references: z.array(z.string()),
  unknowns: z.array(z.string()),
});
export type ProjectBriefV1 = z.infer<typeof ProjectBriefV1>;

/* ------------------------------------------------------------------ *
 * RequirementSetV1 - Product Manager output (LLD 5, round 1)
 * ------------------------------------------------------------------ */

export const RequirementItemV1 = z.object({
  id: z.string().min(3),
  statement: z.string().min(15),
  priority: RequirementPriority,
  /** 'brief' = stated by the owner. 'inferred' = PM filled a gap (must be visible). */
  source: z.enum(['brief', 'inferred']),
});
export type RequirementItemV1 = z.infer<typeof RequirementItemV1>;

export const RequirementSetV1 = z.object({
  goals: z.array(z.string().min(10)),
  audience: z.array(z.string().min(2)),
  requirements: z.array(RequirementItemV1),
  assumptions: z.array(z.string().min(10)),
  /** Blocking questions become NEEDS_INPUT. Never guessed away. */
  missing_questions: z.array(z.string().min(10)),
  in_scope: z.array(z.string().min(3)),
  out_of_scope: z.array(z.string().min(3)),
});
export type RequirementSetV1 = z.infer<typeof RequirementSetV1>;

/* ------------------------------------------------------------------ *
 * AgentContributionV1 (LLD 6.2)
 * ------------------------------------------------------------------ */

/** Phrases that signal an empty agreement. LLD 6.2: "I agree" alone is invalid. */
const LOW_CONTENT_RATIONALE =
  /^(i\s+agree|agreed|agree|sounds?\s+good|looks?\s+good|lgtm|ok(ay)?|\+1|no\s+concerns?|makes\s+sense|same|this|yes)\b[\s.!]*$/i;

const MIN_RATIONALE_CHARS = 40;

export const AgentContributionV1Base = z.object({
  topic: z.string().min(5),
  /** Stable id other agents cite in round 2, e.g. "prop-ux-home-01". */
  proposal_id: z.string().min(3),
  agent_role: AgentRole,
  contribution_type: ContributionType,
  summary: z.string().min(15),
  rationale: z.string().min(MIN_RATIONALE_CHARS),
  alternatives: z.array(z.string().min(3)),
  risks: z.array(z.string().min(5)),
  dependencies: z.array(z.string().min(3)),
  /** Which proposal this reacts to. Required for objection/support/revision. */
  related_proposal_id: z.string().min(3).nullable(),
  /**
   * The concrete change or mitigation being asked for.
   *
   * ADDED BEYOND THE LLD 6.2 EXAMPLE, and reported to the Product Owner:
   * LLD 6.2 states an objection "must ... recommend a change or mitigation",
   * but the example payload has no field to carry it, so the rule could not
   * be machine-enforced. This field makes it enforceable.
   */
  recommended_change: z.string().min(15).nullable(),
  /** Short quotes/pointers to the brief or proposal being critiqued. */
  evidence: z.array(z.string().min(5)),
  severity: Severity,
});

/**
 * Cross-review rule from LLD 6.2, enforced in code rather than in prose:
 *   - objection / support / revision MUST cite a real related_proposal_id
 *   - objection / revision MUST carry a recommended_change
 *   - a rationale that is only "I agree" is rejected
 */
export const AgentContributionV1 = AgentContributionV1Base.superRefine((value, ctx) => {
  // recommend_against is about the project, not about one colleague's
  // proposal, so it is the one reaction that needs no citation.
  const needsReference =
    value.contribution_type === 'objection' ||
    value.contribution_type === 'support' ||
    value.contribution_type === 'revision';

  if (value.contribution_type === 'recommend_against') {
    if (value.evidence.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message:
          'recommending against a project requires evidence from the brief - name the ' +
          'specific features or constraints that make it unsafe to scope',
      });
    }
    if (value.recommended_change === null || value.recommended_change.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['recommended_change'],
        message:
          'say what should happen instead: a reduced scope, a prerequisite to obtain first, ' +
          'or a different approach. "Do not build it" alone is not actionable',
      });
    }
    if (value.severity !== 'high' && value.severity !== 'critical') {
      ctx.addIssue({
        code: 'custom',
        path: ['severity'],
        message:
          `severity "${value.severity}" contradicts recommending against the project. ` +
          'Use high or critical, or choose objection instead',
      });
    }
  }

  if (needsReference && (value.related_proposal_id === null || value.related_proposal_id.trim() === '')) {
    ctx.addIssue({
      code: 'custom',
      path: ['related_proposal_id'],
      message:
        `contribution_type "${value.contribution_type}" must cite the proposal_id it reacts to ` +
        '(cross-review rule, LLD 6.2)',
    });
  }

  if (value.contribution_type === 'proposal' && value.related_proposal_id !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['related_proposal_id'],
      message: 'a first-round proposal must set related_proposal_id to null',
    });
  }

  const needsRecommendation =
    value.contribution_type === 'objection' || value.contribution_type === 'revision';

  if (needsRecommendation && (value.recommended_change === null || value.recommended_change.trim() === '')) {
    ctx.addIssue({
      code: 'custom',
      path: ['recommended_change'],
      message:
        `contribution_type "${value.contribution_type}" must recommend a concrete change or ` +
        'mitigation, not just state a problem (cross-review rule, LLD 6.2)',
    });
  }

  if (LOW_CONTENT_RATIONALE.test(value.rationale.trim())) {
    ctx.addIssue({
      code: 'custom',
      path: ['rationale'],
      message:
        'rationale is an empty agreement. State WHY, referring to something specific in the ' +
        'brief or the cited proposal (LLD 6.2)',
    });
  }

  if (value.contribution_type === 'objection' && value.evidence.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['evidence'],
      message: 'an objection must point at specific evidence from the brief or cited proposal',
    });
  }
});
export type AgentContributionV1 = z.infer<typeof AgentContributionV1>;

/* ------------------------------------------------------------------ *
 * ArchitectureDecisionV1 (LLD 6.3)
 * ------------------------------------------------------------------ */

export const DecisionAlternativeV1 = z.object({
  name: z.string().min(2),
  pros: z.array(z.string().min(3)),
  cons: z.array(z.string().min(3)),
});

export const ArchitectureDecisionV1Base = z.object({
  decision_id: z.string().min(3),
  problem: z.string().min(15),
  alternatives: z.array(DecisionAlternativeV1),
  selected: z.string().min(2),
  rationale: z.string().min(MIN_RATIONALE_CHARS),
  rejected_reasons: z.array(z.string().min(5)),
  affected_requirements: z.array(z.string().min(2)),
  open_questions: z.array(z.string().min(10)),
});

export const ArchitectureDecisionV1 = ArchitectureDecisionV1Base.superRefine((value, ctx) => {
  // A "decision" with one option is not a decision - the rubric scores
  // "alternatives and trade-offs clear" (LLD 14.2).
  if (value.alternatives.length < 2) {
    ctx.addIssue({
      code: 'custom',
      path: ['alternatives'],
      message: 'a decision record must weigh at least two alternatives',
    });
  }
  const names = value.alternatives.map((a) => a.name.trim().toLowerCase());
  if (!names.includes(value.selected.trim().toLowerCase())) {
    ctx.addIssue({
      code: 'custom',
      path: ['selected'],
      message: `"selected" must be one of the listed alternatives: ${names.join(', ')}`,
    });
  }
  if (value.alternatives.some((a) => a.pros.length === 0 || a.cons.length === 0)) {
    ctx.addIssue({
      code: 'custom',
      path: ['alternatives'],
      message: 'every alternative needs at least one pro and one con',
    });
  }
});
export type ArchitectureDecisionV1 = z.infer<typeof ArchitectureDecisionV1>;

/* ------------------------------------------------------------------ *
 * TechLeadSynthesisV1 - round 3 output (LLD 7)
 * ------------------------------------------------------------------ */

export const BlockerV1 = z.object({
  question: z.string().min(10),
  /** true => the meeting cannot produce an approvable spec until answered. */
  blocking: z.boolean(),
  raised_by: AgentRole,
  affected_requirements: z.array(z.string().min(2)),
});
export type BlockerV1 = z.infer<typeof BlockerV1>;

/* ------------------------------------------------------------------ *
 * Tech Lead verdict on the project as a whole
 * ------------------------------------------------------------------ */

export const ProjectVerdict = z.enum([
  /** Nothing in the way beyond the usual open questions. */
  'proceed',
  /** Safe only if the listed conditions are met first. */
  'proceed_with_conditions',
  /** Should not be scoped as described. The owner decides what happens next. */
  'do_not_proceed',
]);
export type ProjectVerdict = z.infer<typeof ProjectVerdict>;

/* ------------------------------------------------------------------ *
 * Every important requirement must be accounted for
 * ------------------------------------------------------------------ */

export const RequirementStatus = z.enum([
  /** A decision record covers it. decision_id must name which. */
  'decided',
  /** Deliberately left for later, with a reason. */
  'deferred',
  /** Cannot be settled until a blocker is answered. */
  'blocked',
  /** Judged outside what this project should do. */
  'out_of_scope',
]);

export const RequirementDispositionV1 = z.object({
  requirement_id: z.string().min(3),
  status: RequirementStatus,
  /** The ADR that settles it. Required when status is "decided". */
  decision_id: z.string().min(3).nullable(),
  note: z.string().min(15),
});
export type RequirementDispositionV1 = z.infer<typeof RequirementDispositionV1>;

/* ------------------------------------------------------------------ *
 * What round 2 actually changed
 * ------------------------------------------------------------------ */

/**
 * Structured on purpose.
 *
 * This was a flat array of strings with a 10-character minimum, and on
 * benchmark B3 it produced four lines of this shape:
 *
 *     "Decision DEC-001 updated based on round-2 feedback"
 *
 * Which says that something changed and nothing about what. A length rule
 * produces length. Naming the position before and the position after makes
 * the empty version impossible to write: there is nowhere to put the filler.
 */
export const DecisionChangeV1 = z.object({
  decision_id: z.string().min(3),
  triggered_by_role: AgentRole,
  related_proposal_id: z.string().min(3).nullable(),
  /** What the plan said before round 2. */
  previous_position: z.string().min(15),
  /** What it says now. */
  revised_position: z.string().min(15),
  /** The argument that moved it. */
  why: z.string().min(25),
});
export type DecisionChangeV1 = z.infer<typeof DecisionChangeV1>;

/* ------------------------------------------------------------------ *
 * Round 3 is TWO calls, not one
 * ------------------------------------------------------------------ *
 *
 * It used to be one. On benchmark B3 the provider refused it outright:
 *
 *     Request too large ... on tokens per minute (TPM):
 *     Limit 8000, Requested 8280
 *
 * On this tier a single request's prompt PLUS its reserved output must fit
 * under the per-minute ceiling. Round 3 had grown to ~4,200 tokens of prompt
 * and needed ~4,100 of output, so it no longer fit in one request - and the
 * squeeze came from both sides at once: ten requirements made the prompt
 * bigger AND required ten dispositions in the answer.
 *
 * Lowering the output budget only trades the 413 for the truncation we had
 * just fixed. The answer had outgrown one request, so it is now two:
 *
 *   3a  TechLeadDecisionsV1       verdict, decisions, what changed, blockers
 *   3b  RequirementDispositionSetV1  every requirement mapped to a decision
 *
 * This also scales: a twenty-requirement brief would have broken the single
 * call again. And it is a better order to think in - decide first, then
 * account for every requirement against those decisions.
 */

export const TechLeadDecisionsV1Base = z.object({
  consensus_summary: z.string().min(40),
  verdict: ProjectVerdict,
  verdict_justification: z.string().min(40),
  /** Required when the verdict is not a plain "proceed". */
  verdict_conditions: z.array(z.string().min(10)),
  decisions: z.array(ArchitectureDecisionV1Base),
  changed_due_to_feedback: z.array(DecisionChangeV1),
  unresolved_blockers: z.array(BlockerV1),
});

export const TechLeadDecisionsV1 = TechLeadDecisionsV1Base.superRefine((value, ctx) => {
  // Decision ids are referenced by the change log and by every requirement
  // disposition. Two decisions sharing an id makes those references point at
  // nothing in particular - a real failure the old `min(3)` never caught.
  const seen = new Set<string>();
  value.decisions.forEach((d, index) => {
    const key = d.decision_id.trim().toLowerCase();
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['decisions', index, 'decision_id'],
        message:
          `"${d.decision_id}" is used by more than one decision. Ids must be unique, because ` +
          'the change log and the requirement dispositions refer back to them',
      });
    }
    seen.add(key);
  });

  if (value.verdict !== 'proceed' && value.verdict_conditions.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['verdict_conditions'],
      message:
        `verdict "${value.verdict}" must list what has to be true before this project is safe ` +
        'to proceed. An empty list means the verdict cannot be acted on',
    });
  }

  const decisionIds = new Set(value.decisions.map((d) => d.decision_id));

  value.changed_due_to_feedback.forEach((change, index) => {
    if (!decisionIds.has(change.decision_id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['changed_due_to_feedback', index, 'decision_id'],
        message:
          `"${change.decision_id}" is not one of the decisions you recorded ` +
          `(${[...decisionIds].join(', ') || 'none'})`,
      });
    }
    if (
      change.previous_position.trim().toLowerCase() === change.revised_position.trim().toLowerCase()
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['changed_due_to_feedback', index, 'revised_position'],
        message: 'previous_position and revised_position are identical, so nothing changed',
      });
    }
  });
});
export type TechLeadDecisionsV1 = z.infer<typeof TechLeadDecisionsV1Base>;

export const RequirementDispositionSetV1Base = z.object({
  requirement_dispositions: z.array(RequirementDispositionV1),
});
export type RequirementDispositionSetV1 = z.infer<typeof RequirementDispositionSetV1Base>;

/**
 * The two halves joined back together. Downstream code - the report, the
 * signals, the event log - sees one synthesis, as before.
 */
export const TechLeadSynthesisV1Base = z.object({
  consensus_summary: z.string().min(40),
  verdict: ProjectVerdict,
  verdict_justification: z.string().min(40),
  /** Required when the verdict is not a plain "proceed". */
  verdict_conditions: z.array(z.string().min(10)),
  decisions: z.array(ArchitectureDecisionV1Base),
  /** One entry per important requirement. Nothing may go unmentioned. */
  requirement_dispositions: z.array(RequirementDispositionV1),
  changed_due_to_feedback: z.array(DecisionChangeV1),
  unresolved_blockers: z.array(BlockerV1),
});

export const TechLeadSynthesisV1 = TechLeadSynthesisV1Base.superRefine((value, ctx) => {
  if (value.verdict !== 'proceed' && value.verdict_conditions.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['verdict_conditions'],
      message:
        `verdict "${value.verdict}" must list what has to be true before this project is safe ` +
        'to proceed. An empty list means the verdict cannot be acted on',
    });
  }

  const decisionIds = new Set(value.decisions.map((d) => d.decision_id));

  value.changed_due_to_feedback.forEach((change, index) => {
    if (!decisionIds.has(change.decision_id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['changed_due_to_feedback', index, 'decision_id'],
        message:
          `"${change.decision_id}" is not one of the decisions you recorded ` +
          `(${[...decisionIds].join(', ') || 'none'})`,
      });
    }
    if (
      change.previous_position.trim().toLowerCase() === change.revised_position.trim().toLowerCase()
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['changed_due_to_feedback', index, 'revised_position'],
        message: 'previous_position and revised_position are identical, so nothing changed',
      });
    }
  });

  value.requirement_dispositions.forEach((disposition, index) => {
    if (disposition.status === 'decided') {
      if (disposition.decision_id === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['requirement_dispositions', index, 'decision_id'],
          message: 'status "decided" must name the decision record that settles it',
        });
      } else if (!decisionIds.has(disposition.decision_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['requirement_dispositions', index, 'decision_id'],
          message:
            `"${disposition.decision_id}" is not one of the decisions you recorded ` +
            `(${[...decisionIds].join(', ') || 'none'})`,
        });
      }
    }
  });
});
export type TechLeadSynthesisV1 = z.infer<typeof TechLeadSynthesisV1Base>;

/* ------------------------------------------------------------------ *
 * Registry so the CLI and tests can look schemas up by name
 * ------------------------------------------------------------------ */

export const SCHEMA_REGISTRY = {
  ProjectBriefV1,
  RequirementSetV1,
  AgentContributionV1: AgentContributionV1Base,
  ArchitectureDecisionV1: ArchitectureDecisionV1Base,
  TechLeadSynthesisV1: TechLeadSynthesisV1Base,
  TechLeadDecisionsV1: TechLeadDecisionsV1Base,
  RequirementDispositionSetV1: RequirementDispositionSetV1Base,
} as const;

export type SchemaName = keyof typeof SCHEMA_REGISTRY;
