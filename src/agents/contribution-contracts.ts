/**
 * Round-aware validators for AgentContributionV1.
 *
 * WHY THIS FILE EXISTS - a real bug found while running the harness:
 *
 * AgentContributionV1 permits contribution_type "proposal" with
 * related_proposal_id null. That is correct for round 1 and WRONG for round 2,
 * where the whole point is to react to someone else's work. A model that
 * replies to a cross-review turn with a fresh proposal passed validation and
 * the meeting happily recorded a round-2 "objection" count of zero. The
 * meeting looked complete and had no cross-review in it.
 *
 * Worse, LLD 6.2 says an objection must cite a REAL proposal_id. "Real" cannot
 * be checked by a static schema - it depends on which proposals exist in this
 * meeting. So the round-2 validator is built per turn from the actual ids.
 *
 * Both validators reuse the SAME JSON Schema on the wire. Only the Zod gate
 * differs, which means a violation is caught by the provider's existing repair
 * loop: the model is told exactly what it got wrong, with the list of valid
 * ids, and asked again. No new error path, no silent acceptance.
 */
import { z } from 'zod';
import {
  AgentContributionV1,
  AgentContributionV1Base,
  RequirementDispositionSetV1Base,
  TechLeadDecisionsV1,
  TechLeadDecisionsV1Base,
  TechLeadSynthesisV1,
  TechLeadSynthesisV1Base,
} from '../shared/schemas.js';
import { buildGroqJsonSchema } from '../shared/json-schema.js';
import type { StructuredContract } from '../providers/types.js';

const CONTRIBUTION_WIRE = buildGroqJsonSchema('AgentContributionV1', AgentContributionV1Base);
const SYNTHESIS_WIRE = buildGroqJsonSchema('TechLeadSynthesisV1', TechLeadSynthesisV1Base);
const DECISIONS_WIRE = buildGroqJsonSchema('TechLeadDecisionsV1', TechLeadDecisionsV1Base);
const DISPOSITIONS_WIRE = buildGroqJsonSchema(
  'RequirementDispositionSetV1',
  RequirementDispositionSetV1Base,
);

function contractFor(
  validator: z.ZodType<z.infer<typeof AgentContributionV1>>,
): StructuredContract<z.infer<typeof AgentContributionV1>> {
  return {
    schemaName: 'AgentContributionV1',
    validator,
    jsonSchema: CONTRIBUTION_WIRE.jsonSchema,
    strippedKeywords: CONTRIBUTION_WIRE.strippedKeywords,
  };
}

/**
 * Round 1: an independent proposal, citing nobody.
 *
 * recommend_against is allowed here too. A specialist who reads the brief and
 * concludes the project should not be scoped as described must be able to say
 * so immediately, rather than being made to propose a design first and object
 * to it afterwards.
 */
export const PROPOSAL_CONTRACT = contractFor(
  AgentContributionV1.superRefine((value, ctx) => {
    if (value.contribution_type !== 'proposal' && value.contribution_type !== 'recommend_against') {
      ctx.addIssue({
        code: 'custom',
        path: ['contribution_type'],
        message:
          'round 1 is independent assessment: use "proposal", or "recommend_against" if this ' +
          `project should not be scoped as described. Not "${value.contribution_type}"`,
      });
    }
  }),
);

/**
 * Round 2: a reaction to one of `knownProposalIds`.
 *
 * `question` is allowed without a citation - a role may legitimately need the
 * owner to answer something before it can review anything (LLD 7).
 */
export function reactionContract(
  knownProposalIds: readonly string[],
): StructuredContract<z.infer<typeof AgentContributionV1>> {
  const known = new Set(knownProposalIds);
  return contractFor(
    AgentContributionV1.superRefine((value, ctx) => {
      if (value.contribution_type === 'proposal') {
        ctx.addIssue({
          code: 'custom',
          path: ['contribution_type'],
          message:
            'round 2 is cross-review: react to a colleague\'s proposal using "objection", ' +
            '"support", "revision" or "question". Do not restate your own proposal.',
        });
        return;
      }

      // A question needs no citation, and neither does recommending against
      // the project - that is about the brief, not about a colleague.
      if (value.contribution_type === 'question' || value.contribution_type === 'recommend_against') {
        return;
      }

      if (value.related_proposal_id === null || !known.has(value.related_proposal_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['related_proposal_id'],
          message:
            `related_proposal_id must be one of the proposals you were shown: ` +
            `${[...known].join(', ')}. You sent "${value.related_proposal_id ?? 'null'}".`,
        });
      }
    }),
  );
}


/**
 * Round 3: the Tech Lead's synthesis, checked against the requirements that
 * actually exist in this meeting.
 *
 * `mustRequirementIds` comes from the PM's output, so "every must-requirement
 * is accounted for" becomes a machine check rather than a hope. On benchmark
 * B3 the riskiest requirement in the brief - finance staff being able to read
 * ANY student's record - received no decision at all. Security flagged it as
 * an insider risk and the synthesis simply never mentioned it. Nothing caught
 * that, because nothing was looking.
 *
 * Now a missing requirement fails validation and the repair loop hands the
 * model the exact list of ids it skipped.
 */
export function synthesisContract(
  mustRequirementIds: readonly string[],
): StructuredContract<z.infer<typeof TechLeadSynthesisV1>> {
  const required = [...new Set(mustRequirementIds)];

  const validator = TechLeadSynthesisV1.superRefine((value, ctx) => {
    const covered = new Set(value.requirement_dispositions.map((d) => d.requirement_id));
    const missing = required.filter((id) => !covered.has(id));

    if (missing.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['requirement_dispositions'],
        message:
          'every important requirement needs an entry, even if only to say it is deferred or ' +
          `blocked. Missing: ${missing.join(', ')}`,
      });
    }

    const unknown = value.requirement_dispositions
      .map((d) => d.requirement_id)
      .filter((id) => !required.includes(id));
    if (unknown.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['requirement_dispositions'],
        message:
          `these requirement ids do not exist in this meeting: ${unknown.join(', ')}. ` +
          `The ids are: ${required.join(', ')}`,
      });
    }
  });

  return {
    schemaName: 'TechLeadSynthesisV1',
    validator,
    jsonSchema: SYNTHESIS_WIRE.jsonSchema,
    strippedKeywords: SYNTHESIS_WIRE.strippedKeywords,
  };
}


/* ------------------------------------------------------------------ *
 * Round 3, split in two (see the comment in shared/schemas.ts)
 * ------------------------------------------------------------------ */

/** 3a: the verdict, the decisions, and what round 2 changed. */
export const DECISIONS_CONTRACT: StructuredContract<z.infer<typeof TechLeadDecisionsV1>> = {
  schemaName: 'TechLeadDecisionsV1',
  validator: TechLeadDecisionsV1,
  jsonSchema: DECISIONS_WIRE.jsonSchema,
  strippedKeywords: DECISIONS_WIRE.strippedKeywords,
};

/**
 * 3b: every requirement mapped to one of the decisions just made.
 *
 * Built from this meeting's real requirement ids AND the decision ids from
 * step 3a, so a skipped requirement or a dangling decision reference fails
 * validation and the repair loop names exactly what is missing.
 */
export function dispositionsContract(
  requirementIds: readonly string[],
  decisionIds: readonly string[],
): StructuredContract<z.infer<typeof RequirementDispositionSetV1Base>> {
  const required = [...new Set(requirementIds)];
  const known = new Set(decisionIds);

  const validator = RequirementDispositionSetV1Base.superRefine((value, ctx) => {
    const covered = new Set(value.requirement_dispositions.map((d) => d.requirement_id));
    const missing = required.filter((id) => !covered.has(id));

    if (missing.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['requirement_dispositions'],
        message:
          'every requirement needs an entry, even if only to say it is deferred or blocked. ' +
          `Missing: ${missing.join(', ')}`,
      });
    }

    const unknown = value.requirement_dispositions
      .map((d) => d.requirement_id)
      .filter((id) => !required.includes(id));
    if (unknown.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['requirement_dispositions'],
        message:
          `these requirement ids do not exist in this meeting: ${unknown.join(', ')}. ` +
          `The ids are: ${required.join(', ')}`,
      });
    }

    value.requirement_dispositions.forEach((disposition, index) => {
      if (disposition.status !== 'decided') return;
      if (disposition.decision_id === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['requirement_dispositions', index, 'decision_id'],
          message: 'status "decided" must name the decision record that settles it',
        });
      } else if (!known.has(disposition.decision_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['requirement_dispositions', index, 'decision_id'],
          message:
            `"${disposition.decision_id}" is not a decision from this meeting ` +
            `(${[...known].join(', ') || 'none were recorded'})`,
        });
      }
    });
  });

  return {
    schemaName: 'RequirementDispositionSetV1',
    validator,
    jsonSchema: DISPOSITIONS_WIRE.jsonSchema,
    strippedKeywords: DISPOSITIONS_WIRE.strippedKeywords,
  };
}
