// 06 §Queue order: PUT / DELETE /api/queue/order and the store behind them (and MCP
// `reorder_queue`). Needs `pnpm db:up`.
import type { AddressInfo } from 'node:net';
import {
  API_PATHS,
  BoardResponseSchema,
  QueueOrderResponseSchema,
  TicketDtoSchema,
} from '@conductor/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/api/index.js';
import { reorderQueue, resetQueueOrder } from '../src/api/queue-order.js';
import { FakeEngineService, InMemoryBoardBus, InMemoryOutputBus } from '../src/contracts.js';
import type { ApiHandle } from '../src/main.js';
import { useTestDatabase } from './db.js';
import { newAccount } from './gateway/auth-harness.js';

const db = useTestDatabase();
const boardBus = new InMemoryBoardBus();
let api: ApiHandle;
let base: string;

async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  api = createApi({
    db: db.pool,
    engine: new FakeEngineService(),
    boardBus,
    outputBus: new InMemoryOutputBus(),
  });
  await api.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await api.close();
});

/** Through the API (the local account), with `priority`. */
async function create(title: string, priority = 0) {
  const res = await send('POST', API_PATHS.tickets, {
    title,
    body: '## Goal\nQueue me.',
    repo: 'acme/app',
    workflow_id: 'conductor',
    kind: 'work',
    priority,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return TicketDtoSchema.parse(res.body).id;
}

async function positions(ids: string[]) {
  const r = await db.pool.query<{ id: string; queue_position: number | null }>(
    'SELECT id, queue_position FROM ticket WHERE id = ANY($1::uuid[])',
    [ids],
  );
  const by = new Map(r.rows.map((x) => [x.id, x.queue_position]));
  return ids.map((id) => by.get(id));
}

async function queuedColumn(ids: string[]) {
  const res = await send('GET', API_PATHS.board);
  const board = BoardResponseSchema.parse(res.body);
  const wanted = new Set(ids);
  return board.columns
    .find((c) => c.id === 'queued')!
    .cards.filter((c) => wanted.has(c.ticket_id))
    .map((c) => c.ticket_id);
}

describe('PUT / DELETE /api/queue/order', () => {
  it('puts the listed tickets first, ranks everything, and the board follows', async () => {
    // Clean slate for the local account: earlier tests' tickets stay unranked behind ours.
    await send('DELETE', API_PATHS.queueOrder, {});
    const low = await create('low', 0);
    const high = await create('high', 5);
    const mid = await create('mid', 2);
    expect(await queuedColumn([low, high, mid])).toEqual([high, mid, low]);

    const published = boardBus.published.length;
    const res = await send('PUT', API_PATHS.queueOrder, { ticket_ids: [low, mid] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const out = QueueOrderResponseSchema.parse(res.body);
    expect(out.ticket_ids.slice(0, 3)).toEqual([low, mid, high]);
    expect(out.skipped).toEqual([]);
    expect(await positions([low, mid, high])).toEqual([1, 2, 3]);
    expect(await queuedColumn([low, high, mid])).toEqual([low, mid, high]);
    // One card.upserted per ticket whose place changed, carrying the new position.
    const events = boardBus.published.slice(published);
    expect(events.every((e) => e.type === 'card.upserted')).toBe(true);
    const lowCard = events.find((e) => e.type === 'card.upserted' && e.ticket_id === low);
    expect(lowCard?.type === 'card.upserted' && lowCard.card.queue_position).toBe(1);

    // A new ticket, even a high-priority one, queues after the hand-ordered ones.
    const later = await create('later', 9);
    expect(await queuedColumn([low, high, mid, later])).toEqual([low, mid, high, later]);

    const reset = await send('DELETE', API_PATHS.queueOrder, {});
    expect(reset.status).toBe(200);
    expect(await positions([low, mid, high])).toEqual([null, null, null]);
    expect(await queuedColumn([low, high, mid, later])).toEqual([later, high, mid, low]);
  });

  it('doesn’t touch updated_at', async () => {
    const a = await create('a');
    const before = await db.pool.query('SELECT updated_at FROM ticket WHERE id = $1', [a]);
    await send('PUT', API_PATHS.queueOrder, { ticket_ids: [a] });
    const after = await db.pool.query('SELECT updated_at FROM ticket WHERE id = $1', [a]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('skips a ticket that is no longer queued; 404 when none is', async () => {
    const a = await create('a');
    const b = await create('b');
    await db.pool.query("UPDATE ticket SET status = 'claimed' WHERE id = $1", [b]);
    const res = await send('PUT', API_PATHS.queueOrder, { ticket_ids: [b, a] });
    expect(res.status).toBe(200);
    const out = QueueOrderResponseSchema.parse(res.body);
    expect(out.skipped).toEqual([b]);
    expect(out.ticket_ids[0]).toBe(a);
    expect(out.ticket_ids).not.toContain(b);
    expect((await send('PUT', API_PATHS.queueOrder, { ticket_ids: [b] })).status).toBe(404);
  });

  it('400 for an empty list, a repeated id or a non-uuid', async () => {
    const a = await create('a');
    for (const ticket_ids of [[], [a, a], ['nope']]) {
      expect((await send('PUT', API_PATHS.queueOrder, { ticket_ids })).status).toBe(400);
    }
  });
});

describe('reorderQueue (store)', () => {
  async function ticketOf(accountId: string, priority = 0) {
    const r = await db.pool.query<{ id: string }>(
      `INSERT INTO ticket (account_id, repo, title, workflow_id, priority)
       VALUES ($1, 'acme/app', 't', 'conductor', $2) RETURNING id`,
      [accountId, priority],
    );
    return r.rows[0]!.id;
  }

  it('keeps the unlisted tickets in their order after the listed ones', async () => {
    const { account_id } = await newAccount(db.pool);
    const [a, b, c, d] = [
      await ticketOf(account_id, 4),
      await ticketOf(account_id, 3),
      await ticketOf(account_id, 2),
      await ticketOf(account_id, 1),
    ];
    expect((await reorderQueue(db.pool, account_id, [c])).ticket_ids).toEqual([c, a, b, d]);
    // A second partial reorder keeps the hand order of the rest.
    expect((await reorderQueue(db.pool, account_id, [d])).ticket_ids).toEqual([d, c, a, b]);
    expect(await positions([d, c, a, b])).toEqual([1, 2, 3, 4]);
    const res = await resetQueueOrder(db.pool, account_id);
    expect(res.ticket_ids).toEqual([a, b, c, d]);
    expect(res.events).toHaveLength(4);
  });

  it('never reorders another account’s tickets', async () => {
    const mine = await newAccount(db.pool);
    const theirs = await newAccount(db.pool);
    const m = await ticketOf(mine.account_id);
    const t = await ticketOf(theirs.account_id);
    const res = await reorderQueue(db.pool, mine.account_id, [t, m]);
    expect(res.skipped).toEqual([t]);
    expect(res.ticket_ids).toEqual([m]);
    expect(await positions([t])).toEqual([null]);
  });

  it('writes nothing and emits nothing when the order is already so', async () => {
    const { account_id } = await newAccount(db.pool);
    const a = await ticketOf(account_id);
    await reorderQueue(db.pool, account_id, [a]);
    expect((await reorderQueue(db.pool, account_id, [a])).events).toEqual([]);
  });
});
