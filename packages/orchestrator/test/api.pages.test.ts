// ADR-0038: conductor-hosted pages. The daemon's publish (machine credential), GET /p/:id (its
// headers, a session or a share token, 410 after expiry), the sweep, the card's Share, the pages
// on the ticket and session detail, and the start_session gate for daemons without the feature.
// Password mode, so the session, Origin and CSRF rules of the real deployment apply. Needs
// `pnpm db:up`.
import { request } from 'node:http';
import {
  API_PATHS,
  CONDUCTOR_V4_DEF,
  DAEMON_FEATURE_PAGES,
  EnrollResponseSchema,
  EnrollmentTokenCreatedSchema,
  HostedPageSchema,
  PAGE_HTML_MAX_BYTES,
  PublishPageResponseSchema,
  SessionDetailSchema,
  SharePageResponseSchema,
  TicketDetailSchema,
  TicketDtoSchema,
  type AgentState,
} from '@conductor/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGE_CSP } from '../src/api/pages.js';
import {
  PAGES_FALLBACK_NOTE,
  sweepExpiredPages,
  withPagesFeature,
} from '../src/engine/pages.js';
import {
  HTTPS_URL,
  cookieOf,
  createUser,
  passwordAuth,
  startApi,
  type Res,
  type TestApi,
} from './auth/helpers.js';
import { useTestDatabase } from './db.js';

const db = useTestDatabase();
const PASSWORD = 'correct horse battery staple';
const auth = passwordAuth(HTTPS_URL);
const PAGES_WORKFLOW = 'conductor_pages_test';

let api: TestApi;
let a: { cookie: string; accountId: string };
let b: { cookie: string; accountId: string };
/** Two machines of `a`'s account, enrolled once (the enroll route is rate-limited). */
let mine: Awaited<ReturnType<typeof enroll>>;
let other: Awaited<ReturnType<typeof enroll>>;

/** A raw request (node:http) with the public Host and Origin; a header set to '' is left out. */
function raw(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: api.port,
        agent: false,
        method,
        path,
        headers: Object.fromEntries(
          Object.entries({
            host: auth.mode === 'password' ? auth.publicHost : '',
            origin: HTTPS_URL,
            ...(opts.body !== undefined
              ? {
                  'content-type': 'application/json',
                  'content-length': String(Buffer.byteLength(opts.body)),
                }
              : {}),
            ...opts.headers,
          }).filter(([, v]) => v !== ''),
        ),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Res['json'] = {};
          try {
            json = JSON.parse(text) as Res['json'];
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

async function signIn(): Promise<{ cookie: string; accountId: string }> {
  const u = await createUser(db.pool, { password: PASSWORD });
  const res = await api.send('POST', API_PATHS.authLogin, {
    body: { email: u.email, password: PASSWORD },
  });
  expect(res.status).toBe(200);
  return { cookie: cookieOf(res), accountId: u.accountId };
}

const as = (who: { cookie: string }) => ({ headers: { cookie: who.cookie } });

async function createTicket(who: { cookie: string }) {
  const res = await api.send('POST', API_PATHS.tickets, {
    ...as(who),
    body: { title: 'Mockup', body: 'draw it', repo: 'github.com/acme/app', kind: 'personal' },
  });
  return TicketDtoSchema.parse(res.json);
}

async function enroll(who: { cookie: string }) {
  const t = await api.send('POST', API_PATHS.machineEnrollmentTokens, { ...as(who), body: {} });
  const { token } = EnrollmentTokenCreatedSchema.parse(t.json);
  const e = await api.send('POST', API_PATHS.machinesEnroll, {
    body: { token, hostname: 'h', os: 'linux', arch: 'x64', daemon_version: '0.1.0' },
  });
  expect(e.status).toBe(201);
  return EnrollResponseSchema.parse(e.json);
}

/** A live session in `planning` of the pages-enabled workflow (planning: `{pages: {max: 2}}`). */
async function liveSession(ticketId: string, machineId: string | null, status = 'running') {
  const r = await db.pool.query<{ id: string }>(
    'INSERT INTO session (ticket_id, workflow_id, workflow_version, workflow_state, status, ' +
      "machine_id, account_id) SELECT $1, $4, 1, 'planning', $2, $3, t.account_id " +
      'FROM ticket t WHERE t.id = $1 RETURNING id',
    [ticketId, status, machineId, PAGES_WORKFLOW],
  );
  return r.rows[0]!.id;
}

const publish = (
  sessionId: string,
  credential: string | undefined,
  body: Record<string, unknown>,
) =>
  raw('POST', API_PATHS.daemonSessionPages(sessionId), {
    headers: { origin: '', ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
    body: JSON.stringify(body),
  });

/** A published page of a fresh ticket: its ids and the response. */
async function published(body: Record<string, unknown> = {}) {
  const t = await createTicket(a);
  const m = mine;
  const sessionId = await liveSession(t.id, m.machine_id);
  const res = await publish(sessionId, m.credential, {
    title: 'Mockup A',
    html: '<!doctype html><h1>Hi</h1><script src="https://evil.example/x.js"></script>',
    ...body,
  });
  expect(res.status, res.text).toBe(201);
  return { ticket: t, machine: m, sessionId, page: PublishPageResponseSchema.parse(res.json) };
}

/** The path (with query) of an absolute page URL. */
const pathOf = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

beforeAll(async () => {
  const def = structuredClone(CONDUCTOR_V4_DEF) as unknown as { id: string };
  def.id = PAGES_WORKFLOW;
  const planning = (def as unknown as typeof CONDUCTOR_V4_DEF).states.planning as AgentState;
  planning.tools = ['read', 'pages'];
  planning.result = ['plan', 'summary', { pages: { max: 2 } }];
  await db.pool.query(
    'INSERT INTO workflow_definition (id, version, definition) VALUES ($1, 1, $2)',
    [PAGES_WORKFLOW, JSON.stringify(def)],
  );
  api = await startApi({ db: db.pool, auth });
  a = await signIn();
  b = await signIn();
  mine = await enroll(a);
  other = await enroll(a);
});

afterAll(async () => {
  await api.close();
});

describe('POST daemon publish', () => {
  it('stores the page under the session and its state, 7 days by default, not shared', async () => {
    const before = Date.now();
    const { page, sessionId } = await published();
    expect(page.url).toBe(`${HTTPS_URL}/p/${page.id}`);
    expect(page.share_url).toBeNull();
    const days = (Date.parse(page.expires_at) - before) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
    const row = await db.pool.query(
      'SELECT session_id, workflow_state, share_token, shared_by FROM page WHERE id = $1',
      [page.id],
    );
    expect(row.rows[0]).toEqual({
      session_id: sessionId,
      workflow_state: 'planning',
      share_token: null,
      shared_by: null,
    });
  });

  it('401 without a credential; 404 for another machine or a finished session', async () => {
    const t = await createTicket(a);
    const live = await liveSession(t.id, mine.machine_id);
    const body = { title: 't', html: '<p>x</p>' };
    expect((await publish(live, undefined, body)).status).toBe(401);
    expect((await publish(live, other.credential, body)).status).toBe(404);
    const t2 = await createTicket(a);
    const done = await liveSession(t2.id, mine.machine_id, 'done');
    expect((await publish(done, mine.credential, body)).status).toBe(404);
    // A browser's cookie is not a machine credential.
    const cookie = await raw('POST', API_PATHS.daemonSessionPages(live), {
      headers: { cookie: a.cookie },
      body: JSON.stringify(body),
    });
    expect(cookie.status).toBe(401);
  });

  it('400 on a bad body, 413 over 2 MiB of UTF-8', async () => {
    const t = await createTicket(a);
    const m = mine;
    const s = await liveSession(t.id, m.machine_id);
    expect((await publish(s, m.credential, { title: 't' })).status).toBe(400);
    expect((await publish(s, m.credential, { title: 't', html: 'x', ttl_days: 31 })).status).toBe(
      400,
    );
    const big = await publish(s, m.credential, { title: 't', html: 'é'.repeat(PAGE_HTML_MAX_BYTES / 2 + 1) });
    expect(big.status).toBe(413);
    expect(big.json.error?.code).toBe('page_too_large');
  });
});

describe('GET /p/:id', () => {
  it('serves the HTML in a sandbox with no network: an external <script src> is blocked', async () => {
    const { page } = await published();
    const res = await raw('GET', pathOf(page.url), as(a));
    expect(res.status).toBe(200);
    expect(res.text).toContain('<h1>Hi</h1>');
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    const csp = String(res.headers['content-security-policy']);
    // The route's headers replace the app's (whose frame-ancestors 'none' would block the card).
    expect(csp).toBe(PAGE_CSP);
    for (const d of [
      'sandbox allow-scripts',
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      'img-src data:',
      "frame-ancestors 'self'",
    ]) {
      expect(csp).toContain(d);
    }
    // No source list allows https://evil.example: script-src is inline only, and nothing else
    // (connect-src, default-src) names a host.
    expect(csp).not.toMatch(/https?:|\*/);
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('needs a session of the account: 401 without one, 404 for another account', async () => {
    const { page } = await published();
    expect((await raw('GET', pathOf(page.url))).status).toBe(401);
    expect((await raw('GET', pathOf(page.url), as(b))).status).toBe(404);
    expect((await raw('GET', '/p/not-a-uuid', as(a))).status).toBe(404);
  });

  it('a share token opens it without a session; a token of another page does not', async () => {
    const shared = await published({ share: true });
    expect(shared.page.share_url).toMatch(new RegExp(`/p/${shared.page.id}\\?t=.{40,}`));
    const open = await raw('GET', pathOf(shared.page.share_url!));
    expect(open.status).toBe(200);
    expect(open.text).toContain('<h1>Hi</h1>');
    const row = await db.pool.query('SELECT shared_by, shared_at FROM page WHERE id = $1', [
      shared.page.id,
    ]);
    expect(row.rows[0].shared_by).toBe('agent');
    expect(row.rows[0].shared_at).not.toBeNull();

    const other = await published();
    const token = new URL(shared.page.share_url!).searchParams.get('t')!;
    const wrong = await raw('GET', `/p/${other.page.id}?t=${encodeURIComponent(token)}`);
    expect(wrong.status).toBe(404);
    expect((await raw('GET', `/p/${shared.page.id}?t=nope`)).status).toBe(404);
  });

  it('410 once expired (session or token), then the sweep deletes it (404)', async () => {
    const { page } = await published({ share: true });
    await db.pool.query("UPDATE page SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      page.id,
    ]);
    expect((await raw('GET', pathOf(page.url), as(a))).status).toBe(410);
    expect((await raw('GET', pathOf(page.share_url!))).status).toBe(410);
    expect(await sweepExpiredPages(db.pool, new Date())).toBeGreaterThanOrEqual(1);
    expect((await raw('GET', pathOf(page.url), as(a))).status).toBe(404);
  });
});

describe('Share, the ticket list, and the pages on detail', () => {
  it('Share mints one link, the same every time; never for another account', async () => {
    const { page, ticket } = await published();
    const first = await api.send('POST', API_PATHS.pageShare(page.id), { ...as(a), body: {} });
    expect(first.status, first.text).toBe(200);
    const { share_url } = SharePageResponseSchema.parse(first.json);
    const again = SharePageResponseSchema.parse(
      (await api.send('POST', API_PATHS.pageShare(page.id), { ...as(a), body: {} })).json,
    );
    expect(again.share_url).toBe(share_url);
    expect((await raw('GET', pathOf(share_url))).status).toBe(200);
    expect(
      (await api.send('POST', API_PATHS.pageShare(page.id), { ...as(b), body: {} })).status,
    ).toBe(404);
    const list = await api.send('GET', API_PATHS.ticketPages(ticket.id), as(a));
    const pages = HostedPageSchema.array().parse(list.json);
    expect(pages.map((p) => [p.id, p.shared_by, p.share_url])).toEqual([
      [page.id, 'user', share_url],
    ]);
    expect(
      (await api.send('GET', API_PATHS.ticketPages(ticket.id), as(b))).json,
    ).toEqual([]);
  });

  it('the pages planning attached are on the session and ticket detail, ours marked hosted', async () => {
    const { page, sessionId, ticket } = await published();
    const external = 'https://claude.ai/public/artifacts/abc';
    await db.pool.query('UPDATE session SET context = $2 WHERE id = $1', [
      sessionId,
      JSON.stringify({
        planning: {
          plan: 'p',
          pages: [
            { url: page.url, title: 'Mockup A' },
            { url: external, title: 'Elsewhere' },
            { url: 'https://x.example/3', title: 'Over the max' },
          ],
        },
      }),
    ]);
    const s = await api.send('GET', API_PATHS.session(sessionId), as(a));
    expect(s.status, s.text).toBe(200);
    const pages = SessionDetailSchema.parse(s.json).pages;
    expect(pages).toEqual([
      {
        url: page.url,
        title: 'Mockup A',
        state: 'planning',
        expires_at: page.expires_at,
        hosted: true,
        expired: false,
      },
      {
        url: external,
        title: 'Elsewhere',
        state: 'planning',
        expires_at: null,
        hosted: false,
        expired: false,
      },
    ]);
    // The ticket's latest session is this one.
    const td = await api.send('GET', API_PATHS.ticket(ticket.id), as(a));
    expect(TicketDetailSchema.parse(td.json).pages?.map((p) => p.url)).toEqual([
      page.url,
      external,
    ]);
  });
});

describe('start_session gate', () => {
  it("drops the pages tool for a daemon that can't publish, with a note", async () => {
    const m = other;
    const payload = { prompt: 'Plan it.', tools: ['read', 'pages'] };
    expect(await withPagesFeature(db.pool, payload, `machine:${m.machine_id}`)).toEqual({
      prompt: 'Plan it.' + PAGES_FALLBACK_NOTE,
      tools: ['read'],
    });
    await db.pool.query('UPDATE machine SET features = $2 WHERE id = $1', [
      m.machine_id,
      [DAEMON_FEATURE_PAGES],
    ]);
    expect(await withPagesFeature(db.pool, payload, `machine:${m.machine_id}`)).toBe(payload);
    const none = { prompt: 'x', tools: ['read'] };
    expect(await withPagesFeature(db.pool, none, 'machine:nope')).toBe(none);
  });
});
