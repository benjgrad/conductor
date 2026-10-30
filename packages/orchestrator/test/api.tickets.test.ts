// GET / PATCH /api/tickets/:id: read a ticket in any column (a queued one has no session), edit
// it where the card's column allows it (`ticket_editable`, `queued_ticket_editable`).
import type { AddressInfo } from 'node:net';
import {
  API_PATHS,
  SessionDetailSchema,
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
let api: ApiHandle;
let base: string;

/** v1: the defaults (Queued and human editable, the agent column not); v2 opens the agent one. */
const wf = (agentEditable?: boolean): WorkflowDefinitionInput => ({
  id: 'edit_wf',
  version: 1,
  start: 'implement',
  budget: { usd: 1, minutes: 10, max_loop_retries: 1 },
  states: {
    implement: {
      type: 'agent',
      prompt: 'ticket_template',
      on: { done: 'done', ask_user: 'needs_input' },
      ...(agentEditable === undefined ? {} : { ticket_editable: agentEditable }),
    },
    needs_input: { type: 'human', on: { 'input.provided': 'implement' } },
    done: { type: 'terminal' },
  },
});

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
    boardBus: new InMemoryBoardBus(),
    outputBus: new InMemoryOutputBus(),
  });
  await api.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  for (const definition of [wf(), wf(true)]) {
    const res = await send('POST', API_PATHS.workflows, { definition });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
});

afterAll(async () => {
  await api.close();
});

async function createTicket() {
  const res = await send('POST', API_PATHS.tickets, {
    title: 'Original',
    body: 'first body',
    repo: 'acme/app',
    workflow_id: 'edit_wf',
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

/** A session of the ticket in `state` of edit_wf `version`. */
async function seedSession(ticketId: string, state: string, status: string, version = 1) {
  const s = await db.pool.query<{ id: string }>(
    'INSERT INTO session (ticket_id, workflow_id, workflow_version, workflow_state, status) ' +
      "VALUES ($1, 'edit_wf', $2, $3, $4) RETURNING id",
    [ticketId, version, state, status],
  );
  return s.rows[0]!.id;
}

async function upsertsSince(id: string) {
  const r = await db.pool.query<{
    session_id: string | null;
    payload: { card: { title: string } };
  }>(
    "SELECT session_id, payload FROM event WHERE type = 'card.upserted' AND payload->>'ticket_id' = $1 " +
      'ORDER BY id',
    [id],
  );
  return r.rows;
}

describe('GET /api/tickets/:id', () => {
  it('a queued ticket: its body, no session, editable by default', async () => {
    const t = await createTicket();
    const d = await getTicket(t.id);
    expect(d).toMatchObject({
      id: t.id,
      body: 'first body',
      session_id: null,
      workflow_state: null,
      column: 'queued',
      column_title: 'Queued',
      editable: true,
    });
  });

  it('404 for an unknown id, a malformed one, and another account’s ticket', async () => {
    expect((await send('GET', API_PATHS.ticket(crypto.randomUUID()))).status).toBe(404);
    expect((await send('GET', API_PATHS.ticket('nope'))).status).toBe(404);
    const other = await createUser(db.pool, { password: 'correct horse battery staple' });
    const r = await db.pool.query<{ id: string }>(
      "INSERT INTO ticket (repo, title, workflow_id, account_id) VALUES ('a/b', 'x', 'edit_wf', $1) " +
        'RETURNING id',
      [other.accountId],
    );
    const res = await send('GET', API_PATHS.ticket(r.rows[0]!.id));
    expect(res.status).toBe(404);
    expect((res.body.error as { code: string }).code).toBe('not_found');
  });
});

describe('PATCH /api/tickets/:id', () => {
  it('edits a queued ticket and emits its card', async () => {
    const t = await createTicket();
    const before = await getTicket(t.id);
    const res = await send('PATCH', API_PATHS.ticket(t.id), {
      expected_updated_at: before.updated_at,
      title: 'Renamed',
      body: 'more detail',
      priority: 3,
    });
    expect(res.status).toBe(200);
    const after = TicketDetailSchema.parse(res.body);
    expect(after).toMatchObject({
      title: 'Renamed',
      body: 'more detail',
      priority: 3,
      kind: 'work',
    });
    expect(after.updated_at).not.toBe(before.updated_at);
    const ups = await upsertsSince(t.id);
    expect(ups.at(-1)).toMatchObject({ session_id: null, payload: { card: { title: 'Renamed' } } });
  });

  it('409 from a stale updated_at; 400 with nothing to change', async () => {
    const t = await createTicket();
    const before = await getTicket(t.id);
    const first = await send('PATCH', API_PATHS.ticket(t.id), {
      expected_updated_at: before.updated_at,
      title: 'One',
    });
    expect(first.status).toBe(200);
    const stale = await send('PATCH', API_PATHS.ticket(t.id), {
      expected_updated_at: before.updated_at,
      title: 'Two',
    });
    expect(stale.status).toBe(409);
    expect((stale.body.error as { code: string }).code).toBe('conflict');
    const empty = await send('PATCH', API_PATHS.ticket(t.id), {
      expected_updated_at: before.updated_at,
    });
    expect(empty.status).toBe(400);
  });

  it('403 ticket_not_editable in an agent column by default; 200 when the state allows it', async () => {
    const t = await createTicket();
    await seedSession(t.id, 'implement', 'running', 1);
    const d = await getTicket(t.id);
    expect(d).toMatchObject({ workflow_state: 'implement', editable: false });
    const res = await send('PATCH', API_PATHS.ticket(t.id), {
      expected_updated_at: d.updated_at,
      body: 'x',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'ticket_not_editable' });
    expect((await getTicket(t.id)).body).toBe('first body');

    const t2 = await createTicket();
    const sessionId = await seedSession(t2.id, 'implement', 'running', 2);
    const d2 = await getTicket(t2.id);
    expect(d2.editable).toBe(true);
    const ok = await send('PATCH', API_PATHS.ticket(t2.id), {
      expected_updated_at: d2.updated_at,
      body: 'new detail',
    });
    expect(ok.status).toBe(200);
    expect(TicketDetailSchema.parse(ok.body)).toMatchObject({
      body: 'new detail',
      session_id: sessionId,
    });
    expect((await upsertsSince(t2.id)).at(-1)?.session_id).toBe(sessionId);

    // The session's own detail carries the flag and the new body.
    const detail = SessionDetailSchema.parse(
      (await send('GET', `/api/sessions/${sessionId}`)).body,
    );
    expect(detail.ticket_editable).toBe(true);
    expect(detail.ticket_body).toBe('new detail');
  });

  it('a human column is editable by default', async () => {
    const t = await createTicket();
    const sessionId = await seedSession(t.id, 'needs_input', 'needs_input', 1);
    expect((await getTicket(t.id)).editable).toBe(true);
    const detail = SessionDetailSchema.parse(
      (await send('GET', `/api/sessions/${sessionId}`)).body,
    );
    expect(detail.ticket_editable).toBe(true);
  });
});
