// UX-15 FR-4: the push_needs_input enqueue (in the engine's apply transaction) and the push
// dispatcher, against a test database with a fake push sender. Needs `pnpm db:up`.
import { randomUUID } from 'node:crypto';
import { LOCAL_ACCOUNT_ID } from '@conductor/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeOutboxTransport, InMemoryBoardBus } from '../../src/contracts.js';
import type { OutboxRow, PushSubscriptionRow } from '../../src/db/types.js';
import { createEngineService } from '../../src/engine/index.js';
import type { PushConfig } from '../../src/push/config.js';
import { enqueueNeedsInputPush } from '../../src/push/enqueue.js';
import type { PushResult, PushSender, PushTarget } from '../../src/push/sender.js';
import { useTestDatabase } from '../db.js';
import { MACHINE, ScriptedApply, seedSession } from '../engine/fixtures.js';

const db = useTestDatabase();
// Never handed to web-push: every test injects the fake sender.
const PUSH: PushConfig = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:o@example.test' };
const LONG_QUESTION = `Which port should the health endpoint use? ${'x'.repeat(200)}`;

class FakeSender implements PushSender {
  calls: { endpoint: string; payload: Record<string, unknown> }[] = [];
  /** Per endpoint: the scripted results, in order; then ok. */
  script = new Map<string, PushResult[]>();
  send(target: PushTarget, payload: string): Promise<PushResult> {
    this.calls.push({
      endpoint: target.endpoint,
      payload: JSON.parse(payload) as Record<string, unknown>,
    });
    return Promise.resolve(this.script.get(target.endpoint)?.shift() ?? { ok: true });
  }
}
const FAIL: PushResult = { ok: false, gone: false, status: 500, error: 'http_500' };
const GONE = (status: 404 | 410): PushResult => ({
  ok: false,
  gone: true,
  status,
  error: `http_${status}`,
});

let t = new Date('2026-10-29T12:00:00.000Z').getTime();
const clock = { now: () => new Date(t), advance: (ms: number) => (t += ms) };
let script: ScriptedApply;
let sender: FakeSender;

const make = (push: PushConfig | null = PUSH) =>
  createEngineService({
    db: db.pool,
    boardBus: new InMemoryBoardBus(),
    now: clock.now,
    apply: script.apply,
    push,
    pushSender: sender,
  });

beforeEach(async () => {
  script = new ScriptedApply().on('agent.ask_user', (_s, ev) => ({
    snapshot: { status: 'needs_input', workflow_state: 'needs_input', return_to: 'implement' },
    effects: [
      { type: 'session_status', from: 'running', to: 'needs_input' },
      {
        type: 'create_input_request',
        kind: 'agent_question',
        question: ev.type === 'agent.ask_user' ? ev.question : '',
        return_to: 'implement',
      },
    ],
  }));
  sender = new FakeSender();
  await db.pool.query("DELETE FROM outbox WHERE kind = 'push_needs_input'");
  await db.pool.query('DELETE FROM push_subscription');
});

async function subscribe(accountId: string, userId: string, endpoint: string): Promise<string> {
  const r = await db.pool.query<{ id: string }>(
    `INSERT INTO push_subscription (account_id, user_id, endpoint, p256dh, auth, created_at)
     VALUES ($1, $2, $3, 'BKey', 'auth', $4) RETURNING id`,
    [accountId, userId, endpoint, clock.now()],
  );
  return r.rows[0]!.id;
}

async function otherAccount(): Promise<string> {
  const r = await db.pool.query<{ id: string }>(
    "INSERT INTO account (name) VALUES ('other') RETURNING id",
  );
  return r.rows[0]!.id;
}

/** A running session that asks a question: returns ids and the input request id. */
async function ask(engine: ReturnType<typeof make>['engine'], question = LONG_QUESTION) {
  const seeded = await seedSession(db.pool, {
    status: 'running',
    machine_id: MACHINE,
    workflow_state: 'implement',
    agent_process_live: true,
  });
  const res = await engine.applyEvent(seeded.sessionId, { type: 'agent.ask_user', question });
  expect(res.status).toBe('applied');
  const ir = await db.pool.query<{ id: string }>(
    'SELECT id FROM input_request WHERE session_id = $1',
    [seeded.sessionId],
  );
  return { ...seeded, inputRequestId: ir.rows[0]!.id };
}

const pushRows = async () =>
  (
    await db.pool.query<OutboxRow>(
      "SELECT * FROM outbox WHERE kind = 'push_needs_input' ORDER BY id",
    )
  ).rows;
const subs = async () =>
  (await db.pool.query<PushSubscriptionRow>('SELECT * FROM push_subscription ORDER BY endpoint'))
    .rows;

describe('push_needs_input (UX-15)', () => {
  it('one input request → one row per subscribed user, one push per subscription', async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    await subscribe(LOCAL_ACCOUNT_ID, userA, 'https://push.test/a1');
    await subscribe(LOCAL_ACCOUNT_ID, userA, 'https://push.test/a2');
    await subscribe(LOCAL_ACCOUNT_ID, userB, 'https://push.test/b1');
    await subscribe(await otherAccount(), randomUUID(), 'https://push.test/other');
    const handle = make();
    const { ticketId, sessionId, inputRequestId } = await ask(handle.engine);

    const rows = await pushRows();
    expect(rows.map((r) => r.target).sort()).toEqual([`user:${userA}`, `user:${userB}`].sort());
    for (const r of rows) {
      expect(r).toMatchObject({
        account_id: LOCAL_ACCOUNT_ID,
        session_id: sessionId,
        idempotency_key: inputRequestId,
        fencing_token: null,
        status: 'pending',
      });
    }

    const stats = await handle.dispatchPushOnce();
    expect(stats).toMatchObject({ sent: 3, acked: 2, failed: 0 });
    expect(sender.calls.map((c) => c.endpoint).sort()).toEqual([
      'https://push.test/a1',
      'https://push.test/a2',
      'https://push.test/b1',
    ]);
    const payload = sender.calls[0]!.payload;
    expect(Object.keys(payload).sort()).toEqual(['body', 'tag', 'title', 'url']);
    expect(payload).toMatchObject({
      title: 'Add /health',
      url: `/#/?ticket=${ticketId}`,
      tag: inputRequestId,
    });
    const body = payload.body as string;
    expect(body.startsWith('implement: Which port')).toBe(true);
    expect([...body.slice('implement: '.length)]).toHaveLength(120);
    expect(body.endsWith('…')).toBe(true);

    // Done: acked, the notification text dropped; a second pass sends nothing.
    for (const r of await pushRows()) {
      expect(r.status).toBe('acked');
      expect(r.payload.notification).toBeNull();
    }
    expect((await subs()).filter((s) => s.last_ok_at !== null)).toHaveLength(3);
    clock.advance(120_000);
    await handle.dispatchPushOnce();
    expect(sender.calls).toHaveLength(3);
  });

  it('a retry resends only the failed subscription; a second enqueue adds nothing', async () => {
    const user = randomUUID();
    await subscribe(LOCAL_ACCOUNT_ID, user, 'https://push.test/ok');
    await subscribe(LOCAL_ACCOUNT_ID, user, 'https://push.test/flaky');
    sender.script.set('https://push.test/flaky', [FAIL]);
    const handle = make();
    const { ticketId, sessionId, inputRequestId } = await ask(handle.engine);

    expect(await handle.dispatchPushOnce()).toMatchObject({ sent: 1, failed: 1, acked: 0 });
    let [row] = await pushRows();
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_error: 'http_500' });
    // Not due before the backoff.
    await handle.dispatchPushOnce();
    expect(sender.calls).toHaveLength(2);

    clock.advance(5_000);
    expect(await handle.dispatchPushOnce()).toMatchObject({ sent: 1, acked: 1 });
    // ok: once in total; flaky: the failure, then the retry.
    expect(sender.calls.map((c) => c.endpoint).sort()).toEqual([
      'https://push.test/flaky',
      'https://push.test/flaky',
      'https://push.test/ok',
    ]);
    expect(sender.calls.at(-1)!.endpoint).toBe('https://push.test/flaky');
    [row] = await pushRows();
    expect(row!.status).toBe('acked');
    expect((await subs()).map((s) => s.failures)).toEqual([0, 0]);

    // The same input request enqueued again (idempotency key): no new row.
    const n = await enqueueNeedsInputPush(db.pool, {
      accountId: LOCAL_ACCOUNT_ID,
      sessionId,
      ticketId,
      ticketTitle: 'x',
      agent: null,
      inputRequestId,
      question: 'q',
      now: clock.now(),
    });
    expect(n).toBe(0);
    expect(await pushRows()).toHaveLength(1);
  });

  it.each([404, 410] as const)('a %d deletes the subscription', async (status) => {
    const user = randomUUID();
    await subscribe(LOCAL_ACCOUNT_ID, user, 'https://push.test/gone');
    await subscribe(LOCAL_ACCOUNT_ID, user, 'https://push.test/live');
    sender.script.set('https://push.test/gone', [GONE(status)]);
    const handle = make();
    await ask(handle.engine);
    expect(await handle.dispatchPushOnce()).toMatchObject({ sent: 1, deleted: 1, acked: 1 });
    expect((await subs()).map((s) => s.endpoint)).toEqual(['https://push.test/live']);
  });

  it('five failures drop the subscription', async () => {
    const user = randomUUID();
    await subscribe(LOCAL_ACCOUNT_ID, user, 'https://push.test/down');
    sender.script.set('https://push.test/down', [FAIL, FAIL, FAIL, FAIL, FAIL, FAIL]);
    const handle = make();
    await ask(handle.engine);
    for (let i = 1; i <= 4; i++) {
      await handle.dispatchPushOnce();
      expect((await subs())[0]!.failures).toBe(i);
      clock.advance(60_000);
    }
    expect(await handle.dispatchPushOnce()).toMatchObject({ deleted: 1, acked: 1 });
    expect(await subs()).toEqual([]);
    expect(sender.calls).toHaveLength(5);
    expect((await pushRows())[0]!.status).toBe('acked');
  });

  it('a row older than the TTL (1 h) fails as expired, without sending', async () => {
    await subscribe(LOCAL_ACCOUNT_ID, randomUUID(), 'https://push.test/late');
    const handle = make();
    await ask(handle.engine);
    clock.advance(3600_000);
    expect(await handle.dispatchPushOnce()).toMatchObject({ expired: 1, sent: 0 });
    expect((await pushRows())[0]).toMatchObject({ status: 'failed', last_error: 'expired' });
    expect(sender.calls).toEqual([]);
  });

  it('without VAPID: nothing is enqueued or sent, and no push loop runs', async () => {
    await subscribe(LOCAL_ACCOUNT_ID, randomUUID(), 'https://push.test/a');
    const handle = make(null);
    await ask(handle.engine);
    expect(await pushRows()).toEqual([]);
    expect(await handle.dispatchPushOnce()).toBeNull();
    const workers = handle.startWorkers({ transport: new FakeOutboxTransport() });
    await workers.stop();
    expect(sender.calls).toEqual([]);
  });

  it('no subscriptions in the account: no row', async () => {
    await subscribe(await otherAccount(), randomUUID(), 'https://push.test/elsewhere');
    const handle = make();
    await ask(handle.engine);
    expect(await pushRows()).toEqual([]);
  });

  it('the machine dispatcher never sends a push row', async () => {
    await subscribe(LOCAL_ACCOUNT_ID, randomUUID(), 'https://push.test/a');
    const handle = make();
    await ask(handle.engine);
    const transport = new FakeOutboxTransport().connect(MACHINE);
    await handle.dispatchOnce(transport);
    expect(transport.sent.filter((s) => s.message.type === ('push_needs_input' as string))).toEqual(
      [],
    );
    expect((await pushRows())[0]!.status).toBe('pending');
  });
});
