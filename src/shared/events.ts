/**
 * Durable event + usage log (LLD 8.2, 10).
 *
 * M0 writes JSONL files under runs/<runId>/. Postgres replaces this at M1;
 * the API below is deliberately the one Postgres will implement:
 *
 *   - a monotonic sequence number per run (unique (run_id, sequence_number))
 *   - append-only, flushed before the caller advances any state
 *   - idempotency keys so a retried step cannot write the same event twice
 *   - readAfter(n) so a reconnecting UI fetches only what it missed
 *
 * That last point is what makes "kill the worker mid-meeting and restart"
 * (test T14) recoverable instead of a guess.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export type EventType =
  | 'run_started'
  | 'run_state_changed'
  | 'meeting_started'
  | 'round_started'
  | 'agent_contribution'
  | 'decision_recorded'
  | 'validation_retry'
  | 'provider_error'
  | 'rate_limit_wait'
  | 'needs_input'
  | 'meeting_blocked'
  | 'meeting_completed'
  | 'build_rejected';

export interface RunEvent {
  readonly sequence_number: number;
  readonly run_id: string;
  readonly project_id: string;
  readonly meeting_id: string | null;
  readonly event_type: EventType;
  readonly role: string | null;
  readonly round: number | null;
  readonly created_at: string;
  readonly idempotency_key: string | null;
  readonly payload_json: unknown;
  /** Short human-readable line for the Office/Meeting timeline. */
  readonly display_text: string;
}

export type NewRunEvent = Omit<RunEvent, 'sequence_number' | 'created_at' | 'run_id' | 'project_id'>;

/** One row per model call. Mirrors the usage_records table in LLD 8. */
export interface UsageRecord {
  readonly run_id: string;
  readonly created_at: string;
  readonly role: string;
  readonly purpose: string;
  readonly provider: string;
  readonly model_id: string;
  /** null when the provider did not report it. We never estimate and call it real. */
  readonly prompt_tokens: number | null;
  readonly completion_tokens: number | null;
  readonly total_tokens: number | null;
  readonly latency_ms: number;
  readonly transport_attempts: number;
  readonly validation_retries: number;
  readonly status: 'succeeded' | 'failed';
  readonly error_code: string | null;
  readonly correlation_id: string;
  /** Groq reports no cost field; stays null rather than being invented. */
  readonly cost_reported: number | null;
}

export interface EventLogOptions {
  readonly runsDir: string;
  readonly runId: string;
  readonly projectId: string;
  readonly now?: () => Date;
}

export class EventLog {
  private readonly dir: string;
  private readonly eventsPath: string;
  private readonly usagePath: string;
  private readonly runId: string;
  private readonly projectId: string;
  private readonly now: () => Date;
  private sequence = 0;
  private readonly seenKeys = new Set<string>();

  constructor(options: EventLogOptions) {
    this.runId = options.runId;
    this.projectId = options.projectId;
    this.now = options.now ?? (() => new Date());
    this.dir = join(options.runsDir, options.runId);
    this.eventsPath = join(this.dir, 'events.jsonl');
    this.usagePath = join(this.dir, 'usage.jsonl');
    mkdirSync(this.dir, { recursive: true });
    this.recover();
  }

  /**
   * Rebuild in-memory state from what is already on disk.
   * This is the resume path: a restarted worker continues the sequence and
   * remembers which idempotency keys it already honoured.
   */
  private recover(): void {
    if (!existsSync(this.eventsPath)) return;
    const raw = readFileSync(this.eventsPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: RunEvent;
      try {
        parsed = JSON.parse(line) as RunEvent;
      } catch {
        // A torn final line means the process died mid-write. Stop here rather
        // than guessing: everything before it is intact and replayable.
        break;
      }
      if (typeof parsed.sequence_number === 'number') {
        this.sequence = Math.max(this.sequence, parsed.sequence_number);
      }
      if (typeof parsed.idempotency_key === 'string') {
        this.seenKeys.add(parsed.idempotency_key);
      }
    }
  }

  get lastSequence(): number {
    return this.sequence;
  }

  get directory(): string {
    return this.dir;
  }

  /**
   * Append an event. Returns the stored event, or null when the
   * idempotency key was already recorded (a duplicate was suppressed).
   */
  append(event: NewRunEvent): RunEvent | null {
    if (event.idempotency_key !== null && this.seenKeys.has(event.idempotency_key)) {
      return null;
    }
    const stored: RunEvent = {
      sequence_number: this.sequence + 1,
      run_id: this.runId,
      project_id: this.projectId,
      created_at: this.now().toISOString(),
      ...event,
    };
    this.writeLine(this.eventsPath, stored);
    this.sequence = stored.sequence_number;
    if (stored.idempotency_key !== null) this.seenKeys.add(stored.idempotency_key);
    return stored;
  }

  recordUsage(record: Omit<UsageRecord, 'run_id' | 'created_at'>): UsageRecord {
    const stored: UsageRecord = {
      run_id: this.runId,
      created_at: this.now().toISOString(),
      ...record,
    };
    this.writeLine(this.usagePath, stored);
    return stored;
  }

  readAll(): RunEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    return readFileSync(this.eventsPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as RunEvent];
        } catch {
          return [];
        }
      });
  }

  /** The reconnect path: give me everything after the sequence I already have. */
  readAfter(sequenceNumber: number): RunEvent[] {
    return this.readAll().filter((e) => e.sequence_number > sequenceNumber);
  }

  readUsage(): UsageRecord[] {
    if (!existsSync(this.usagePath)) return [];
    return readFileSync(this.usagePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as UsageRecord];
        } catch {
          return [];
        }
      });
  }

  /**
   * Write one JSON line and fsync it.
   *
   * fsync matters: without it a crash can lose an event we already treated as
   * persisted, and the worker would resume from a checkpoint that never
   * existed. Slow, and correct - M0 does at most a few dozen writes per run.
   */
  private writeLine(path: string, value: unknown): void {
    const line = `${JSON.stringify(value)}\n`;
    const fd = openSync(path, 'a');
    try {
      writeSync(fd, line);
      // Best-effort durability; ignore platforms where fsync is unavailable.
      try {
        fsyncSync(fd);
      } catch {
        /* non-fatal on filesystems without fsync */
      }
    } finally {
      closeSync(fd);
    }
  }
}
