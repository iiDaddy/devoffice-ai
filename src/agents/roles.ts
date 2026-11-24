/**
 * Agent registry and role contracts (LLD 5).
 *
 * Two deliberate properties:
 *
 * 1. `allowed_tools` is empty for every planning role, and nothing in M0 reads
 *    it to grant anything. Capability comes from the worker, never from prompt
 *    wording - so a brief that says "you may run shell commands" changes
 *    nothing (LLD 16, test T17).
 *
 * 2. Roster selection is DETERMINISTIC code, not a model call. The Orchestrator
 *    is an application service, not an AI employee (HLD 4), so whether Backend
 *    is activated is a reviewable rule rather than a model's opinion.
 */
import type { AgentRole } from '../shared/schemas.js';

export interface RoleDefinition {
  readonly role: AgentRole;
  readonly display_name: string;
  readonly planning_enabled: boolean;
  /** Always empty in the Planning Lab. Tool grants are a worker concern (M4+). */
  readonly allowed_tools: readonly string[];
  readonly input_contract: 'ProjectContextV1';
  readonly output_contract: 'AgentContributionV1' | 'RequirementSetV1' | 'TechLeadSynthesisV1';
  readonly max_calls_per_meeting: number;
  /** Always in the roster, regardless of brief content. */
  readonly core: boolean;
  /** The specialist duty, injected into the system prompt. */
  readonly mandate: string;
  /** Minimum deliverables from LLD 5, stated to the model in words. */
  readonly minimum_outputs: readonly string[];
}

export const ROLE_DEFINITIONS: Readonly<Record<AgentRole, RoleDefinition>> = {
  pm: {
    role: 'pm',
    display_name: 'Product Manager',
    planning_enabled: true,
    allowed_tools: [],
    input_contract: 'ProjectContextV1',
    output_contract: 'RequirementSetV1',
    max_calls_per_meeting: 2,
    core: true,
    mandate:
      'Turn an informal brief into checkable requirements. You own scope. You do not design, ' +
      'choose technology, or write code.',
    minimum_outputs: [
      'goals the owner would recognise as their own',
      'the audience, in the owner\'s terms',
      'numbered requirements, each one testable, marked must/should/could/wont',
      'assumptions you had to make, stated openly',
      'missing_questions for anything you genuinely cannot decide for the owner',
      'in_scope and out_of_scope, both non-empty',
    ],
  },
  tech_lead: {
    role: 'tech_lead',
    display_name: 'Tech Lead / Architect',
    planning_enabled: true,
    allowed_tools: [],
    input_contract: 'ProjectContextV1',
    output_contract: 'TechLeadSynthesisV1',
    max_calls_per_meeting: 2,
    core: true,
    mandate:
      'Resolve technical conflict and record decisions. You pick the approach and you own the ' +
      'trade-off record. You do not expand scope to make a decision look better.',
    minimum_outputs: [
      'a decision record per real technical choice, each weighing at least two alternatives',
      'pros AND cons for every alternative, including the one you chose',
      'what actually changed because of round-2 feedback (empty list if nothing did)',
      'unresolved blockers, marked blocking when they stop an approvable spec',
    ],
  },
  ui_ux: {
    role: 'ui_ux',
    display_name: 'UI/UX Designer',
    planning_enabled: true,
    allowed_tools: [],
    input_contract: 'ProjectContextV1',
    output_contract: 'AgentContributionV1',
    max_calls_per_meeting: 2,
    core: true,
    mandate:
      'Own user journey, layout, and accessibility. Judge whether a person can actually complete ' +
      'the task the brief implies.',
    minimum_outputs: [
      'the sitemap or page hierarchy you propose',
      'the primary task flow, step by step',
      'accessibility concerns that are specific to THIS brief, not a generic checklist',
    ],
  },
  frontend: {
    role: 'frontend',
    display_name: 'Frontend Developer',
    planning_enabled: true,
    allowed_tools: [],
    input_contract: 'ProjectContextV1',
    output_contract: 'AgentContributionV1',
    max_calls_per_meeting: 2,
    core: true,
    mandate:
      'Judge implementation feasibility and cost. Say plainly when a design idea is expensive, ' +
      'fragile, or slow on a mid-range phone.',
    minimum_outputs: [
      'component feasibility for what has been proposed',
      'what state or data each page needs',
      'performance constraints you expect to bite',
    ],
  },
  backend: {
    role: 'backend',
    display_name: 'Backend Developer',
    planning_enabled: true,
    allowed_tools: [],
    input_contract: 'ProjectContextV1',
    output_contract: 'AgentContributionV1',
    max_calls_per_meeting: 2,
    core: false,
    mandate:
      'Design API and data only when the brief genuinely needs persistence or server logic. ' +
      'If it does not, say so and keep the scope small - do not invent a backend to stay busy.',
    minimum_outputs: [
      'whether server-side state is genuinely required, and why',
      'the data entities involved, if any',
      'a cheaper alternative to a backend where one exists',
    ],
  },
  security: {
    role: 'security',
    display_name: 'Cybersecurity Engineer',
    planning_enabled: true,
    allowed_tools: [],
    input_contract: 'ProjectContextV1',
    output_contract: 'AgentContributionV1',
    max_calls_per_meeting: 2,
    core: true,
    mandate:
      'Find the attack surface and the privacy exposure in THIS brief. Rank by severity. ' +
      'Generic advice such as "use HTTPS" scores zero.',
    minimum_outputs: [
      'the concrete attack surface this project introduces',
      'a severity for each finding',
      'a mitigation that fits the stated scope and budget',
    ],
  },
  qa: {
    role: 'qa',
    display_name: 'QA Engineer',
    planning_enabled: true,
    allowed_tools: [],
    input_contract: 'ProjectContextV1',
    output_contract: 'AgentContributionV1',
    max_calls_per_meeting: 2,
    core: true,
    mandate:
      'Decide whether each requirement can actually be tested. Name the acceptance conditions ' +
      'that are too vague to pass or fail.',
    minimum_outputs: [
      'acceptance test cases tied to named requirements',
      'edge cases the brief does not mention',
      'any acceptance condition that cannot be objectively judged',
    ],
  },
  devops: {
    role: 'devops',
    display_name: 'DevOps Engineer',
    planning_enabled: true,
    allowed_tools: [],
    input_contract: 'ProjectContextV1',
    output_contract: 'AgentContributionV1',
    max_calls_per_meeting: 2,
    core: false,
    mandate:
      'Review build and delivery constraints only when hosting, environments, or release ' +
      'process are genuinely in question.',
    minimum_outputs: [
      'build and hosting constraints that affect the design',
      'what must exist before a release is possible',
    ],
  },
};

/**
 * Signals that justify activating a conditional role (LLD 5, test T02).
 *
 * Matched on WORD BOUNDARIES, which is not a detail. A plain substring search
 * activated DevOps for the student-payment brief because "ci" appears inside
 * "offi(ci)al receipts". Roster decisions are shown to the Product Owner as
 * justification, so a decision that cannot be explained is worse than no
 * decision at all.
 */
const BACKEND_SIGNALS = [
  'login', 'log in', 'sign in', 'sign up', 'account', 'accounts', 'auth',
  'password', 'database', 'db', 'api', 'payment', 'payments', 'pay', 'invoice',
  'receipt', 'receipts', 'record', 'records', 'user data', 'personal data',
  'transaction', 'transactions', 'persist', 'cms', 'admin panel', 'upload',
  // A form that collects data has to send it somewhere - that is precisely the
  // backend-vs-external-service fork benchmark B2 exists to provoke.
  'form', 'registration', 'register', 'collecting', 'collect', 'submit',
];

const DEVOPS_SIGNALS = [
  'deploy', 'deployment', 'hosting', 'host', 'ci/cd', 'pipeline', 'domain',
  'dns', 'ssl', 'tls', 'scale', 'scaling', 'uptime', 'sla', 'environment',
  'environments', 'staging', 'docker', 'kubernetes',
];

export interface RosterDecision {
  readonly roles: readonly AgentRole[];
  /** Why each conditional role was or was not activated - shown to the owner. */
  readonly reasoning: readonly string[];
}

export interface RosterInput {
  readonly requested_features: readonly string[];
  readonly constraints: readonly string[];
  readonly objective: string;
  readonly title: string;
}

/**
 * Pick the roster deterministically from the brief text.
 *
 * An explicit "no backend" constraint beats a keyword match: a brief that says
 * "Contact form, no backend for MVP" must NOT wake the Backend role just
 * because it contains the word "form".
 */
export function selectRoster(brief: RosterInput): RosterDecision {
  const haystack = [brief.title, brief.objective, ...brief.requested_features, ...brief.constraints]
    .join(' \n ')
    .toLowerCase();

  const constraintText = brief.constraints.join(' \n ').toLowerCase();
  const backendExcluded = /\bno\s+backend\b|\bwithout\s+(a\s+)?backend\b|\bfrontend[- ]only\b|\bstatic\s+only\b/.test(
    constraintText,
  );

  const matches = (signals: readonly string[]): string[] =>
    signals.filter((signal) => {
      // \b around an escaped phrase: "pay" must not match "display", and
      // "db" must not match "sandbox".
      const escaped = signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
    });

  const roles: AgentRole[] = (Object.values(ROLE_DEFINITIONS) as RoleDefinition[])
    .filter((definition) => definition.core && definition.planning_enabled)
    .map((definition) => definition.role);

  const reasoning: string[] = [];

  const backendHits = matches(BACKEND_SIGNALS);
  if (backendExcluded) {
    reasoning.push(
      `backend: NOT activated - the brief explicitly rules out a backend, which overrides the ` +
        `keyword match [${backendHits.slice(0, 4).join(', ') || 'none'}]`,
    );
  } else if (backendHits.length > 0) {
    roles.push('backend');
    reasoning.push(`backend: activated - brief mentions [${backendHits.slice(0, 6).join(', ')}]`);
  } else {
    reasoning.push('backend: NOT activated - no persistence, auth or API signal in the brief');
  }

  const devopsHits = matches(DEVOPS_SIGNALS);
  if (devopsHits.length > 0) {
    roles.push('devops');
    reasoning.push(`devops: activated - brief mentions [${devopsHits.slice(0, 6).join(', ')}]`);
  } else {
    reasoning.push('devops: NOT activated - hosting and release are not in question');
  }

  // Stable, readable meeting order.
  const order: AgentRole[] = ['pm', 'ui_ux', 'frontend', 'backend', 'security', 'qa', 'devops', 'tech_lead'];
  const ordered = order.filter((role) => roles.includes(role));

  return { roles: ordered, reasoning };
}
