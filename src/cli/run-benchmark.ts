/**
 * `npm run bench -- --brief=b1-portfolio`
 * `npm run bench:mock`
 *
 * The M0 test harness. Runs a real three-round meeting, persists every event,
 * and writes an evidence report you can read without trusting this program's
 * opinion of itself.
 *
 * Flags:
 *   --brief=b1-portfolio|b2-event-landing|b3-payment-portal|all
 *   --provider=groq|mock          (default groq; falls back to nothing if no key)
 *   --run-id=<id>                 reuse an id to RESUME a blocked/killed run
 *   --out=<dir>                   where reports go (default docs/evidence)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventLog } from '../shared/events.js';
import { isDevOfficeError } from '../shared/errors.js';
import { GroqProvider } from '../providers/groq.js';
import { MockProvider } from '../providers/mock.js';
import { RequestThrottle } from '../providers/throttle.js';
import type { ModelProvider } from '../providers/types.js';
import { BENCHMARK_BRIEFS, getBrief, type BenchmarkBrief } from '../benchmarks/briefs.js';
import { computeSignals, renderMarkdownReport } from '../benchmarks/report.js';
import { runMeeting } from '../workflows/meeting.js';
import { requestBuild } from '../workflows/build-gate.js';
import { configOrExit, heading, parseArgs } from './shared.js';
import type { AppConfig } from '../shared/config.js';

function buildProvider(
  kind: string,
  config: AppConfig,
  onProgress: (line: string) => void,
): ModelProvider {
  if (kind === 'mock') return new MockProvider();

  if (config.GROQ_API_KEY === null || config.GROQ_MODEL_PLANNING === null) {
    console.error('\nCannot run against Groq:');
    if (config.GROQ_API_KEY === null) console.error('  - GROQ_API_KEY is not set');
    if (config.GROQ_MODEL_PLANNING === null) console.error('  - GROQ_MODEL_PLANNING is not set');
    console.error('\nRun `npm run check:env` for setup steps, or `npm run bench:mock` to');
    console.error('exercise the wiring with clearly-labelled template output instead.\n');
    process.exit(2);
  }

  const throttle = new RequestThrottle({
    maxConcurrency: config.WORKER_MAX_CONCURRENCY,
    maxRequestsPerMinute: config.THROTTLE_MAX_REQUESTS_PER_MINUTE,
    maxTokensPerMinute: config.THROTTLE_MAX_TOKENS_PER_MINUTE,
    minIntervalMs: config.THROTTLE_MIN_INTERVAL_MS,
    onWait: (waitMs, reason) => {
      if (waitMs > 250) onProgress(`  [pacing] waiting ${waitMs}ms (${reason})`);
    },
  });

  return new GroqProvider({
    apiKey: config.GROQ_API_KEY,
    modelId: config.GROQ_MODEL_PLANNING,
    baseUrl: config.GROQ_BASE_URL,
    structuredMode: config.GROQ_STRUCTURED_MODE,
    temperature: config.MODEL_TEMPERATURE,
    timeoutMs: config.REQUEST_TIMEOUT_MS,
    maxTransportRetries: config.MODEL_REQUEST_MAX_RETRIES,
    maxSchemaRepairs: config.SCHEMA_REPAIR_MAX_RETRIES,
    quotaExhaustedThresholdMs: config.QUOTA_EXHAUSTED_THRESHOLD_MS,
    throttle,
    onRetry: ({ attempt, waitMs, code }) =>
      onProgress(`  [retry ${attempt}] ${code} - waiting ${waitMs}ms`),
    onValidationRetry: ({ attempt, schemaName, issues }) =>
      onProgress(`  [repair ${attempt}] ${schemaName}: ${issues.slice(0, 2).join(' | ')}`),
  });
}

async function runOne(
  brief: BenchmarkBrief,
  provider: ModelProvider,
  config: AppConfig,
  runId: string,
  outDir: string,
): Promise<{ state: string; reportPath: string }> {
  heading(`${brief.label}  [${brief.id}]`);

  const projectId = `proj-${brief.id}`;
  const meetingId = `meet-${brief.id}`;
  const eventLog = new EventLog({ runsDir: config.RUNS_DIR, runId, projectId });

  if (eventLog.lastSequence > 0) {
    console.log(`Resuming run ${runId} from sequence ${eventLog.lastSequence}.`);
    console.log('Contributions already in the log will be replayed, not re-purchased.\n');
  }

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  const result = await runMeeting({
    provider,
    eventLog,
    config,
    brief: brief.brief,
    projectId,
    meetingId,
    runId,
    onProgress: (line) => console.log(line),
  });

  // Prove the gate (test T12): ask for a build and show the refusal in the log.
  const rejection = requestBuild(
    { projectId, approvedSpecId: null, requestedBy: 'benchmark-harness', source: 'api' },
    config,
    eventLog,
  );
  console.log(`\n[gate] build request -> ${rejection.code}: ${rejection.message}`);

  const usage = eventLog.readUsage();
  const signals = computeSignals(result, usage);
  const events = eventLog.readAll();
  const buildRejections = events.filter((e) => e.event_type === 'build_rejected').length;

  const markdown = renderMarkdownReport({
    brief,
    result,
    signals: {
      ...signals,
      stateCorrectness: { ...signals.stateCorrectness, buildAttemptsRejected: buildRejections },
    },
    usage,
    eventCount: events.length,
    eventsPath: join(eventLog.directory, 'events.jsonl'),
    startedAt,
    durationMs: Date.now() - startedMs,
  });

  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, `${brief.id}-${runId}.md`);
  writeFileSync(reportPath, markdown, 'utf8');

  console.log(`\nTerminal state : ${result.state}`);
  if (result.verdict !== null) console.log(`Team verdict   : ${result.verdict}`);
  if (result.recommendedAgainstBy.length > 0) {
    console.log(`Recommended against by: ${result.recommendedAgainstBy.join(', ')}`);
  }
  console.log(`Model calls    : ${result.modelAttempts} attempted, ${result.modelCalls} succeeded ` +
    `(replayed ${result.replayedFromLog} from log)`);
  console.log(`Events         : ${events.length} -> ${eventLog.directory}/events.jsonl`);
  console.log(`Reported tokens: prompt=${signals.usage.reportedPromptTokens ?? 'not reported'}, ` +
    `completion=${signals.usage.reportedCompletionTokens ?? 'not reported'}`);
  console.log(`Retries        : transport=${signals.usage.transportRetries}, ` +
    `schema repair=${signals.usage.validationRetries}`);
  console.log(`Report         : ${reportPath}`);

  if (result.state === 'BLOCKED') {
    console.log(`\nThis run is BLOCKED (${result.errorCode}) but NOT lost.`);
    if (result.errorMessage !== null) console.log(`Reason: ${result.errorMessage}`);
    console.log(`Resume with:  npm run bench -- --brief=${brief.id} --run-id=${runId}`);
  }

  return { state: result.state, reportPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = configOrExit();
  const providerKind = args['provider'] ?? 'groq';
  const outDir = args['out'] ?? 'docs/evidence';
  const briefArg = args['brief'] ?? 'b1-portfolio';

  const provider = buildProvider(providerKind, config, (line) => console.log(line));

  heading('DevOffice AI - M0 Planning Lab benchmark');
  console.log(`Provider        : ${provider.name} / ${provider.modelId}`);
  console.log(`Simulated       : ${provider.simulated}`);
  console.log(`Max rounds      : ${config.MEETING_MAX_ROUNDS}`);
  console.log(`Concurrency     : ${config.WORKER_MAX_CONCURRENCY}`);
  console.log(`Pacing ceiling  : ${config.THROTTLE_MAX_REQUESTS_PER_MINUTE} req/min, ` +
    `${config.THROTTLE_MAX_TOKENS_PER_MINUTE} tok/min (self-imposed; provider headers override)`);
  console.log(`Autonomous build: ${config.ENABLE_AUTONOMOUS_BUILD} (M0 requires false)`);

  if (provider.simulated) {
    console.log('\n' + '!'.repeat(72));
    console.log('SIMULATED RUN. The template provider is in use, not a language model.');
    console.log('Output proves the WIRING only. It says nothing about agent quality and');
    console.log('must not be scored against the LLD 14.2 rubric.');
    console.log('!'.repeat(72));
  }

  const availability = await provider.checkAvailability();
  if (!availability.available) {
    console.error(`\nProvider unavailable [${availability.reason}]: ${availability.detail}`);
    console.error('No automatic fallback to another or paid provider will happen (HLD 10).');
    process.exit(1);
  }

  const briefs = briefArg === 'all' ? BENCHMARK_BRIEFS : [getBrief(briefArg)];
  const outcomes: Array<{ id: string; state: string; reportPath: string }> = [];

  for (const brief of briefs) {
    const runId = args['run-id'] ?? `${brief.id}-${randomUUID().slice(0, 8)}`;
    try {
      const outcome = await runOne(brief, provider, config, runId, outDir);
      outcomes.push({ id: brief.id, ...outcome });
    } catch (error) {
      if (isDevOfficeError(error)) {
        console.error(`\n[${error.code}] ${error.message}`);
        outcomes.push({ id: brief.id, state: `FAILED:${error.code}`, reportPath: '-' });
      } else {
        throw error;
      }
    }
  }

  heading('Summary');
  for (const outcome of outcomes) {
    console.log(`  ${outcome.id.padEnd(20)} ${outcome.state.padEnd(22)} ${outcome.reportPath}`);
  }
  console.log(
    '\nRubric scores are intentionally blank in every report. Read the transcripts and' +
      '\nfill them in by hand - see LLD 14.2.',
  );
}

void main();
