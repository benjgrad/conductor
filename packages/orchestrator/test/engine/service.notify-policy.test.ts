// ADR-0037 P6 (T4): the EngineService wrapper under a workflow `notify` policy. One push per
// positive decision (the question when the landing opens a request, else the transition), none
// for a silent one, the decision stored on the event and the request, and the `coalesce` bucket
// as the idempotency key. Needs `pnpm db:up`: the outbox and its unique key are what is tested.
import { randomUUID } from 'node:crypto';
import { LOCAL_ACCOUNT_ID, notifyBucketKey, type NotifyDecision } from '@conductor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryBoardBus } from '../../src/contracts.js';
import type { OutboxRow } from '../../src/db/types.js';
import { createEngineService } from '../../src/engine/index.js';
import type { PushSender } from '../../src/push/sender.js';
import { useTestDatabase } from '../db.js';
import { MACHINE, ScriptedApply, seedBase, seedSession } from './fixtures.js';

const db = useTestDatabase();

let t = new Date('2026-11-06T12:00:00.000Z').getTime();
const now = () => new Date(t);
let script: ScriptedApply;
const sender: PushSender = { send: () => Promise.resolve({ ok: true }) };

const make = () =>
  createEngineService({
    db: db.pool,
    boardBus: new InMemoryBoardBus(),
    now,
    apply: script.apply,
    push: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:o@example.test' },
    pushSender: sender,
  }).engine;

const decision = (via: string, d: 'push' | 'silent'): NotifyDecision => ({
  via,
  mode: 'once',
  decision: d,
});

/** implement → needs_input through a hand-off that opens a request, with `d` on both effects. */
const handoff = (d: NotifyDecision) =>
  script.on('agent.complete_state', () => ({
    snapshot: {
      status: 'needs_input',
      workflow_state: 'needs_input',
      return_to: 'implement',
      ...(d.decision === 'push' ? { notified_transitions: [d.via] } : {}),
    },
    effects: [
      {
        type: 'state_entered',
        from: 'implement',
        to: 'needs_input',
        visit: 1,
        cause: 'transition',
        transition: d.via,
        notify_decision: d,
      },
      { type: 'session_status', from: 'running', to: 'needs_input' },
      {
        type: 'create_input_request',
        kind: 'handoff',
        question: 'PR ready',
        return_to: 'implement',
        notify_decision: d,
      },
    ],
  }));

/** implement → build, no request, with a push decision. */
const move = () =>
  script.on('agent.complete_state', () => ({
    snapshot: { workflow_state: 'build', status: 'running' },
    effects: [
      {
        type: 'state_entered',
        from: 'implement',
        to: 'build',
        visit: 1,
        cause: 'transition',
        transition: 'done',
        notify_decision: { via: 'done', mode: 'every', decision: 'push' },
      },
    ],
  }));

const pushes = async () =>
  (
    await db.pool.query<OutboxRow>(
      "SELECT * FROM outbox WHERE kind IN ('push_needs_input', 'push_transition') ORDER BY id",
    )
  ).rows;

beforeEach(async () => {
  script = new ScriptedApply();
  await seedBase(db.pool);
  await db.pool.query(
    "UPDATE workflow_definition SET definition = definition || $1::jsonb WHERE id = 'm1_basic'",
    [JSON.stringify({ notify: { default: 'once', engine_moves: 'never', coalesce: '15m' } })],
  );
  await db.pool.query("DELETE FROM outbox WHERE kind IN ('push_needs_input', 'push_transition')");
  await db.pool.query('DELETE FROM push_subscription');
  await db.pool.query(
    `INSERT INTO push_subscription (account_id, user_id, endpoint, p256dh, auth, created_at)
     VALUES ($1, $2, 'https://push.test/a', 'BKey', 'auth', $3)`,
    [LOCAL_ACCOUNT_ID, randomUUID(), now()],
  );
});

const running = () =>
  seedSession(db.pool, {
    status: 'running',
    machine_id: MACHINE,
    workflow_state: 'implement',
    agent_process_live: true,
  });

describe('notify policy in the EngineService wrapper (ADR-0037 P6)', () => {
  it('a pushing hand-off: one push_needs_input on the bucketed key, no push_transition', async () => {
    handoff(decision('pr_ready_for_review', 'push'));
    const { ticketId, sessionId } = await running();
    const res = await make().applyEvent(sessionId, { type: 'agent.complete_state', result: {} });
    expect(res.status).toBe('applied');

    const rows = await pushes();
    expect(rows.map((r) => [r.kind, r.idempotency_key])).toEqual([
      ['push_needs_input', notifyBucketKey(ticketId, 'needs_input', now(), 15 * 60)],
    ]);
    const req = await db.pool.query<{ notify: unknown }>(
      'SELECT notify FROM input_request WHERE session_id = $1',
      [sessionId],
    );
    expect(req.rows[0]!.notify).toEqual(decision('pr_ready_for_review', 'push'));
    const ev = await db.pool.query<{ payload: { notify?: unknown } }>(
      "SELECT payload FROM event WHERE session_id = $1 AND type = 'state.entered'",
      [sessionId],
    );
    expect(ev.rows[0]!.payload.notify).toEqual(decision('pr_ready_for_review', 'push'));
    const s = await db.pool.query<{ notified_transitions: string[] }>(
      'SELECT notified_transitions FROM session WHERE id = $1',
      [sessionId],
    );
    expect(s.rows[0]!.notified_transitions).toEqual(['pr_ready_for_review']);
  });

  it('a silent decision writes no push but records the decision', async () => {
    handoff(decision('pr_ready_for_review', 'silent'));
    const { sessionId } = await running();
    await make().applyEvent(sessionId, { type: 'agent.complete_state', result: {} });
    expect(await pushes()).toEqual([]);
    const req = await db.pool.query<{ notify: unknown }>(
      'SELECT notify FROM input_request WHERE session_id = $1',
      [sessionId],
    );
    expect(req.rows[0]!.notify).toEqual(decision('pr_ready_for_review', 'silent'));
  });

  it('coalesce: two pushing moves into one state inside the window send one push', async () => {
    move();
    const { sessionId } = await running();
    const engine = make();
    await engine.applyEvent(sessionId, { type: 'agent.complete_state', result: {} });
    t += 60_000;
    await engine.applyEvent(sessionId, { type: 'agent.complete_state', result: {} });
    const rows = await pushes();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('push_transition');
    expect(rows[0]!.idempotency_key).toMatch(/^notify:.+:build:\d+$/);
    t += 15 * 60_000;
    await engine.applyEvent(sessionId, { type: 'agent.complete_state', result: {} });
    expect(await pushes()).toHaveLength(2);
  });
});
