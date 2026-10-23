import type { SessionSnapshot } from './types.js';

// A running m1_basic session in `implement`, for engine (T04) and EngineService fake tests.
export const SNAPSHOT_FIXTURE: SessionSnapshot = {
  id: '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f',
  ticket: {
    id: '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2',
    title: 'Add /health',
    body: 'Return 200',
    repo: 'github.com/benjgrad/fixture-app',
    external_ref: null,
  },
  machine_id: 'mbp-ben',
  workflow_id: 'm1_basic',
  workflow_version: 1,
  workflow_state: 'implement',
  status: 'running',
  fencing_token: 1,
  claude_session_id: null,
  agent_command_id: '5e4d3c2b-1a09-4f8e-b7d6-c5b4a3928170',
  agent_process_live: true,
  pending_answer: null,
  retry_counters: {},
  state_visits: { implement: 1 },
  state_entered_at: '2026-10-22T12:00:00.000Z',
  state_deadline: '2026-10-22T12:30:00.000Z',
  return_to: null,
  spend_usd: 0,
  claude_spend_totals: {},
  wall_seconds: 0,
  context: {},
  step: null,
};
