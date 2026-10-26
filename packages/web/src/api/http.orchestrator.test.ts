import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import {
  createApi,
  FakeEngineService,
  InMemoryBoardBus,
  InMemoryOutputBus,
} from '@conductor/orchestrator';
import { SNAPSHOT_FIXTURE, type BoardSseEvent, type SessionSnapshot } from '@conductor/shared';
import { EventSource } from 'eventsource';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Aliased: the react-hooks lint (on for web) reads a use* call as a hook; this is vitest wiring.
import { useTestDatabase as testDatabase } from '../../../orchestrator/test/db.js';
import { ApiRequestError, type ApiClient, type Unsubscribe } from './client.js';
import { createHttpApi } from './http.js';

// The HTTP client against the real orchestrator API (createApi): Fastify on an ephemeral
// port, a per-run Postgres (orchestrator/test/db.ts), FakeEngineService for the engine routes,
// in-memory buses, and the `eventsource` package as the EventSource. This pins the
// client <-> createApi seam: routes, DTO shapes, ApiError envelopes and SSE framing/resume.
// Needs `pnpm db:up`.

const db = testDatabase();
const workflowsDir = resolve(import.meta.dirname, '../../../../docs/design/workflows');
const m1Basic = JSON.parse(
  readFileSync(resolve(workflowsDir, 'm1_basic.v1.json'), 'utf8'),
) as unknown;

type Api = ReturnType<typeof createApi>;
let api: Api;
let base: string;
let engine: FakeEngineService;
let client: ApiClient;
const urls: string[] = [];
const stops: Unsubscribe[] = [];

beforeAll(async () => {
  engine = new FakeEngineService();
  api = createApi({
    db: db.pool,
    engine,
    boardBus: new InMemoryBoardBus(),
    outputBus: new InMemoryOutputBus(),
  });
  await api.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const res = await fetch(`${base}/api/workflows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ definition: m1Basic }),
  });
  expect(res.status).toBe(201);
  client = createHttpApi({
    baseUrl: base,
    eventSource: (url) => {
      urls.push(url);
      return new EventSource(url);
    },
    // Long enough that a ticket created right after a drop is written while disconnected.
    backoff: { initialMs: 300, maxMs: 300 },
  });
});

afterAll(async () => {
  for (const stop of stops) stop();
  await api.close();
});

async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const newTicket = (title: string) =>
  client.createTicket({
    title,
    body: 'b',
    repo: 'acme/app',
    workflow_id: 'm1_basic',
    kind: 'work',
  });

const cardFor = (events: BoardSseEvent[], ticketId: string) =>
  events.find((e) => e.type === 'card.upserted' && e.card.ticket_id === ticketId);

/** Ticket + needs_input session + open input_request, written directly; snapshot seeded. */
async function seedNeedsInput() {
  const ticket = await newTicket('seeded needs_input');
  const s = await db.pool.query<{ id: string }>(
    'INSERT INTO session (ticket_id, workflow_id, workflow_version, workflow_state, status, ' +
      "branch) VALUES ($1, 'm1_basic', 1, 'implement', 'needs_input', 'conductor/x') RETURNING id",
    [ticket.id],
  );
  const sessionId = s.rows[0]!.id;
  const ir = await db.pool.query<{ id: string }>(
    "INSERT INTO input_request (session_id, kind, question) VALUES ($1, 'agent_question', " +
      "'Which DB?') RETURNING id",
    [sessionId],
  );
  const snap: SessionSnapshot = { ...SNAPSHOT_FIXTURE, id: sessionId, fencing_token: 1 };
  engine.seed(snap);
  return { sessionId, inputId: ir.rows[0]!.id };
}

describe('createHttpApi against the real orchestrator API', () => {
  it('board: createTicket -> card.upserted on the stream; resumes across a dropped connection', async () => {
    const board = await client.getBoard();
    const got: BoardSseEvent[] = [];
    let opens = 0;
    let errors = 0;
    urls.length = 0;
    stops.push(
      client.streamBoard(board.last_event_id, {
        onEvent: (e) => got.push(e),
        onOpen: () => (opens += 1),
        onError: () => (errors += 1),
      }),
    );
    await until(() => opens === 1);

    // (a) A ticket created through the client arrives on the board stream.
    const first = await newTicket('online');
    await until(() => cardFor(got, first.id) !== undefined);
    const firstId = cardFor(got, first.id)!.id;

    // (b) Drop every connection (like a restart or a network blip), write while disconnected.
    api.server.closeAllConnections();
    await until(() => errors >= 1);
    const offline = await newTicket('offline');
    expect(opens).toBe(1); // still disconnected: the backoff has not elapsed
    await until(() => opens >= 2);
    await until(() => cardFor(got, offline.id) !== undefined);

    // The reconnect resumed from the last delivered id via ?last_event_id.
    expect(urls[0]).toContain(`last_event_id=${board.last_event_id}`);
    expect(urls[1]).toContain(`last_event_id=${firstId}`);
    const ids = got.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(cardFor(got, offline.id)!.id).toBeGreaterThan(firstId);
  });

  it('answer: resolves OkResponse, then 409 when answered again or not pending', async () => {
    const { sessionId, inputId } = await seedNeedsInput();
    const body = { input_request_id: inputId, answer: 'Postgres' };
    await expect(client.answer(sessionId, body)).resolves.toEqual({ ok: true });

    const again = client.answer(sessionId, body);
    await expect(again).rejects.toBeInstanceOf(ApiRequestError);
    await expect(again).rejects.toMatchObject({ status: 409, code: 'input_already_answered' });

    // The engine ignoring the answer (session no longer waiting) maps to input_not_pending.
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
    const stale = client.answer(sessionId, { ...body, answer: 'again' });
    await expect(stale).rejects.toBeInstanceOf(ApiRequestError);
    await expect(stale).rejects.toMatchObject({ status: 409, code: 'input_not_pending' });
  });

  it('getSession: parses the real SessionDetail; unknown id rejects with not_found', async () => {
    const { sessionId, inputId } = await seedNeedsInput();
    const detail = await client.getSession(sessionId);
    expect(detail.card.session_id).toBe(sessionId);
    expect(detail.pending_input?.id).toBe(inputId);

    const missing = client.getSession('00000000-0000-4000-8000-000000000000');
    await expect(missing).rejects.toBeInstanceOf(ApiRequestError);
    await expect(missing).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});
