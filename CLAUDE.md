# DevOffice AI — working rules

Read this before changing anything. The rules below are not style preferences:
each one exists because breaking it has already caused a real failure, or
would silently defeat the point of the project.

## What this project is

An AI "dev team": several specialist agents discuss a website brief, challenge
each other's proposals, record decisions, and hand a human Product Owner a
specification to approve. Coding only ever happens after that approval.

**Current milestone: M0 / Planning Lab.** The meeting works end to end against
a real provider. Specification generation, the web UI, and autonomous coding
are NOT built yet and must not be started without the owner saying so.

The point of the whole thing is *evidence over theatre*. A fluent transcript
that nobody can verify is a failure, however good it reads.

## Rules that break things if ignored

1. **Never use `.optional()` in `src/shared/schemas.ts`.** Use `.nullable()`.
   Groq strict mode requires every property to appear in `required`, and
   `.optional()` silently drops it. A startup guard throws with a JSON pointer
   if you get this wrong.

2. **Model IDs live only in `src/providers/` and `src/cli/`.** A test scans
   the source and fails if `gpt-oss`, `llama-3`, `qwen3` and similar appear
   anywhere else. Provider-agnostic is enforced, not aspirational.

3. **No shell execution anywhere in `src/`.** No `child_process`, `execSync`,
   `spawnSync`, `node:vm`, `eval(`, `new Function(`. A test scans for these.
   Autonomous build belongs to M4/M5 behind a sandbox.

4. **`ENABLE_AUTONOMOUS_BUILD` must stay `false`.** `loadConfig()` refuses to
   start if it is true. Do not "temporarily" flip it.

5. **Quantitative rules stay in Zod, never in the JSON Schema sent to Groq.**
   `minLength`, `minItems`, `pattern` and friends are stripped before the
   schema goes on the wire — Groq does not document them as supported and an
   unknown keyword 400s the whole request. State the expectation in the prompt
   instead.

6. **Only two files may write to disk:** `src/shared/events.ts` and
   `src/cli/run-benchmark.ts`. A test asserts exactly that list.

## Honesty rules

These matter more than the code quality rules.

- **Never auto-score the LLD 14.2 rubric.** Reports emit it blank on purpose.
  A program grading agent output grades fluency, not thinking.
- **Never invent usage or cost.** If the provider reports no tokens, the field
  stays `null`. Groq reports no cost, so `cost_reported` is always `null`.
- **Simulated output must be labelled.** `MockProvider` sets `simulated: true`
  and its text is prefixed `[SIMULATED]`. Never make it look real.
- **Report attempts, not just successes.** `modelAttempts` and `modelCalls`
  are separate fields because "0 calls" after a failed run read as if nothing
  had been tried.
- **A meeting is never complete because the model said so.** Completion is
  decided by the state machine from validated output.

## Architecture

```
src/shared/      schemas, errors, config, event log   <- no AI, no vendor
src/providers/   ModelProvider interface + Groq + mock <- only place "Groq" exists
src/agents/      role definitions, prompts, per-round contracts
src/workflows/   meeting orchestration, build gate
src/benchmarks/  the three briefs + evidence report
src/cli/         check:env, models, bench
```

Dependencies point downward only. `workflows` may import `providers`;
`providers` must never import `workflows`.

**The orchestrator is deterministic code, not an agent.** Who speaks, who sees
what, when the meeting ends — all decided in `src/workflows/meeting.ts`. The
model only fills in contributions. Do not move control flow into a prompt.

## Contracts

- Round 1 uses `PROPOSAL_CONTRACT`; round 2 uses `reactionContract(ids)`;
  round 3 uses `synthesisContract(requirementIds)`. Same JSON Schema on the
  wire, different Zod gates. Validation failures feed the provider's existing
  repair loop — do not add a separate error path.
- Round-aware validators are built from the meeting's **actual** ids, so a
  citation to a proposal that does not exist is caught rather than recorded.

## Prefer structure over length rules

A minimum-character rule produces length, not content. This was learned the
hard way: `changed_due_to_feedback` used to be `string[]` with a 10-character
minimum and produced four lines of "Decision DEC-001 updated based on round-2
feedback". It is now an object with `previous_position` / `revised_position` /
`why`, and the empty version has nowhere to go.

When you want substance, add fields. Do not add length minimums.

## Before you finish any change

```bash
npm run typecheck    # must be 0 errors
npm test             # must be all green
```

Never report a change as done without running both. If a test fails, say so
plainly rather than adjusting the test to pass — unless the test itself is
wrong, in which case explain why before changing it.

Adding behaviour means adding a test. Fixing a bug means adding a test that
reproduces it, using the real error text where one exists.

## Windows

The owner develops on Windows, PowerShell. Node path helpers return `\`, so
normalise to `/` before comparing paths. This has already broken two tests.

## Secrets

`.env` is gitignored and must stay that way. `GROQ_API_KEY` is read only in
`src/shared/config.ts` and used only in `src/providers/groq.ts`. It must never
reach a log, an error message, an event payload or a report.

## Running things

```bash
npm run check:env                          # is the environment ready
npm run models                             # what this account can reach
npm run bench -- --brief=b1-portfolio      # one benchmark
npm run bench -- --brief=all               # all three
npm run bench -- --brief=X --run-id=<id>   # resume a blocked run
npm run bench:mock                         # no API key needed, labelled SIMULATED
```

A run takes 5–12 minutes. Most of that is deliberate pacing: the free-tier
token-per-minute ceiling, not a hang.

## Background

- `docs/M0-REPORT.md` — 13 findings from reading the blueprints, and why
- `docs/ADRs/` — why each significant choice was made
- `docs/evidence/` — real benchmark transcripts, scored by hand
- `docs/BLUEPRINT.md` — where the source HLD and LLD live
