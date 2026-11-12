// ADR-0041: a question's default answer through the real EngineService and sweep. The sweep
// delivers a due default (request closed answered_by `system`, a `question.default_taken` row, a
// `state.entered` with cause `default_taken`, one push); a human answer first leaves nothing to
// fire; a stale default is cleared; a human's overrule reaches the agent as a message.
// Needs `pnpm db:up`.
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONTEXT_KEY, LOCAL_ACCOUNT_ID } from '@conductor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryBoardBus, InMemoryOutputBus } from '../../src/contracts.js';
import type { InputRequestRow, OutboxRow, SessionRow } from '../../src/db/types.js';
import { createEngineService } from '../../src/engine/index.js';
import type { PushSender } from '../../src/push/sender.js';
import { useTestDatabase } from '../db.js';
import { MACHINE, seedBase } from './fixtures.js';

const db = useTestDatabase();
let t = new Date('2026-11-12T12:00:00.000Z').getTime();
const now = () => new Date(t);
const HOUR = 3_600_000;
const sender: PushSender = { send: () => Promise.resolve({ ok: true }) };

const DEFAULT_FLOW = {
  id: 'default_flow',
  version: 1,
  start: 'planning',
  budget: { usd: 20, minutes: 600, max_loop_retries: 3 },
  on_budget_exceeded: 'needs_input',
  states: {
    planning: {
      type: 'agent',
      title: 'Planning',
      prompt: 'plan_template',
      tools: ['read'],
      on: {
        plan_ready: { goto: 'done', title: 'Plan ready' },
        ask_user: {
          goto: 'needs_input',
          default: { after: '8h', answer: '$recommended' },
        },
      },
    },
    needs_input: {
      type: 'human',
      title: 'Needs input',
      on: { answer: { goto: '$return_to', title: 'Answer', actor: 'human' } },
    },
    done: { type: 'terminal', title: 'Done' },
  },
};

let outputBus = new InMemoryOutputBus();
const make = () =>
  createEngineService({
    db: db.pool,
    boardBus: new InMemoryBoardBus(),
    now,
    push: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:o@example.test' },
    pushSender: sender,
    outputBus,
  });

beforeEach(async () => {
  t += 10 * 24 * HOUR; // every test runs later than the last one's deadlines
  outputBus = new InMemoryOutputBus();
  await seedBase(db.pool);
  await db.pool.query(
    'INSERT INTO workflow_definition (id, version, definition) VALUES ($1, 1, $2) ' +
      'ON CONFLICT DO NOTHING',
    ['default_flow', JSON.stringify(DEFAULT_FLOW)],
  );
  // Only this test's sessions are due.
  await db.pool.query('UPDATE session SET watch_deadline = NULL, state_deadline = NULL');
  await db.pool.query('UPDATE input_request SET default_at = NULL');
  await db.pool.query('DELETE FROM push_subscription');
  await db.pool.query(
    `INSERT INTO push_subscription (account_id, user_id, endpoint, p256dh, auth, created_at)
     VALUES ($1, $2, 'https://push.test/a', 'BKey', 'auth', $3)`,
    [LOCAL_ACCOUNT_ID, randomUUID(), now()],
  );
});

/**
 * A session parked in needs_input, asked from planning, with an 8h default armed on its open
 * request. `visit` is the visit the default was armed for (the session is on visit 1).
 */
async function parked(visit = 1): Promise<{ sessionId: string; requestId: string; at: Date }> {
  const ticketId = randomUUID();
  const sessionId = randomUUID();
  const requestId = randomUUID();
  const at = new Date(t + 8 * HOUR);
  await db.pool.query(
    'INSERT INTO ticket (id, repo, title, body, workflow_id, workflow_version, status) ' +
      "VALUES ($1, 'github.com/x/app', 'Defaulted', 'b', 'default_flow', 1, 'in_progress')",
    [ticketId],
  );
  const context = {
    [DEFAULT_CONTEXT_KEY]: {
      state: 'needs_input',
      visit,
      return_to: 'planning',
      transition: 'ask_user',
      recommended: 'Go with A',
      after: '8h',
      at: at.toISOString(),
    },
  };
  await db.pool.query(
    `INSERT INTO session (id, ticket_id, workflow_id, workflow_version, status, workflow_state,
                          machine_id, branch, context, state_visits, state_entered_at, return_to)
     VALUES ($1, $2, 'default_flow', 1, 'needs_input', 'needs_input', $3, 'conductor/x', $4,
             $5, $6, 'planning')`,
    [
      sessionId,
      ticketId,
      MACHINE,
      JSON.stringify(context),
      JSON.stringify({ planning: 1, needs_input: 1 }),
      now(),
    ],
  );
  await db.pool.query(
    'INSERT INTO input_request (id, session_id, kind, question, return_to, created_at, ' +
      "default_answer, default_at) VALUES ($1, $2, 'agent_question', 'A or B?', 'planning', $3, " +
      "'Go with A', $4)",
    [requestId, sessionId, now(), at],
  );
  return { sessionId, requestId, at };
}

const session = async (id: string) =>
  (await db.pool.query<SessionRow>('SELECT * FROM session WHERE id = $1', [id])).rows[0]!;
const request = async (id: string) =>
  (await db.pool.query<InputRequestRow>('SELECT * FROM input_request WHERE id = $1', [id]))
    .rows[0]!;
const outbox = async (id: string) =>
  (await db.pool.query<OutboxRow>('SELECT * FROM outbox WHERE session_id = $1 ORDER BY id', [id]))
    .rows;
const events = async (id: string, type: string) =>
  (
    await db.pool.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM event WHERE session_id = $1 AND type = $2 ORDER BY id',
      [id, type],
    )
  ).rows.map((r) => r.payload);

describe('default answers: the sweep (ADR-0041)', () => {
  it('nothing fires before default_at', async () => {
    const { sessionId } = await parked();
    await make().sweepOnce();
    expect((await session(sessionId)).workflow_state).toBe('needs_input');
  });

  it('a due default is delivered, the request closed by system, audited and pushed', async () => {
    const { sessionId, requestId, at } = await parked();
    t = at.getTime();
    const stats = await make().sweepOnce();
    expect(stats.applied).toBeGreaterThanOrEqual(1);
    const s = await session(sessionId);
    expect(s.workflow_state).toBe('planning');
    const r = await request(requestId);
    expect(r).toMatchObject({ answer: 'Go with A', answered_by: 'system' });
    expect(await events(sessionId, 'question.default_taken')).toEqual([
      {
        input_request_id: requestId,
        state: 'needs_input',
        to: 'planning',
        answer: 'Go with A',
        after: '8h',
      },
    ]);
    expect(await events(sessionId, 'state.entered')).toEqual([
      expect.objectContaining({
        from: 'needs_input',
        to: 'planning',
        cause: 'default_taken',
        actor: 'system',
        reason: 'Go with A',
      }),
    ]);
    const rows = await outbox(sessionId);
    const pushes = rows.filter((x) => x.kind === 'push_transition');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.idempotency_key).toBe(`default_taken:${requestId}`);
    // The resume carries the answer (no live process here).
    expect(rows.some((x) => x.kind === 'start_session')).toBe(true);
    expect(
      outputBus
        .snapshot(sessionId)
        .some((c) => c.stream === 'debug' && c.text.includes('Go with A')),
    ).toBe(true);
    // A second sweep finds nothing to fire.
    expect((await make().sweepOnce()).fired).toBe(0);
  });

  it('a human answer first: the sweep fires nothing', async () => {
    const { sessionId, requestId, at } = await parked();
    const handle = make();
    const res = await handle.engine.applyEvent(
      sessionId,
      { type: 'input.provided', input_request_id: requestId, answer: 'B' },
      { actor: 'ui' },
    );
    expect(res.status).toBe('applied');
    t = at.getTime();
    expect((await handle.sweepOnce()).fired).toBe(0);
    expect((await request(requestId)).answered_by).toBe('ui');
    expect(await events(sessionId, 'question.default_taken')).toEqual([]);
  });

  it('a stale default (another visit) is ignored and its timer cleared', async () => {
    const { sessionId, requestId, at } = await parked(2);
    t = at.getTime();
    const stats = await make().sweepOnce();
    expect(stats.ignored).toBe(1);
    expect((await session(sessionId)).workflow_state).toBe('needs_input');
    expect((await request(requestId)).default_at).toBeNull();
  });
});

describe('default answers: overrule (ADR-0041)', () => {
  it('a running agent gets the correction as a message; overruled_at and an audit row', async () => {
    const { sessionId, requestId, at } = await parked();
    t = at.getTime();
    const handle = make();
    await handle.sweepOnce();
    // The resumed agent started (the daemon's `started`).
    await db.pool.query('UPDATE session SET agent_process_live = true WHERE id = $1', [sessionId]);
    const res = await handle.engine.applyEvent(sessionId, {
      type: 'human.overrule',
      input_request_id: requestId,
      text: 'Use B',
      actor: 'ui',
    });
    expect(res.status).toBe('applied');
    expect((await outbox(sessionId)).filter((x) => x.kind === 'send_message')).toHaveLength(1);
    expect((await request(requestId)).overruled_at).not.toBeNull();
    expect(await events(sessionId, 'question.overruled')).toEqual([
      { input_request_id: requestId, text: 'Use B', actor: 'ui' },
    ]);
  });

  it('refused while the agent is still starting, or before any default', async () => {
    const { sessionId, requestId, at } = await parked();
    const handle = make();
    const overrule = () =>
      handle.engine.applyEvent(sessionId, {
        type: 'human.overrule',
        input_request_id: requestId,
        text: 'Use B',
        actor: 'ui',
      });
    expect((await overrule()).status).toBe('ignored');
    t = at.getTime();
    await handle.sweepOnce();
    expect((await overrule()).status).toBe('ignored');
    expect((await request(requestId)).overruled_at).toBeNull();
  });
});
