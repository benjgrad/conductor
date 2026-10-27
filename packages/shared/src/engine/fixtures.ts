import {
  moveStateLabel,
  type EngineEvent,
  type GateStep,
  type MachineLostMark,
  type MachineLostReason,
  type SessionSnapshot,
} from './types.js';
import type { PrContext, QaContext, QaResult } from './qa.types.js';

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
  approvals: null,
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

// ---------------------------------------------------------------- review and merge (M2r-T01)

const M2R_PR_URL = 'https://github.com/benjgrad/fixture-app/pull/7';
const M2R_HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const M2R_MIGRATION = 'packages/orchestrator/migrations/1730000000000_qa.sql';

/** One QaResult per verdict (ADR-0020 §2), as stored in `context.in_qa`. */
export const QA_RESULT_FIXTURES: { pass: QaResult; pass_with_debt: QaResult; fail: QaResult } = {
  pass: {
    verdict: 'pass',
    requirements: [
      { req: 'FR-1', met: true, reason: 'schema.m2r.test.ts covers every new field.' },
    ],
    findings: [],
    required_fixes: [],
    debt: [],
    unknowns: [],
    tests_run: [{ cmd: 'pnpm vitest run packages/shared', result: 'pass' }],
    summary: 'Every requirement is met; nothing blocks a merge.',
  },
  pass_with_debt: {
    verdict: 'pass_with_debt',
    findings: [{ severity: 'minor', text: 'The stub labels are untested.', file: 'apply.ts' }],
    required_fixes: [],
    debt: [{ text: 'Stub cases in actionArgs', site: 'apply.ts:1975', payoff: 'M2r-T04' }],
    unknowns: [{ question: 'Should close_pr delete the branch?', why: 'U-089 says keep it.' }],
    tests_run: [{ cmd: 'pnpm typecheck', result: 'pass' }],
    summary: 'Met, with one recorded shortcut.',
  },
  fail: {
    verdict: 'fail',
    requirements: [{ req: 'FR-3', met: false, reason: 'MergePrResult accepts unmet + error.' }],
    findings: [
      {
        severity: 'blocker',
        text: 'A result can carry both unmet and error.',
        file: 'packages/shared/src/protocol/actions.ts',
        line: 120,
      },
    ],
    required_fixes: ['Make the failure branches strict.'],
    debt: [],
    unknowns: [],
    tests_run: [{ cmd: 'pnpm vitest run actions.m2r', result: 'fail', note: '1 failed' }],
    summary: 'One blocker.',
  },
};

/** `context.__qa` in round 2 of 4 (the `qa_fail` transition has `retries: 3`), verdict pending. */
export const QA_CONTEXT_FIXTURE: QaContext = {
  head_sha: M2R_HEAD,
  verdict: null,
  round: 2,
  max_rounds: 4,
  claude_session_id: '4d2e8b63-3c0f-4e72-9015-7f6e5d4c3b2a',
};

/** `context.__pr` once Ready to merge: inspected, a migration in the diff. */
export const PR_CONTEXT_FIXTURE: PrContext = {
  pr_url: M2R_PR_URL,
  head_sha: M2R_HEAD,
  inspect: {
    head_sha: M2R_HEAD,
    files: ['packages/shared/src/engine/qa.ts', M2R_MIGRATION],
    files_truncated: false,
    mergeable: 'MERGEABLE',
    state: 'OPEN',
    matched: { migration: [M2R_MIGRATION] },
  },
};

/** `context.__pr` after Merge. */
export const PR_CONTEXT_MERGED_FIXTURE: PrContext = {
  ...PR_CONTEXT_FIXTURE,
  merged: {
    at: '2026-10-27T15:00:00.000Z',
    merge_commit_sha: 'c3d4e5f60718293a4b5c6d7e8f9012345678901a',
    by: 'ui',
  },
};

/** The merge move step with the approvals the human gave (ADR-0020 §5). */
export const MERGE_STEP_FIXTURE: GateStep = {
  ...MOVE_STEP_FIXTURE,
  from: 'ready_to_merge',
  outcome: 'merge',
  to: 'done',
  subject: '[merge]',
  phase: 'actions',
  head_sha: null,
  transition: 'merge',
  actor: 'human',
  reason: null,
  conditions: [],
  conditions_deadline: null,
  conditions_poll_ms: null,
  approvals: { who: 'ui', ids: ['migration'], files: { migration: [M2R_MIGRATION] } },
};

/** ADR-0020 engine event shapes. */
export const M2R_EVENT_FIXTURES: {
  human_merge: Extract<EngineEvent, { type: 'human.transition' }>;
  human_merge_unapproved: Extract<EngineEvent, { type: 'human.transition' }>;
  qa_pass: Extract<EngineEvent, { type: 'agent.complete_state' }>;
  merge_completed: Extract<EngineEvent, { type: 'action.completed' }>;
} = {
  human_merge: {
    type: 'human.transition',
    name: 'merge',
    text: null,
    actor: 'ui',
    approvals: ['migration'],
  },
  human_merge_unapproved: { type: 'human.transition', name: 'merge', text: null, actor: 'ui' },
  qa_pass: {
    type: 'agent.complete_state',
    result: {
      verdict: 'pass',
      tests_run: [{ cmd: 'pnpm vitest run packages/shared', result: 'pass' }],
      summary: 'Every requirement is met; nothing blocks a merge.',
    },
    transition: 'qa_pass',
    reason: 'Every requirement is met.',
  },
  merge_completed: {
    type: 'action.completed',
    command_id: '5e4d3c2b-1a09-4f8e-b7d6-c5b4a3928170',
    action: 'merge_pr',
    result: {
      ok: true,
      merged: true,
      already: false,
      merge_commit_sha: 'c3d4e5f60718293a4b5c6d7e8f9012345678901a',
      head_sha: M2R_HEAD,
    },
    error: null,
  },
};
