/**
 * `npm run models`
 *
 * Lists the model ids THIS account can reach, straight from
 * GET /openai/v1/models. No hardcoded list, because availability changes:
 * as of 24 Nov 2026 the Llama production models are Enterprise-only and the
 * self-serve text models are the gpt-oss pair. That will move again.
 */
import { configOrExit, heading } from './shared.js';

async function main(): Promise<void> {
  heading('Groq models reachable by this account');
  const config = configOrExit();

  if (config.GROQ_API_KEY === null) {
    console.log('GROQ_API_KEY is not set, so no live list can be fetched.\n');
    console.log('Reference list from the docs (checked 24 Nov 2026) - VERIFY against your account:');
    console.log('  Self-serve, supports strict json_schema:');
    console.log('    openai/gpt-oss-120b     131,072 ctx / 65,536 out');
    console.log('    openai/gpt-oss-20b      131,072 ctx / 65,536 out');
    console.log('    qwen/qwen3.8-27b        131,072 ctx / 16,384 out');
    console.log('  Enterprise only (Contact Sales) - NOT usable on a free account:');
    console.log('    llama-3.3-70b-versatile, llama-3.1-8b-instant, meta-models/muse-spark-open');
    process.exit(1);
  }

  const response = await fetch(`${config.GROQ_BASE_URL.replace(/\/+$/, '')}/models`, {
    headers: { Authorization: `Bearer ${config.GROQ_API_KEY}` },
  });

  if (!response.ok) {
    console.error(`Request failed: HTTP ${response.status}`);
    console.error((await response.text()).slice(0, 500));
    process.exit(1);
  }

  const body = (await response.json()) as {
    data?: Array<{ id?: string; owned_by?: string; context_window?: number }>;
  };
  const models = (body.data ?? []).filter((m) => typeof m.id === 'string');
  models.sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''));

  console.log(`${models.length} models reachable:\n`);
  for (const model of models) {
    const ctx = model.context_window === undefined ? '' : `  ctx=${model.context_window}`;
    console.log(`  ${(model.id ?? '').padEnd(40)} owner=${model.owned_by ?? '?'}${ctx}`);
  }
  console.log('\nPut one of these ids in .env as GROQ_MODEL_PLANNING.');
  console.log('For structured output, prefer a model documented to support strict json_schema.');
}

void main();
