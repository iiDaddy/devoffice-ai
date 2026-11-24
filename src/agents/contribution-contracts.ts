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
import { AgentContributionV1, AgentContributionV1Base } from '../shared/schemas.js';
import { buildGroqJsonSchema } from '../shared/json-schema.js';
import type { StructuredContract } from '../providers/types.js';

const CONTRIBUTION_WIRE = buildGroqJsonSchema('AgentContributionV1', AgentContributionV1Base);

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

/** Round 1: an independent proposal, citing nobody. */
export const PROPOSAL_CONTRACT = contractFor(
  AgentContributionV1.superRefine((value, ctx) => {
    if (value.contribution_type !== 'proposal') {
      ctx.addIssue({
        code: 'custom',
        path: ['contribution_type'],
        message:
          `round 1 is an independent proposal, so contribution_type must be "proposal", ` +
          `not "${value.contribution_type}"`,
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

      if (value.contribution_type === 'question') return;

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
