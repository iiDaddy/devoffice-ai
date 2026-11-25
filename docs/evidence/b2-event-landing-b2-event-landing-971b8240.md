# M0 benchmark evidence - Event landing page (contains a real architectural fork)

| | |
|---|---|
| Brief | `b2-event-landing` |
| Run id | `b2-event-landing-971b8240` |
| Started | 2026-11-25T04:29:59.679Z |
| Duration | 5.3s |
| Terminal state | **NEEDS_INPUT** |
| Provider | groq |
| Model calls | 1 attempted, 1 succeeded |
| Replayed from log | 11 |
| Events persisted | 28 |
| Event log | `runs\b2-event-landing-971b8240\events.jsonl` |

## Roster decision (deterministic, not a model call)

Selected: `pm`, `ui_ux`, `frontend`, `backend`, `security`, `qa`, `tech_lead`

- backend: activated - brief mentions [form, registration, register, collecting]
- devops: NOT activated - hosting and release are not in question

## Machine-checkable signals

These are counted by code, not judged. They do not score the rubric.

```json
{
  "roleSpecialisation": {
    "proposals": 5,
    "maxPairwiseSimilarity": 0.171,
    "mostSimilarPair": "backend vs security"
  },
  "challengeQuality": {
    "reactions": 5,
    "objections": 2,
    "citingAKnownProposal": 5,
    "withEvidence": 2,
    "withRecommendedChange": 2,
    "danglingCitations": []
  },
  "decisionRationale": {
    "decisions": 3,
    "passingAdrValidation": 3,
    "failures": []
  },
  "requirementTraceability": {
    "requirements": 8,
    "referencedByAnAdr": 8,
    "orphanRequirementIds": []
  },
  "securityQaSignal": {
    "securityContributions": 2,
    "qaContributions": 2,
    "genericPhrasesDetected": [],
    "severitiesUsed": [
      "info",
      "high",
      "medium",
      "low"
    ]
  },
  "stateCorrectness": {
    "terminalState": "NEEDS_INPUT",
    "buildAttemptsRejected": 4,
    "approvalEventsFound": 0
  },
  "quotaRecovery": {
    "blocked": false,
    "errorCode": null,
    "contributionsPreserved": 11,
    "replayedFromLog": 11
  },
  "usage": {
    "calls": 15,
    "reportedPromptTokens": 28839,
    "reportedCompletionTokens": 13576,
    "transportRetries": 0,
    "validationRetries": 0,
    "failedCalls": 3
  }
}
```

## Transcript

### Round 1 - Product Manager requirements

- `REQ-001` **must** (brief): The landing page must include a hero section with a prominent registration call‑to‑action button.
- `REQ-002` **must** (brief): The page must display the meetup schedule organized by time slots, showing each session title.
- `REQ-003` **must** (brief): Each speaker must be presented in a card containing a photo, name, and short biography.
- `REQ-004` **must** (brief): The registration form must collect the attendee's name, email address, and dietary requirement.
- `REQ-005` **must** (brief): The registration form must be operable via screen readers and meet WCAG 2.1 AA accessibility criteria.
- `REQ-006` **should** (inferred): All page content must be responsive and render correctly on desktop and mobile browsers.
- `REQ-007` **must** (brief): The solution must be deployable using only free hosting services without incurring costs.
- `REQ-008` **could** (inferred): If a third‑party form service is employed, it must be free of charge and comply with accessibility standards.

Open questions raised:
- Can we use a third‑party form service for handling registration submissions?
- What is the expected number of registrations to anticipate load and scalability?
- Are there any existing branding guidelines or visual assets that must be followed?
- Which free hosting platform should be used for deployment?

### Round 1 - specialist proposals

#### ui_ux - `prop-ui_ux-landing-page-ux-01` (info)

**Community Tech Meetup Landing Page UX**

Proposed sitemap, primary task flow, and targeted accessibility considerations for the meetup landing page to meet all must‑have requirements within budget and timeline.

*Rationale:* The brief demands a clear, single‑page experience that showcases the hero CTA, schedule, speakers, and registration form while remaining fully screen‑reader accessible and responsive. A hierarchical sitemap that mirrors the visual sections simplifies navigation for both sighted and assistive‑technology users, and a step‑by‑step task flow ensures users can register without friction. Highlighting specific WCAG 2.1 AA concerns (focus order, ARIA labels, contrast) directly addresses REQ‑005 and the zero‑budget constraint by using native HTML elements and free hosting options.
*Risks:* If the navigation hierarchy is too deep, users may lose context on mobile devices; Embedding a third‑party form could introduce hidden accessibility issues; Time pressure (two‑week launch) may lead to insufficient usability testing

#### frontend - `prop-frontend-meetup-landing-01` (info)

**Frontend Implementation Feasibility for Meetup Landing Page**

The page can be built with static HTML/CSS + minimal JavaScript, meeting accessibility, responsiveness, and zero‑budget constraints while staying fast on mid‑range phones.

*Rationale:* All required features (hero CTA, schedule grid, speaker cards, accessible registration form) are static or lightly interactive. Using native HTML elements, CSS Grid/Flexbox, and lazy‑loaded images keeps the bundle < 50 KB, ensuring < 2 s load on a Snapdragon 730 device. No heavy framework is needed, which avoids performance penalties and hosting cost issues.
*Risks:* Large speaker photos could exceed mobile bandwidth if not optimized; Screen‑reader support may be broken by custom JS widgets; Third‑party form service might not expose accessible ARIA attributes; Free hosting limits (bandwidth, build size) could be hit if assets are not minified

#### backend - `prop-backend-registration-data-01` (info)

**Registration data handling for meetup landing page**

Server‑side storage is unnecessary; use a free third‑party form service to collect registrations instead of building a backend.

*Rationale:* The brief explicitly lists building a backend database as out of scope and seeks a zero‑budget solution. All required registration fields (name, email, dietary requirement) can be captured by free form services that provide email notifications or spreadsheet storage, satisfying WCAG accessibility and keeping costs at zero. Therefore persisting data on a custom server is not justified.
*Risks:* Dependency on third‑party service uptime and privacy policies; Limited control over form styling and validation beyond what the service offers; Potential data export limitations for future analysis

#### security - `prop-security-attack-surface-01` (high)

**Attack surface and privacy exposure analysis**

Identify data collection risks and third‑party form exposure for the meetup landing page.

*Rationale:* The brief requires a registration form that collects name, email, and dietary requirements and leaves open the use of a third‑party form service. Collecting personal data on a static site introduces transmission, storage, and third‑party privacy risks that must be assessed and mitigated before launch.
*Risks:* Personal data (email, dietary info) could be intercepted if submitted over non‑HTTPS connections – high privacy impact; Third‑party form service may store data in jurisdictions without adequate protection – potential GDPR violation; Improper input sanitisation could lead to XSS or injection attacks affecting visitors; Embedded speaker images could contain malicious payloads if not validated – low but possible; Lack of CSRF protection on any custom endpoint could allow forged submissions – medium

#### qa - `prop-qa-acceptance-tests-01` (medium)

**QA Acceptance Test Proposal for Meetup Landing Page**

Define concrete test cases for each requirement and flag acceptance criteria that are too vague to be objectively judged.

*Rationale:* A thorough QA plan is essential to ensure the landing page meets all must‑have functional and non‑functional requirements before the two‑week launch deadline. This proposal maps test cases to each requirement, highlights ambiguous statements (e.g., "prominent" CTA, "responsive" rendering), and outlines edge‑case scenarios that the brief does not explicitly cover, enabling the team to assess feasibility and avoid later rework.
*Risks:* Ambiguous wording may lead to inconsistent test verdicts; Limited time may restrict depth of edge‑case coverage; Free hosting constraints could affect performance testing; Potential reliance on third‑party form service not yet approved

### Round 2 - cross-review

#### ui_ux - **support** on `prop-security-attack-surface-01` (info)

Security proposal correctly flags privacy and injection risks and aligns with our need for accessible, trustworthy data collection.

*Why:* The identified risks—non‑HTTPS transmission, third‑party jurisdiction, XSS, and CSRF—directly affect user trust and the accessibility experience. From a UI/UX standpoint, ensuring secure transmission and clear privacy notices is essential for screen‑reader users and for maintaining a credible registration flow, which supports the brief’s goal of driving registrations.
*Evidence:* Security proposal lists high‑severity privacy and injection concerns that match brief requirements for WCAG 2.1 AA compliance; Brief explicitly requires screen‑reader operable registration form, making secure, accessible handling a UI priority

#### frontend - **revision** on `prop-ui_ux-landing-page-ux-01` (low)

Recommend flattening navigation to a single‑page layout with proper focus handling to meet WCAG and avoid mobile context loss.

*Why:* The UI/UX proposal warns that a deep navigation hierarchy can cause users on mobile to lose context, which conflicts with the requirement for screen‑reader accessibility and a two‑week timeline. Implementing a single‑page scrollable layout with anchor links and explicit ARIA landmarks reduces complexity, improves performance on mid‑range phones, and ensures focus is managed when the hero CTA jumps to the registration form.
*Evidence:* "If the navigation hierarchy is too deep, users may lose context on mobile devices" – UI/UX proposal risk note; WCAG 2.1 AA requires logical focus order and visible focus indicators for interactive elements; Mid‑range phones have limited processing power; reducing DOM depth improves render performance
*Recommended change:* Replace any multi‑level navigation with a single‑page scrollable layout using skip links and ARIA landmarks; ensure that clicking the hero CTA moves keyboard focus to the registration form section (or opens a modal) to maintain screen‑reader context.

#### backend - **question** on `prop-security-attack-surface-01` (info)

Is a custom backend required for registration data collection or can a free third‑party form be used?

*Why:* The brief explicitly lists building a backend database as out of scope and requires a zero‑budget solution; therefore we need clarification on whether any server‑side logic is truly necessary or if a static site with a free, accessible form service suffices.
*Evidence:* Out_of_scope section states "Building a backend database to store registration data" is excluded; Requirement REQ‑008 allows free third‑party form services

#### security - **objection** on `prop-backend-registration-data-01` (high)

Third‑party form service introduces privacy exposure and insufficient data protection for collected attendee data.

*Why:* The backend proposal recommends using a free third‑party form service to capture name, email, and dietary requirements without any analysis of privacy impact, data‑in‑transit encryption, storage location, retention policy, or compliance with GDPR/CCPA. Collecting personally identifiable information via an uncontrolled external service creates a high‑severity attack surface: data could be intercepted, stored insecurely, or shared with third parties, violating user privacy and potentially exposing the organization to legal liability.
*Evidence:* "Server‑side storage is unnecessary; use a free third‑party form service to collect registrations instead of building a backend."; "Dependency on third‑party service uptime and privacy policies"
*Recommended change:* Mandate a privacy impact assessment and select a third‑party form service that guarantees end‑to‑end TLS, explicit GDPR/CCPA compliance, data‑retention limits, and user‑initiated deletion; alternatively, replace the external service with a free serverless function‑based form to keep data under our control and enforce proper security controls.

#### qa - **objection** on `prop-ui_ux-landing-page-ux-01` (medium)

UI/UX proposal lacks concrete, testable acceptance criteria for accessibility and navigation depth

*Why:* The UI/UX proposal mentions addressing WCAG 2.1 AA concerns (focus order, ARIA labels, contrast) and warns about a deep navigation hierarchy, but it does not define measurable acceptance conditions. Without explicit criteria (e.g., contrast ratio ≥4.5:1, focus indicator width ≥2 px, ARIA‑label presence on all interactive elements), QA cannot objectively pass or fail the requirement, leading to ambiguous testing and potential non‑compliance.
*Evidence:* "Highlighting specific WCAG 2.1 AA concerns (focus order, ARIA labels, contrast) directly addresses REQ‑005" – lacks quantitative thresholds; "Risks: If the navigation hierarchy is too deep, users may lose context on mobile devices" – depth not quantified; "Time pressure (two‑week launch) may lead to insufficient usability testing" – indicates risk but no mitigation plan
*Recommended change:* Include explicit, measurable acceptance criteria for each WCAG 2.1 AA item (e.g., contrast ≥4.5:1, focus indicator visible, ARIA labels on hero CTA, heading hierarchy H1‑H3 correct) and define a maximum navigation depth (no more than two hierarchical levels). Document these criteria in the proposal so QA can create objective test cases.

### Round 3 - decision synthesis

The team agreed on a single‑page accessible layout, a privacy‑first serverless form handling approach, and a pure static HTML/CSS implementation to meet all must‑have requirements within zero budget and the two‑week timeline.

#### ADR `dec-001` - selected: **Serverless function‑based form with free tier storage**

*Problem:* How to collect registration data while satisfying privacy, accessibility, zero‑budget, and security requirements.

- **Free third‑party form service** - pros: No development effort required, Instantly available and often includes email notifications, Fits zero‑budget constraint | cons: Potential privacy and GDPR compliance issues, Limited control over ARIA attributes and styling, Dependency on external uptime and data‑retention policies
- **Serverless function‑based form with free tier storage** - pros: Full control over data handling, encryption, and GDPR compliance, Can enforce required ARIA attributes and validation, Still fits zero‑budget using free hosting providers | cons: Requires minimal development and deployment effort, Needs a free hosting platform that supports serverless functions, Potential cold‑start latency, though negligible for low traffic

*Rationale:* Choosing a serverless function gives us direct control over data protection, allows us to meet WCAG 2.1 AA accessibility for the form, and still respects the zero‑budget constraint, addressing the high‑severity security objection about third‑party privacy exposure.
*Affects:* REQ-004, REQ-005, REQ-007, REQ-008

#### ADR `dec-002` - selected: **Single‑page flat layout with skip links and ARIA landmarks**

*Problem:* Navigation structure needed to satisfy WCAG 2.1 AA, mobile usability, and the two‑week schedule.

- **Multi‑level navigation hierarchy** - pros: Can group content into logical sections, Scales if more pages are added later | cons: Increases focus‑order complexity for screen readers, Risk of losing context on mobile devices as highlighted by frontend feedback, Adds implementation overhead within the tight timeline
- **Single‑page flat layout with skip links and ARIA landmarks** - pros: Simplifies focus management and meets WCAG focus‑order requirements, Reduces navigation depth to a maximum of two levels (skip links only), Easier and faster to implement within two weeks | cons: Less modular if future expansion beyond a single page is needed, Potentially longer scroll for users on very small screens

*Rationale:* The flat single‑page approach directly addresses the frontend revision and security concerns about navigation depth, ensures screen‑reader context is preserved, and aligns with the two‑week launch deadline while still fulfilling all must‑have content sections.
*Affects:* REQ-001, REQ-002, REQ-003, REQ-005, REQ-006

#### ADR `dec-003` - selected: **Pure static HTML/CSS with minimal vanilla JavaScript**

*Problem:* Selection of frontend technology stack that meets performance, budget, and timeline constraints.

- **Pure static HTML/CSS with minimal vanilla JavaScript** - pros: Zero build tooling cost, fits zero‑budget, Very small bundle size (< 50 KB) ensuring fast load on low‑end devices, Simpler deployment on any free static host | cons: Manual repetition of markup for speaker cards and schedule rows, Limited templating convenience
- **Lightweight static site generator (e.g., Eleventy, Hugo)** - pros: Provides templating to avoid markup duplication, Can still be deployed for free and produce static assets | cons: Adds a build step and learning curve, May exceed the two‑week timeline for setup and testing, Potentially larger build artifacts if not carefully configured

*Rationale:* Given the strict two‑week deadline, zero‑budget requirement, and the need for full control over accessibility markup, the simplest static approach minimizes risk and satisfies all performance and hosting constraints.
*Affects:* REQ-001, REQ-002, REQ-003, REQ-004, REQ-005, REQ-006, REQ-007

**Changed because of round-2 feedback:**

- Flatten navigation to a single‑page layout (frontend revision)
- Adopt serverless function form handling after security objection

### Blocking questions (state NEEDS_INPUT)

- Which free hosting platform should be used for deploying the static site and serverless function?
- Can we use a third‑party form service for handling registration submissions?
- What is the expected number of registrations to anticipate load and scalability?
- Are there any existing branding guidelines or visual assets that must be followed?
- Which free hosting platform should be used for deployment?

## What a competent team had to do on this brief

- [ ] The registration form is identified as the decision point: own backend vs external service
- [ ] At least one ADR weighs those alternatives with pros AND cons on both sides
- [ ] Dietary requirement is recognised as personal data with a retention/consent implication
- [ ] Accessibility is specific - form labels, focus order, speaker-card alt text - not a checklist
- [ ] The "may we use a third-party service" unknown becomes a blocking question, not an assumption

## Red flags - tick means the run FAILED, however polished it reads

- [ ] Picking a backend without weighing the zero-budget, two-week constraint
- [ ] Treating dietary requirement as ordinary text with no privacy comment
- [ ] Promising a registration count SLA that the brief never mentioned

## Rubric (LLD 14.2) - TO BE SCORED BY A HUMAN

Scores are deliberately blank. Fill them in from the transcript above.
Gate proposed by the LLD: at least 13/16 on two of three briefs, with no zero on
"State/approval correctness".

| Metric | Score (0/1/2) | Supporting signal | Note |
|---|---|---|---|
| Role specialization | _ | max pairwise similarity of proposals | |
| Challenge quality | _ | objections citing a real proposal, with evidence + fix | |
| Decision rationale | _ | ADRs passing the two-alternatives rule | |
| Requirement traceability | _ | requirements referenced by an ADR | |
| Security/QA signal | _ | generic phrases detected; severities used | |
| Spec completeness | _ | NOT APPLICABLE AT M0 - spec generation is M3 | |
| State/approval correctness | _ | terminal state; build attempts rejected | |
| Quota/recovery handling | _ | blocked-but-resumable; contributions preserved | |

**Total: _ / 16**  (scored by: ______________  date: __________)
