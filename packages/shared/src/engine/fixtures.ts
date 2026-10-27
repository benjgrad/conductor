import {
  moveStateLabel,
  type EngineEvent,
  type GateStep,
  type MachineLostMark,
  type MachineLostReason,
  type SessionSnapshot,
} from './types.js';

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

// ---------------------------------------------------------------- ADR-0011 (M1b-T01)

/**
 * A `conductor` v2 (CONDUCTOR_V2_DRAFT) move step from `implementing` along `ready_for_testing`,
 * in its conditions phase: checks and open_pr passed, PR checks green, approvals 0/1 pending,
 * the M5 conditions disabled.
 */
export const MOVE_STEP_FIXTURE: GateStep = {
  kind: 'move',
  from: 'implementing',
  outcome: 'ready_for_testing',
  to: 'waiting_external',
  attachment: null,
  subject: 'The endpoint is implemented and tested.',
  claude_session_id: null,
  nudged: false,
  phase: 'conditions',
  index: 0,
  head_sha: '3b18e512dba79e4c8300dd08aeb37f8e728b8dad',
  transition: 'ready_for_testing',
  actor: 'agent',
  reason: 'The endpoint is implemented and tested.',
  conditions: [
    {
      type: 'pr_checks_green',
      label: 'PR checks green',
      status: 'met',
      value: '3/3',
      detail: null,
      checked_at: '2026-10-26T12:02:00.000Z',
    },
    {
      type: 'pr_approvals',
      label: 'PR approved',
      status: 'pending',
      value: '0/1',
      detail: null,
      checked_at: '2026-10-26T12:02:00.000Z',
    },
    {
      type: 'jira_fields_set',
      label: 'Jira fields set: resolution',
      status: 'disabled',
      value: null,
      detail: null,
      checked_at: null,
    },
    {
      type: 'azure_pipeline_succeeded',
      label: 'Pipeline ci succeeded',
      status: 'disabled',
      value: null,
      detail: null,
      checked_at: null,
    },
  ],
  conditions_deadline: '2026-10-29T12:01:00.000Z',
  conditions_poll_ms: 120_000,
  conditions_note: null,
};

/** A work ticket's session on `conductor` v2 (draft) in `implementing`, running. */
export const SNAPSHOT_V2_FIXTURE: SessionSnapshot = {
  ...SNAPSHOT_FIXTURE,
  ticket: { ...SNAPSHOT_FIXTURE.ticket, kind: 'work' },
  workflow_id: 'conductor',
  workflow_version: 2,
  workflow_state: 'implementing',
  state_visits: { planning: 1, implementing: 1 },
  context: { planning: { plan: '1. add route', summary: 'one route' } },
};

/** The same session held by MOVE_STEP_FIXTURE (U-059: `waiting_external`, worker ended). */
export const SNAPSHOT_V2_CONDITIONS_FIXTURE: SessionSnapshot = {
  ...SNAPSHOT_V2_FIXTURE,
  workflow_state: moveStateLabel('implementing', 'waiting_external', 'ready_for_testing'),
  status: 'waiting_external',
  agent_command_id: null,
  agent_process_live: false,
  state_deadline: '2026-10-26T12:04:00.000Z',
  context: {
    ...SNAPSHOT_V2_FIXTURE.context,
    __pr: { pr_url: 'https://github.com/benjgrad/fixture-app/pull/7', state: 'open' },
  },
  step: MOVE_STEP_FIXTURE,
};

/** One fixture per ADR-0011 engine event shape. */
export const M1B_EVENT_FIXTURES: {
  agent_transition: Extract<EngineEvent, { type: 'agent.complete_state' }>;
  agent_question: Extract<EngineEvent, { type: 'agent.complete_state' }>;
  human_transition: Extract<EngineEvent, { type: 'human.transition' }>;
  conditions_completed: Extract<EngineEvent, { type: 'action.completed' }>;
} = {
  agent_transition: {
    type: 'agent.complete_state',
    result: { summary: 'added /health' },
    transition: 'ready_for_testing',
    reason: 'The endpoint is implemented and tested.',
  },
  agent_question: {
    type: 'agent.complete_state',
    result: {},
    transition: 'scope_changed',
    reason: 'The ticket also needs a DB migration. Include it, or split it out?',
  },
  human_transition: {
    type: 'human.transition',
    name: 'waiting_on_someone',
    text: 'Dana is reviewing the API shape.',
    actor: 'ui',
  },
  conditions_completed: {
    type: 'action.completed',
    command_id: '5e4d3c2b-1a09-4f8e-b7d6-c5b4a3928170',
    action: 'evaluate_conditions',
    result: {
      results: [
        { type: 'pr_checks_green', status: 'met', value: '3/3', detail: null },
        { type: 'pr_approvals', status: 'met', value: '1/1', detail: null },
      ],
    },
    error: null,
  },
};

// ---------------------------------------------------------------- lost machines (M2-T02, U-068)

/** One `machine.lost` per reason, for SNAPSHOT_FIXTURE's machine (T06, T20 tests). */
export const MACHINE_LOST_EVENT_FIXTURES: {
  [R in MachineLostReason]: Extract<EngineEvent, { type: 'machine.lost' }>;
} = {
  lease_expired: {
    type: 'machine.lost',
    machine_id: 'mbp-ben',
    reason: 'lease_expired',
    machine_name: "Ben's MacBook",
  },
  revoked: { type: 'machine.lost', machine_id: 'mbp-ben', reason: 'revoked' },
  pinned_machine_offline: {
    type: 'machine.lost',
    machine_id: 'mbp-ben',
    reason: 'pinned_machine_offline',
    machine_name: "Ben's MacBook",
    offline_ms: 900_000,
  },
};

/** `context.__machine_lost` after SNAPSHOT_FIXTURE's lease lapsed in `implement`. */
export const MACHINE_LOST_MARK_FIXTURE: MachineLostMark = {
  machine_id: 'mbp-ben',
  machine_name: "Ben's MacBook",
  reason: 'lease_expired',
  state: 'implement',
  at: '2026-10-22T12:10:00.000Z',
};
