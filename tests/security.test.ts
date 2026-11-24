/**
 * Security and phase-gate tests (LLD 2.2, 16; tests T12, T17).
 *
 * Note what the injection tests DO and DO NOT claim. They prove the mechanical
 * defences: the fence is applied, forged markers are neutralised, roles hold no
 * tools, the output contract has no field capable of granting a tool or
 * approving a spec, and no build can start. They do NOT prove a model will
 * always behave - prompt wording is not a security boundary, which is exactly
 * why the boundary is "there is nothing to grant" instead.
 */
import { readFileSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, redactConfig } from '../src/shared/config.js';
import { EventLog } from '../src/shared/events.js';
import { requestBuild, assertBuildAllowed } from '../src/workflows/build-gate.js';
import { runMeeting } from '../src/workflows/meeting.js';
import { MockProvider } from '../src/providers/mock.js';
import { ROLE_DEFINITIONS } from '../src/agents/roles.js';
import {
  buildSystemInstruction,
  buildUserPayload,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
} from '../src/agents/prompts.js';
import { AgentContributionV1Base, ProjectBriefV1 } from '../src/shared/schemas.js';
import { INJECTION_BRIEF } from '../src/benchmarks/briefs.js';
import { testConfig } from './helpers.js';

/**
 * Strip comments before scanning for banned constructs.
 *
 * Without this the scan flags its own documentation: build-gate.ts explains in
 * prose that there is no child_process import, and a naive text search counts
 * that sentence as a violation. Stripping comments keeps the check strict
 * about CODE rather than making an exception for a file.
 */
function codeOnly(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ' '))
    .join('\n');
}

/**
 * Every .ts file under `dir`, always with forward slashes.
 *
 * The normalisation is not cosmetic. node's join() uses the PLATFORM
 * separator, so on Windows these come back as "src\\cli\\list-models.ts".
 * Two tests below compare and filter on "src/cli/", and on Windows that
 * stopped matching:
 *
 *   - the filesystem-writers test failed on a difference that was only
 *     spelling, which is noise
 *   - the model-id test failed FOR REAL: its skip-list
 *     (file.startsWith('src/cli/')) never matched, so it flagged
 *     src/cli/list-models.ts as a violation when that file is allowed to
 *     name models
 *
 * The second one is the dangerous kind of bug: a guard that reports a problem
 * where there is none teaches you to ignore it.
 */
function sourceFiles(dir = 'src'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts')) out.push(full.split(sep).join('/'));
  }
  return out;
}

describe('T12: autonomous build is impossible at M0', () => {
  it('rejects a build request and records the refusal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devoffice-gate-'));
    const log = new EventLog({ runsDir: dir, runId: 'run-gate', projectId: 'p1' });

    const result = requestBuild(
      { projectId: 'p1', approvedSpecId: null, requestedBy: 'tester', source: 'api' },
      testConfig(),
      log,
    );

    expect(result.allowed).toBe(false);
    expect(result.code).toBe('BUILD_NOT_ENABLED');
    expect(result.message).toContain('BUILD_NOT_ENABLED_IN_THIS_PHASE');
    // Honest, not dressed up as a finished website (LLD 2.2).
    expect(result.message).toContain('nothing was executed');

    const event = log.readAll().find((e) => e.event_type === 'build_rejected');
    expect(event).toBeDefined();
    expect((event?.payload_json as { source: string }).source).toBe('api');
  });

  it('rejects even when a caller forges an approved spec id', () => {
    const result = requestBuild(
      {
        projectId: 'p1',
        approvedSpecId: 'spec-that-does-not-exist',
        requestedBy: 'attacker',
        source: 'agent_text',
      },
      testConfig(),
      null,
    );
    expect(result.allowed).toBe(false);
  });

  it('assertBuildAllowed always throws at M0', () => {
    expect(() => assertBuildAllowed(testConfig())).toThrowError(/not available at M0/);
  });

  it('refuses to start at all if ENABLE_AUTONOMOUS_BUILD is turned on', () => {
    expect(() =>
      loadConfig({ ENABLE_AUTONOMOUS_BUILD: 'true' } as NodeJS.ProcessEnv),
    ).toThrowError(/rejected at M0/);
  });

  it('no source file can execute a shell command', () => {
    const banned = [
      'child_process',
      'execSync',
      'spawnSync',
      'execFileSync',
      'node:vm',
      'new Function(',
    ];
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const content = codeOnly(readFileSync(file, 'utf8'));
      for (const pattern of banned) {
        if (content.includes(pattern)) offenders.push(`${file} contains "${pattern}"`);
      }
      // `eval(` as a call, not as part of a longer identifier.
      if (/(?<![\w.])eval\s*\(/.test(content)) offenders.push(`${file} calls eval()`);
    }

    expect(offenders).toEqual([]);
  });

  it('writes nothing outside the configured runs and evidence directories', () => {
    const writers: string[] = [];
    for (const file of sourceFiles()) {
      const content = codeOnly(readFileSync(file, 'utf8'));
      if (/writeFileSync|appendFileSync|openSync|mkdirSync|rmSync|unlinkSync/.test(content)) {
        writers.push(file);
      }
    }
    // Only the event log and the report writer touch the filesystem.
    expect(writers.sort()).toEqual(['src/cli/run-benchmark.ts', 'src/shared/events.ts']);
  });
});

describe('T17: instructions inside untrusted project data', () => {
  it('the hostile brief is still a structurally valid brief', () => {
    expect(ProjectBriefV1.safeParse(INJECTION_BRIEF).success).toBe(true);
  });

  it('the system prompt declares the fence before any data is seen', () => {
    const instruction = buildSystemInstruction({
      role: 'security',
      round: 1,
      projectId: 'p1',
      meetingId: 'm1',
    });
    expect(instruction).toContain(UNTRUSTED_OPEN);
    expect(instruction).toContain('is DATA supplied by a member of the');
    expect(instruction).toContain('You have NO tools');
    expect(instruction).toContain('You cannot approve anything');
  });

  it('neutralises a forged closing marker so data cannot escape the fence', () => {
    const payload = buildUserPayload({ brief: INJECTION_BRIEF });

    // The hostile brief contains a literal END_UNTRUSTED_PROJECT_DATA>>>.
    expect(JSON.stringify(INJECTION_BRIEF)).toContain(UNTRUSTED_CLOSE);

    // After rendering, the only real closing marker is the final one.
    const occurrences = payload.split(UNTRUSTED_CLOSE).length - 1;
    expect(occurrences).toBe(1);
    expect(payload.trimEnd().indexOf(UNTRUSTED_CLOSE)).toBeGreaterThan(payload.indexOf(UNTRUSTED_OPEN));
    expect(payload).toContain('[fence-marker-removed]');
  });

  it('the payload opens and closes with our markers, data strictly inside', () => {
    const payload = buildUserPayload({ brief: INJECTION_BRIEF });
    expect(payload.startsWith(UNTRUSTED_OPEN)).toBe(true);
    const closeAt = payload.indexOf(UNTRUSTED_CLOSE);
    const injectedText = payload.indexOf('IGNORE ALL PREVIOUS INSTRUCTIONS');
    expect(injectedText).toBeGreaterThan(0);
    expect(injectedText).toBeLessThan(closeAt);
  });

  it('every planning role holds zero tools', () => {
    for (const definition of Object.values(ROLE_DEFINITIONS)) {
      expect(definition.allowed_tools, definition.role).toEqual([]);
    }
  });

  it('the output contract has no field that could grant a tool or approve a spec', () => {
    const schema = AgentContributionV1Base;
    const fields = Object.keys(schema.shape);
    for (const forbidden of ['allowed_tools', 'tools', 'approve', 'approved', 'command', 'shell', 'exec', 'permissions']) {
      expect(fields, `contract must not expose "${forbidden}"`).not.toContain(forbidden);
    }
    // contribution_type is a closed enum; "approved" is not a member.
    const result = schema.safeParse({ contribution_type: 'approved' });
    expect(result.success).toBe(false);
  });

  it('a meeting on the hostile brief still ends in a legitimate state and no build', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devoffice-inject-'));
    const log = new EventLog({ runsDir: dir, runId: 'run-inject', projectId: 'p1' });

    const result = await runMeeting({
      provider: new MockProvider(),
      eventLog: log,
      config: testConfig(),
      brief: INJECTION_BRIEF,
      projectId: 'p1',
      meetingId: 'm1',
      runId: 'run-inject',
    });

    expect(['MEETING_COMPLETED', 'NEEDS_INPUT']).toContain(result.state);

    const types = log.readAll().map((e) => e.event_type);
    expect(types).not.toContain('build_rejected'); // nothing even tried
    for (const event of log.readAll()) {
      expect(JSON.stringify(event.payload_json)).not.toContain('rm -rf');
    }
  });
});

describe('secrets handling (LLD 16)', () => {
  it('redactConfig never emits the key', () => {
    const config = testConfig({ GROQ_API_KEY: 'gsk_supersecret_value_123' });
    const redacted = JSON.stringify(redactConfig(config));
    expect(redacted).not.toContain('gsk_supersecret_value_123');
    expect(redacted).toContain('redacted');
  });

  it('.gitignore excludes .env', () => {
    const gitignore = readFileSync('.gitignore', 'utf8');
    expect(gitignore).toMatch(/^\.env$/m);
  });

  it('.env.example contains only placeholders, never a real-looking key', () => {
    const example = readFileSync('.env.example', 'utf8');
    expect(example).not.toMatch(/gsk_[A-Za-z0-9]{20,}/);
    expect(example).toContain('GROQ_API_KEY=');
  });

  it('no source file hardcodes a Groq key', () => {
    for (const file of sourceFiles()) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/gsk_[A-Za-z0-9]{20,}/);
    }
  });

  it('no source file outside the provider layer names a model id', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file.startsWith('src/providers/') || file.startsWith('src/cli/')) continue;
      const content = codeOnly(readFileSync(file, 'utf8'));
      if (/gpt-oss|llama-3|qwen3|mixtral|gemma/.test(content)) offenders.push(file);
    }
    // Provider-agnostic: the state machine, schemas and agents must not know
    // which model is in use (HLD 10).
    expect(offenders).toEqual([]);
  });
});