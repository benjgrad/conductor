// M1-T07 wiring: the whole orchestrator started by `main()` (real createDb, engine, gateway, API,
// outbox dispatcher, timeout sweep) on a per-run Postgres database, serving a built web app next
// to the API. No daemon here: the ask/answer cases that drove the in-process TS Daemon
// (ask-answer.test.ts) moved to the E2E suite (e2e/m1.e2e.test.ts, MR-T16), where they run against
// the real daemon binary.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_PATHS } from '@conductor/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type Orchestrator } from '../../src/main.js';
import { useTestDatabase } from '../db.js';

const db = useTestDatabase();

let tmp: string;
let port: number;
let orch: Orchestrator;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'conductor-t07-'));
  const webDir = join(tmp, 'web');
  mkdirSync(join(webDir, 'assets'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>conductor</title>');
  writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)');
  port = await freePort();
  orch = await main({
    env: {
      DATABASE_URL: db.url,
      CONDUCTOR_PORT: String(port),
      CONDUCTOR_WEB_DIR: webDir,
    },
    signals: false,
    log: () => {},
  });
});

afterEach(async () => {
  await orch.stop();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);

describe('main() wiring (M1-T07)', () => {
  it('serves the built web app next to the API', async () => {
    const index = await api('/');
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(await index.text()).toContain('<title>conductor</title>');
    const asset = await api('/assets/app.js');
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(await asset.text()).toBe('console.log(1)');
    // Client-side routes get the shell; a missing asset and /api stay with the API.
    expect(await (await api('/sessions/abc')).text()).toContain('<title>conductor</title>');
    expect((await api('/assets/missing.js')).status).toBe(404);
    expect((await api('/%2e%2e/%2e%2e/package.json')).status).toBe(404);
    const board = await api(API_PATHS.board);
    expect(board.status).toBe(200);
    expect(board.headers.get('content-type')).toContain('application/json');
    expect((await api('/api/nope')).status).toBe(404);
  });
});
