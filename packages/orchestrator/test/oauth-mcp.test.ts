// ADR-0028: the OAuth authorization server and the /mcp endpoint, password mode, end to end over
// HTTP against a test database (the routes, the security hook and the SDK transport are the
// subject). Needs `pnpm db:up`.
import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { API_PATHS } from '@conductor/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disableUser } from '../src/auth/admin-commands.js';
import { createSession } from '../src/auth/sessions.js';
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

beforeAll(async () => {
  api = await startApi({ db: db.pool, auth: AUTH });
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

async function signedInUser() {
  const u = await createUser(db.pool, { password: '', passwordHash: PASSWORD_HASH });
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
    expect(names.sort()).toEqual([
      'answer_input',
      'create_ticket',
      'get_ticket',
      'list_tickets',
      'take_transition',
    ]);

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
