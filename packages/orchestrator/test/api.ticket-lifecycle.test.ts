// UXR-86: POST /api/tickets/:id/cancel and /reopen. A queued ticket (no session) is cancelled and
// reopened as a ticket row; one with a session goes through the engine / reopenSession.
import type { AddressInfo } from 'node:net';
import {
  API_PATHS,
  BoardResponseSchema,
  TicketDetailSchema,
  TicketDtoSchema,
  type WorkflowDefinitionInput,
} from '@conductor/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/api/index.js';
import { FakeEngineService, InMemoryBoardBus, InMemoryOutputBus } from '../src/contracts.js';
import type { ApiHandle } from '../src/main.js';
import { createUser } from './auth/helpers.js';
import { useTestDatabase } from './db.js';

const db = useTestDatabase();
const engine = new FakeEngineService();
const boardBus = new InMemoryBoardBus();
let api: ApiHandle;
let base: string;

const wf: WorkflowDefinitionInput = {
  id: 'cancel_wf',
  version: 1,
  start: 'implement',
  budget: { usd: 1, minutes: 10, max_loop_retries: 1 },
  states: {
    implement: {
      type: 'agent',
      prompt: 'ticket_template',
      on: { done: 'done', ask_user: 'needs_input' },
    },
    needs_input: { type: 'human', on: { 'input.provided': 'implement' } },
    done: { type: 'terminal' },
  },
};

async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  api = createApi({ db: db.pool, engine, boardBus, outputBus: new InMemoryOutputBus() });
  await api.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const res = await send('POST', API_PATHS.workflows, { definition: wf });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
});

afterAll(async () => {
  await api.close();
});

async function createTicket() {
  const res = await send('POST', API_PATHS.tickets, {
    title: 'Queued one',
    body: '',
    repo: 'acme/app',
    workflow_id: 'cancel_wf',
    kind: 'work',
  });
  expect(res.status).toBe(201);
  return TicketDtoSchema.parse(res.body);
}

async function getTicket(id: string) {
  const res = await send('GET', API_PATHS.ticket(id));
  expect(res.status).toBe(200);
  return TicketDetailSchema.parse(res.body);
}

async function boardCard(ticketId: string) {
  const res = await send('GET', API_PATHS.board);
  const board = BoardResponseSchema.parse(res.body);
  return board.columns.flatMap((c) => c.cards).find((c) => c.ticket_id === ticketId);
}

describe('POST /api/tickets/:id/cancel', () => {
  it('cancels a queued ticket: status, terminal card, event row without a session, card event', async () => {
    const t = await createTicket();
    const published = boardBus.published.length;
    const res = await send('POST', API_PATHS.ticketCancel(t.id), { reason: 'not needed' });
    expect(res.status, JSON.stringify(res.body)).toBe(202);

    const d = await getTicket(t.id);
    expect(d.status).toBe('cancelled');
    expect(d.column).not.toBe('queued');
    const card = await boardCard(t.id);
    expect(card?.badges).toContain('cancelled');
    expect(card?.column).toBe(d.column);

    const ev = await db.pool.query<{ session_id: string | null; payload: Record<string, unknown> }>(
      "SELECT session_id, payload FROM event WHERE type = 'operator.cancel' AND payload->>'ticket_id' = $1",
      [t.id],
    );
    expect(ev.rows).toEqual([
      { session_id: null, payload: { ticket_id: t.id, reason: 'not needed', actor: 'ui' } },
    ]);
    const upserts = boardBus.published.slice(published);
    expect(upserts.map((e) => e.type)).toEqual(['card.upserted']);

    // Already cancelled: 409; the claim takes only `ready` tickets.
    const again = await send('POST', API_PATHS.ticketCancel(t.id), {});
    expect(again.status).toBe(409);
    expect((again.body.error as { code: string }).code).toBe('conflict');
  });

  it('404 for a malformed id, an unknown one and another account’s ticket', async () => {
    expect((await send('POST', API_PATHS.ticketCancel('nope'), {})).status).toBe(404);
    expect((await send('POST', API_PATHS.ticketCancel(crypto.randomUUID()), {})).status).toBe(404);
    const other = await createUser(db.pool, { password: 'correct horse battery staple' });
    const r = await db.pool.query<{ id: string }>(
      "INSERT INTO ticket (repo, title, workflow_id, account_id) VALUES ('a/b', 'x', 'cancel_wf', $1) " +
        'RETURNING id',
      [other.accountId],
    );
    expect((await send('POST', API_PATHS.ticketCancel(r.rows[0]!.id), {})).status).toBe(404);
    const row = await db.pool.query<{ status: string }>('SELECT status FROM ticket WHERE id = $1', [
      r.rows[0]!.id,
    ]);
    expect(row.rows[0]!.status).toBe('ready');
  });

  it('a ticket with a session is cancelled through the engine (operator.cancel)', async () => {
    const t = await createTicket();
    const s = await db.pool.query<{ id: string }>(
      'INSERT INTO session (ticket_id, workflow_id, workflow_version, workflow_state, status) ' +
        "VALUES ($1, 'cancel_wf', 1, 'implement', 'running') RETURNING id",
      [t.id],
    );
    const sid = s.rows[0]!.id;
    // No snapshot seeded: the fake engine rejects it as unknown → the route's 404.
    const calls = engine.calls.length;
    const res = await send('POST', API_PATHS.ticketCancel(t.id), { reason: 'stop' });
    expect(engine.calls.slice(calls)).toEqual([
      { sessionId: sid, event: { type: 'operator.cancel', reason: 'stop' }, opts: { actor: 'ui' } },
    ]);
    expect(res.status).toBe(404);
    // The ticket row itself was not touched here.
    expect((await getTicket(t.id)).status).toBe('ready');
  });
});

describe('POST /api/tickets/:id/reopen', () => {
  it('puts a cancelled queued ticket back in the queue; 409 for one that is not cancelled', async () => {
    const t = await createTicket();
    expect((await send('POST', API_PATHS.ticketReopen(t.id), {})).status).toBe(409);
    expect((await send('POST', API_PATHS.ticketCancel(t.id), {})).status).toBe(202);
    const res = await send('POST', API_PATHS.ticketReopen(t.id), {});
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const d = await getTicket(t.id);
    expect(d).toMatchObject({ status: 'ready', column: 'queued', session_id: null });
    expect((await boardCard(t.id))?.badges).not.toContain('cancelled');
    const ev = await db.pool.query(
      "SELECT 1 FROM event WHERE type = 'operator.reopen' AND session_id IS NULL AND payload->>'ticket_id' = $1",
      [t.id],
    );
    expect(ev.rowCount).toBe(1);
  });

  it('a cancelled ticket with a session is reopened as a new session', async () => {
    const t = await createTicket();
    await db.pool.query("UPDATE ticket SET status = 'cancelled' WHERE id = $1", [t.id]);
    await db.pool.query(
      'INSERT INTO session (ticket_id, workflow_id, workflow_version, workflow_state, status) ' +
        "VALUES ($1, 'cancel_wf', 1, 'implement', 'failed')",
      [t.id],
    );
    const res = await send('POST', API_PATHS.ticketReopen(t.id), {});
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const d = await getTicket(t.id);
    expect(d.status).toBe('ready');
    const sessions = await db.pool.query('SELECT 1 FROM session WHERE ticket_id = $1', [t.id]);
    expect(sessions.rowCount).toBe(2);
  });
});
