// M1-T14: the API's Host / Origin / content-type guard (09 §M1 local hardening), against the real
// createApi on a real listener. node:http is used (not fetch) so the tests can set Host / Origin.
// M2-T08: error codes `forbidden` / `unsupported_media_type`, no Vite dev origins, the security
// headers on every response, and password mode (09 §Hosted security).
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { API_PATHS, conductorPort } from '@conductor/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/api/index.js';
import {
  HttpGuard,
  SECURITY_HEADERS,
  isLoopbackHostname,
  parseHostHeader,
} from '../src/api/security.js';
import { FakeEngineService, InMemoryBoardBus, InMemoryOutputBus } from '../src/contracts.js';
import type { ApiHandle } from '../src/main.js';
import { HTTPS_URL, passwordAuth, startApi, type TestApi } from './auth/helpers.js';
import { useTestDatabase } from './db.js';

const db = useTestDatabase();
let api: ApiHandle;
let port: number;
const SID = '00000000-0000-4000-8000-0000000000aa';

beforeAll(async () => {
  api = createApi({
    db: db.pool,
    engine: new FakeEngineService(),
    boardBus: new InMemoryBoardBus(),
    outputBus: new InMemoryOutputBus(),
    security: { allowedHosts: ['conductor.lan'], allowedOrigins: ['https://ui.example'] },
  });
  await api.listen(0, '127.0.0.1');
  port = (api.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await api.close();
});

function send(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: { error?: { code: string; message: string } };
}> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (text += d));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: text ? (JSON.parse(text) as never) : {},
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const json = { 'content-type': 'application/json' };
const cancel = `/api/sessions/${SID}/cancel`;

describe('Host check (DNS rebinding)', () => {
  it('allows loopback names and configured hosts', async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, 'localhost']) {
      expect((await send('GET', '/api/machines', { host })).status, host).toBe(200);
    }
    expect((await send('GET', '/api/machines', { host: `conductor.lan:${port}` })).status).toBe(
      200,
    );
  });

  it('rejects any other Host with 403 before routing', async () => {
    for (const host of [
      `evil.example:${port}`,
      'rebind.attacker.test',
      '127.0.0.1.evil.example',
      'localhost.evil.example',
      'x@localhost',
    ]) {
      const r = await send('GET', '/api/machines', { host });
      expect(r.status, host).toBe(403);
      expect(r.body.error?.code).toBe('forbidden');
    }
    // state-changing too, and unknown routes don't leak a 404
    expect((await send('POST', cancel, { ...json, host: 'evil.example' }, '{}')).status).toBe(403);
    expect((await send('GET', '/api/nope', { host: 'evil.example' })).status).toBe(403);
  });
});

describe('Origin check (CSRF)', () => {
  it('rejects a state-changing request from a foreign Origin', async () => {
    for (const origin of [
      'https://evil.example',
      'null',
      'http://localhost:9999',
      'file://',
      // TD-069: no Vite dev origins; the dev proxy rewrites Vite's own Origin (vite.config.ts)
      'http://localhost:5173',
      'http://127.0.0.1:4173',
    ]) {
      const r = await send('POST', cancel, { ...json, origin }, '{}');
      expect(r.status, origin).toBe(403);
      expect(r.body.error?.code).toBe('forbidden');
      expect(r.body.error?.message).toMatch(/origin/);
    }
  });

  it('allows same-origin, the orchestrator origin and configured ones', async () => {
    for (const origin of [
      `http://127.0.0.1:${port}`, // same-origin with Host
      `http://localhost:${conductorPort(process.env)}`, // the orchestrator's own origin
      'https://ui.example',
    ]) {
      // 404: the guard passed, the session doesn't exist
      expect((await send('POST', cancel, { ...json, origin }, '{}')).status, origin).toBe(404);
    }
    // no Origin (curl, the daemon, server-side callers) passes
    expect((await send('POST', cancel, json, '{}')).status).toBe(404);
  });

  it('does not apply to GET (read-only; the browser gets no CORS headers)', async () => {
    expect((await send('GET', '/api/machines', { origin: 'https://evil.example' })).status).toBe(
      200,
    );
  });
});

describe('content-type on unsafe requests', () => {
  it('415 without application/json (no simple cross-site form posts)', async () => {
    for (const headers of [
      {},
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/x-www-form-urlencoded' },
      { 'content-type': 'multipart/form-data; boundary=x' },
    ]) {
      const r = await send('POST', cancel, headers, '{}');
      expect(r.status, JSON.stringify(headers)).toBe(415);
      expect(r.body.error?.code).toBe('unsupported_media_type');
    }
    // every unsafe method, not only POST
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect((await send(method, cancel, { 'content-type': 'text/plain' }, 'x')).status).toBe(415);
    }
  });

  it('accepts application/json with parameters, and an empty JSON body', async () => {
    expect(
      (await send('POST', cancel, { 'content-type': 'application/json; charset=utf-8' }, '{}'))
        .status,
    ).toBe(404);
    expect((await send('POST', cancel, json)).status).toBe(404);
  });
});

describe('POST /api/sessions/:id/transition (ADR-0011) is guarded too', () => {
  const transition = `/api/sessions/${SID}/transition`;
  const body = JSON.stringify({ name: 'done' });

  it('403 from a foreign Origin, 415 without application/json, 404 once past the guard', async () => {
    const foreign = await send(
      'POST',
      transition,
      { ...json, origin: 'https://evil.example' },
      body,
    );
    expect(foreign.status).toBe(403);
    expect(foreign.body.error?.message).toMatch(/origin/);
    const plain = await send('POST', transition, { 'content-type': 'text/plain' }, body);
    expect(plain.status).toBe(415);
    expect((await send('POST', transition, json, body)).status).toBe(404);
  });
});

describe('HttpGuard helpers', () => {
  it('parses Host headers and recognises loopback', () => {
    expect(parseHostHeader('LocalHost:7400')).toEqual({ hostname: 'localhost', port: '7400' });
    expect(parseHostHeader('[::1]:80')).toEqual({ hostname: '::1', port: '80' });
    expect(parseHostHeader('a b')).toBeNull();
    expect(isLoopbackHostname('127.1.2.3')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1.nip.io')).toBe(false);
  });

  it('upgradeAllowed: no Origin passes, a foreign Origin fails', () => {
    const g = new HttpGuard({}, { CONDUCTOR_PORT: '7400' });
    expect(g.upgradeAllowed({ host: 'localhost:7400' })).toBe(true);
    expect(g.upgradeAllowed({ host: 'localhost:7400', origin: 'http://localhost:7400' })).toBe(
      true,
    );
    expect(g.upgradeAllowed({ host: 'localhost:7400', origin: 'https://evil.example' })).toBe(
      false,
    );
  });
});

/** The ADR-0017 headers, exactly. */
function expectSecurityHeaders(
  headers: Record<string, string | string[] | undefined>,
  what: string,
) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS))
    expect(headers[k], `${what}: ${k}`).toBe(v);
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-content-type-options']).toBe('nosniff');
}

describe('security headers (local mode)', () => {
  it('on 200, 403, 404 and 415 responses', async () => {
    expectSecurityHeaders((await send('GET', '/api/machines', {})).headers, '200');
    expectSecurityHeaders(
      (await send('GET', '/api/machines', { host: 'evil.example' })).headers,
      '403',
    );
    expectSecurityHeaders((await send('GET', '/api/nope', {})).headers, '404');
    expectSecurityHeaders((await send('POST', cancel, {}, '{}')).headers, '415');
  });
});

describe('password mode (09 §Hosted security)', () => {
  let pw: TestApi;
  const auth = passwordAuth(HTTPS_URL);
  const HOST = 'conductor.test';
  const ORIGIN = 'https://conductor.test';

  beforeAll(async () => {
    pw = await startApi({ db: db.pool, auth });
  });
  afterAll(async () => {
    await pw.close();
  });

  const post = (path: string, headers: Record<string, string>, body = '{}') =>
    pw.send('POST', path, {
      headers: { host: HOST, ...headers },
      body: JSON.parse(body) as unknown,
    });

  it('403 forbidden for a POST from a foreign Origin', async () => {
    for (const origin of [
      'https://evil.example',
      'http://conductor.test',
      'https://conductor.test:8443',
      'null',
    ]) {
      const r = await post(API_PATHS.authLogin, { origin });
      expect(r.status, origin).toBe(403);
      expect(r.json.error?.code).toBe('forbidden');
    }
  });

  it('403 without Origin unless Sec-Fetch-Site: same-origin; enroll is exempt', async () => {
    const raw = await rawPost(pw.port, API_PATHS.authLogout, { host: HOST, ...json });
    expect(raw.status).toBe(403);
    expect(raw.body.error?.code).toBe('forbidden');
    const crossSite = await rawPost(pw.port, API_PATHS.authLogout, {
      host: HOST,
      ...json,
      'sec-fetch-site': 'cross-site',
    });
    expect(crossSite.status).toBe(403);
    const same = await rawPost(pw.port, API_PATHS.authLogout, {
      host: HOST,
      ...json,
      'sec-fetch-site': 'same-origin',
    });
    expect(same.status).toBe(200);
    // the daemon's enroll call (no Origin, no Sec-Fetch-Site) passes the guard and needs no
    // session: the empty body reaches the M2-T17 route and is a 400, not a 401 / 403
    const enroll = await rawPost(pw.port, API_PATHS.machinesEnroll, { host: HOST, ...json });
    expect(enroll.status).toBe(400);
  });

  it('415 unsupported_media_type for text/plain', async () => {
    const r = await rawPost(pw.port, API_PATHS.authLogin, {
      host: HOST,
      origin: ORIGIN,
      'content-type': 'text/plain',
    });
    expect(r.status).toBe(415);
    expect(r.body.error?.code).toBe('unsupported_media_type');
  });

  it('403 for any Host but the public one (loopback included)', async () => {
    for (const host of [
      'evil.test',
      `127.0.0.1:${pw.port}`,
      'localhost',
      'conductor.test.evil.test',
    ]) {
      const r = await pw.send('GET', API_PATHS.authMe, { headers: { host } });
      expect(r.status, host).toBe(403);
      expect(r.json.error?.code).toBe('forbidden');
    }
    // the default port is the same host
    expect(
      (await pw.send('GET', API_PATHS.board, { headers: { host: 'conductor.test:443' } })).status,
    ).toBe(401);
  });

  it('/api/* without a session is 401 unauthorized, unknown routes and SSE included', async () => {
    for (const path of [API_PATHS.board, API_PATHS.machines, API_PATHS.boardStream, '/api/nope']) {
      const r = await pw.send('GET', path);
      expect(r.status, path).toBe(401);
      expect(r.json.error?.code).toBe('unauthorized');
    }
    // spellings the router may resolve to an /api route are judged on the matched route
    for (const path of [
      '/%61pi/board',
      '/%2Fapi/board',
      '/API/board',
      '//api/board',
      '/api/../api/board',
    ]) {
      const r = await pw.send('GET', path);
      expect([401, 404], path).toContain(r.status);
    }
    expect((await pw.send('GET', '/%61pi/board')).status).toBe(401);
    const bogus = await pw.send('GET', API_PATHS.board, {
      headers: { cookie: '__Host-conductor_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    });
    expect(bogus.status).toBe(401);
  });

  it('every response has the CSP and nosniff headers', async () => {
    expectSecurityHeaders((await pw.send('GET', API_PATHS.board)).headers, '401');
    expectSecurityHeaders(
      (await pw.send('GET', API_PATHS.board, { headers: { host: 'evil.test' } })).headers,
      '403',
    );
    expectSecurityHeaders(
      (await post(API_PATHS.authLogin, { origin: ORIGIN }, '{"email":"a@b.c","password":"x"}'))
        .headers,
      '401 login',
    );
    expectSecurityHeaders((await post('/auth/nope', { origin: ORIGIN })).headers, '404');
    expectSecurityHeaders(
      (
        await rawPost(pw.port, API_PATHS.authLogin, {
          host: HOST,
          origin: ORIGIN,
          'content-type': 'text/plain',
        })
      ).headers,
      '415',
    );
  });
});

describe('the web app loads under the CSP', () => {
  it('index.html has no inline script or event handler (source, and the build when present)', () => {
    const web = new URL('../../web/', import.meta.url);
    const files = ['index.html', 'dist/index.html']
      .map((f) => new URL(f, web))
      .filter((u) => existsSync(u));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const html = readFileSync(file, 'utf8');
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
      expect(scripts.length, file.pathname).toBeGreaterThan(0);
      for (const [, attrs, body] of scripts) {
        expect(attrs, file.pathname).toMatch(/\bsrc=/);
        expect(body!.trim(), file.pathname).toBe('');
      }
      expect(html, file.pathname).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html, file.pathname).not.toMatch(/javascript:/i);
    }
  });
});

/** A POST with exactly these headers (no Origin unless given). */
function rawPost(
  p: number,
  path: string,
  headers: Record<string, string>,
  body = '{}',
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: { error?: { code: string; message: string } };
}> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: p, method: 'POST', path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (text += d));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: text ? (JSON.parse(text) as never) : {},
        }),
      );
    });
    req.on('error', reject);
    req.end(body);
  });
}
