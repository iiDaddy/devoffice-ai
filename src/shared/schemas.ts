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
  const needsReference =
    value.contribution_type === 'objection' ||
    value.contribution_type === 'support' ||
    value.contribution_type === 'revision';

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

export const TechLeadSynthesisV1 = z.object({
  consensus_summary: z.string().min(40),
  decisions: z.array(ArchitectureDecisionV1Base),
  /** What actually changed because of round-2 feedback. Empty = nothing changed. */
  changed_due_to_feedback: z.array(z.string().min(10)),
  unresolved_blockers: z.array(BlockerV1),
});
export type TechLeadSynthesisV1 = z.infer<typeof TechLeadSynthesisV1>;

/* ------------------------------------------------------------------ *
 * Registry so the CLI and tests can look schemas up by name
 * ------------------------------------------------------------------ */

export const SCHEMA_REGISTRY = {
  ProjectBriefV1,
  RequirementSetV1,
  AgentContributionV1: AgentContributionV1Base,
  ArchitectureDecisionV1: ArchitectureDecisionV1Base,
  TechLeadSynthesisV1,
} as const;

export type SchemaName = keyof typeof SCHEMA_REGISTRY;
