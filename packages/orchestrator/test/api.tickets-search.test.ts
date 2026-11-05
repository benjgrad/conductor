// UXR-85: GET /api/tickets (password mode), the web's search box and Archive: the account
// scope, the text and id-prefix match, the status groups, the order and the offset paging.
// Needs `pnpm db:up`.
import { API_PATHS, TicketSearchResponseSchema, type TicketStatus } from '@conductor/shared';
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
  return { cookie: cookieOf(res), accountId: u.accountId };
}

let minutesAgo = 1000;

/** A ticket of the account, each one updated more recently than the one before. */
async function ticket(
  accountId: string,
  t: { title: string; body?: string; ref?: string; status?: TicketStatus },
): Promise<string> {
  const r = await db.pool.query<{ id: string }>(
    'INSERT INTO ticket (account_id, repo, title, body, external_ref, workflow_id, status, ' +
      "kind, updated_at) VALUES ($1, 'github.com/acme/app', $2, $3, $4, 'conductor', $5, " +
      "'work', now() - make_interval(mins => $6)) RETURNING id",
    [accountId, t.title, t.body ?? '', t.ref ?? null, t.status ?? 'ready', minutesAgo--],
  );
  return r.rows[0]!.id;
}

async function session(accountId: string, ticketId: string): Promise<string> {
  // A stub definition: the search reads only the session's id.
  await db.pool.query(
    "INSERT INTO workflow_definition (id, version, definition) VALUES ('wf_search', 1, '{}') " +
      'ON CONFLICT DO NOTHING',
  );
  const r = await db.pool.query<{ id: string }>(
    'INSERT INTO session (account_id, ticket_id, workflow_id, workflow_version) ' +
      "VALUES ($1, $2, 'wf_search', 1) RETURNING id",
    [accountId, ticketId],
  );
  return r.rows[0]!.id;
}

describe('GET /api/tickets', () => {
  it('needs a session', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    expect((await api.send('GET', API_PATHS.tickets)).status).toBe(401);
  });

  it('searches the account’s tickets of any status, newest first, paged', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    const b = await signIn(api);
    const old = await ticket(a.accountId, { title: 'Fix the Login page', status: 'done' });
    const gone = await ticket(a.accountId, {
      title: 'Drop the cache',
      body: 'the login cookie expires',
      status: 'cancelled',
    });
    const failed = await ticket(a.accountId, { title: 'Port', ref: 'LOGIN-7', status: 'failed' });
    const queued = await ticket(a.accountId, { title: 'Docs: 100% coverage_now' });
    await ticket(b.accountId, { title: 'login for someone else' });
    const sid = await session(a.accountId, old);

    const get = async (qs: string) => {
      const res = await api!.send('GET', `${API_PATHS.tickets}${qs}`, {
        headers: { cookie: a.cookie },
      });
      expect(res.status, qs).toBe(200);
      return TicketSearchResponseSchema.parse(res.json);
    };
    const ids = (r: { tickets: { id: string }[] }) => r.tickets.map((t) => t.id);

    // Title, body and external ref, case-insensitively; never account b's.
    const login = await get('?q=LOGIN');
    expect(ids(login)).toEqual([failed, gone, old]);
    expect(login).toMatchObject({ total: 3, next_cursor: null });
    expect(login.tickets[1]!.snippet).toContain('login cookie');
    expect(login.tickets[2]).toMatchObject({ session_id: sid, status: 'done' });
    expect(login.tickets[0]!.session_id).toBeNull();

    // `%` and `_` are literal; an id prefix matches.
    expect(ids(await get('?q=' + encodeURIComponent('100%')))).toEqual([queued]);
    expect(ids(await get('?q=_now'))).toEqual([queued]);
    expect(ids(await get('?q=50%25x'))).toEqual([]);
    expect(ids(await get(`?q=${gone.slice(0, 8)}`))).toEqual([gone]);

    // No q: every status by default, no snippet; the status groups.
    const all = await get('');
    expect(ids(all)).toEqual([queued, failed, gone, old]);
    expect(all.tickets[0]!.snippet).toBeNull();
    expect(ids(await get('?status=open'))).toEqual([queued, failed]);
    expect(ids(await get('?status=done,cancelled'))).toEqual([gone, old]);
    expect(ids(await get('?status=cancelled&q=login'))).toEqual([gone]);

    // Offset paging.
    const first = await get('?limit=3');
    expect(first).toMatchObject({ total: 4, next_cursor: 3 });
    const last = await get('?limit=3&cursor=3');
    expect(ids(last)).toEqual([old]);
    expect(last.next_cursor).toBeNull();
  });

  it('refuses a bad status, limit or cursor', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    for (const qs of ['?status=nope', '?limit=0', '?limit=51', '?cursor=-1', '?limit=x']) {
      const res = await api.send('GET', `${API_PATHS.tickets}${qs}`, {
        headers: { cookie: a.cookie },
      });
      expect(res.status, qs).toBe(400);
    }
  });
});
