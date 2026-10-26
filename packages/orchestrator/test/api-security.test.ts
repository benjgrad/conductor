// M1-T14: the API's Host / Origin / content-type guard (09 §M1 local hardening), against the real
// createApi on a real listener. node:http is used (not fetch) so the tests can set Host / Origin.
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { conductorPort } from '@conductor/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/api/index.js';
import { HttpGuard, isLoopbackHostname, parseHostHeader } from '../src/api/security.js';
import { FakeEngineService, InMemoryBoardBus, InMemoryOutputBus } from '../src/contracts.js';
import type { ApiHandle } from '../src/main.js';
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
): Promise<{ status: number; body: { error?: { code: string; message: string } } }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (text += d));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as never) : {} }),
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
      expect(r.body.error?.code).toBe('bad_request');
    }
    // state-changing too, and unknown routes don't leak a 404
    expect((await send('POST', cancel, { ...json, host: 'evil.example' }, '{}')).status).toBe(403);
    expect((await send('GET', '/api/nope', { host: 'evil.example' })).status).toBe(403);
  });
});

describe('Origin check (CSRF)', () => {
  it('rejects a state-changing request from a foreign Origin', async () => {
    for (const origin of ['https://evil.example', 'null', 'http://localhost:9999', 'file://']) {
      const r = await send('POST', cancel, { ...json, origin }, '{}');
      expect(r.status, origin).toBe(403);
      expect(r.body.error?.message).toMatch(/origin/);
    }
  });

  it('allows same-origin, the orchestrator origin, the Vite dev origin and configured ones', async () => {
    for (const origin of [
      `http://127.0.0.1:${port}`, // same-origin with Host
      `http://localhost:${conductorPort(process.env)}`, // the orchestrator's own origin
      'http://localhost:5173',
      'http://127.0.0.1:5173',
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

describe('content-type on POST', () => {
  it('415 without application/json (no simple cross-site form posts)', async () => {
    for (const headers of [
      {},
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/x-www-form-urlencoded' },
      { 'content-type': 'multipart/form-data; boundary=x' },
    ]) {
      const r = await send('POST', cancel, headers, '{}');
      expect(r.status, JSON.stringify(headers)).toBe(415);
      expect(r.body.error?.code).toBe('bad_request');
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
