import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  API_PATHS,
  BOARD_SSE_FIXTURES,
  encodeSseFrame,
  OUTPUT_CHUNK_FIXTURE,
  type BoardSseEvent,
  type OutputChunk,
} from '@conductor/shared';
import { EventSource } from 'eventsource';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiRequestError } from './client.js';
import { createHttpApi } from './http.js';
import { createMockApi } from './mock.js';

// The HTTP client over real sockets and a spec-compliant EventSource (the `eventsource`
// package; Node has none), against a stand-in server that speaks the T08 wire format:
// encodeSseFrame frames, Last-Event-ID from the header or `?last_event_id=`, the output ring
// replayed on every connect. A stand-in makes connection drops and ring replays easy to script;
// the client against the real orchestrator routes (createApi + Postgres) is
// http.orchestrator.test.ts.

const SESSION = OUTPUT_CHUNK_FIXTURE.session_id;

const boardLog: BoardSseEvent[] = [];
const ring: OutputChunk[] = [];
const boardConns = new Set<ServerResponse>();
const outputConns = new Set<ServerResponse>();
const resumeIds: (string | null)[] = [];
let server: Server;
let base: string;

function sse(res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(': connected\n\n');
}

function publish(ev: BoardSseEvent) {
  boardLog.push(ev);
  for (const res of boardConns) res.write(encodeSseFrame(ev.type, ev, ev.id));
}

function appendOutput(chunk: OutputChunk) {
  ring.push(chunk);
  for (const res of outputConns) res.write(encodeSseFrame('output', chunk));
}

/** Drop every open stream like a restart or a network blip would. */
function dropAll() {
  for (const res of [...boardConns, ...outputConns]) res.socket?.destroy();
  boardConns.clear();
  outputConns.clear();
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === API_PATHS.board) {
    const board = await createMockApi().getBoard();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...board, last_event_id: 0 }));
    return;
  }
  if (url.pathname === API_PATHS.boardStream) {
    const header = req.headers['last-event-id'];
    const raw =
      (typeof header === 'string' ? header : null) ?? url.searchParams.get('last_event_id');
    resumeIds.push(raw);
    const cursor = Number(raw ?? boardLog.at(-1)?.id ?? 0);
    sse(res);
    for (const ev of boardLog) if (ev.id > cursor) res.write(encodeSseFrame(ev.type, ev, ev.id));
    boardConns.add(res);
    req.on('close', () => boardConns.delete(res));
    return;
  }
  if (url.pathname === API_PATHS.sessionOutputStream(SESSION)) {
    sse(res);
    for (const c of ring) res.write(encodeSseFrame('output', c));
    outputConns.add(res);
    req.on('close', () => outputConns.delete(res));
    return;
  }
  if (req.method === 'POST' && url.pathname === API_PATHS.sessionInput(SESSION)) {
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'input_not_pending', message: 'not pending' } }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'not_found', message: `no route ${req.url}` } }));
}

beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  dropAll();
  await new Promise<void>((r) => server.close(() => r()));
});

const api = () =>
  createHttpApi({
    baseUrl: base,
    eventSource: (url) => new EventSource(url),
    backoff: { initialMs: 20, maxMs: 100 },
  });

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const ev = (id: number): BoardSseEvent => ({ ...BOARD_SSE_FIXTURES['session.status'], id });

describe('createHttpApi over HTTP', () => {
  it('REST: parses the board and surfaces ApiError bodies', async () => {
    const client = api();
    const board = await client.getBoard();
    expect(board.columns.needs_input.length).toBeGreaterThan(0);
    await expect(
      client.answer(SESSION, {
        input_request_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
        answer: 'x',
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'input_not_pending',
    } satisfies Partial<ApiRequestError>);
  });

  it('board: replays past last_event_id, survives a dropped connection with no gap or duplicate', async () => {
    publish(ev(1));
    publish(ev(2));
    publish(ev(3));
    const got: number[] = [];
    let opens = 0;
    const stop = api().streamBoard(1, {
      onEvent: (e) => got.push(e.id),
      onOpen: () => opens++,
    });
    await until(() => got.length === 2);
    publish(ev(4));
    await until(() => got.length === 3);

    dropAll();
    // Published while the client is disconnected: must arrive via the resume replay.
    publish(ev(5));
    publish(ev(6));
    await until(() => got.length === 5);
    publish(ev(7));
    await until(() => got.length === 6);
    stop();

    expect(got).toEqual([2, 3, 4, 5, 6, 7]);
    expect(opens).toBe(2);
    expect(resumeIds).toEqual(['1', '4']);
  });

  it('output: ring then live, and the ring replay after a reconnect is not duplicated', async () => {
    const chunk = (seq: number): OutputChunk => ({ ...OUTPUT_CHUNK_FIXTURE, seq, text: `${seq}` });
    appendOutput(chunk(0));
    const got: number[] = [];
    const stop = api().streamOutput(SESSION, { onEvent: (c) => got.push(c.seq) });
    await until(() => got.length === 1);
    appendOutput(chunk(1));
    await until(() => got.length === 2);
    dropAll();
    appendOutput(chunk(2));
    await until(() => got.length === 3);
    stop();
    expect(got).toEqual([0, 1, 2]);
  });
});
