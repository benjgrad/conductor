import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLOSE_PROTOCOL,
  CLOSE_REASONS,
  CLOSE_REVOKED,
  CLOSE_UNAUTHORIZED,
  DAEMON_AUTH_HEADER,
  daemonAuthHeaderValue,
} from '@conductor/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import { ReconnectingWs } from './ws-client.js';

// M2-T04: the upgrade header and the fatal close codes.

const BACKOFF = { initialMs: 10, maxMs: 20, factor: 2 };

interface Server {
  wss: WebSocketServer;
  url: string;
  headers: (string | undefined)[];
  sockets: WebSocket[];
  rejected: number;
}

const servers: WebSocketServer[] = [];
const clients: ReconnectingWs[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  for (const wss of servers.splice(0)) {
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  }
});

async function server(rejectStatus: number | null = null): Promise<Server> {
  const s = { headers: [], sockets: [], rejected: 0 } as unknown as Server;
  s.wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: (_info, cb) => {
      if (rejectStatus === null) return cb(true);
      s.rejected++;
      cb(false, rejectStatus);
    },
  });
  servers.push(s.wss);
  s.wss.on('connection', (ws, req) => {
    s.headers.push(req.headers[DAEMON_AUTH_HEADER]);
    s.sockets.push(ws);
  });
  await new Promise<void>((r) => s.wss.once('listening', () => r()));
  s.url = `ws://127.0.0.1:${(s.wss.address() as AddressInfo).port}`;
  return s;
}

function client(url: string, headers?: Record<string, string>) {
  const ev = { opens: 0, closes: 0, fatal: [] as number[], logs: [] as string[] };
  const c = new ReconnectingWs(
    url,
    BACKOFF,
    {
      onOpen: () => ev.opens++,
      onMessage: () => {},
      onClose: () => ev.closes++,
      onFatal: (code) => ev.fatal.push(code),
    },
    { log: (m) => ev.logs.push(m), ...(headers ? { headers } : {}) },
  );
  clients.push(c);
  c.start();
  return { c, ev };
}

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 150)); // several backoff windows

describe('ReconnectingWs (M2-T04)', () => {
  it('sends the bearer header when enrolled and none in local mode', async () => {
    const s = await server();
    client(s.url, { [DAEMON_AUTH_HEADER]: daemonAuthHeaderValue('cred-1') });
    client(s.url);
    await until(() => s.headers.length === 2);
    expect(s.headers).toContain('Bearer cred-1');
    expect(s.headers).toContain(undefined);
  });

  it('close 4001 stops reconnecting and reports it once', async () => {
    const s = await server();
    const { c, ev } = client(s.url);
    await until(() => ev.opens === 1);
    s.sockets[0]!.close(CLOSE_REVOKED, CLOSE_REASONS[CLOSE_REVOKED]);
    await until(() => ev.fatal.length === 1);
    await settle();
    expect(ev.fatal).toEqual([CLOSE_REVOKED]);
    expect(s.sockets).toHaveLength(1);
    expect(c.failed).toBe(true);
    expect(ev.logs.join('\n')).toMatch(/machine revoked.*not reconnecting/);
    c.start(); // a failed client stays stopped
    await settle();
    expect(s.sockets).toHaveLength(1);
  });

  it('close 4003 is fatal too; 4005 says to re-run the install command', async () => {
    for (const code of [CLOSE_UNAUTHORIZED, CLOSE_PROTOCOL] as const) {
      const s = await server();
      const { ev } = client(s.url);
      await until(() => ev.opens === 1);
      s.sockets[0]!.close(code, CLOSE_REASONS[code]);
      await until(() => ev.fatal.length === 1);
      await settle();
      expect(s.sockets).toHaveLength(1);
      if (code === CLOSE_PROTOCOL) {
        expect(ev.logs.join('\n')).toContain('update the daemon: re-run the install command');
      }
    }
  });

  it('HTTP 401 at the upgrade is treated as unauthorized: no retries', async () => {
    const s = await server(401);
    const { ev } = client(s.url, { [DAEMON_AUTH_HEADER]: daemonAuthHeaderValue('revoked') });
    await until(() => ev.fatal.length === 1);
    await settle();
    expect(ev.fatal).toEqual([CLOSE_UNAUTHORIZED]);
    expect(s.rejected).toBe(1);
  });

  it('another refused upgrade, and an ordinary close, still reconnect', async () => {
    const bad = await server(503);
    const r = client(bad.url);
    await until(() => bad.rejected >= 2);
    expect(r.ev.fatal).toEqual([]);
    r.c.stop();

    const s = await server();
    const { ev } = client(s.url);
    await until(() => ev.opens === 1);
    s.sockets[0]!.close(1000);
    await until(() => ev.opens === 2);
    expect(ev.fatal).toEqual([]);
  });
});
