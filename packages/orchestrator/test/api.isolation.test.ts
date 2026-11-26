// M2-T12 / M2-T21 (ADR-0012 §Tenancy, §Proving isolation): two accounts on one instance in
// `password` mode. Account B never sees or acts on account A's board, sessions, session streams
// or workflows: another account's id is "not found", like an unknown one. Also the account
// triggers (migration account-from-parent): a child row takes its parent's account. Needs the
// shared server: `pnpm db:up`.
import { API_PATHS, CONDUCTOR_WORKFLOW_ID, type BoardResponse } from '@conductor/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedAccount } from '../src/engine/seed.js';
import type { SseConnection } from '../src/stream/sse.js';
import { InMemoryBoardBus } from '../src/contracts.js';
import { serveBoardStream } from '../src/stream/board.js';
import {
  HTTPS_URL,
  cookieOf,
  createUser,
  passwordAuth,
  startApi,
  type TestApi,
} from './auth/helpers.js';
import { useTestDatabase } from './db.js';

const db = useTestDatabase();
const PASSWORD = 'correct horse battery staple';

let api: TestApi;

interface Who {
  cookie: string;
  accountId: string;
}

async function signIn(): Promise<Who> {
  const u = await createUser(db.pool, { password: PASSWORD });
  await seedAccount(db.pool, u.accountId);
  const res = await api.send('POST', API_PATHS.authLogin, {
    body: { email: u.email, password: PASSWORD },
  });
  expect(res.status).toBe(200);
  return { cookie: cookieOf(res), accountId: u.accountId };
}

const as = (who: Who, body?: unknown) => ({
  headers: { cookie: who.cookie },
  ...(body !== undefined ? { body } : {}),
});

/** A ticket of `who` (through the API) and a session on it (inserted: no machine claims it). */
async function ticketWithSession(who: Who): Promise<{ ticketId: string; sessionId: string }> {
  const res = await api.send(
    'POST',
    API_PATHS.tickets,
    as(who, { title: 'secret work', body: '', repo: 'github.com/acme/app', kind: 'work' }),
  );
  expect(res.status).toBe(201);
  const ticketId = res.json.id as string;
  const v = await db.pool.query<{ v: number }>(
    'SELECT max(version) AS v FROM workflow_definition WHERE account_id = $1 AND id = $2',
    [who.accountId, CONDUCTOR_WORKFLOW_ID],
  );
  const s = await db.pool.query<{ id: string }>(
    'INSERT INTO session (ticket_id, workflow_id, workflow_version, status, workflow_state) ' +
      "VALUES ($1, $2, $3, 'needs_input', 'planning') RETURNING id",
    [ticketId, CONDUCTOR_WORKFLOW_ID, v.rows[0]!.v],
  );
  return { ticketId, sessionId: s.rows[0]!.id };
}

const boardTickets = (board: BoardResponse) =>
  board.columns.flatMap((c) => c.cards).map((c) => c.ticket_id);

beforeEach(async () => {
  api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
});

afterEach(async () => {
  await api.close();
});

describe('account isolation (two accounts)', () => {
  it('the board shows only the caller’s tickets', async () => {
    const a = await signIn();
    const b = await signIn();
    const { ticketId } = await ticketWithSession(a);
    const boardA = await api.send('GET', API_PATHS.board, as(a));
    const boardB = await api.send('GET', API_PATHS.board, as(b));
    expect(boardA.status).toBe(200);
    expect(boardTickets(boardA.json as unknown as BoardResponse)).toContain(ticketId);
    expect(boardTickets(boardB.json as unknown as BoardResponse)).not.toContain(ticketId);
  });

  it('another account’s session is not found on every session route', async () => {
    const a = await signIn();
    const b = await signIn();
    const { sessionId, ticketId } = await ticketWithSession(a);
    expect((await api.send('GET', `/api/sessions/${sessionId}`, as(a))).status).toBe(200);

    const routes: [string, string, unknown?][] = [
      ['GET', `/api/sessions/${sessionId}`],
      ['GET', `/api/sessions/${sessionId}/transcript`],
      ['GET', `/api/stream/sessions/${sessionId}/output`],
      ['POST', `/api/sessions/${sessionId}/cancel`, {}],
      ['POST', `/api/sessions/${sessionId}/approve`, {}],
      ['POST', `/api/sessions/${sessionId}/messages`, { text: 'hi' }],
      ['POST', `/api/sessions/${sessionId}/reopen`, { text: 'again' }],
      [
        'POST',
        `/api/sessions/${sessionId}/input`,
        { input_request_id: '00000000-0000-4000-8000-0000000000aa', answer: 'yes' },
      ],
      ['POST', API_PATHS.sessionTransition(sessionId), { name: 'approve' }],
      ['POST', API_PATHS.sessionFreshConversation(sessionId), { text: 'start over' }],
      ['PUT', API_PATHS.sessionRequirements(sessionId), { items: ['x'] }],
      ['GET', API_PATHS.ticket(ticketId)],
    ];
    for (const [method, path, body] of routes) {
      const res = await api.send(method, path, as(b, body));
      expect([path, res.status]).toEqual([path, 404]);
    }
  });

  it('child rows take their ticket’s account, and a mismatched account is refused', async () => {
    const a = await signIn();
    const b = await signIn();
    const { sessionId, ticketId } = await ticketWithSession(a);
    const s = await db.pool.query<{ account_id: string }>(
      'SELECT account_id FROM session WHERE id = $1',
      [sessionId],
    );
    expect(s.rows[0]!.account_id).toBe(a.accountId);
    const ev = await db.pool.query<{ account_id: string }>(
      "INSERT INTO event (session_id, type, payload) VALUES ($1, 'x.test', '{}') RETURNING account_id",
      [sessionId],
    );
    expect(ev.rows[0]!.account_id).toBe(a.accountId);
    // The ticket's card.upserted on create (no session) follows the ticket.
    const created = await db.pool.query<{ account_id: string }>(
      "SELECT account_id FROM event WHERE session_id IS NULL AND payload->>'ticket_id' = $1",
      [ticketId],
    );
    expect(created.rows.map((r) => r.account_id)).toEqual(created.rows.map(() => a.accountId));
    await expect(
      db.pool.query(
        "INSERT INTO event (session_id, type, payload, account_id) VALUES ($1, 'x.test', '{}', $2)",
        [sessionId, b.accountId],
      ),
    ).rejects.toThrow(/belongs to account/);
  });

  it('the board stream sends only the caller’s board events', async () => {
    const a = await signIn();
    const b = await signIn();
    const { ticketId } = await ticketWithSession(a);
    const frames = async (who: Who) => {
      const out: string[] = [];
      const conn: SseConnection = {
        closed: false,
        write: (f) => void out.push(f),
        close: () => undefined,
        onClose: () => undefined,
      };
      await serveBoardStream(
        conn,
        { db: db.pool, boardBus: new InMemoryBoardBus(), accountId: who.accountId },
        0,
      );
      return out.join('');
    };
    expect(await frames(a)).toContain(ticketId);
    expect(await frames(b)).not.toContain(ticketId);
  });

  it('workflows are per account: a save in A is invisible to B and numbered separately', async () => {
    const a = await signIn();
    const b = await signIn();
    const latest = async (who: Who) => {
      const res = await api.send('GET', API_PATHS.workflow(CONDUCTOR_WORKFLOW_ID), as(who));
      expect(res.status).toBe(200);
      return res.json as unknown as {
        version: number;
        versions: number[];
        definition: Record<string, unknown>;
        history: { created_by: string | null; note: string | null }[];
      };
    };
    const before = await latest(a);
    expect((await latest(b)).version).toBe(before.version);

    // A non-admin member saves their own account's workflow.
    const saved = await api.send(
      'POST',
      API_PATHS.workflows,
      as(a, { definition: before.definition, note: 'mine' }),
    );
    expect(saved.status).toBe(201);
    expect(saved.json.version).toBe(before.version + 1);

    const afterA = await latest(a);
    const afterB = await latest(b);
    expect(afterA.version).toBe(before.version + 1);
    expect(afterB.version).toBe(before.version);
    expect(afterB.versions).not.toContain(before.version + 1);
    expect(afterB.history.map((h) => h.note)).not.toContain('mine');
    // B's version numbering is its own: its next save is the same number A got.
    const savedB = await api.send(
      'POST',
      API_PATHS.workflows,
      as(b, { definition: afterB.definition }),
    );
    expect(savedB.json.version).toBe(before.version + 1);
    expect((await latest(a)).history.map((h) => h.note)).toContain('mine');
  });
});
