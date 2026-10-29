// UX-13a: GET /api/team and `agent_name` on the board, session detail and ticket DTOs
// (10-contracts §Agent team), password mode. Needs `pnpm db:up`.
import {
  API_PATHS,
  BoardResponseSchema,
  SessionDetailSchema,
  TeamResponseSchema,
  TicketDtoSchema,
} from '@conductor/shared';
import { afterEach, describe, expect, it } from 'vitest';
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
let api: TestApi | null = null;

afterEach(async () => {
  await api?.close();
  api = null;
});

async function signIn(t: TestApi): Promise<{ cookie: string; accountId: string }> {
  const u = await createUser(db.pool, { password: PASSWORD });
  const res = await t.send('POST', API_PATHS.authLogin, {
    body: { email: u.email, password: PASSWORD },
  });
  expect(res.status).toBe(200);
  return { cookie: cookieOf(res), accountId: u.accountId };
}

/** A ticket created through the API, then assigned to a new agent `name` with a running session. */
async function assigned(t: TestApi, cookie: string, accountId: string, name: string) {
  const res = await t.send('POST', API_PATHS.tickets, {
    headers: { cookie },
    body: { title: 'T', body: '', repo: 'github.com/org/app', kind: 'work' },
  });
  expect(res.status).toBe(201);
  const dto = TicketDtoSchema.parse(res.json);
  expect(dto.agent_name).toBeNull();

  const agent = await db.pool.query<{ id: string }>(
    `INSERT INTO agent (account_id, name, last_assigned_at) VALUES ($1, $2, now()) RETURNING id`,
    [accountId, name],
  );
  await db.pool.query(`UPDATE ticket SET agent_id = $2, status = 'claimed' WHERE id = $1`, [
    dto.id,
    agent.rows[0]!.id,
  ]);
  const s = await db.pool.query<{ id: string }>(
    `INSERT INTO session (account_id, ticket_id, workflow_id, workflow_version, status)
     SELECT $1, $2, id, max(version), 'running' FROM workflow_definition
      WHERE id = $3 GROUP BY id RETURNING id`,
    [accountId, dto.id, dto.workflow_id],
  );
  return { ticketId: dto.id, sessionId: s.rows[0]!.id };
}

describe('GET /api/team (UX-13a)', () => {
  it('needs a session', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const res = await api.send('GET', API_PATHS.team);
    expect([res.status, res.json.error?.code]).toEqual([401, 'unauthorized']);
  });

  it('lists the signed-in account’s team only, with each agent’s active ticket', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    const b = await signIn(api);
    const { ticketId } = await assigned(api, a.cookie, a.accountId, 'Ada');

    const teamA = await api.send('GET', API_PATHS.team, { headers: { cookie: a.cookie } });
    expect(teamA.status).toBe(200);
    expect(TeamResponseSchema.parse(teamA.json).map((m) => [m.name, m.active_ticket_id])).toEqual([
      ['Ada', ticketId],
    ]);

    const teamB = await api.send('GET', API_PATHS.team, { headers: { cookie: b.cookie } });
    expect(TeamResponseSchema.parse(teamB.json)).toEqual([]);
  });
});

describe('agent_name on cards and details (UX-13a)', () => {
  it('the board card and the session detail carry the ticket’s agent', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    const { ticketId, sessionId } = await assigned(api, a.cookie, a.accountId, 'Omar');

    const board = await api.send('GET', API_PATHS.board, { headers: { cookie: a.cookie } });
    const card = BoardResponseSchema.parse(board.json)
      .columns.flatMap((c) => c.cards)
      .find((c) => c.ticket_id === ticketId);
    expect(card?.agent_name).toBe('Omar');

    const res = await api.send('GET', API_PATHS.session(sessionId), {
      headers: { cookie: a.cookie },
    });
    const detail = SessionDetailSchema.parse(res.json);
    expect([detail.agent_name, detail.card.agent_name]).toEqual(['Omar', 'Omar']);
  });
});
