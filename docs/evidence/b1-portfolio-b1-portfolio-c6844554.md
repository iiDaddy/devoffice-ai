# M0 benchmark evidence - Personal portfolio (baseline)

| | |
|---|---|
| Brief | `b1-portfolio` |
| Run id | `b1-portfolio-c6844554` |
| Started | 2026-11-24T16:20:19.450Z |
| Duration | 545.2s |
| Terminal state | **NEEDS_INPUT** |
| Provider | groq |
| Model calls made | 10 |
| Replayed from log | 0 |
| Events persisted | 19 |
| Event log | `runs\b1-portfolio-c6844554\events.jsonl` |

## Roster decision (deterministic, not a model call)

Selected: `pm`, `ui_ux`, `frontend`, `security`, `qa`, `tech_lead`

- backend: NOT activated - the brief explicitly rules out a backend, which overrides the keyword match [none]
- devops: NOT activated - hosting and release are not in question

## Machine-checkable signals

These are counted by code, not judged. They do not score the rubric.

```json
{
  "roleSpecialisation": {
    "proposals": 4,
    "maxPairwiseSimilarity": 0.101,
    "mostSimilarPair": "frontend vs security"
  },
  "challengeQuality": {
    "reactions": 4,
    "objections": 3,
    "citingAKnownProposal": 4,
    "withEvidence": 3,
    "withRecommendedChange": 3,
    "danglingCitations": []
  },
  "decisionRationale": {
    "decisions": 3,
    "passingAdrValidation": 3,
    "failures": []
  },
  "requirementTraceability": {
    "requirements": 12,
    "referencedByAnAdr": 8,
    "orphanRequirementIds": [
      "REQ-006",
      "REQ-010",
      "REQ-011",
      "REQ-012"
    ]
  },
  "securityQaSignal": {
    "securityContributions": 2,
    "qaContributions": 2,
    "genericPhrasesDetected": [],
    "severitiesUsed": [
      "low",
      "info",
      "high",
      "medium"
    ]
  },
  "stateCorrectness": {
    "terminalState": "NEEDS_INPUT",
    "buildAttemptsRejected": 1,
    "approvalEventsFound": 0
  },
  "quotaRecovery": {
    "blocked": false,
    "errorCode": null,
    "contributionsPreserved": 9,
    "replayedFromLog": 0
  },
  "usage": {
    "calls": 10,
    "reportedPromptTokens": 23973,
    "reportedCompletionTokens": 10463,
    "transportRetries": 0,
    "validationRetries": 0,
    "failedCalls": 0
  }
}
```

## Transcript

### Round 1 - Product Manager requirements

- `REQ-001` **must** (brief): The website must display a Home page that includes a brief introduction and navigation links to other sections.
- `REQ-002` **must** (brief): The website must include an About page presenting the developer's background and summary.
- `REQ-003` **must** (brief): The website must include a Skills page listing technical skills in a readable format.
- `REQ-004` **must** (brief): The website must include a Projects page showcasing at least three projects with title, description, and link.
- `REQ-005` **must** (brief): The website must include a Contact page with a form that collects name, email, and message fields.
- `REQ-006` **must** (brief): The website must be mobile responsive, adapting layout for screen widths down to 320px.
- `REQ-007` **must** (brief): The website must have a professional visual design using a clean layout, consistent typography, and appropriate color scheme.
- `REQ-008` **must** (brief): The website must be deployable as a static site without requiring a backend server.
- `REQ-009` **should** (inferred): The contact form should submit messages via a client‑side email service to a specified email address.
- `REQ-010` **could** (inferred): The website could load all pages in under 2 seconds on a typical 3G connection.
- `REQ-011` **could** (inferred): The website could include a downloadable PDF version of the portfolio for offline review.
- `REQ-012` **wont** (inferred): The website will not include user authentication or login functionality.

Open questions raised:
- Which email address or service should the contact form use to deliver messages?
- Are there any specific branding colors or fonts the developer wants to apply?
- Should the site include any analytics tracking (e.g., Google Analytics)?

### Round 1 - specialist proposals

#### ui_ux - `prop-ui_ux-portfolio-01` (low)

**Junior Developer Portfolio UI/UX Design**

Proposed sitemap, primary task flow, and accessibility considerations for the portfolio site to meet all must‑have requirements.

*Rationale:* A clear hierarchical sitemap ensures recruiters can locate Home, About, Skills, Projects, and Contact pages quickly, supporting REQ‑001‑005. The step‑by‑step task flow mirrors the user journey from landing on Home to submitting the contact form, guaranteeing a professional experience on mobile and desktop (REQ‑006, REQ‑007). Specific accessibility concerns address form labeling, focus order, color contrast, and touch target size, which are essential for a static, responsive site and are not covered by generic checklists.
*Risks:* Over‑loading the navigation with too many items could overwhelm recruiters; Choosing a color palette without contrast testing may fail WCAG AA

#### frontend - `prop-frontend-portfolio-01` (info)

**Junior Developer Portfolio Frontend Feasibility**

Static responsive portfolio feasible with modest assets and client‑side email integration for contact form.

*Rationale:* All required pages (Home, About, Skills, Projects, Contact) can be built as static HTML/CSS/JS components using a lightweight framework or vanilla code. Data for each page is simple JSON or markdown, loaded at build time, so no runtime API calls are needed. Mobile‑responsive layout can be achieved with CSS Grid/Flexbox and media queries down to 320px. A client‑side email service (e.g., EmailJS) satisfies the contact form requirement without a backend. Asset optimization (image compression, code splitting) keeps load times under 2 s on 3G, meeting the performance goal on mid‑range phones.
*Risks:* Uncompressed images could breach the 2 s load target on slow networks; Exposing email service keys in client code may be a security concern; Complex CSS may cause layout glitches on low‑end devices

#### security - `prop-security-portfolio-01` (high)

**Static portfolio contact form security**

Identify client‑side contact form attack surface, privacy leaks, and propose mitigations for a static portfolio site.

*Rationale:* The brief specifies a client‑side email service for the contact form with no backend, exposing the developer's email address and allowing unvalidated user input. This creates high‑impact attack vectors such as email injection, spam abuse, data leakage to third parties, and possible XSS via project links. Ranking these risks and providing realistic mitigations fits the project's static‑site constraint and limited budget.
*Risks:* Email address harvest and spam (medium); Abuse of client‑side email service to send arbitrary emails (high); Leak of visitor metadata to third‑party service (high); Cross‑site scripting via unsanitized project URLs or message content (medium); Open redirect or malicious link injection in project listings (low)

#### qa - `prop-qa-acceptance-tests-01` (medium)

**QA Acceptance Test Plan for Portfolio Site**

Define test cases for each requirement, flag vague criteria, and outline edge cases for the junior developer portfolio site.

*Rationale:* A comprehensive test plan is needed to verify that every MUST requirement can be objectively measured, to expose any acceptance statements that are too subjective, and to anticipate edge‑case scenarios not covered in the brief. The plan maps test cases to each REQ‑xxx, lists edge conditions (e.g., extremely narrow viewports, broken image links, malformed email input), and identifies requirements that cannot be judged without additional clarification (REQ‑007 professional visual design, REQ‑009 target email/service, REQ‑010 performance baseline on 3G). This ensures the development team receives clear, testable acceptance criteria before implementation.
*Risks:* If vague requirements are not clarified, test results may be disputed; Performance testing on 3G may require network throttling tools not yet provisioned; Client‑side email integration could fail without a confirmed service

### Round 2 - cross-review

#### ui_ux - **objection** on `prop-frontend-portfolio-01` (medium)

Frontend proposal lacks explicit accessibility provisions for the portfolio site.

*Why:* The frontend plan focuses on layout, responsiveness, and performance but does not address WCAG 2.1 AA compliance, semantic HTML, ARIA attributes, keyboard navigation, color contrast, or alt text. Without these, the site may be unusable for users with disabilities, risking exclusion, legal non‑compliance, and a poorer recruiter impression.
*Evidence:* The frontend proposal outlines layout, responsiveness, and performance but does not mention WCAG compliance, ARIA roles, keyboard navigation, or color contrast.; No mention of alt text for project images or semantic markup for form fields.
*Recommended change:* Include a detailed accessibility strategy: ensure WCAG 2.1 AA compliance, add ARIA labels, keyboard‑focus indicators, sufficient color contrast, alt text for all images, and run automated accessibility tests (axe) as part of CI.

#### frontend - **support** on `prop-ui_ux-portfolio-01` (info)

The UI/UX sitemap and task flow meet all must‑have requirements and are feasible for a static, responsive portfolio.

*Why:* The proposed hierarchical navigation (Home, About, Skills, Projects, Contact) aligns with REQ‑001‑005 and keeps the recruiter journey simple. The mobile‑first task flow respects REQ‑006 and the accessibility notes satisfy WCAG contrast and touch‑target guidance, making implementation straightforward with React/Next.js static generation.
*Evidence:* Nielsen Norman Group, "Navigation Design Guidelines" (2023); WCAG 2.1 Success Criterion 1.4.3 Contrast (Minimum); MDN Web Docs, "Responsive design basics"

#### security - **objection** on `prop-frontend-portfolio-01` (high)

Frontend proposal risks exposing EmailJS API keys in the browser, creating a high‑severity attack surface for spam and credential abuse.

*Why:* The frontend proposal explicitly lists "Exposing email service keys in client code may be a security concern" as a risk. Publicly visible API keys allow any attacker to invoke the email service, send arbitrary messages, and potentially exhaust quota or damage reputation. Because the site is static and has no backend, the only way to protect the key is to avoid embedding it in the client altogether. Without mitigation, the contact form becomes a vector for abuse, phishing, and denial‑of‑service against the developer's email address.
*Evidence:* "Exposing email service keys in client code may be a security concern" (frontend proposal risk); Public documentation of EmailJS shows API keys are secret and must not be exposed to browsers
*Recommended change:* Replace direct client‑side EmailJS integration with a minimal serverless endpoint that stores the API key securely and forwards messages, or switch to a service that only requires a public token and add CAPTCHA/honeypot validation to the form to mitigate automated abuse.

#### qa - **objection** on `prop-ui_ux-portfolio-01` (medium)

UI/UX proposal lacks testable criteria for professional visual design and accessibility

*Why:* The UI/UX proposal states the site must have a "professional visual design using a clean layout, consistent typography, and appropriate color scheme" and mentions color‑contrast testing, but it does not define measurable thresholds or concrete checks. Without quantifiable metrics (e.g., WCAG AA contrast ratio, minimum font size, spacing standards) the acceptance condition cannot be objectively judged, making it untestable for QA.
*Evidence:* "The website must have a professional visual design using a clean layout, consistent typography, and appropriate color scheme."; "Choosing a color palette without contrast testing may fail WCAG AA"
*Recommended change:* Add explicit, measurable design criteria: require minimum contrast ratio of 4.5:1 for text/background (WCAG AA), base font size ≥16px, line‑height ≥1.5, consistent heading hierarchy (H1‑H3), and a defined color palette with contrast verification. Include a checklist for these items in the acceptance criteria.

### Round 3 - decision synthesis

The team agreed on a static‑site approach with a secure, public‑token email service, explicit accessibility compliance, and measurable visual design criteria, while noting open questions on branding, email target, and analytics.

#### ADR `DEC-001` - selected: **Public‑token only service (e.g., Formspree) with CAPTCHA/honeypot**

*Problem:* How to implement the contact form submission without violating the no‑backend constraint and maintaining security.

- **Direct client‑side EmailJS integration** - pros: Simple implementation, No backend required, Fits static site constraint | cons: Exposes API keys in browser, High spam/abuse risk, Fails security requirement
- **Serverless endpoint (e.g., Netlify Functions) to proxy EmailJS** - pros: Keeps API keys secret, Reduces spam risk, Allows validation/honeypot | cons: Introduces backend component contrary to MVP constraint, Adds deployment complexity, Potential cost
- **Public‑token only service (e.g., Formspree) with CAPTCHA/honeypot** - pros: No secret keys exposed, Remains fully static, Low security risk with CAPTCHA, Fits MVP no‑backend rule | cons: Requires account setup, Limited customization compared to full EmailJS, Depends on third‑party service availability

*Rationale:* Choosing a public‑token service preserves the static‑site requirement, eliminates secret key exposure highlighted by security, and mitigates spam through CAPTCHA, while still satisfying REQ‑005 and REQ‑009 with acceptable effort.
*Affects:* REQ-005, REQ-009, REQ-008

#### ADR `DEC-002` - selected: **Detailed WCAG 2.1 AA compliance checklist with automated tests**

*Problem:* What level of accessibility compliance should be built into the portfolio site?

- **No explicit accessibility plan** - pros: Faster development, Less upfront effort | cons: Risk of WCAG non‑compliance, QA cannot verify, Potential legal/UX issues
- **Detailed WCAG 2.1 AA compliance checklist with automated tests** - pros: Ensures accessibility for recruiters using assistive tech, Addresses UI/UX objection, Provides measurable criteria for QA | cons: Additional development time, Requires tooling (axe, CI integration)

*Rationale:* The UI/UX objection highlighted missing accessibility provisions; adopting a concrete WCAG AA checklist satisfies REQ‑001‑005 usability, aligns with professional standards, and gives QA a clear verification path.
*Affects:* REQ-001, REQ-002, REQ-003, REQ-004, REQ-005, REQ-007

#### ADR `DEC-003` - selected: **Define measurable design criteria (contrast ≥4.5:1, base font ≥16px, line‑height ≥1.5, consistent heading hierarchy, approved color palette)**

*Problem:* How to define the professional visual design so it is testable and meets stakeholder expectations.

- **Leave visual design criteria vague** - pros: Full creative freedom, Less upfront specification | cons: QA cannot objectively assess, Risk of not meeting professional look, May conflict with branding expectations
- **Define measurable design criteria (contrast ≥4.5:1, base font ≥16px, line‑height ≥1.5, consistent heading hierarchy, approved color palette)** - pros: Provides clear acceptance criteria, Addresses QA objection, Ensures consistency and professionalism | cons: Constrains designer choices, Requires contrast testing tools

*Rationale:* QA flagged the lack of testable visual standards; specifying concrete metrics makes REQ‑007 verifiable, supports consistent branding, and aligns with professional expectations without adding technical complexity.
*Affects:* REQ-007

**Changed because of round-2 feedback:**

- Added a public‑token email service with CAPTCHA in response to security objection
- Included a detailed WCAG AA accessibility checklist after UI/UX objection
- Established measurable visual design criteria following QA objection

### Blocking questions (state NEEDS_INPUT)

- Which email address or service should the contact form use to deliver messages?
- Are there any specific branding colors or fonts the developer wants to apply?
- Should the site include any analytics tracking (e.g., Google Analytics)?
- Which email address or service should the contact form use to deliver messages?
- Are there any specific branding colors or fonts the developer wants to apply?
- Should the site include any analytics tracking (e.g., Google Analytics)?

## What a competent team had to do on this brief

- [ ] Backend role is NOT activated - the brief rules it out explicitly (T02)
- [ ] The contact-form delivery question is raised as a blocker rather than guessed (T07)
- [ ] QA ties acceptance tests to named requirements, not to vibes
- [ ] Security scopes to the real surface: form spam, outbound links, no secrets in a static site
- [ ] Where roles agree, the record is a concise consensus, not invented conflict (T06)

## Red flags - tick means the run FAILED, however polished it reads

- [ ] Inventing a CMS, database or login that nobody asked for
- [ ] Security output that is only "use HTTPS" and "validate input"
- [ ] Silently deciding where the contact form delivers

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
