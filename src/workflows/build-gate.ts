/**
 * The hard gate that keeps the Planning Lab a planning lab (LLD 2.2, test T12).
 *
 * Invariants from the LLD this enforces:
 *   - "P0 cannot call real coding executor even if AI text asks to do so"
 *   - "BUILD_NOT_ENABLED must be visible and honest, not displayed as a
 *      completed website"
 *   - "API and worker both enforce guards; UI disabled buttons do not count"
 *
 * In M0 there is no coding engine to disable - there is simply no shell
 * execution, no child_process import and no filesystem write outside runs/.
 * tests/no-execution.test.ts asserts that by scanning the source, so the
 * guarantee survives someone later adding an innocent-looking helper.
 *
 * This module is the single place a future build request must pass through.
 */
import { DevOfficeError } from '../shared/errors.js';
import type { AppConfig } from '../shared/config.js';
import type { EventLog } from '../shared/events.js';

export interface BuildRequest {
  readonly projectId: string;
  readonly approvedSpecId: string | null;
  readonly requestedBy: string;
  /** Where the request came from, so an audit can tell apart UI and AI text. */
  readonly source: 'owner_ui' | 'api' | 'worker' | 'agent_text';
}

export interface BuildRejection {
  readonly allowed: false;
  readonly code: 'BUILD_NOT_ENABLED';
  readonly state: 'BUILD_NOT_ENABLED';
  readonly message: string;
  readonly milestone: string;
}

/**
 * Always rejects at M0, and records the attempt.
 *
 * Note it rejects BEFORE looking at approvedSpecId: at this milestone there is
 * nothing a caller can supply that would make a build legal, so there is no
 * code path where a forged spec id gets further.
 */
export function requestBuild(
  request: BuildRequest,
  config: AppConfig,
  eventLog: EventLog | null,
): BuildRejection {
  const message =
    'BUILD_NOT_ENABLED_IN_THIS_PHASE. This deployment is the Planning Lab (M0-M3). ' +
    'Autonomous coding arrives at M4/M5 and requires a sandbox, a coding-engine adapter ' +
    'and a separate Product Owner approval. No code was generated and nothing was executed.';

  eventLog?.append({
    event_type: 'build_rejected',
    role: null,
    round: null,
    meeting_id: null,
    idempotency_key: `build_rejected:${request.projectId}:${Date.now()}`,
    payload_json: {
      code: 'BUILD_NOT_ENABLED',
      source: request.source,
      requested_by: request.requestedBy,
      approved_spec_id: request.approvedSpecId,
      enable_autonomous_build: config.ENABLE_AUTONOMOUS_BUILD,
      milestone: 'M0',
    },
    display_text: `Build request rejected (source: ${request.source}) - BUILD_NOT_ENABLED`,
  });

  return {
    allowed: false,
    code: 'BUILD_NOT_ENABLED',
    state: 'BUILD_NOT_ENABLED',
    message,
    milestone: 'M0',
  };
}

/** For call sites that should throw rather than branch. */
export function assertBuildAllowed(config: AppConfig): never {
  void config;
  throw new DevOfficeError(
    'BUILD_NOT_ENABLED',
    'Autonomous build is not available at M0. See docs/ADRs and HLD section 12.',
  );
}
