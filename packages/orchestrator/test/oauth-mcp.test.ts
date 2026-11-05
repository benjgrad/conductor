// ADR-0028: the OAuth authorization server and the /mcp endpoint, password mode, end to end over
// HTTP against a test database (the routes, the security hook and the SDK transport are the
// subject). Needs `pnpm db:up`.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import {
  API_PATHS,
  CONDUCTOR_V4,
  CONDUCTOR_V4_DEF,
  SNAPSHOT_FIXTURE,
  transitionsOf,
  type WorkflowDefinitionInput,
} from '@conductor/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disableUser } from '../src/auth/admin-commands.js';
import { createSession } from '../src/auth/sessions.js';
import {
  FakeEngineService,
  FakeTranscriptSource,
  InMemoryBoardBus,
  InMemoryOutputBus,
  type TranscriptFetchResult,
} from '../src/contracts.js';
import { seedConductorWorkflow } from '../src/engine/seed.js';
import { issueTokens } from '../src/oauth/tokens.js';
import { HTTPS_URL, createUser, passwordAuth, startApi, type TestApi } from './auth/helpers.js';
import { useTestDatabase } from './db.js';

const db = useTestDatabase();
const AUTH = passwordAuth(HTTPS_URL);
const COOKIE_NAME = AUTH.mode === 'password' ? AUTH.cookie.name : '';
const ISSUER = HTTPS_URL;
const HOST = new URL(HTTPS_URL).host;
const REDIRECT = 'http://127.0.0.1:33418/callback';
// A fixed hash: argon2 is not under test here.
const PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaGhhc2hoYXNoaGFzaA';

let api: TestApi;
const engine = new FakeEngineService();
const boardBus = new InMemoryBoardBus();
const outputBus = new InMemoryOutputBus();
let transcriptAnswer: TranscriptFetchResult = { status: 'offline' };
const transcripts = new FakeTranscriptSource(() => transcriptAnswer);

beforeAll(async () => {
  api = await startApi({ db: db.pool, auth: AUTH, engine, boardBus, outputBus, transcripts });
});
afterAll(async () => {
  await api.close();
});

interface Raw {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: Record<string, unknown>;
}

/** One request with the public Host and nothing else unless given (no Origin, no cookie). */
function raw(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: api.port, method, path, headers: { host: HOST, ...opts.headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (text += d));
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try {
            json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          } catch {
            // HTML
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const form = (body: Record<string, string>, headers: Record<string, string> = {}) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(body).toString(),
});

async function signedInUser(opts: { admin?: boolean } = {}) {
  const u = await createUser(db.pool, {
    password: '',
    passwordHash: PASSWORD_HASH,
    ...(opts.admin ? { admin: true } : {}),
  });
  const s = await createSession(db.pool, {
    userId: u.userId,
    accountId: u.accountId,
    userAgent: null,
    ip: null,
    now: new Date(),
  });
  return { ...u, cookie: `${COOKIE_NAME}=${s.token}` };
}

async function register(name = 'Claude Code', redirect = REDIRECT): Promise<string> {
  const res = await raw(
    'POST',
    API_PATHS.oauthRegister,
    json({ client_name: name, redirect_uris: [redirect] }),
  );
  expect(res.status).toBe(201);
  return res.json.client_id as string;
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function authorizeParams(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    resource: `${ISSUER}/mcp`,
    ...extra,
  };
}

const authorizePath = (params: Record<string, string>) =>
  `${API_PATHS.oauthAuthorize}?${new URLSearchParams(params).toString()}`;

/** Consent with Allow and return the code from the redirect. */
async function consent(cookie: string, params: Record<string, string>): Promise<string> {
  const res = await raw(
    'POST',
    API_PATHS.oauthAuthorize,
    form({ ...params, decision: 'allow' }, { cookie, origin: ISSUER }),
  );
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.location as string);
  expect(loc.origin + loc.pathname).toBe(REDIRECT);
  expect(loc.searchParams.get('state')).toBe('st-1');
  expect(loc.searchParams.get('iss')).toBe(ISSUER);
  return loc.searchParams.get('code')!;
}

function exchange(clientId: string, code: string, verifier: string) {
  return raw(
    'POST',
    API_PATHS.oauthToken,
    form({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
    }),
  );
}

/**
 * A user's access token without the OAuth flow (that flow is tested above; its endpoints are
 * rate-limited per IP, which a long file runs into).
 */
async function minted() {
  const u = await signedInUser();
  const clientId = randomUUID();
  await db.pool.query('INSERT INTO oauth_client (id, name, redirect_uris) VALUES ($1, $2, $3)', [
    clientId,
    'Minted',
    [REDIRECT],
  ]);
  const t = await issueTokens(
    db.pool,
    { grant_id: randomUUID(), client_id: clientId, account_id: u.accountId, user_id: u.userId },
    new Date(),
  );
  return { user: u, access: t.access_token };
}

/** A user connected through the whole flow: its access and refresh tokens. */
async function connect(user?: Awaited<ReturnType<typeof signedInUser>>) {
  const u = user ?? (await signedInUser());
  const clientId = await register();
  const { verifier, challenge } = pkce();
  const code = await consent(u.cookie, authorizeParams(clientId, challenge));
  const res = await exchange(clientId, code, verifier);
  expect(res.status).toBe(200);
  return {
    user: u,
    clientId,
    access: res.json.access_token as string,
    refresh: res.json.refresh_token as string,
  };
}

let rpcId = 0;
function mcp(token: string | null, method: string, params: unknown = {}) {
  return raw(
    'POST',
    API_PATHS.mcp,
    json(
      { jsonrpc: '2.0', id: ++rpcId, method, params },
      {
        accept: 'application/json, text/event-stream',
        ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      },
    ),
  );
}

/** tools/call → the parsed JSON of its text block, and whether it is an error. */
async function call(token: string, name: string, args: Record<string, unknown>) {
  const res = await mcp(token, 'tools/call', { name, arguments: args });
  expect(res.status).toBe(200);
  const result = res.json.result as { content: { text: string }[]; isError?: boolean };
  return {
    isError: result.isError === true,
    body: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
  };
}

describe('discovery', () => {
  it('serves both metadata documents for the public issuer', async () => {
    for (const path of [
      API_PATHS.wellKnownProtectedResource,
      API_PATHS.wellKnownProtectedResourceMcp,
    ]) {
      const res = await raw('GET', path);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        resource: `${ISSUER}/mcp`,
        authorization_servers: [ISSUER],
      });
    }
    const as = await raw('GET', API_PATHS.wellKnownAuthServer);
    expect(as.json).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      registration_endpoint: `${ISSUER}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });
});

describe('security hook', () => {
  it('takes form bodies only on the OAuth paths, and keeps the Origin rule elsewhere', async () => {
    const u = await signedInUser();
    const formOnApi = await raw(
      'POST',
      API_PATHS.tickets,
      form({ title: 'x' }, { cookie: u.cookie, origin: ISSUER }),
    );
    expect(formOnApi.status).toBe(415);
    const noOriginOnApi = await raw('POST', API_PATHS.tickets, json({}, { cookie: u.cookie }));
    expect(noOriginOnApi.status).toBe(403);
    // An MCP client may send any Origin (or none): the bearer token authenticates it.
    const foreign = await raw(
      'POST',
      API_PATHS.oauthRegister,
      json({ redirect_uris: [REDIRECT] }, { origin: 'https://claude.ai' }),
    );
    expect(foreign.status).toBe(201);
  });
});

describe('registration', () => {
  it('refuses a non-loopback http redirect URI', async () => {
    const res = await raw(
      'POST',
      API_PATHS.oauthRegister,
      json({ redirect_uris: ['http://evil.example/cb'] }),
    );
    expect([res.status, res.json.error]).toEqual([400, 'invalid_redirect_uri']);
  });
});

describe('authorize', () => {
  it('sends a signed-out user to sign-in, coming back to the same request', async () => {
    const clientId = await register();
    const path = authorizePath(authorizeParams(clientId, pkce().challenge));
    const res = await raw('GET', path);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/signin?next=${encodeURIComponent(path)}`);
  });

  it('shows an error page, never a redirect, for an unregistered redirect URI', async () => {
    const u = await signedInUser();
    const clientId = await register();
    const params = authorizeParams(clientId, pkce().challenge, {
      redirect_uri: 'https://evil.example/cb',
    });
    const res = await raw('GET', authorizePath(params), { headers: { cookie: u.cookie } });
    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
    expect(res.headers['content-type']).toMatch(/^text\/html/);
  });

  it('sends `plain` PKCE back to the client as invalid_request', async () => {
    const u = await signedInUser();
    const clientId = await register();
    const params = authorizeParams(clientId, 'x'.repeat(43), { code_challenge_method: 'plain' });
    const res = await raw('GET', authorizePath(params), { headers: { cookie: u.cookie } });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('st-1');
  });

  it('renders consent with the escaped client name and a CSP that allows the redirect', async () => {
    const u = await signedInUser();
    const clientId = await register('<script>x</script>');
    const res = await raw('GET', authorizePath(authorizeParams(clientId, pkce().challenge)), {
      headers: { cookie: u.cookie },
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(res.text).not.toContain('<script>');
    expect(res.text).toContain(u.email);
    expect(res.text).toContain('an app on this computer');
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("form-action 'self' http://127.0.0.1:33418");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('refuses the consent form without Origin, and denies with access_denied', async () => {
    const u = await signedInUser();
    const clientId = await register();
    const params = authorizeParams(clientId, pkce().challenge);
    const noOrigin = await raw(
      'POST',
      API_PATHS.oauthAuthorize,
      form({ ...params, decision: 'allow' }, { cookie: u.cookie }),
    );
    expect(noOrigin.status).toBe(403);
    const deny = await raw(
      'POST',
      API_PATHS.oauthAuthorize,
      form({ ...params, decision: 'deny' }, { cookie: u.cookie, origin: ISSUER }),
    );
    expect(deny.status).toBe(302);
    expect(new URL(deny.headers.location as string).searchParams.get('error')).toBe(
      'access_denied',
    );
  });
});

describe('token', () => {
  it('refuses a wrong verifier, and a replayed code revokes what it issued', async () => {
    const u = await signedInUser();
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const params = authorizeParams(clientId, challenge);

    const wrong = await exchange(clientId, await consent(u.cookie, params), pkce().verifier);
    expect([wrong.status, wrong.json.error]).toEqual([400, 'invalid_grant']);

    const code = await consent(u.cookie, params);
    const first = await exchange(clientId, code, verifier);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(first.headers['cache-control']).toBe('no-store');
    const access = first.json.access_token as string;
    expect(access.startsWith('cnd_at_')).toBe(true);
    expect((await mcp(access, 'tools/list')).status).toBe(200);

    const replay = await exchange(clientId, code, verifier);
    expect([replay.status, replay.json.error]).toEqual([400, 'invalid_grant']);
    expect((await mcp(access, 'tools/list')).status).toBe(401);
  });

  it('rotates the refresh token; the old one is then refused', async () => {
    const c = await connect();
    const refresh = (token: string) =>
      raw(
        'POST',
        API_PATHS.oauthToken,
        form({ grant_type: 'refresh_token', client_id: c.clientId, refresh_token: token }),
      );
    const next = await refresh(c.refresh);
    expect(next.status).toBe(200);
    expect(next.json.refresh_token).not.toBe(c.refresh);
    expect((await mcp(next.json.access_token as string, 'tools/list')).status).toBe(200);
    const again = await refresh(c.refresh);
    expect([again.status, again.json.error]).toEqual([400, 'invalid_grant']);
  });

  it('disabling the user revokes their tokens', async () => {
    const c = await connect();
    await disableUser(
      { db: db.pool, sockets: { disconnectMachine: () => undefined } },
      c.user.userId,
      new Date(),
    );
    const live = await db.pool.query(
      'SELECT 1 FROM oauth_token WHERE user_id = $1 AND revoked_at IS NULL',
      [c.user.userId],
    );
    expect(live.rowCount).toBe(0);
    expect((await mcp(c.access, 'tools/list')).status).toBe(401);
  });
});

describe('/mcp', () => {
  it('401s without a token (pointing at the metadata), and with only a cookie', async () => {
    const res = await mcp(null, 'tools/list');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp", scope="conductor"`,
    );
    const u = await signedInUser();
    const cookieOnly = await raw(
      'POST',
      API_PATHS.mcp,
      json({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { cookie: u.cookie, origin: ISSUER }),
    );
    expect(cookieOnly.status).toBe(401);
    const bad = await mcp('cnd_at_nope', 'tools/list');
    expect(bad.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('GET is 405', async () => {
    expect((await raw('GET', API_PATHS.mcp)).status).toBe(405);
  });

  it('lists the tools and serves them, scoped to the token’s account', async () => {
    const a = await connect();
    const b = await connect();

    const init = await mcp(a.access, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect((init.json.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
      'conductor',
    );
    const list = await mcp(a.access, 'tools/list');
    const names = (list.json.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    // The tool set Ben approved (2026-10-30), plus ADR-0030's workflow tools, ADR-0032's
    // schedules and ADR-0033's advisor tools (P2: get_process_report, get_insight; P3:
    // propose_change, list_change_proposals, apply_change): nothing else.
    expect(names.sort()).toEqual([
      'adopt_default_workflow',
      'answer_input',
      'apply_change',
      'cancel_ticket',
      'clear_repo_checks',
      'create_ticket',
      'decide_proposed_ticket',
      'delete_schedule',
      'get_insight',
      'get_process_metrics',
      'get_process_report',
      'get_repo_checks',
      'get_ticket',
      'get_ticket_artifacts',
      'get_workflow',
      'list_change_proposals',
      'list_findings',
      'list_machines',
      'list_repo_checks',
      'list_schedules',
      'list_tickets',
      'message_agent',
      'propose_change',
      'reopen_ticket',
      'reorder_queue',
      'run_schedule_now',
      'save_schedule',
      'save_workflow',
      'search_tickets',
      'set_repo_checks',
      'take_transition',
      'wait_for_updates',
    ]);
    const tools = (list.json.result as { tools: { description: string }[] }).tools;
    for (const t of tools) expect(t.description.length).toBeLessThanOrEqual(700);
    // ADR-0031 / ADR-0032 / ADR-0033 / ADR-0034: 32 tools (06 §Queue order added reorder_queue); the list is what every client loads first, so it
    // stays small. ADR-0033 raised the budget from 18 KB to 20 KB for the advisor tools, and its
    // P3 amendment to 22 KB for the change-proposal tools, and ADR-0034 to 23 KB for
    // decide_proposed_ticket.
    expect(Buffer.byteLength(list.text, 'utf8')).toBeLessThanOrEqual(23 * 1024);

    const created = await call(a.access, 'create_ticket', {
      title: 'From MCP',
      repo: 'github.com/acme/app',
      body: '## Goal\nTest.',
      kind: 'work',
    });
    expect(created.isError).toBe(false);
    const id = created.body.id as string;
    expect(created.body).toMatchObject({ title: 'From MCP', short_id: id.slice(0, 8) });

    const listed = await call(a.access, 'list_tickets', {});
    expect((listed.body.tickets as { id: string }[]).map((t) => t.id)).toEqual([id]);

    const got = await call(a.access, 'get_ticket', { ticket: id.slice(0, 8) });
    expect(got.body).toMatchObject({
      id,
      title: 'From MCP',
      column: 'queued',
      waiting_on: 'machine',
      cursor: expect.any(Number) as number,
      body: '## Goal\nTest.',
    });

    const queued = await call(a.access, 'answer_input', { ticket: id, answer: 'yes' });
    expect(queued.isError).toBe(true);
    expect((queued.body.error as { code: string }).code).toBe('wrong_state');

    // Account B sees none of it.
    expect((await call(b.access, 'list_tickets', {})).body.tickets).toEqual([]);
    const other = await call(b.access, 'get_ticket', { ticket: id });
    expect(other.isError).toBe(true);
    expect((other.body.error as { code: string }).code).toBe('not_found');
  });
});

// A workflow with a human state whose `merge` needs a board approval (ADR-0020 §5).
const GATED_WORKFLOW = {
  id: 'mcp_gated',
  version: 1,
  start: 'implement',
  budget: { usd: 2, minutes: 60, max_loop_retries: 3 },
  on_budget_exceeded: 'review',
  states: {
    implement: { type: 'agent', prompt: 'ticket_template', on: { done: 'review' } },
    review: {
      type: 'human',
      on: {
        send_back: 'implement',
        merge: {
          goto: 'done',
          requires: {
            approvals: [
              { id: 'migration', label: 'Approve migration', paths: ['**/migrations/**'] },
            ],
          },
        },
      },
    },
    done: { type: 'terminal' },
  },
};

/** A ticket of `accountId` with one session in `status` (in `review` unless done). */
async function seedTicketSession(accountId: string, status: 'needs_input' | 'done') {
  await db.pool.query(
    'INSERT INTO workflow_definition (id, version, definition) VALUES ($1, 1, $2) ' +
      'ON CONFLICT DO NOTHING',
    [GATED_WORKFLOW.id, JSON.stringify(GATED_WORKFLOW)],
  );
  const t = await db.pool.query<{ id: string }>(
    'INSERT INTO ticket (account_id, repo, title, body, workflow_id, workflow_version, status, kind) ' +
      "VALUES ($1, 'github.com/acme/app', 'Seeded', 'Body', $2, 1, $3, 'work') RETURNING id",
    [accountId, GATED_WORKFLOW.id, status === 'done' ? 'done' : 'in_progress'],
  );
  const ticketId = t.rows[0]!.id;
  const s = await db.pool.query<{ id: string }>(
    'INSERT INTO session (account_id, ticket_id, workflow_id, workflow_version, status, ' +
      "workflow_state, branch) VALUES ($1, $2, $3, 1, $4, $5, 'conductor/test') RETURNING id",
    [accountId, ticketId, GATED_WORKFLOW.id, status, status === 'done' ? 'done' : 'review'],
  );
  return { ticketId, sessionId: s.rows[0]!.id };
}

const errorOf = (r: { body: Record<string, unknown> }) =>
  r.body.error as { code: string; message: string } & Record<string, unknown>;

describe('/mcp tools (approved set)', () => {
  it('search_tickets matches title, body and short id literally, inside the account', async () => {
    const a = await connect();
    const b = await connect();
    const mk = (token: string, title: string, body: string) =>
      call(token, 'create_ticket', { title, repo: 'github.com/acme/app', body, kind: 'work' });
    const login = (await mk(a.access, 'Fix the login page', '## Goal\nUsers sign in.')).body
      .id as string;
    const cover = (await mk(a.access, 'Coverage', '## Goal\nReach 100% coverage.')).body
      .id as string;
    await mk(b.access, 'Fix the login page too', '## Goal\nOther account.');

    const byTitle = await call(a.access, 'search_tickets', { query: 'LOGIN' });
    expect((byTitle.body.tickets as { id: string }[]).map((t) => t.id)).toEqual([login]);
    const byBody = await call(a.access, 'search_tickets', { query: '100%' });
    expect(byBody.body.tickets).toEqual([
      expect.objectContaining({
        id: cover,
        snippet: expect.stringContaining('100% coverage') as string,
      }),
    ]);
    // `%` and `_` are literal, not wildcards.
    expect((await call(a.access, 'search_tickets', { query: '1_0' })).body.tickets).toEqual([]);
    expect((await call(a.access, 'search_tickets', { query: '%' })).body.tickets).toEqual([
      expect.objectContaining({ id: cover }),
    ]);
    const byId = await call(a.access, 'search_tickets', { query: login.slice(0, 8) });
    expect((byId.body.tickets as { id: string }[]).map((t) => t.id)).toContain(login);
    // B never sees A's tickets.
    const fromB = await call(b.access, 'search_tickets', { query: 'Users sign in' });
    expect(fromB.body.tickets).toEqual([]);

    // reorder_queue (06 §Queue order), on the same two accounts (each connect() counts against
    // the registration rate limit).
    const queue = async (token: string, title: string, priority: number) => {
      const id = (
        await call(token, 'create_ticket', {
          title,
          repo: 'github.com/acme/app',
          body: '## Goal\nQueue.',
          kind: 'work',
        })
      ).body.id as string;
      await db.pool.query('UPDATE ticket SET priority = $2 WHERE id = $1', [id, priority]);
      return id;
    };
    const low = await queue(a.access, 'low', 0);
    const high = await queue(a.access, 'high', 5);
    const mid = await queue(a.access, 'mid', 2);
    const queued = async () =>
      (
        (await call(a.access, 'list_tickets', { column: 'queued' })).body.tickets as {
          id: string;
        }[]
      )
        .map((t) => t.id)
        .filter((id) => [low, mid, high].includes(id));
    expect(await queued()).toEqual([high, mid, low]);

    const res = await call(a.access, 'reorder_queue', {
      tickets: [low.slice(0, 8), mid],
    });
    expect((res.body.queue as { id: string }[]).map((t) => t.id).slice(0, 2)).toEqual([low, mid]);
    expect(await queued()).toEqual([low, mid, high]);

    // Another account can't see, so can't reorder, these tickets.
    const other = await call(b.access, 'reorder_queue', { tickets: [high] });
    expect(errorOf(other).code).toBe('not_found');
    expect(errorOf(await call(a.access, 'reorder_queue', {})).code).toBe('invalid_input');

    await call(a.access, 'reorder_queue', { tickets: [] });
    expect(await queued()).toEqual([high, mid, low]);
  });

  it('create_ticket without kind takes the account’s last kind on the repo (WF-T03)', async () => {
    const a = await minted();
    const b = await minted();
    const mk = (token: string, extra: Record<string, unknown> = {}) =>
      call(token, 'create_ticket', {
        title: 'Follow-up',
        repo: 'https://github.com/me/notes.git',
        body: '## Goal\nX.',
        ...extra,
      });
    expect((await mk(a.access, { kind: 'personal', repo: 'github.com/me/notes' })).isError).toBe(
      false,
    );
    const followUp = await mk(a.access);
    expect(followUp.isError).toBe(false);
    const listed = await call(a.access, 'list_tickets', { kind: 'personal' });
    expect((listed.body.tickets as { id: string }[]).map((t) => t.id)).toContain(
      followUp.body.id as string,
    );
    // B has no ticket on the repo: A's kind does not leak across accounts.
    const fromB = await mk(b.access);
    expect(fromB.isError).toBe(true);
    expect(errorOf(fromB).message).toContain('kind');
  });

  it('list_tickets filters by status, kind and repo', async () => {
    const a = await connect();
    const mk = async (title: string, repo: string, kind: string) =>
      (await call(a.access, 'create_ticket', { title, repo, body: '## Goal\nX.', kind })).body
        .id as string;
    const work = await mk('Work one', 'github.com/acme/app', 'work');
    const personal = await mk('Personal one', 'github.com/me/notes', 'personal');
    const gone = await mk('Cancelled one', 'github.com/acme/app', 'work');
    await db.pool.query("UPDATE ticket SET status = 'cancelled' WHERE id = $1", [gone]);
    const ids = async (args: Record<string, unknown>) =>
      ((await call(a.access, 'list_tickets', args)).body.tickets as { id: string }[])
        .map((t) => t.id)
        .sort();

    expect(await ids({})).toEqual([work, personal].sort());
    expect(await ids({ status: 'cancelled' })).toEqual([gone]);
    expect(await ids({ status: 'all' })).toEqual([work, personal, gone].sort());
    expect(await ids({ kind: 'personal' })).toEqual([personal]);
    expect(await ids({ repo: 'GitHub.com/acme/app', status: 'all' })).toEqual([work, gone].sort());
  });

  it('take_transition lists the allowed names and refuses an approval-gated move', async () => {
    const a = await connect();
    const { ticketId, sessionId } = await seedTicketSession(a.user.accountId, 'needs_input');

    const got = await call(a.access, 'get_ticket', { ticket: ticketId });
    // jsonb keeps its own key order, so the transitions' order isn't asserted.
    const byName = (x: { name: string }, y: { name: string }) => x.name.localeCompare(y.name);
    expect((got.body.transitions as { name: string }[]).sort(byName)).toEqual([
      {
        name: 'merge',
        title: expect.any(String) as string,
        needs_text: false,
        requires_approval: true,
      },
      { name: 'send_back', title: expect.any(String) as string, needs_text: false },
    ]);

    const before = engine.calls.length;
    const unknown = await call(a.access, 'take_transition', { ticket: ticketId, name: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(errorOf(unknown).code).toBe('wrong_state');
    expect((errorOf(unknown).allowed as string[]).sort()).toEqual(['merge', 'send_back']);

    const gated = await call(a.access, 'take_transition', { ticket: ticketId, name: 'merge' });
    expect(gated.isError).toBe(true);
    expect(errorOf(gated)).toMatchObject({
      code: 'approval_required',
      url: `${ISSUER}/#/?ticket=${ticketId}`,
    });
    // Neither reached the engine.
    expect(engine.calls.length).toBe(before);

    await call(a.access, 'take_transition', { ticket: ticketId, name: 'send_back', text: 'Again' });
    expect(engine.calls.at(-1)).toMatchObject({
      sessionId,
      event: { type: 'human.transition', name: 'send_back', text: 'Again', actor: 'ui' },
    });
  });

  it('cancel_ticket applies operator.cancel; an engine refusal is a tool error', async () => {
    const a = await connect();
    const { ticketId, sessionId } = await seedTicketSession(a.user.accountId, 'needs_input');
    // The fake engine has no snapshot for this session, so it rejects the event.
    const res = await call(a.access, 'cancel_ticket', { ticket: ticketId, reason: 'Not needed' });
    expect(engine.calls.at(-1)).toMatchObject({
      sessionId,
      event: { type: 'operator.cancel', reason: 'Not needed' },
    });
    expect(res.isError).toBe(true);
  });

  it('reopen_ticket resumes a done ticket and refuses a live one', async () => {
    const a = await connect();
    const live = await seedTicketSession(a.user.accountId, 'needs_input');
    const refused = await call(a.access, 'reopen_ticket', { ticket: live.ticketId, text: 'More' });
    expect(refused.isError).toBe(true);
    expect(errorOf(refused).code).toBe('conflict');

    const done = await seedTicketSession(a.user.accountId, 'done');
    const res = await call(a.access, 'reopen_ticket', { ticket: done.ticketId, text: 'Add docs' });
    expect(res.isError).toBe(false);
    const newId = res.body.session_id as string;
    const s = await db.pool.query<{ status: string; ticket_id: string }>(
      'SELECT status, ticket_id FROM session WHERE id = $1',
      [newId],
    );
    expect(s.rows[0]).toEqual({ status: 'queued', ticket_id: done.ticketId });
  });

  it('list_machines shows only the account’s unrevoked machines', async () => {
    const a = await connect();
    const b = await connect();
    const id = `mcp-m-${randomBytes(4).toString('hex')}`;
    await db.pool.query(
      'INSERT INTO machine (id, account_id, name, hostname, os, arch, cpu_total, mem_total_mb, ' +
        'disk_free_mb, budget_cpu, budget_mem_mb, max_sessions, max_concurrent_builds) ' +
        "VALUES ($1, $2, 'Laptop', 'h', 'darwin', 'arm64', 8, 16000, 100000, 4, 8000, 2, 1)",
      [id, a.user.accountId],
    );
    await db.pool.query(
      'INSERT INTO machine_repo (machine_id, account_id, repo, path, head_commit, tree_clean, remote) ' +
        "VALUES ($1, $2, 'github.com/acme/app', '/src/app', 'abc', true, 'github.com/acme/app')",
      [id, a.user.accountId],
    );
    const res = await call(a.access, 'list_machines', {});
    expect(res.body.machines).toEqual([
      expect.objectContaining({
        id,
        name: 'Laptop',
        max_sessions: 2,
        running_sessions: 0,
        repos: ['github.com/acme/app'],
      }),
    ]);
    expect((await call(b.access, 'list_machines', {})).body.machines).toEqual([]);
  });

  it('every ticket tool answers not_found for another account’s ticket', async () => {
    const a = await connect();
    const b = await connect();
    const { ticketId } = await seedTicketSession(a.user.accountId, 'needs_input');
    const before = engine.calls.length;
    for (const [tool, args] of [
      ['get_ticket', {}],
      ['get_ticket_artifacts', {}],
      ['message_agent', { text: 'x' }],
      ['wait_for_updates', { since: 0, timeout_seconds: 0 }],
      ['answer_input', { answer: 'x' }],
      ['take_transition', { name: 'send_back' }],
      ['reopen_ticket', { text: 'x' }],
      ['cancel_ticket', {}],
    ] as const) {
      const r = await call(b.access, tool, { ticket: ticketId, ...args });
      expect(r.isError, tool).toBe(true);
      expect(errorOf(r).code, tool).toBe('not_found');
    }
    expect(engine.calls.length).toBe(before);
  });
});

// ADR-0031: conversational clients (waiting_on, artifacts, messages, long poll).
describe('/mcp for conversational clients', () => {
  // /oauth/register, authorize and token allow 30 / min per IP, and the blocks above use all of
  // it: this block runs on its own API instance (its own in-memory limits; the same database,
  // engine and buses), swapped in for the file's helpers and restored after.
  let a: Awaited<ReturnType<typeof connect>>;
  let b: Awaited<ReturnType<typeof connect>>;
  let main: TestApi;
  beforeAll(async () => {
    main = api;
    api = await startApi({ db: db.pool, auth: AUTH, engine, boardBus, outputBus, transcripts });
    a = await connect(await signedInUser({ admin: true }));
    b = await connect();
  });
  afterAll(async () => {
    await api.close();
    api = main;
  });
  /** A session of `accountId` in `implement` (an agent state), as given. */
  async function seedAgentSession(
    accountId: string,
    opts: {
      status?: 'running' | 'needs_input' | 'done';
      context?: Record<string, unknown>;
      machine?: boolean;
      question?: string;
    } = {},
  ) {
    const { ticketId, sessionId } = await seedTicketSession(accountId, 'needs_input');
    let machineId: string | null = null;
    if (opts.machine) {
      machineId = `mcp-m-${randomBytes(4).toString('hex')}`;
      await db.pool.query(
        'INSERT INTO machine (id, account_id, name, hostname, os, arch, cpu_total, mem_total_mb, ' +
          'disk_free_mb, budget_cpu, budget_mem_mb, max_sessions, max_concurrent_builds) ' +
          "VALUES ($1, $2, 'Laptop', 'h', 'darwin', 'arm64', 8, 16000, 100000, 4, 8000, 2, 1)",
        [machineId, accountId],
      );
    }
    await db.pool.query(
      "UPDATE session SET status = $2, workflow_state = 'implement', context = $3, " +
        'machine_id = $4 WHERE id = $1',
      [sessionId, opts.status ?? 'running', JSON.stringify(opts.context ?? {}), machineId],
    );
    let inputId: string | null = null;
    if (opts.question !== undefined) {
      const ir = await db.pool.query<{ id: string }>(
        "INSERT INTO input_request (session_id, kind, question) VALUES ($1, 'agent_question', $2) " +
          'RETURNING id',
        [sessionId, opts.question],
      );
      inputId = ir.rows[0]!.id;
    }
    engine.seed({ ...SNAPSHOT_FIXTURE, id: sessionId, fencing_token: 1 });
    return { ticketId, sessionId, inputId, machineId };
  }

  it('get_ticket says who it waits on, in one field, with a status report', async () => {
    const working = await seedAgentSession(a.user.accountId, {
      context: { plan: { plan: '1. Draft\n2. Send', summary: 'Draft then send.' } },
    });
    const got = await call(a.access, 'get_ticket', { ticket: working.ticketId });
    expect(got.body).toMatchObject({
      state: 'implement',
      status: 'running',
      waiting_on: 'agent',
      status_line: expect.stringContaining('The agent is working in implement') as string,
      cursor: expect.any(Number) as number,
    });
    expect(got.body.status_report).toContain('Plan summary: Draft then send.');

    const asked = await seedAgentSession(a.user.accountId, {
      status: 'needs_input',
      question: 'Blue or red?',
    });
    const q = await call(a.access, 'get_ticket', { ticket: asked.ticketId });
    expect(q.body).toMatchObject({
      waiting_on: 'you',
      status_line: 'Waiting on you: the agent asks: "Blue or red?"',
    });
    // list_tickets agrees, and needs_input=true means "waits on the user".
    const listed = await call(a.access, 'list_tickets', { needs_input: true, limit: 50 });
    const ids = (listed.body.tickets as { id: string }[]).map((t) => t.id);
    expect(ids).toContain(asked.ticketId);
    expect(ids).not.toContain(working.ticketId);
    expect(listed.body.tickets).toContainEqual(
      expect.objectContaining({ id: asked.ticketId, waiting_on: 'you' }),
    );
  });

  it('get_ticket_artifacts reads the plan in pages, results, output and the transcript', async () => {
    const long = 'p'.repeat(7000);
    const { ticketId, sessionId } = await seedAgentSession(a.user.accountId, {
      context: { plan: { plan: long, summary: 'Big plan.' }, implement: { pr: 'x' } },
      machine: true,
    });
    const first = await call(a.access, 'get_ticket_artifacts', { ticket: ticketId });
    expect(first.body).toMatchObject({
      from_state: 'plan',
      summary: 'Big plan.',
      cursor: 0,
      next_cursor: 6000,
      total_chars: 7000,
    });
    expect((first.body.plan as string).length).toBe(6000);
    const second = await call(a.access, 'get_ticket_artifacts', { ticket: ticketId, cursor: 6000 });
    expect(second.body).toMatchObject({ next_cursor: null });
    expect((second.body.plan as string).length).toBe(1000);

    const results = await call(a.access, 'get_ticket_artifacts', {
      ticket: ticketId,
      what: 'results',
    });
    expect(Object.keys(results.body.results as object).sort()).toEqual(['implement', 'plan']);
    const one = await call(a.access, 'get_ticket_artifacts', {
      ticket: ticketId,
      what: 'results',
      state: 'implement',
    });
    expect(JSON.parse(one.body.result as string)).toEqual({ pr: 'x' });
    const missing = await call(a.access, 'get_ticket_artifacts', {
      ticket: ticketId,
      what: 'results',
      state: 'nope',
    });
    expect(errorOf(missing).code).toBe('not_found');

    outputBus.append(sessionId, 'assistant', 'Drafting the memo.');
    outputBus.append(sessionId, 'tool_use', 'Edit memo.md');
    const out = await call(a.access, 'get_ticket_artifacts', { ticket: ticketId, what: 'output' });
    expect(out.body.output).toBe('Drafting the memo.');

    transcriptAnswer = { status: 'offline' };
    const offline = await call(a.access, 'get_ticket_artifacts', {
      ticket: ticketId,
      what: 'transcript',
    });
    expect(errorOf(offline).code).toBe('machine_offline');
    transcriptAnswer = {
      status: 'ok',
      truncated: false,
      chunks: [
        { stream: 'user', text: 'Start', ts: '2026-11-03T10:00:00.000Z' },
        { stream: 'tool_use', text: 'Read', ts: '2026-11-03T10:00:01.000Z' },
        { stream: 'assistant', text: 'Done.', ts: '2026-11-03T10:00:02.000Z' },
      ],
    };
    const tr = await call(a.access, 'get_ticket_artifacts', {
      ticket: ticketId,
      what: 'transcript',
    });
    expect(tr.body).toMatchObject({
      messages: [
        { from: 'user', text: 'Start' },
        { from: 'agent', text: 'Done.' },
      ],
      next_cursor: null,
    });
  });

  it('get_ticket_artifacts lists the proposed follow-up tickets (06 §Proposed tickets)', async () => {
    const proposed = { title: 'Speed up CI', repo: 'github.com/acme/app', why: 'Slow.' };
    const { ticketId } = await seedAgentSession(a.user.accountId, {
      context: { implement: { summary: 's', proposed_tickets: [proposed, { title: 1 }] } },
    });
    const res = await call(a.access, 'get_ticket_artifacts', {
      ticket: ticketId,
      what: 'proposals',
    });
    expect(res.body.proposals).toEqual([
      expect.objectContaining({ ...proposed, state: 'implement', status: 'pending' }),
    ]);
    const results = await call(a.access, 'get_ticket_artifacts', {
      ticket: ticketId,
      what: 'results',
    });
    expect(results.body.pending_proposals).toEqual([
      expect.objectContaining({ title: proposed.title, repo: proposed.repo }),
    ]);
  });

  it('decide_proposed_ticket approves (once) or dismisses a proposal (ADR-0034)', async () => {
    const one = { title: 'Speed up CI', repo: 'github.com/acme/app', why: 'Slow.' };
    const two = { title: 'Fix docs', repo: 'github.com/acme/app', why: 'Stale.' };
    const { ticketId } = await seedAgentSession(a.user.accountId, {
      context: { implement: { summary: 's', proposed_tickets: [one, two] } },
    });
    const listed = await call(a.access, 'get_ticket_artifacts', {
      ticket: ticketId,
      what: 'proposals',
    });
    const [p1, p2] = listed.body.proposals as { id: string }[];

    const approved = await call(a.access, 'decide_proposed_ticket', {
      ticket: ticketId.slice(0, 8),
      proposal_id: p1!.id,
      decision: 'approve',
      title: 'Speed up CI (edited)',
    });
    expect(approved.isError).toBe(false);
    expect(approved.body).toMatchObject({ proposal_id: p1!.id, status: 'approved' });
    const created = approved.body.ticket_id as string;
    const got = await call(a.access, 'get_ticket', { ticket: created });
    expect(got.body).toMatchObject({ id: created, title: 'Speed up CI (edited)' });
    // Idempotent: the same ticket again.
    const again = await call(a.access, 'decide_proposed_ticket', {
      ticket: ticketId,
      proposal_id: p1!.id,
      decision: 'approve',
    });
    expect(again.body).toMatchObject({ ticket_id: created });
    // An approved one can't be dismissed.
    const late = await call(a.access, 'decide_proposed_ticket', {
      ticket: ticketId,
      proposal_id: p1!.id,
      decision: 'dismiss',
    });
    expect(errorOf(late).code).toBe('conflict');

    const dismissed = await call(a.access, 'decide_proposed_ticket', {
      ticket: ticketId,
      proposal_id: p2!.id,
      decision: 'dismiss',
    });
    expect(dismissed.body).toEqual({ proposal_id: p2!.id, status: 'dismissed' });
    // Another account sees neither the ticket nor its proposals.
    const other = await call(b.access, 'decide_proposed_ticket', {
      ticket: ticketId,
      proposal_id: p2!.id,
      decision: 'dismiss',
    });
    expect(errorOf(other).code).toBe('not_found');
  });

  it('message_agent talks to a working agent, and never answers its question by accident', async () => {
    const working = await seedAgentSession(a.user.accountId);
    const sent = await call(a.access, 'message_agent', {
      ticket: working.ticketId,
      text: 'Also add a test',
    });
    expect(sent.body).toEqual({ ok: true, delivered: 'live', waiting_on: 'agent' });
    expect(engine.calls.at(-1)).toMatchObject({
      sessionId: working.sessionId,
      event: { type: 'operator.message', text: 'Also add a test' },
    });
    expect(outputBus.snapshot(working.sessionId).at(-1)).toMatchObject({
      stream: 'user',
      text: 'Also add a test',
    });

    const asked = await seedAgentSession(a.user.accountId, {
      status: 'needs_input',
      question: 'Ship it?',
    });
    const before = engine.calls.length;
    const refused = await call(a.access, 'message_agent', {
      ticket: asked.ticketId,
      text: 'Summarize',
    });
    expect(errorOf(refused)).toMatchObject({
      code: 'question_open',
      input_request_id: asked.inputId,
    });
    expect(engine.calls.length).toBe(before);
    const answered = await call(a.access, 'message_agent', {
      ticket: asked.ticketId,
      text: 'Yes',
      as_answer: true,
    });
    expect(answered.body).toMatchObject({ ok: true, delivered: 'answer' });
    expect(engine.calls.at(-1)).toMatchObject({
      event: { type: 'input.provided', input_request_id: asked.inputId, answer: 'Yes' },
    });

    const done = await seedTicketSession(a.user.accountId, 'done');
    const late = await call(a.access, 'message_agent', { ticket: done.ticketId, text: 'More' });
    expect(errorOf(late).code).toBe('wrong_state');
    expect(errorOf(late).message).toContain('reopen_ticket');
  });

  it('wait_for_updates returns the account’s changed tickets after a cursor, or times out', async () => {
    const mine = await seedAgentSession(a.user.accountId, {
      status: 'needs_input',
      question: 'Which one?',
    });
    const theirs = await seedAgentSession(b.user.accountId);
    const start = await call(a.access, 'wait_for_updates', {});
    const cursor = start.body.cursor as number;
    expect(start.body).toMatchObject({ changes: [], timed_out: false });

    const statusEvent = (sessionId: string) =>
      db.pool.query(
        "INSERT INTO event (session_id, type, payload) VALUES ($1, 'session.status', $2)",
        [
          sessionId,
          JSON.stringify({ from: 'running', to: 'needs_input', workflow_state: 'implement' }),
        ],
      );
    // Another account's change only moves the cursor; the wait times out.
    await statusEvent(theirs.sessionId);
    const quiet = await call(a.access, 'wait_for_updates', { since: cursor, timeout_seconds: 1 });
    expect(quiet.body).toMatchObject({ changes: [], timed_out: true });
    expect(quiet.body.cursor as number).toBeGreaterThan(cursor);

    // Two events for one ticket collapse to one change, as the ticket is now; a publish wakes it.
    const waiting = call(a.access, 'wait_for_updates', {
      since: quiet.body.cursor,
      needs_you_only: true,
      timeout_seconds: 20,
    });
    await new Promise((r) => setTimeout(r, 200));
    await statusEvent(mine.sessionId);
    await statusEvent(mine.sessionId);
    boardBus.publish({
      type: 'session.status',
      id: 1,
      ts: new Date().toISOString(),
      session_id: mine.sessionId,
      from: 'running',
      to: 'needs_input',
      workflow_state: 'implement',
    });
    const woke = await waiting;
    expect(woke.body).toMatchObject({
      timed_out: false,
      changes: [
        {
          id: mine.ticketId,
          waiting_on: 'you',
          question: 'Which one?',
        },
      ],
    });
  });

  it('lists the same tools, in the same order, for every caller', async () => {
    const names = async (token: string) =>
      ((await mcp(token, 'tools/list')).json.result as { tools: { name: string }[] }).tools.map(
        (t) => t.name,
      );
    expect(await names(a.access)).toEqual(await names(b.access));
  });
});

// ADR-0032: recurring schedules, over MCP.
describe('/mcp schedule tools', () => {
  // Its own API instance for its own OAuth rate limits (as '/mcp for conversational clients').
  let main: TestApi;
  beforeAll(async () => {
    main = api;
    api = await startApi({ db: db.pool, auth: AUTH, engine, boardBus, outputBus, transcripts });
  });
  afterAll(async () => {
    await api.close();
    api = main;
  });

  it('save, list, run now, pause and delete a schedule, inside the account', async () => {
    const a = await connect();
    const b = await connect();
    const machineId = `mcp-sch-${randomBytes(4).toString('hex')}`;
    await db.pool.query(
      'INSERT INTO machine (id, account_id, name, hostname, os, arch, cpu_total, mem_total_mb, ' +
        'disk_free_mb, budget_cpu, budget_mem_mb, max_sessions, max_concurrent_builds) ' +
        "VALUES ($1, $2, 'Work laptop', 'wl', 'win32', 'x64', 8, 16000, 100000, 4, 8000, 2, 1)",
      [machineId, a.user.accountId],
    );
    await db.pool.query(
      'INSERT INTO machine_repo (machine_id, account_id, repo, path, head_commit, tree_clean, remote) ' +
        "VALUES ($1, $2, 'github.com/acme/app', '/src/app', 'abc', true, 'github.com/acme/app')",
      [machineId, a.user.accountId],
    );

    const missing = await call(a.access, 'save_schedule', { name: 'No cron' });
    expect([missing.isError, errorOf(missing).code]).toEqual([true, 'invalid_input']);
    const tooOften = await call(a.access, 'save_schedule', {
      name: 'Too often',
      cron: '*/5 * * * *',
      title: 'x',
      repo: 'github.com/acme/app',
      kind: 'work',
    });
    expect([tooOften.isError, errorOf(tooOften).code]).toEqual([true, 'invalid_input']);

    const saved = await call(a.access, 'save_schedule', {
      name: 'PRs and Jira',
      cron: '0 9 * * 1-5',
      timezone: 'America/Toronto',
      title: 'Keep my PRs and Jira up to date',
      body: 'Use the mtd skills on every open PR and its Jira ticket. '.repeat(10),
      repo: 'https://github.com/Acme/App.git',
      kind: 'work',
      machines: ['work laptop'],
    });
    expect(saved.isError).toBe(false);
    const id = saved.body.id as string;
    expect(saved.body).toMatchObject({
      ok: true,
      repo: 'github.com/Acme/App',
      workflow_id: 'routine',
      machine_ids: [machineId],
      enabled: true,
    });

    const listed = await call(a.access, 'list_schedules', {});
    const [only] = listed.body.schedules as Record<string, unknown>[];
    expect(only).toMatchObject({ id, name: 'PRs and Jira', body_truncated: true });
    expect((only!.body as string).length).toBeLessThanOrEqual(300);
    expect((await call(b.access, 'list_schedules', {})).body.schedules).toEqual([]);

    const run = await call(a.access, 'run_schedule_now', { id });
    expect(run.isError).toBe(false);
    const ticketId = run.body.id as string;
    const ticket = await call(a.access, 'get_ticket', { ticket: ticketId });
    expect(ticket.isError).toBe(false);
    expect(String(ticket.body.title)).toMatch(/^Keep my PRs and Jira up to date · /);
    const again = await call(a.access, 'run_schedule_now', { id });
    expect([again.isError, errorOf(again).code]).toEqual([true, 'previous_run_open']);
    const fromB = await call(b.access, 'run_schedule_now', { id });
    expect([fromB.isError, errorOf(fromB).code]).toEqual([true, 'not_found']);

    const paused = await call(a.access, 'save_schedule', { id, enabled: false });
    expect(paused.body).toMatchObject({ enabled: false, next_run_at: null });
    const editB = await call(b.access, 'save_schedule', { id, enabled: true });
    expect([editB.isError, errorOf(editB).code]).toEqual([true, 'not_found']);

    const delB = await call(b.access, 'delete_schedule', { id });
    expect([delB.isError, errorOf(delB).code]).toEqual([true, 'not_found']);
    expect((await call(a.access, 'delete_schedule', { id })).body).toEqual({ ok: true });
    expect((await call(a.access, 'list_schedules', {})).body.schedules).toEqual([]);
  });
});

// ADR-0030: per-repo checks and the workflow, over MCP.
describe('/mcp workflow tools', () => {
  const M1_CHECKS = [
    { name: 'Web build', cmd: 'cd m-one && npm ci && npm run build', timeout: '15m' },
    { name: '.NET tests', cmd: 'vstest.console.exe Com.Method.Tests.dll' },
  ];

  it('set, get, list and clear a repo’s checks, inside the account', async () => {
    await seedConductorWorkflow(db.pool, { log: null });
    const a = await connect();
    const b = await connect();
    const none = await call(a.access, 'get_repo_checks', { repo: 'github.com/Acme/MethodUI' });
    expect(none.body.override).toBeNull();
    const gates = none.body.effective as { at: string; source: string; checks: unknown[] }[];
    expect(gates.length).toBeGreaterThan(0);
    expect(gates.every((g) => g.source === 'workflow')).toBe(true);
    expect(gates.map((g) => g.at)).toContain('implementing.pr_ready_for_review');

    const set = await call(a.access, 'set_repo_checks', {
      repo: 'https://github.com/Acme/MethodUI.git',
      setup: '',
      checks: M1_CHECKS,
    });
    expect(set.isError).toBe(false);
    expect(set.body).toMatchObject({
      ok: true,
      repo: 'github.com/acme/methodui',
      setup: '',
      checks: M1_CHECKS,
      updated_by: `mcp:${a.user.email}`,
    });

    const got = await call(a.access, 'get_repo_checks', { repo: 'github.com/acme/methodui' });
    expect(got.body.override).toMatchObject({ setup: '', checks: M1_CHECKS });
    expect(
      (got.body.effective as { source: string; checks: unknown[] }[]).every(
        (g) => g.source === 'override' && JSON.stringify(g.checks) === JSON.stringify(M1_CHECKS),
      ),
    ).toBe(true);
    const listed = await call(a.access, 'list_repo_checks', {});
    expect((listed.body.repos as { repo: string }[]).map((r) => r.repo)).toEqual([
      'github.com/acme/methodui',
    ]);

    // B sees none of it, and can't clear it.
    expect((await call(b.access, 'list_repo_checks', {})).body.repos).toEqual([]);
    const fromB = await call(b.access, 'get_repo_checks', { repo: 'github.com/acme/methodui' });
    expect(fromB.body.override).toBeNull();
    const clearB = await call(b.access, 'clear_repo_checks', { repo: 'github.com/acme/methodui' });
    expect([clearB.isError, errorOf(clearB).code]).toEqual([true, 'not_found']);

    const cleared = await call(a.access, 'clear_repo_checks', { repo: 'github.com/acme/methodui' });
    expect(cleared.body).toEqual({ ok: true });
    expect((await call(a.access, 'list_repo_checks', {})).body.repos).toEqual([]);
  });

  it('set_repo_checks refuses duplicate names and empty commands', async () => {
    const a = await connect();
    const dup = await call(a.access, 'set_repo_checks', {
      repo: 'github.com/acme/app',
      checks: [
        { name: 'Build', cmd: 'make' },
        { name: 'Build', cmd: 'make test' },
      ],
    });
    expect([dup.isError, errorOf(dup).code]).toEqual([true, 'invalid_input']);
    const blank = await call(a.access, 'set_repo_checks', {
      repo: 'github.com/acme/app',
      checks: [{ name: 'Build', cmd: '   ' }],
    });
    expect([blank.isError, errorOf(blank).code]).toEqual([true, 'invalid_input']);
    expect((await call(a.access, 'list_repo_checks', {})).body.repos).toEqual([]);
  });

  it('get_workflow outlines the workflow, or returns one state in full', async () => {
    await seedConductorWorkflow(db.pool, { log: null });
    const a = await connect();
    const outline = await call(a.access, 'get_workflow', {});
    expect(outline.isError).toBe(false);
    expect(outline.body).toMatchObject({ id: 'conductor', start: 'planning' });
    expect(outline.body.truncated).toBeUndefined();
    const states = outline.body.states as Record<string, { type: string; transitions: string[] }>;
    expect(states.implementing).toMatchObject({ type: 'agent' });
    expect(states.implementing!.transitions).toContain('pr_ready_for_review');
    expect(outline.body.check_gates).toEqual(
      expect.arrayContaining([expect.objectContaining({ at: 'implementing.pr_ready_for_review' })]),
    );
    const one = await call(a.access, 'get_workflow', { state: 'implementing' });
    expect(one.body).toMatchObject({ state: 'implementing', definition: { type: 'agent' } });
    const missing = await call(a.access, 'get_workflow', { state: 'nope' });
    expect([missing.isError, errorOf(missing).code]).toEqual([true, 'not_found']);
  });

  // ADR-0030 §Amendment: saving a workflow over MCP.
  const def = (over: Partial<WorkflowDefinitionInput> = {}) =>
    ({ ...structuredClone(CONDUCTOR_V4), ...over }) as Record<string, unknown>;
  const versionsOf = async (id: string) =>
    (
      await db.pool.query<{ version: number; created_by: string | null }>(
        'SELECT version, created_by FROM workflow_definition WHERE id = $1 ORDER BY version',
        [id],
      )
    ).rows;

  it('save_workflow refuses a non-admin, a truncated read and an invalid definition', async () => {
    const user = await connect();
    const denied = await call(user.access, 'save_workflow', { definition: def({ id: 'mcp_a' }) });
    expect([denied.isError, errorOf(denied).code]).toEqual([true, 'forbidden']);
    const denyAdopt = await call(user.access, 'adopt_default_workflow', {});
    expect([denyAdopt.isError, errorOf(denyAdopt).code]).toEqual([true, 'forbidden']);

    const admin = await connect(await signedInUser({ admin: true }));
    const cut = def({ id: 'mcp_a' }) as { states: Record<string, { prompt?: string }> };
    cut.states.planning!.prompt = 'Plan the work…[truncated]';
    const truncated = await call(admin.access, 'save_workflow', { definition: cut });
    expect([truncated.isError, errorOf(truncated).code]).toEqual([true, 'invalid_input']);

    const invalid = await call(admin.access, 'save_workflow', {
      definition: def({ id: 'mcp_a', start: 'nope' }),
    });
    expect([invalid.isError, errorOf(invalid).code]).toEqual([true, 'invalid_workflow']);
    const errors = errorOf(invalid).errors as { rule: number; path: string; message: string }[];
    const atStart = errors.filter((e) => e.path === 'start');
    expect(atStart.length).toBeGreaterThan(0);
    expect(atStart.every((e) => Number.isInteger(e.rule) && e.message.length > 0)).toBe(true);
    expect(await versionsOf('mcp_a')).toEqual([]);
  });

  it('save_workflow saves the next version, checks base_version, and keeps approvals', async () => {
    const admin = await connect(await signedInUser({ admin: true }));
    const first = await call(admin.access, 'save_workflow', { definition: def({ id: 'mcp_b' }) });
    expect(first.isError).toBe(false);
    expect(first.body).toEqual({ id: 'mcp_b', version: 1, default_available: null });
    const stale = await call(admin.access, 'save_workflow', {
      definition: def({ id: 'mcp_b' }),
      base_version: 7,
    });
    expect([stale.isError, errorOf(stale).code, errorOf(stale).latest]).toEqual([
      true,
      'conflict',
      1,
    ]);
    const second = await call(admin.access, 'save_workflow', {
      definition: def({ id: 'mcp_b' }),
      base_version: 1,
    });
    expect(second.body).toMatchObject({ id: 'mcp_b', version: 2 });
    expect(await versionsOf('mcp_b')).toEqual([
      { version: 1, created_by: `mcp:${admin.user.email}` },
      { version: 2, created_by: `mcp:${admin.user.email}` },
    ]);

    // A stored version with a human approval (written on the board): an MCP save without it is
    // refused.
    const gated = structuredClone(CONDUCTOR_V4_DEF) as unknown as {
      id: string;
      version: number;
      states: Record<string, { on: Record<string, string | object> }>;
    };
    const name = transitionsOf(CONDUCTOR_V4_DEF, 'needs_input', { actor: 'human' })[0]!.name;
    const t = gated.states.needs_input!.on[name];
    gated.states.needs_input!.on[name] = {
      ...(typeof t === 'string' ? { goto: t } : t),
      requires: { approvals: [{ id: 'migration', label: 'Approve', paths: ['**/migrations/**'] }] },
    };
    gated.id = 'mcp_c';
    await db.pool.query(
      "INSERT INTO workflow_definition (id, version, definition) VALUES ('mcp_c', 1, $1)",
      [JSON.stringify(gated)],
    );
    const weakened = await call(admin.access, 'save_workflow', {
      definition: def({ id: 'mcp_c' }),
    });
    expect([weakened.isError, errorOf(weakened).code]).toEqual([true, 'approval_weakened']);
    expect(errorOf(weakened).transitions).toEqual([`needs_input.${name}`]);
    expect((await versionsOf('mcp_c')).length).toBe(1);
  });

  it('an edit of conductor stops the seed; adopt_default_workflow restores the default', async () => {
    await seedConductorWorkflow(db.pool, { log: null });
    const admin = await connect(await signedInUser({ admin: true }));
    const before = await call(admin.access, 'get_workflow', {});
    expect(before.body.default_available).toBeNull();
    const latest = before.body.version as number;

    const edited = def() as { states: Record<string, { title?: string }> };
    edited.states.planning!.title = 'Plan it';
    const saved = await call(admin.access, 'save_workflow', {
      definition: edited,
      base_version: latest,
    });
    // The shipped v4 is still stored, so nothing newer is available yet; a later shipped version
    // would be (seed.test.ts), because the seed no longer follows an edited latest.
    expect(saved.body).toEqual({ id: 'conductor', version: latest + 1, default_available: null });
    expect(await seedConductorWorkflow(db.pool, { log: null })).toBe(false);
    const after = await call(admin.access, 'get_workflow', { state: 'planning' });
    expect(after.body).toMatchObject({
      version: latest + 1,
      default_available: null,
      definition: { title: 'Plan it' },
    });

    const adopted = await call(admin.access, 'adopt_default_workflow', {
      base_version: latest + 1,
    });
    expect(adopted.body).toEqual({ id: 'conductor', version: latest + 2, default_available: null });
    const back = await call(admin.access, 'get_workflow', { state: 'planning' });
    expect(back.body).toMatchObject({
      version: latest + 2,
      definition: { title: CONDUCTOR_V4_DEF.states.planning!.title },
    });
  });

  it('propose_change → apply_change → list_change_proposals, inside the account', async () => {
    const a = await minted();
    const b = await minted();
    const repo = 'github.com/acme/proposals';
    const proposal = {
      title: 'Build in m-one',
      change: { kind: 'repo_checks', repo, checks: { checks: M1_CHECKS } },
      rationale: 'The root has no package.json.',
      evidence: [{ finding_id: 'failing_check:npm run build', text: '3 of 3 runs failed' }],
      expected_effect: {
        metric: 'check_failure_rate',
        direction: 'down',
        text: 'The build stops failing.',
      },
      rollback: 'clear_repo_checks',
    };
    const bad = await call(a.access, 'propose_change', {
      ...proposal,
      change: { kind: 'machine_settings', permission_mode: 'bypassPermissions' },
    });
    expect([bad.isError, errorOf(bad).code]).toEqual([true, 'invalid_input']);

    const made = await call(a.access, 'propose_change', proposal);
    expect(made.body).toMatchObject({ status: 'proposed', target: repo, requires_admin: false });
    const id = made.body.id as string;
    // Nothing changed yet; another account can't see or apply it.
    expect((await call(a.access, 'get_repo_checks', { repo })).body.override).toBeNull();
    expect(errorOf(await call(b.access, 'list_change_proposals', { id })).code).toBe('not_found');
    expect(errorOf(await call(b.access, 'apply_change', { id, confirm: true })).code).toBe(
      'not_found',
    );
    // apply_change needs confirm: true.
    const noConfirm = await mcp(a.access, 'tools/call', {
      name: 'apply_change',
      arguments: { id },
    });
    expect((noConfirm.json.result as { isError?: boolean }).isError).toBe(true);

    const applied = await call(a.access, 'apply_change', { id, confirm: true });
    expect(applied.body).toMatchObject({ status: 'applied' });
    const now = await call(a.access, 'get_repo_checks', { repo });
    expect((now.body.override as { checks: unknown[] }).checks).toEqual(M1_CHECKS);
    const again = await call(a.access, 'apply_change', { id, confirm: true });
    expect(errorOf(again).code).toBe('already_applied');

    const one = await call(a.access, 'list_change_proposals', { id });
    expect(one.body).toMatchObject({ status: 'applied', review: { too_early: true } });
    const list = await call(a.access, 'list_change_proposals', {});
    expect(list.body).toMatchObject({ total: 1, next_cursor: null });
  });
});
