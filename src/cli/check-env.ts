/**
 * `npm run check:env`
 *
 * Tells the operator exactly where they stand before anything is spent:
 * is the config valid, is there a key, can the account reach the configured
 * model. It never guesses a quota and never reports success it did not observe.
 */
import { GroqProvider } from '../providers/groq.js';
import { RequestThrottle } from '../providers/throttle.js';
import { SCHEMA_REGISTRY } from '../shared/schemas.js';
import { buildGroqJsonSchema } from '../shared/json-schema.js';
import { configOrExit, describeConfig, heading } from './shared.js';

async function main(): Promise<void> {
  heading('DevOffice AI - M0 environment check');

  const config = configOrExit();
  console.log('Configuration loaded and validated:\n');
  describeConfig(config);

  heading('Output contracts (Groq strict-mode compatibility)');
  let schemaFailures = 0;
  for (const [name, schema] of Object.entries(SCHEMA_REGISTRY)) {
    try {
      const built = buildGroqJsonSchema(name, schema);
      console.log(
        `  OK    ${name.padEnd(26)} ${Object.keys(built.jsonSchema['properties'] ?? {}).length} fields, ` +
          `${built.strippedKeywords.length} unsupported keywords stripped`,
      );
    } catch (error) {
      schemaFailures += 1;
      console.log(`  FAIL  ${name}: ${(error as Error).message}`);
    }
  }

  heading('Planning Lab guard');
  console.log(`  ENABLE_AUTONOMOUS_BUILD = ${config.ENABLE_AUTONOMOUS_BUILD} (must be false at M0)`);
  console.log('  Coding engine: NOT PRESENT in this build. No shell, no sandbox, no deploy.');

  heading('Provider reachability');
  if (config.GROQ_API_KEY === null) {
    console.log('  GROQ_API_KEY is NOT set.');
    console.log('  => Real provider validation has NOT been performed.');
    console.log('  => You can still run the full wiring with the template provider:');
    console.log('       npm run bench:mock');
    console.log('     Its output is labelled SIMULATED and cannot be used for rubric scoring.');
    console.log('\n  To test for real:');
    console.log('    1. cp .env.example .env');
    console.log('    2. Get a key at https://console.groq.com/keys and put it in .env');
    console.log('    3. npm run models      # see what your account can actually reach');
    console.log('    4. set GROQ_MODEL_PLANNING in .env to one of those ids');
    console.log('    5. npm run check:env   # run this again');
    process.exit(schemaFailures > 0 ? 1 : 0);
  }

  if (config.GROQ_MODEL_PLANNING === null) {
    console.log('  GROQ_API_KEY is set, but GROQ_MODEL_PLANNING is empty.');
    console.log('  => Run `npm run models` and copy one of the listed ids into .env.');
    console.log('  => No default is shipped on purpose: model availability differs per account');
    console.log('     and hardcoding one would be a promise we cannot keep.');
    process.exit(1);
  }

  const provider = new GroqProvider({
    apiKey: config.GROQ_API_KEY,
    modelId: config.GROQ_MODEL_PLANNING,
    baseUrl: config.GROQ_BASE_URL,
    throttle: new RequestThrottle({
      maxConcurrency: config.WORKER_MAX_CONCURRENCY,
      maxRequestsPerMinute: config.THROTTLE_MAX_REQUESTS_PER_MINUTE,
      maxTokensPerMinute: config.THROTTLE_MAX_TOKENS_PER_MINUTE,
      minIntervalMs: config.THROTTLE_MIN_INTERVAL_MS,
    }),
  });

  const availability = await provider.checkAvailability();
  if (availability.available) {
    console.log(`  OK    ${availability.detail}`);
    console.log('\n  Next: npm run bench -- --brief=b1-portfolio');
  } else {
    console.log(`  FAIL  [${availability.reason}] ${availability.detail}`);
    process.exit(1);
  }

  process.exit(schemaFailures > 0 ? 1 : 0);
}

void main();
