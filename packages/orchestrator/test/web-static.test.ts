// M1-T07 / TD-127: the static web app never answers an API path (09 §Hosted security).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SECURITY_HEADERS } from '../src/api/security.js';
import { isApiPath, serveWebApp } from '../src/web-static.js';

let dir: string;
let server: Server;
let port: number;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'conductor-web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
  // The "API": anything the web app leaves alone.
  server = createServer((_req, res) => {
    res.writeHead(418, { 'content-type': 'text/plain' });
    res.end('api');
  });
  serveWebApp(server, dir);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string) =>
  new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
    (resolve, reject) => {
      request({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      })
        .on('error', reject)
        .end();
    },
  );

describe('serveWebApp', () => {
  it('leaves /api, /auth, /ws and every other API_PATHS route to the API', async () => {
    for (const path of [
      '/api',
      '/api/board',
      '/auth/invites/sometoken',
      '/auth/login',
      '/auth',
      '/ws/daemon',
      '/healthz',
      '/install.sh',
      '/downloads/conductor-daemon-1.0.0.tgz',
      '/downloads/x',
    ]) {
      const r = await get(path);
      expect(r.status, path).toBe(418);
      expect(isApiPath(path), path).toBe(true);
    }
  });

  it('serves the app shell for client-side routes, with the security headers', async () => {
    for (const path of [
      '/',
      '/signin',
      '/signup?invite=x',
      '/reset',
      '/sessions/abc',
      '/healthzz',
    ]) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
      expect(r.body).toContain('<title>app</title>');
      for (const [k, v] of Object.entries(SECURITY_HEADERS))
        expect(r.headers[k], `${path} ${k}`).toBe(v);
    }
  });
});
