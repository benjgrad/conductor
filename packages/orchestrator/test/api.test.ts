import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import {
  BOARD_SSE_EVENT_TYPES,
  BoardResponseSchema,
  BoardSseEventSchema,
  MachineDtoSchema,
  OutputChunkSchema,
  SNAPSHOT_FIXTURE,
  SessionDetailSchema,
  TicketDtoSchema,
  WorkflowDetailSchema,
  WorkflowSummarySchema,
  type BoardSseEvent,
  type SessionSnapshot,
} from '@conductor/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApi, UI_ACTOR } from '../src/api/index.js';
import {
  FakeEngineService,
  InMemoryBoardBus,
  InMemoryOutputBus,
  insertBoardEvents,
} from '../src/contracts.js';
import { withTransaction } from '../src/db/index.js';
import type { ApiHandle } from '../src/main.js';
import { useTestDatabase } from './db.js';
import { openSse, type SseClient } from './sse-client.js';

// M1-T08: REST + SSE against a real (per-run) database, FakeEngineService for engine routes.

const db = useTestDatabase();
const workflowsDir = resolve(import.meta.dirname, '../../../docs/design/workflows');
const m1Basic = JSON.parse(readFileSync(resolve(workflowsDir, 'm1_basic.v1.json'), 'utf8')) as {
  id: string;
  states: Record<string, unknown>;
};

let api: ApiHandle;
let base: string;
let engine: FakeEngineService;
let boardBus: InMemoryBoardBus;
let outputBus: InMemoryOutputBus;
const clients: SseClient[] = [];

beforeAll(async () => {
  engine = new FakeEngineService();
  boardBus = new InMemoryBoardBus();
  outputBus = new InMemoryOutputBus();
  api = createApi({ db: db.pool, engine, boardBus, outputBus });
  await api.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const res = await post('/api/workflows', { definition: m1Basic });
  expect(res.status).toBe(201);
});

afterAll(async () => {
  for (const c of clients) c.close();
  await api.close();
});

beforeEach(() => {
  engine.calls.length = 0;
});

async function post(path: string, body?: unknown) {
  // Every POST carries the JSON content-type (M1-T14); no body is an empty one.
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  const res = await fetch(base + path, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(path: string) {
  const res = await fetch(base + path);
  const body: unknown = await res.json();
  return { status: res.status, body };
}

async function sse(path: string, headers: Record<string, string> = {}) {
  const c = await openSse(base + path, headers);
  clients.push(c);
  return c;
}

async function createTicket(title: string, extra: Record<string, unknown> = {}) {
  const res = await post('/api/tickets', {
    title,
    body: 'b',
    repo: 'acme/app',
    workflow_id: 'm1_basic',
    kind: 'work',
    ...extra,
  });
  expect(res.status).toBe(201);
  return TicketDtoSchema.parse(res.body);
}

/** Ticket + session (status given) + optional open input request, written directly. */
async function seedSession(status: string, opts: { input?: boolean; machine?: string } = {}) {
  const ticket = await createTicket(`seeded ${status}`);
  const s = await db.pool.query<{ id: string }>(
    'INSERT INTO session (ticket_id, workflow_id, workflow_version, workflow_state, status, ' +
      'machine_id, branch) VALUES ($1, $2, 1, $3, $4, $5, $6) RETURNING id',
    [
      ticket.id,
      'm1_basic',
      status === 'needs_input' ? 'needs_input' : 'implement',
      status,
      opts.machine ?? null,
      'conductor/x',
    ],
  );
  const sessionId = s.rows[0]!.id;
  let inputId: string | null = null;
  if (opts.input) {
    const ir = await db.pool.query<{ id: string }>(
      "INSERT INTO input_request (session_id, kind, question) VALUES ($1, 'agent_question', " +
        "'Which DB?') RETURNING id",
      [sessionId],
    );
    inputId = ir.rows[0]!.id;
  }
  const snap: SessionSnapshot = {
    ...SNAPSHOT_FIXTURE,
    id: sessionId,
    fencing_token: 1,
  };
  engine.seed(snap);
  return { ticket, sessionId, inputId };
}

async function boardEventIds(after: number): Promise<number[]> {
  const res = await db.pool.query<{ id: string }>(
    'SELECT id FROM event WHERE id > $1 AND type = ANY($2) ORDER BY id',
    [after, BOARD_SSE_EVENT_TYPES],
  );
  return res.rows.map((r) => Number(r.id));
}

// ==================================================================== workflows

describe('workflows', () => {
  it('saves a new version on every POST (server-assigned) and lists the latest', async () => {
    const res = await post('/api/workflows', { definition: { ...m1Basic, version: 99 } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'm1_basic', version: 2 });

    // ADR-0010: the list is the one workflow; `?all=1` includes the older ones.
    const only = WorkflowSummarySchema.array().parse((await get('/api/workflows')).body);
    expect(only.every((r) => r.id === 'conductor')).toBe(true);
    const list = await get('/api/workflows?all=1');
    expect(list.status).toBe(200);
    const rows = WorkflowSummarySchema.array().parse(list.body);
    const basic = rows.find((r) => r.id === 'm1_basic')!;
    expect(basic.version).toBe(2);
    expect(basic.start).toBe('implement');
    expect(basic.state_count).toBe(Object.keys(m1Basic.states).length);

    const stored = await db.pool.query<{ definition: { version: number } }>(
      "SELECT definition FROM workflow_definition WHERE id = 'm1_basic' AND version = 2",
    );
    expect(stored.rows[0]!.definition.version).toBe(2);
  });

  it('rejects an invalid definition with 400 invalid_workflow and details', async () => {
    const res = await post('/api/workflows', { definition: { ...m1Basic, start: 'nowhere' } });
    expect(res.status).toBe(400);
    const err = res.body.error as { code: string; details: { path: string }[] };
    expect(err.code).toBe('invalid_workflow');
    expect(err.details.some((d) => d.path === 'start')).toBe(true);
  });

  it('rejects a body without a definition shape error as invalid_workflow', async () => {
    const res = await post('/api/workflows', { definition: { id: 'x' } });
    expect(res.status).toBe(400);
    expect((res.body.error as { code: string }).code).toBe('invalid_workflow');
  });

  it('assigns distinct versions to concurrent saves', async () => {
    const def = { ...m1Basic, id: 'concurrent_wf' };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => post('/api/workflows', { definition: def })),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(results.map((r) => r.body.version).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('GET /api/workflows/:id → the latest version, ?version=N → that one (ADR-0009)', async () => {
    const reviewed = JSON.parse(
      readFileSync(resolve(workflowsDir, 'm1_reviewed.v1.json'), 'utf8'),
    ) as typeof m1Basic;
    const v1 = await post('/api/workflows', { definition: { ...reviewed, id: 'detail_wf' } });
    const edited = structuredClone(reviewed) as Record<string, unknown> & typeof m1Basic;
    edited.id = 'detail_wf';
    (edited.states.needs_input as Record<string, unknown>).timeout = '1d';
    (edited.states.needs_input as Record<string, unknown>).on = { timeout: 'implement' };
    const v2 = await post('/api/workflows', { definition: edited });
    expect([v1.body.version, v2.body.version]).toEqual([1, 2]);

    const latest = await get('/api/workflows/detail_wf');
    expect(latest.status).toBe(200);
    const d = WorkflowDetailSchema.parse(latest.body);
    expect(d).toMatchObject({ id: 'detail_wf', version: 2, versions: [1, 2] });
    expect(d.definition.version).toBe(2);
    expect(d.definition.states.needs_input).toMatchObject({ timeout: '1d' });
    // The gate round-trips with its defaults applied.
    const done = (d.definition.states.implement as { on: Record<string, unknown> }).on.done;
    expect(done).toMatchObject({
      goto: 'build',
      requirements: { on_unmet: { goto: 'implement', retries: 2, else: 'needs_input' } },
    });
    expect(Date.parse(d.created_at)).not.toBeNaN();

    const first = WorkflowDetailSchema.parse(
      (await get('/api/workflows/detail_wf?version=1')).body,
    );
    expect(first).toMatchObject({ version: 1, versions: [1, 2] });
    expect(first.definition.states.needs_input).toEqual({ type: 'human' });
  });

  it('GET /api/workflows/:id: 404 for an unknown id or version, 400 for a bad version', async () => {
    for (const path of ['/api/workflows/nope', '/api/workflows/m1_basic?version=999']) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect((res.body as { error: { code: string } }).error.code).toBe('not_found');
    }
    for (const v of ['0', '-1', 'x', '1.5']) {
      const res = await get(`/api/workflows/m1_basic?version=${v}`);
      expect(res.status, v).toBe(400);
    }
  });

  it('reports gate errors with dotted paths into the transition (ADR-0009)', async () => {
    const reviewed = JSON.parse(
      readFileSync(resolve(workflowsDir, 'm1_reviewed.v1.json'), 'utf8'),
    ) as { states: { implement: { on: { done: { requirements: Record<string, unknown> } } } } };
    const gate = reviewed.states.implement.on.done.requirements;
    gate.on_unmet = { goto: 'implement', else: 'done', retries: 2 };
    const res = await post('/api/workflows', { definition: reviewed });
    expect(res.status).toBe(400);
    const err = res.body.error as { details: { path: string; message: string }[] };
    expect(err.details.map((d) => d.path)).toEqual([
      'states.implement.on.done.requirements.on_unmet.else',
    ]);
    expect(err.details[0]!.message).toContain('must be a human state');
  });
});

// ==================================================================== tickets + board

describe('tickets and board', () => {
  it('ADR-0010: workflow_id defaults to conductor (seeded if missing)', async () => {
    const res = await post('/api/tickets', {
      title: 'One workflow',
      body: '',
      repo: 'acme/app',
      kind: 'personal',
    });
    expect(res.status).toBe(201);
    expect(TicketDtoSchema.parse(res.body).workflow_id).toBe('conductor');
    const wf = await get('/api/workflows/conductor');
    expect(wf.status).toBe(200);
    // M1b-T09: a bare database gets v1 then v2; v2 is the shipped default, so none is pending.
    const detail = WorkflowDetailSchema.parse(wf.body);
    expect(detail.version).toBe(2);
    expect(detail.versions).toEqual([1, 2]);
    expect(detail.default_available).toBeNull();
  });

  it('M1b-T09: default_available is 2 once the shipped v2 is gone (only edited versions)', async () => {
    // A database where the user's edit took version 2 before the shipped v2 was seeded.
    const v1 = (await get('/api/workflows/conductor?version=1')).body as {
      definition: Record<string, unknown>;
    };
    await db.pool.query("DELETE FROM workflow_definition WHERE id = 'conductor' AND version = 2");
    const edited = { ...v1.definition, budget: { usd: 9, minutes: 120, max_loop_retries: 3 } };
    expect((await post('/api/workflows', { definition: edited })).status).toBe(201);
    const detail = WorkflowDetailSchema.parse((await get('/api/workflows/conductor')).body);
    expect(detail.version).toBe(2);
    expect(detail.definition.budget?.usd).toBe(9);
    expect(detail.default_available).toBe(2);
    // Another id never has one.
    const basic = WorkflowDetailSchema.parse((await get('/api/workflows/m1_basic')).body);
    expect(basic.default_available).toBeNull();
  });

  it('creates a ticket with a card.upserted board event in the same transaction', async () => {
    const before = boardBus.published.length;
    const ticket = await createTicket('Add login', { priority: 3, required_tags: ['mac'] });
    expect(ticket.status).toBe('ready');
    expect(ticket.priority).toBe(3);
    expect(ticket.required_tags).toEqual(['mac']);

    const rows = await db.pool.query<{ id: string; type: string; session_id: string | null }>(
      "SELECT id, type, session_id FROM event WHERE payload->>'ticket_id' = $1",
      [ticket.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.type).toBe('card.upserted');
    expect(rows.rows[0]!.session_id).toBeNull();

    const published = boardBus.published.slice(before);
    expect(published).toHaveLength(1);
    const ev = published[0]!;
    expect(ev.type).toBe('card.upserted');
    expect(ev.id).toBe(Number(rows.rows[0]!.id));
    if (ev.type === 'card.upserted') {
      expect(ev.card.ticket_id).toBe(ticket.id);
      expect(ev.card.column).toBe('queued');
    }
  });

  it('ADR-0011: stores kind, returns it and puts it on the card; 400 without it', async () => {
    const before = boardBus.published.length;
    const ticket = await createTicket('Personal errand', { kind: 'personal' });
    expect(ticket.kind).toBe('personal');
    const row = await db.pool.query<{ kind: string | null }>(
      'SELECT kind FROM ticket WHERE id = $1',
      [ticket.id],
    );
    expect(row.rows[0]!.kind).toBe('personal');
    const ev = boardBus.published.slice(before)[0]!;
    expect(ev.type === 'card.upserted' && ev.card.kind).toBe('personal');
    const board = BoardResponseSchema.parse((await get('/api/board')).body);
    const card = board.columns.flatMap((c) => c.cards).find((c) => c.ticket_id === ticket.id)!;
    expect(card.kind).toBe('personal');

    const missing = await post('/api/tickets', {
      title: 't',
      body: '',
      repo: 'r',
      workflow_id: 'm1_basic',
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({
      code: 'bad_request',
      details: [expect.objectContaining({ path: 'kind' })],
    });
    const wrong = await post('/api/tickets', {
      title: 't',
      body: '',
      repo: 'r',
      workflow_id: 'm1_basic',
      kind: 'home',
    });
    expect(wrong.status).toBe(400);
  });

  it('400s on an unknown workflow and on a bad body', async () => {
    const res = await post('/api/tickets', {
      title: 't',
      body: '',
      repo: 'r',
      workflow_id: 'missing',
      kind: 'work',
    });
    expect(res.status).toBe(400);
    expect((res.body.error as { code: string }).code).toBe('bad_request');

    const bad = await post('/api/tickets', { title: '' });
    expect(bad.status).toBe(400);
    const err = bad.body.error as { code: string; details: unknown[] };
    expect(err.code).toBe('bad_request');
    expect(err.details.length).toBeGreaterThan(0);

    const notJson = await fetch(base + '/api/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(notJson.status).toBe(400);
  });

  it('GET /api/board groups cards by column with last_event_id', async () => {
    const low = await createTicket('low', { priority: 0 });
    const high = await createTicket('high', { priority: 5 });
    const running = await seedSession('running');
    const waiting = await seedSession('needs_input', { input: true });
    const failed = await seedSession('lost');

    const res = await get('/api/board');
    expect(res.status).toBe(200);
    const board = BoardResponseSchema.parse(res.body);

    // ADR-0010: an ordered list, Queued first, then the conductor states.
    expect(board.columns.map((c) => c.id)).toEqual([
      'queued',
      'planning',
      'implementing',
      'needs_input',
      'waiting_external',
      'done',
    ]);
    const col = (id: string) => board.columns.find((c) => c.id === id)!.cards;
    const queuedIds = col('queued').map((c) => c.ticket_id);
    expect(queuedIds.indexOf(high.id)).toBeLessThan(queuedIds.indexOf(low.id));
    // m1_basic's `implement` (agent) maps to Implementing by state type.
    expect(col('implementing').map((c) => c.session_id)).toContain(running.sessionId);
    const ni = col('needs_input').find((c) => c.session_id === waiting.sessionId)!;
    expect(ni.input_request?.id).toBe(waiting.inputId);
    const lost = col('done').find((c) => c.session_id === failed.sessionId)!;
    expect(lost.badges).toContain('lost');
    // Seeded tickets moved out of queued (their card follows the session).
    expect(queuedIds).not.toContain(running.ticket.id);

    const ids = await boardEventIds(0);
    expect(board.last_event_id).toBe(ids[ids.length - 1]);
  });
});

// ==================================================================== sessions

describe('session detail', () => {
  it('returns the detail including the OutputBus ring', async () => {
    const { sessionId, inputId } = await seedSession('needs_input', { input: true });
    outputBus.append(sessionId, 'stdout', 'hello ');
    outputBus.append(sessionId, 'stderr', 'world');

    const res = await get(`/api/sessions/${sessionId}`);
    expect(res.status).toBe(200);
    const detail = SessionDetailSchema.parse(res.body);
    expect(detail.card.session_id).toBe(sessionId);
    expect(detail.card.column).toBe('needs_input');
    expect(detail.workflow.id).toBe('m1_basic');
    expect(detail.workflow_version).toBe(1);
    expect(detail.budget).toEqual({ usd: 2, minutes: 60 });
    expect(detail.pending_input?.id).toBe(inputId);
    expect(detail.recent_output.map((c) => c.text)).toEqual(['hello ', 'world']);
    expect(detail.branch).toBe('conductor/x');
  });

  it('UX-2: ticket_body is the ticket body', async () => {
    const { sessionId, ticket } = await seedSession('running');
    const body = '## Goal\nShip it.\n\n## Functional requirements\n- FR-1 Works';
    await db.pool.query('UPDATE ticket SET body = $2 WHERE id = $1', [ticket.id, body]);

    const detail = SessionDetailSchema.parse((await get(`/api/sessions/${sessionId}`)).body);
    expect(detail.ticket_body).toBe(body);
  });

  it('hides a request a cancel left unanswered from the card and pending_input (TD-079)', async () => {
    const { sessionId } = await seedSession('failed', { input: true });

    const detail = SessionDetailSchema.parse((await get(`/api/sessions/${sessionId}`)).body);
    expect(detail.card.column).toBe('done');
    expect(detail.card.badges).toContain('failed');
    expect(detail.card.input_request).toBeNull();
    expect(detail.pending_input).toBeNull();

    const board = BoardResponseSchema.parse((await get('/api/board')).body);
    const card = board.columns
      .find((c) => c.id === 'done')!
      .cards.find((c) => c.session_id === sessionId)!;
    expect(card.input_request).toBeNull();
  });

  it('ADR-0011: moves = the state.entered rows, oldest first, the last 50', async () => {
    const { sessionId } = await seedSession('waiting_external');
    const other = await seedSession('running');
    const enter = (sid: string, payload: Record<string, unknown>, type = 'state.entered') =>
      db.pool.query('INSERT INTO event (session_id, type, payload) VALUES ($1, $2, $3)', [
        sid,
        type,
        payload,
      ]);
    // 52 moves: two that fall off the limit, a pre-M1b row (no transition fields), 49 newer;
    // another event type and another session's move don't count.
    await enter(sessionId, { from: null, to: 'dropped', visit: 1 });
    await enter(sessionId, { from: 'dropped', to: 'dropped', visit: 2 });
    await enter(sessionId, { from: null, to: 'implement', visit: 1 });
    for (let i = 0; i < 48; i++) {
      await enter(sessionId, {
        from: 'implement',
        to: 'implement',
        visit: i + 2,
        transition: 'retry',
        reason: `try ${i}`,
        actor: 'agent',
      });
    }
    await enter(sessionId, {
      from: 'implement',
      to: 'waiting_external',
      visit: 1,
      transition: 'waiting_on_someone',
      reason: 'Dana reviews',
      actor: 'human',
    });
    await enter(sessionId, { session_id: sessionId }, 'session.status');
    await enter(other.sessionId, { from: null, to: 'implement', visit: 1 });

    const detail = SessionDetailSchema.parse((await get(`/api/sessions/${sessionId}`)).body);
    const moves = detail.moves!;
    expect(moves).toHaveLength(50);
    expect(moves[0]).toMatchObject({
      from: null,
      to: 'implement',
      transition: null,
      reason: null,
      actor: null,
    });
    expect(moves[1]).toMatchObject({ transition: 'retry', reason: 'try 0', actor: 'agent' });
    expect(moves.at(-1)).toMatchObject({
      from: 'implement',
      to: 'waiting_external',
      transition: 'waiting_on_someone',
      reason: 'Dana reviews',
      actor: 'human',
    });
    const at = moves.map((m) => Date.parse(m.at));
    expect(at).toEqual([...at].sort((a, b) => a - b));

    const none = SessionDetailSchema.parse((await get(`/api/sessions/${other.sessionId}`)).body);
    expect(none.moves).toHaveLength(1);
  });

  it('404s for an unknown or malformed id', async () => {
    const unknown = await get('/api/sessions/00000000-0000-4000-8000-000000000000');
    expect(unknown.status).toBe(404);
    expect((unknown.body as { error: { code: string } }).error.code).toBe('not_found');
    const malformed = await get('/api/sessions/not-a-uuid');
    expect(malformed.status).toBe(404);
  });
});

describe('engine routes', () => {
  it('POST /input → input.provided with the UI actor; 409 when already answered', async () => {
    const { sessionId, inputId } = await seedSession('needs_input', { input: true });
    const body = { input_request_id: inputId, answer: 'Postgres', goto: 'build' };
    const res = await post(`/api/sessions/${sessionId}/input`, body);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    expect(engine.calls).toEqual([
      {
        sessionId,
        event: {
          type: 'input.provided',
          input_request_id: inputId,
          answer: 'Postgres',
          goto: 'build',
        },
        opts: { actor: UI_ACTOR },
      },
    ]);

    const again = await post(`/api/sessions/${sessionId}/input`, body);
    expect(again.status).toBe(409);
    expect((again.body.error as { code: string }).code).toBe('input_already_answered');
  });

  it('POST /input maps ignored to 409 input_not_pending and validates the body', async () => {
    const { sessionId, inputId } = await seedSession('running');
    engine.respondWith(({ sessionId: sid, event }) =>
      sid === sessionId && event.type === 'input.provided'
        ? {
            status: 'ignored',
            eventId: engine.nextEventId(),
            reason: 'not_awaited',
            snapshot: engine.snapshot(sid)!,
          }
        : undefined,
    );
    const res = await post(`/api/sessions/${sessionId}/input`, {
      input_request_id: inputId ?? '00000000-0000-4000-8000-000000000001',
      answer: 'x',
    });
    expect(res.status).toBe(409);
    expect((res.body.error as { code: string }).code).toBe('input_not_pending');

    const bad = await post(`/api/sessions/${sessionId}/input`, { answer: '' });
    expect(bad.status).toBe(400);
    expect((bad.body.error as { code: string }).code).toBe('bad_request');
  });

  it('maps unknown_session to 404', async () => {
    const res = await post('/api/sessions/00000000-0000-4000-8000-000000000002/cancel');
    expect(res.status).toBe(404);
    expect((res.body.error as { code: string }).code).toBe('not_found');
  });

  it('POST /approve → external.event ui.approve (data only with a comment)', async () => {
    const { sessionId } = await seedSession('waiting_external');
    expect((await post(`/api/sessions/${sessionId}/approve`, { comment: 'lgtm' })).status).toBe(
      202,
    );
    expect((await post(`/api/sessions/${sessionId}/approve`)).status).toBe(202);
    expect(engine.calls.map((c) => c.event)).toEqual([
      { type: 'external.event', name: 'ui.approve', data: { comment: 'lgtm' } },
      { type: 'external.event', name: 'ui.approve' },
    ]);

    engine.respondWith(({ sessionId: sid, event }) =>
      sid === sessionId && event.type === 'external.event'
        ? {
            status: 'ignored',
            eventId: engine.nextEventId(),
            reason: 'not_awaited',
            snapshot: engine.snapshot(sid)!,
          }
        : undefined,
    );
    const ignored = await post(`/api/sessions/${sessionId}/approve`, {});
    expect(ignored.status).toBe(409);
    expect((ignored.body.error as { code: string }).code).toBe('conflict');
  });

  it('POST /cancel → operator.cancel, with or without a reason', async () => {
    const { sessionId } = await seedSession('running');
    expect((await post(`/api/sessions/${sessionId}/cancel`)).status).toBe(202);
    expect((await post(`/api/sessions/${sessionId}/cancel`, { reason: 'stop' })).status).toBe(202);
    expect(engine.calls.map((c) => c.event)).toEqual([
      { type: 'operator.cancel' },
      { type: 'operator.cancel', reason: 'stop' },
    ]);
  });
  it('POST /messages → operator.message (202) and a `user` chunk after the apply (ADR-0007)', async () => {
    const { sessionId } = await seedSession('running');
    const seen: string[] = [];
    const appliedFirst: boolean[] = [];
    const unsubscribe = outputBus.subscribe(sessionId, (c) => {
      // The chunk is appended only once the engine call has returned (committed).
      appliedFirst.push(engine.calls.some((call) => call.sessionId === sessionId));
      seen.push(`${c.stream}:${c.text}`);
    });
    const res = await post(`/api/sessions/${sessionId}/messages`, { text: '  /context  ' });
    unsubscribe();
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    // Trimmed by SendMessageRequestSchema; slash commands pass through untouched.
    expect(engine.calls).toEqual([
      { sessionId, event: { type: 'operator.message', text: '/context' }, opts: {} },
    ]);
    expect(seen).toEqual(['user:/context']);
    expect(appliedFirst).toEqual([true]);
    expect(outputBus.snapshot(sessionId).map((c) => c.stream)).toEqual(['user']);
  });

  it('POST /messages: 409 conflict when ignored (not running / needs_input), no chunk', async () => {
    for (const status of ['needs_input', 'queued'] as const) {
      const { sessionId } = await seedSession(status, { input: status === 'needs_input' });
      engine.respondWith(({ sessionId: sid, event }) =>
        sid === sessionId && event.type === 'operator.message'
          ? {
              status: 'ignored',
              eventId: engine.nextEventId(),
              reason: 'wrong_status',
              snapshot: engine.snapshot(sid)!,
            }
          : undefined,
      );
      const res = await post(`/api/sessions/${sessionId}/messages`, { text: 'hello' });
      expect(res.status).toBe(409);
      expect((res.body.error as { code: string }).code).toBe('conflict');
      expect(outputBus.snapshot(sessionId)).toEqual([]);
    }
  });

  it('POST /messages: 404 unknown session, 400 on an empty or missing text', async () => {
    const unknown = await post('/api/sessions/00000000-0000-4000-8000-000000000003/messages', {
      text: 'hi',
    });
    expect(unknown.status).toBe(404);
    expect((unknown.body.error as { code: string }).code).toBe('not_found');
    expect((await post('/api/sessions/not-a-uuid/messages', { text: 'hi' })).status).toBe(404);

    const { sessionId } = await seedSession('running');
    engine.calls.length = 0;
    for (const body of [
      { text: '' },
      { text: '   ' },
      {},
      undefined,
      { text: 'x'.repeat(20_001) },
    ]) {
      const res = await post(`/api/sessions/${sessionId}/messages`, body);
      expect(res.status).toBe(400);
      expect((res.body.error as { code: string }).code).toBe('bad_request');
    }
    expect(engine.calls).toEqual([]);
  });
});

// ==================================================================== machines

describe('machines', () => {
  it('lists machines with their running session count', async () => {
    await db.pool.query(
      'INSERT INTO machine (id, hostname, os, arch, tags, status, cpu_total, mem_total_mb, ' +
        'disk_free_mb, budget_cpu, budget_mem_mb, max_sessions, max_concurrent_builds, cpu_free, ' +
        "mem_free_mb, last_heartbeat_at) VALUES ('m1', 'box', 'darwin', 'arm64', '{mac}', " +
        "'online', 10, 32000, 100000, 8, 24000, 3, 1, 6, 12000, now())",
    );
    await seedSession('running', { machine: 'm1' });
    await seedSession('done', { machine: 'm1' });
    const res = await get('/api/machines');
    expect(res.status).toBe(200);
    const machines = MachineDtoSchema.array().parse(res.body);
    expect(machines).toHaveLength(1);
    expect(machines[0]).toMatchObject({
      id: 'm1',
      hostname: 'box',
      status: 'online',
      tags: ['mac'],
      max_sessions: 3,
      running_sessions: 1,
      cpu_free: 6,
      mem_free_mb: 12000,
    });
  });
});

// ==================================================================== SSE

const boardEvents = (c: SseClient): BoardSseEvent[] =>
  c.frames.map((f) => {
    const ev = BoardSseEventSchema.parse(f.data);
    expect(f.id).toBe(ev.id);
    expect(f.event).toBe(ev.type);
    return ev;
  });

describe('board stream', () => {
  it('sends SSE headers and live events when connected without Last-Event-ID', async () => {
    const c = await sse('/api/stream/board');
    expect(c.status).toBe(200);
    expect(c.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const ticket = await createTicket('live one');
    await c.waitFor(1);
    const [ev] = boardEvents(c);
    expect(ev?.type).toBe('card.upserted');
    expect(ev?.type === 'card.upserted' && ev.ticket_id).toBe(ticket.id);
    c.close();
  });

  it('replays from Last-Event-ID (header or query) without gaps or duplicates', async () => {
    const start = (await boardEventIds(0)).at(-1) ?? 0;
    for (let i = 0; i < 3; i++) await createTicket(`before ${i}`);

    const viaHeader = await sse('/api/stream/board', { 'last-event-id': String(start) });
    const viaQuery = await sse(`/api/stream/board?last_event_id=${start}`);
    await viaHeader.waitFor(3);
    await viaQuery.waitFor(3);
    const expected = await boardEventIds(start);
    expect(boardEvents(viaHeader).map((e) => e.id)).toEqual(expected);
    expect(boardEvents(viaQuery).map((e) => e.id)).toEqual(expected);
    viaHeader.close();
    viaQuery.close();
  });

  it('reconnect proves no missed events while writes race the replay', async () => {
    const start = (await boardEventIds(0)).at(-1) ?? 0;

    // First connection sees some events, then drops.
    const first = await sse('/api/stream/board', { 'last-event-id': String(start) });
    for (let i = 0; i < 5; i++) await createTicket(`round1 ${i}`);
    await first.waitFor(5);
    const seen = boardEvents(first);
    first.close();
    const lastSeen = seen.at(-1)!.id;

    // Written while disconnected, including non-board audit rows and rows from another writer
    // (insertBoardEvents directly, like the engine wrapper) that are never published on the bus.
    for (let i = 0; i < 5; i++) await createTicket(`offline ${i}`);
    await db.pool.query("INSERT INTO event (type, payload) VALUES ('state.entered', '{}')");
    const { sessionId, ticket } = await seedSession('running');
    await withTransaction(db.pool, (tx) =>
      insertBoardEvents(tx, [
        {
          type: 'session.status',
          session_id: sessionId,
          from: 'assigned',
          to: 'running',
          workflow_state: 'implement',
        },
        {
          type: 'card.moved',
          session_id: sessionId,
          ticket_id: ticket.id,
          from: 'queued',
          to: 'running',
        },
      ]),
    );

    // Reconnect with Last-Event-ID while concurrent writers keep going.
    const second = await sse('/api/stream/board', { 'last-event-id': String(lastSeen) });
    const racing = Promise.all(Array.from({ length: 20 }, (_, i) => createTicket(`racing ${i}`)));
    await racing;
    const expected = await boardEventIds(lastSeen);
    await second.waitFor(expected.length);
    const got = boardEvents(second).map((e) => e.id);
    expect(got).toEqual(expected);
    expect(new Set(got).size).toBe(got.length);

    // Together the two connections cover every board event since `start`, exactly once.
    const all = [...seen.map((e) => e.id), ...got];
    expect(all).toEqual(await boardEventIds(start));
    second.close();
  });

  it('skips a bus event already covered by the replay', async () => {
    const before = (await boardEventIds(0)).at(-1) ?? 0;
    await createTicket('covered');
    const c = await sse('/api/stream/board', { 'last-event-id': String(before) });
    await c.waitFor(1);
    // Re-publishing the same event (a duplicate publish) must not produce a second frame.
    boardBus.publish(boardBus.published.at(-1)!);
    await createTicket('next');
    await c.waitFor(2);
    await new Promise((r) => setTimeout(r, 50));
    const ids = boardEvents(c).map((e) => e.id);
    expect(ids).toEqual(await boardEventIds(before));
    c.close();
  });
});

describe('session output stream', () => {
  it('replays the ring, then streams live chunks', async () => {
    const { sessionId } = await seedSession('running');
    outputBus.append(sessionId, 'stdout', 'one');
    outputBus.append(sessionId, 'stdout', 'two');
    outputBus.append('00000000-0000-4000-8000-00000000000f', 'stdout', 'other session');
    const c = await sse(`/api/stream/sessions/${sessionId}/output`);
    expect(c.status).toBe(200);
    await c.waitFor(2);
    outputBus.append(sessionId, 'stderr', 'three');
    await c.waitFor(3);
    const chunks = c.frames.map((f) => {
      expect(f.event).toBe('output');
      expect(f.id).toBeUndefined();
      return OutputChunkSchema.parse(f.data);
    });
    expect(chunks.map((ch) => [ch.seq, ch.stream, ch.text])).toEqual([
      [0, 'stdout', 'one'],
      [1, 'stdout', 'two'],
      [2, 'stderr', 'three'],
    ]);
    c.close();
  });

  it('404s for an unknown session', async () => {
    const res = await fetch(
      `${base}/api/stream/sessions/00000000-0000-4000-8000-000000000003/output`,
    );
    expect(res.status).toBe(404);
  });
});

describe('lifecycle', () => {
  it('close() ends open SSE connections instead of hanging', async () => {
    const other = createApi({ db: db.pool, engine, boardBus, outputBus });
    await other.listen(0, '127.0.0.1');
    const url = `http://127.0.0.1:${(other.server.address() as AddressInfo).port}`;
    const c = await openSse(`${url}/api/stream/board`);
    expect(c.status).toBe(200);
    const listeners = (boardBus as unknown as { listeners: Set<unknown> }).listeners.size;
    await other.close();
    expect((boardBus as unknown as { listeners: Set<unknown> }).listeners.size).toBe(listeners - 1);
    c.close();
  });

  it('returns ApiError 404 for unknown routes', async () => {
    const res = await get('/api/nope');
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('not_found');
  });
});
