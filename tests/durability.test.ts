/**
 * Event log durability, sequencing and idempotency (LLD 8.2, 10; tests T14/T15).
 */
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventLog } from '../src/shared/events.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'devoffice-test-'));
}

function makeLog(runsDir: string, runId = 'run-1'): EventLog {
  return new EventLog({ runsDir, runId, projectId: 'proj-1' });
}

const sampleEvent = (key: string | null, text = 'something happened') =>
  ({
    event_type: 'agent_contribution' as const,
    role: 'ui_ux',
    round: 1,
    meeting_id: 'meet-1',
    idempotency_key: key,
    payload_json: { data: { hello: 'world' } },
    display_text: text,
  });

describe('EventLog', () => {
  it('allocates a monotonic sequence per run', () => {
    const log = makeLog(freshDir());
    expect(log.append(sampleEvent('k1'))?.sequence_number).toBe(1);
    expect(log.append(sampleEvent('k2'))?.sequence_number).toBe(2);
    expect(log.append(sampleEvent('k3'))?.sequence_number).toBe(3);
    expect(log.lastSequence).toBe(3);
  });

  it('T11-style: suppresses a duplicate idempotency key instead of writing twice', () => {
    const log = makeLog(freshDir());
    expect(log.append(sampleEvent('same-key'))).not.toBeNull();
    expect(log.append(sampleEvent('same-key', 'again'))).toBeNull();
    expect(log.readAll()).toHaveLength(1);
    expect(log.lastSequence).toBe(1);
  });

  it('T14: a brand-new EventLog over the same run continues the sequence', () => {
    const dir = freshDir();
    const first = makeLog(dir);
    first.append(sampleEvent('k1'));
    first.append(sampleEvent('k2'));

    // Simulates the worker process dying and being restarted.
    const restarted = makeLog(dir);
    expect(restarted.lastSequence).toBe(2);
    expect(restarted.append(sampleEvent('k3'))?.sequence_number).toBe(3);
    expect(restarted.readAll()).toHaveLength(3);
  });

  it('T14: a restarted worker still refuses keys written before the crash', () => {
    const dir = freshDir();
    makeLog(dir).append(sampleEvent('already-done'));

    const restarted = makeLog(dir);
    expect(restarted.append(sampleEvent('already-done'))).toBeNull();
    expect(restarted.readAll()).toHaveLength(1);
  });

  it('survives a half-written final line without losing earlier events', () => {
    const dir = freshDir();
    const log = makeLog(dir);
    log.append(sampleEvent('k1'));
    log.append(sampleEvent('k2'));

    // A process killed mid-write leaves a torn line.
    appendFileSync(join(dir, 'run-1', 'events.jsonl'), '{"sequence_number":3,"event_ty');

    const restarted = makeLog(dir);
    expect(restarted.lastSequence).toBe(2);
    expect(restarted.readAll()).toHaveLength(2);
    // And it can keep going from the last intact checkpoint.
    expect(restarted.append(sampleEvent('k3'))?.sequence_number).toBe(3);
  });

  it('T15: readAfter returns only what a reconnecting client missed, in order', () => {
    const log = makeLog(freshDir());
    for (let i = 1; i <= 5; i += 1) log.append(sampleEvent(`k${i}`, `event ${i}`));

    const missed = log.readAfter(2);
    expect(missed.map((e) => e.sequence_number)).toEqual([3, 4, 5]);
    expect(missed[0]?.display_text).toBe('event 3');
    expect(log.readAfter(5)).toHaveLength(0);
  });

  it('writes one JSON object per line, so the file is greppable and streamable', () => {
    const dir = freshDir();
    const log = makeLog(dir);
    log.append(sampleEvent('k1'));
    log.append(sampleEvent('k2'));

    const lines = readFileSync(join(dir, 'run-1', 'events.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('keeps usage records separate from events and never fabricates a cost', () => {
    const dir = freshDir();
    const log = makeLog(dir);
    log.recordUsage({
      role: 'ui_ux',
      purpose: 'proposal',
      provider: 'groq',
      model_id: 'test-model',
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      latency_ms: 420,
      transport_attempts: 2,
      validation_retries: 1,
      status: 'succeeded',
      error_code: null,
      correlation_id: 'c1',
      cost_reported: null,
    });

    const usage = log.readUsage();
    expect(usage).toHaveLength(1);
    expect(usage[0]?.cost_reported).toBeNull();
    expect(usage[0]?.transport_attempts).toBe(2);
    expect(log.readAll()).toHaveLength(0);
  });

  it('ignores an unparseable usage line rather than crashing the reader', () => {
    const dir = freshDir();
    const log = makeLog(dir);
    writeFileSync(join(dir, 'run-1', 'usage.jsonl'), 'not json\n', 'utf8');
    expect(log.readUsage()).toHaveLength(0);
  });
});
