// ADR-0034: /api/proposals/:id/accept | dismiss (password mode), and the session detail's
// `proposed_tickets`. The routes are thin over proposals/store.ts (covered by proposals.test.ts);
// this checks the HTTP surface: auth, status codes, bodies and account scope. Needs `pnpm db:up`.
import {
  API_PATHS,
  AcceptProposalResponseSchema,
  SessionDetailSchema,
  TicketDtoSchema,
  TicketProposalDtoSchema,
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

async function signIn(t: TestApi) {
  const u = await createUser(db.pool, { password: PASSWORD });
  const res = await t.send('POST', API_PATHS.authLogin, {
    body: { email: u.email, password: PASSWORD },
  });
  expect(res.status).toBe(200);
  return { cookie: cookieOf(res), accountId: u.accountId, email: u.email };
}

/** A ticket of the signed-in user with a needs_input session and two proposals. */
async function proposed(t: TestApi, cookie: string, accountId: string) {
  const res = await t.send('POST', API_PATHS.tickets, {
    headers: { cookie },
    body: { title: 'Source', body: '', repo: 'github.com/org/app', kind: 'personal' },
  });
  expect(res.status).toBe(201);
  const ticket = TicketDtoSchema.parse(res.json);
  const s = await db.pool.query<{ id: string }>(
    `INSERT INTO session (account_id, ticket_id, workflow_id, workflow_version, status,
       workflow_state)
     SELECT $1, $2, id, max(version), 'needs_input', 'needs_input' FROM workflow_definition
      WHERE id = $3 GROUP BY id RETURNING id`,
    [accountId, ticket.id, ticket.workflow_id],
  );
  const sessionId = s.rows[0]!.id;
  const ids: string[] = [];
  for (const title of ['Add docs', 'Fix lint']) {
    const r = await db.pool.query<{ id: string }>(
      `INSERT INTO ticket_proposal (account_id, ticket_id, session_id, state, title, body)
       VALUES ($1, $2, $3, 'implementing', $4, 'Do it') RETURNING id`,
      [accountId, ticket.id, sessionId, title],
    );
    ids.push(r.rows[0]!.id);
  }
  return { ticketId: ticket.id, sessionId, docs: ids[0]!, lint: ids[1]! };
}

describe('/api/proposals (ADR-0034)', () => {
  it('needs a session', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const res = await api.send('POST', API_PATHS.proposalDismiss(crypto.randomUUID()), {
      body: {},
    });
    expect(res.status).toBe(401);
  });

  it('accept, dismiss, conflicts and account scope; the session detail lists them', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    const b = await signIn(api);
    const p = await proposed(api, a.cookie, a.accountId);

    const detail = SessionDetailSchema.parse(
      (await api.send('GET', API_PATHS.session(p.sessionId), { headers: { cookie: a.cookie } }))
        .json,
    );
    expect(detail.proposed_tickets?.map((x) => x.status)).toEqual(['pending', 'pending']);

    const fromB = await api.send('POST', API_PATHS.proposalAccept(p.docs), {
      headers: { cookie: b.cookie },
      body: {},
    });
    expect(fromB.status).toBe(404);

    const bad = await api.send('POST', API_PATHS.proposalAccept(p.docs), {
      headers: { cookie: a.cookie },
      body: { title: '' },
    });
    expect(bad.status).toBe(400);

    const ok = await api.send('POST', API_PATHS.proposalAccept(p.docs), {
      headers: { cookie: a.cookie },
      body: { body: 'Edited' },
    });
    expect(ok.status).toBe(201);
    const accepted = AcceptProposalResponseSchema.parse(ok.json);
    expect(accepted.proposal).toMatchObject({
      status: 'accepted',
      created_ticket_id: accepted.ticket.id,
      decided_by: a.email,
    });
    expect(accepted.ticket).toMatchObject({
      title: 'Add docs',
      body: 'Edited',
      repo: 'github.com/org/app',
      kind: 'personal',
      status: 'ready',
    });

    const again = await api.send('POST', API_PATHS.proposalAccept(p.docs), {
      headers: { cookie: a.cookie },
      body: {},
    });
    expect([again.status, (again.json as { error: { code: string } }).error.code]).toEqual([
      409,
      'conflict',
    ]);

    const dismissed = await api.send('POST', API_PATHS.proposalDismiss(p.lint), {
      headers: { cookie: a.cookie },
      body: {},
    });
    expect(dismissed.status).toBe(200);
    expect(TicketProposalDtoSchema.parse(dismissed.json).status).toBe('dismissed');
  });
});
