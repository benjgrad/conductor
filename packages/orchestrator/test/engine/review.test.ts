import {
  STEP_CONTEXT_KEY,
  REVIEW_PROMPT_HEADING,
  reviewStateLabel,
  StartSessionPayloadSchema,
  type EngineEvent,
} from '@conductor/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { InMemoryBoardBus } from '../../src/contracts.js';
import type { OutboxRow, SessionRow } from '../../src/db/types.js';
import { createEngineService } from '../../src/engine/index.js';
import { useTestDatabase } from '../db.js';
import { loadWorkflow, MACHINE, seedSession } from './fixtures.js';

// ADR-0009 through the EngineService with the real apply(): the reviewer's start_session in the
// outbox, the review step persisted in `context` (no migration), and the worker's Claude session
// kept apart from the reviewer's. Needs `pnpm db:up`.

const db = useTestDatabase();
const NOW = new Date('2026-10-23T12:00:00.000Z');
const WORKER = 'c1a0de00-0000-4000-8000-00000000000a';
const REVIEWER = 'c1a0de00-0000-4000-8000-00000000000b';
const LABEL = reviewStateLabel('implement', 'build');

beforeAll(async () => {
  await db.pool.query(
    'INSERT INTO workflow_definition (id, version, definition) VALUES ($1, 1, $2) ' +
      'ON CONFLICT DO NOTHING',
    ['m1_reviewed', JSON.stringify(loadWorkflow('m1_reviewed.v1.json'))],
  );
});

const session = async (id: string) =>
  (await db.pool.query<SessionRow>('SELECT * FROM session WHERE id = $1', [id])).rows[0]!;
const starts = async (id: string) =>
  (
    await db.pool.query<OutboxRow>(
      "SELECT * FROM outbox WHERE session_id = $1 AND kind = 'start_session' ORDER BY id",
      [id],
    )
  ).rows.map((r) => ({ row: r, payload: StartSessionPayloadSchema.parse(r.payload) }));

describe('requirements review through the EngineService', () => {
  it('starts a fresh read-only reviewer and keeps the worker conversation separate', async () => {
    const { sessionId } = await seedSession(db.pool, { workflow_id: 'm1_reviewed' });
    const { engine } = createEngineService({
      db: db.pool,
      boardBus: new InMemoryBoardBus(),
      now: () => NOW,
    });
    const run = async (event: EngineEvent) => {
      const res = await engine.applyEvent(sessionId, event);
      expect(res.status, event.type).toBe('applied');
      return res;
    };
    const started = async () => {
      const s = await session(sessionId);
      await run({
        type: 'session.started',
        command_id: s.agent_command_id!,
        worktree_path: '/tmp/wt',
        branch: s.branch!,
        port_range: { base: 41000, count: 10 },
      });
    };

    await run({ type: 'session.assigned', machine_id: MACHINE });
    await started();
    await run({ type: 'agent.claude_session_id', claude_session_id: WORKER });
    await run({ type: 'agent.complete_state', result: { summary: 'added /health' } });

    let s = await session(sessionId);
    expect(s).toMatchObject({
      workflow_state: LABEL,
      status: 'running',
      claude_session_id: WORKER,
    });
    expect(s.context[STEP_CONTEXT_KEY]).toMatchObject({
      from: 'implement',
      outcome: 'done',
      to: 'build',
      claude_session_id: null,
    });
    expect(s.state_deadline?.toISOString()).toBe('2026-10-23T12:10:00.000Z');
    let all = await starts(sessionId);
    expect(all).toHaveLength(2);
    const reviewer = all[1]!;
    expect(s.agent_command_id).toBe(reviewer.row.command_id);
    expect(reviewer.payload).toMatchObject({
      workflow_state: LABEL,
      tools: ['review'],
      resume_claude_session_id: null,
      review: true,
    });
    expect(reviewer.payload.prompt.startsWith(REVIEW_PROMPT_HEADING)).toBe(true);
    expect(reviewer.payload.prompt).toContain('1. New code paths have unit tests');
    expect(reviewer.payload.prompt).toContain('2. No TODO comments in changed files');
    expect(reviewer.payload.prompt).toContain('added /health');

    // The reviewer's own Claude session id goes to the review step, never the session.
    await started();
    await run({ type: 'agent.claude_session_id', claude_session_id: REVIEWER });
    s = await session(sessionId);
    expect(s.claude_session_id).toBe(WORKER);
    expect(s.context[STEP_CONTEXT_KEY]).toMatchObject({ claude_session_id: REVIEWER });

    // Unmet: back to implement, resuming the WORKER with the reasons; the step is cleared.
    await run({
      type: 'agent.complete_state',
      result: {
        verdict: [
          { item: 'New code paths have unit tests', met: false, reason: 'no test for /health' },
          { item: 'No TODO comments in changed files', met: true, reason: 'none' },
        ],
      },
    });
    s = await session(sessionId);
    expect(s).toMatchObject({
      workflow_state: 'implement',
      retry_counters: { 'requirements:implement:done': 1 },
      claude_session_id: WORKER,
    });
    expect(s.context[STEP_CONTEXT_KEY]).toBeUndefined();
    expect(s.context[LABEL]).toMatchObject({ verdict: [{ met: false }, { met: true }] });
    all = await starts(sessionId);
    const back = all[2]!.payload;
    expect(back).toMatchObject({
      resume_claude_session_id: WORKER,
      tools: ['edit', 'bash', 'git'],
    });
    expect(back.review).toBeUndefined();
    expect(back.prompt).toContain('Requirements for implement → build were not met:');
    expect(back.prompt).toContain('- New code paths have unit tests: no test for /health');

    // The board shows the review step's label while it runs.
    const states = await db.pool.query<{ payload: { to: string } }>(
      "SELECT payload FROM event WHERE session_id = $1 AND type = 'state.entered' ORDER BY id",
      [sessionId],
    );
    expect(states.rows.map((r) => r.payload.to)).toEqual(['implement', LABEL, 'implement']);
  });
});

describe('gate steps are fenced from the worker (security review 2026-10-23)', () => {
  const VERDICT_ALL_MET = {
    verdict: [
      { item: 'New code paths have unit tests', met: true, reason: 'self-approved' },
      { item: 'No TODO comments in changed files', met: true, reason: 'self-approved' },
    ],
  };

  /** A session in the review step; returns the worker's token and the step's token. */
  async function toReview() {
    const { sessionId } = await seedSession(db.pool, { workflow_id: 'm1_reviewed' });
    const { engine } = createEngineService({
      db: db.pool,
      boardBus: new InMemoryBoardBus(),
      now: () => NOW,
    });
    const tokenOf = async () => Number((await session(sessionId)).fencing_token);
    const run = (event: EngineEvent, fencingToken?: number) =>
      engine.applyEvent(sessionId, event, fencingToken === undefined ? {} : { fencingToken });
    await run({ type: 'session.assigned', machine_id: MACHINE });
    let s = await session(sessionId);
    await run({
      type: 'session.started',
      command_id: s.agent_command_id!,
      worktree_path: '/tmp/wt',
      branch: s.branch!,
      port_range: { base: 41000, count: 10 },
    });
    const worker = await tokenOf();
    const done = await run({ type: 'agent.complete_state', result: { summary: 'x' } }, worker);
    expect(done.status).toBe('applied');
    s = await session(sessionId);
    expect(s.workflow_state).toBe(LABEL);
    const step = await tokenOf();
    // Entering the step bumped the token; the reviewer's start_session carries the new one.
    expect(step).toBeGreaterThan(worker);
    const reviewerRow = (await starts(sessionId)).at(-1)!.row;
    expect(Number(reviewerRow.fencing_token)).toBe(step);
    return { sessionId, run, worker, step };
  }

  it.each([
    ['complete_state (verdict-shaped)', { type: 'agent.complete_state', result: VERDICT_ALL_MET }],
    ['ask_user', { type: 'agent.ask_user', question: 'approve me?' }],
    ['no_outcome', { type: 'agent.no_outcome', last_output: '...' }],
  ] as const)('the worker’s %s during the review is stale and moves nothing', async (_, ev) => {
    const { sessionId, run, worker } = await toReview();
    const before = await session(sessionId);
    const res = await run(ev, worker);
    expect(res).toMatchObject({ status: 'rejected', reason: 'stale_fencing_token' });
    const after = await session(sessionId);
    expect(after.workflow_state).toBe(LABEL);
    expect(after.context).toEqual(before.context);
    expect(after.retry_counters).toEqual(before.retry_counters);
  });

  it('the reviewer’s complete_state (the step’s token) is the verdict', async () => {
    const { sessionId, run, step } = await toReview();
    const res = await run({ type: 'agent.complete_state', result: VERDICT_ALL_MET }, step);
    expect(res.status).toBe('applied');
    const after = await session(sessionId);
    expect(after.workflow_state).toBe('build');
    // Leaving the step fences the reviewer out of the next state too.
    expect(Number(after.fencing_token)).toBeGreaterThan(step);
  });

  it('the reviewer’s ask_user / no_outcome count as no verdict (nudge, then else)', async () => {
    const { sessionId, run, step } = await toReview();
    expect((await run({ type: 'agent.ask_user', question: '?' }, step)).status).toBe('applied');
    expect((await session(sessionId)).workflow_state).toBe(LABEL); // nudged, still reviewing
    const res = await run({ type: 'agent.no_outcome', last_output: '' }, step);
    expect(res.status).toBe('applied');
    expect((await session(sessionId)).workflow_state).toBe('needs_input');
  });
});
