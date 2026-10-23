// ADR-0008 on the orchestrator: the gateway's transcript request/response, the REST routes
// (GET /transcript, POST /reopen), reopenSession's checks and carried columns, and the claim's
// branch pin that sends a reopened session back to its machine. Real Postgres (`pnpm db:up`).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ReopenSessionResponseSchema,
  StartSessionPayloadSchema,
  TranscriptResponseSchema,
  type TranscriptChunk,
} from '@conductor/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../../src/api/index.js';
import {
  commandEnvelopeForOutboxRow,
  FakeEngineService,
  FakeTranscriptSource,
  InMemoryBoardBus,
  InMemoryOutputBus,
  type TranscriptFetchResult,
} from '../../src/contracts.js';
import type { EventRow, OutboxRow, SessionRow, TicketRow } from '../../src/db/types.js';
import { reopenSession } from '../../src/engine/reopen.js';
import { createGateway } from '../../src/gateway/index.js';
import type { ApiHandle, GatewayHandle } from '../../src/main.js';
import { useTestDatabase } from '../db.js';
import { FakeDaemon } from './fake-daemon.js';
import { RecordingEngine } from './recording-engine.js';

const db = useTestDatabase();
const workflowPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/design/workflows/m1_basic.v1.json',
);
const CLAUDE = 'c1a0de00-0000-4000-8000-0000000000aa';
const CHUNKS: TranscriptChunk[] = [
  { stream: 'user', text: 'Add /health', ts: '2026-10-22T20:41:01.000Z' },
  { stream: 'assistant', text: 'Done.', ts: '2026-10-22T20:41:05.000Z' },
];

let server: Server;
let port: number;
let gateway: GatewayHandle;
let boardBus: InMemoryBoardBus;
let daemons: FakeDaemon[];
let tag: string;

beforeAll(async () => {
  await db.pool.query(
    `INSERT INTO workflow_definition (id, version, definition) VALUES ('m1_basic', 1, $1)
     ON CONFLICT DO NOTHING`,
    [readFileSync(workflowPath, 'utf8')],
  );
});

beforeEach(async () => {
  boardBus = new InMemoryBoardBus();
  gateway = createGateway({
    db: db.pool,
    engine: new RecordingEngine(db.pool, boardBus),
    boardBus,
    outputBus: new InMemoryOutputBus(),
    transcriptTimeoutMs: 300,
  });
  server = createServer((_req, res) => res.writeHead(404).end());
  gateway.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  daemons = [];
  tag = `t-${randomUUID().slice(0, 8)}`;
});

afterEach(async () => {
  await Promise.all(daemons.map((d) => d.close()));
  await gateway.close();
  await new Promise<void>((r) => server.close(() => r()));
});

async function registered(id = `m-${tag}`): Promise<FakeDaemon> {
  const d = await FakeDaemon.connect(port, id);
  daemons.push(d);
  d.register({ tags: ['mac', tag] });
  await d.next('registered');
  return d;
}

const one = async <R extends object>(sql: string, args: unknown[]): Promise<R> =>
  (await db.pool.query<R & Record<string, unknown>>(sql, args)).rows[0]!;
const sessionRow = (id: string) => one<SessionRow>('SELECT * FROM session WHERE id = $1', [id]);
const ticketRow = (id: string) => one<TicketRow>('SELECT * FROM ticket WHERE id = $1', [id]);

/** A ticket whose only session finished (`status`) on `machine`, as the engine leaves it. */
async function finished(machine: string, status = 'done') {
  await db.pool.query(
    `INSERT INTO machine (id, hostname, os, arch, status, cpu_total, mem_total_mb, disk_free_mb,
                          budget_cpu, budget_mem_mb, max_sessions, max_concurrent_builds)
     VALUES ($1, 'h', 'darwin', 'arm64', 'offline', 8, 16000, 100000, 4, 8000, 2, 1)
     ON CONFLICT DO NOTHING`,
    [machine],
  );
  const t = await one<TicketRow>(
    `INSERT INTO ticket (repo, title, body, workflow_id, workflow_version, required_tags, status)
     VALUES ('github.com/x/app', 'Add /health', 'Return 200', 'm1_basic', 1, $1, $2) RETURNING *`,
    [[tag], status === 'done' ? 'done' : 'failed'],
  );
  const s = await one<SessionRow>(
    `INSERT INTO session (ticket_id, workflow_id, workflow_version, workflow_state, status,
                          machine_id, branch, worktree_path, claude_session_id, context,
                          retry_counters, state_visits, spend_usd, claude_spend_totals,
                          wall_seconds)
     VALUES ($1, 'm1_basic', 1, $2, $3, $4, $5, '/wt/old', $6, $7, $8, $9, 0.42, $10, 120)
     RETURNING *`,
    [
      t.id,
      status === 'done' ? 'done' : 'needs_input',
      status,
      machine,
      `conductor/${t.id}/oldbranch`,
      CLAUDE,
      JSON.stringify({ implement: { summary: 'first pass' } }),
      JSON.stringify({ 'test->implement': 2 }),
      JSON.stringify({ implement: 3, build: 3, test: 3, done: 1 }),
      JSON.stringify({ [CLAUDE]: 0.42 }),
    ],
  );
  return { ticket: t, session: s };
}

// ---------------------------------------------------------------- gateway transcripts

describe('gateway: fetch_transcript → transcript', () => {
  it('sends the request to the machine and resolves with its reply', async () => {
    const d = await registered();
    const sid = randomUUID();
    const pending = gateway.transcripts!.fetchTranscript(d.machineId, sid);
    const req = await d.next('fetch_transcript');
    expect(req.payload.session_id).toBe(sid);
    expect(req.session_id).toBeNull();
    d.sendRaw({
      type: 'transcript',
      msg_id: randomUUID(),
      seq: null,
      session_id: null,
      fencing_token: null,
      payload: { request_id: req.payload.request_id, chunks: CHUNKS, truncated: true },
    });
    expect(await pending).toEqual({ status: 'ok', chunks: CHUNKS, truncated: true });
  });

  it('passes a daemon error through', async () => {
    const d = await registered();
    const pending = gateway.transcripts!.fetchTranscript(d.machineId, randomUUID());
    const req = await d.next('fetch_transcript');
    d.sendRaw({
      type: 'transcript',
      msg_id: randomUUID(),
      seq: null,
      session_id: null,
      fencing_token: null,
      payload: { request_id: req.payload.request_id, error: 'no_transcript' },
    });
    expect(await pending).toEqual({ status: 'error', error: 'no_transcript' });
  });

  it('times out; a reply from another machine is ignored', async () => {
    const d = await registered();
    const other = await registered(`m2-${tag}`);
    const pending = gateway.transcripts!.fetchTranscript(d.machineId, randomUUID());
    const req = await d.next('fetch_transcript');
    other.sendRaw({
      type: 'transcript',
      msg_id: randomUUID(),
      seq: null,
      session_id: null,
      fencing_token: null,
      payload: { request_id: req.payload.request_id, chunks: [], truncated: false },
    });
    expect(await pending).toEqual({ status: 'timeout' });
  });

  it('offline when the machine is not connected, or its socket closes while waiting', async () => {
    expect(await gateway.transcripts!.fetchTranscript('nobody', randomUUID())).toEqual({
      status: 'offline',
    });
    const d = await registered();
    const pending = gateway.transcripts!.fetchTranscript(d.machineId, randomUUID());
    await d.next('fetch_transcript');
    await d.close();
    expect(await pending).toEqual({ status: 'offline' });
  });
});

// ---------------------------------------------------------------- reopenSession + claim

describe('reopenSession', () => {
  it('creates a queued session carrying branch, context and Claude id; resets the rest', async () => {
    const { ticket, session: old } = await finished('m-x');
    const res = await reopenSession(db.pool, old.id, 'Make it blue', 'ui');
    expect(res.status).toBe('reopened');
    if (res.status !== 'reopened') return;
    const s = await sessionRow(res.sessionId);
    expect(s).toMatchObject({
      ticket_id: ticket.id,
      status: 'queued',
      workflow_state: null,
      machine_id: null,
      branch: old.branch,
      claude_session_id: CLAUDE,
      pending_answer: { input_request_id: null, answer: 'Make it blue' },
      context: { implement: { summary: 'first pass' } },
      retry_counters: {},
      state_visits: {},
      claude_spend_totals: { [CLAUDE]: 0.42 },
      agent_command_id: null,
      agent_process_live: false,
      worktree_path: null,
    });
    expect(Number(s.spend_usd)).toBe(0);
    expect(Number(s.wall_seconds)).toBe(0);
    expect((await ticketRow(ticket.id)).status).toBe('ready');
    const ev = await one<EventRow>(
      `SELECT * FROM event WHERE session_id = $1 AND type = 'operator.reopen'`,
      [res.sessionId],
    );
    expect(ev.payload).toEqual({ text: 'Make it blue', reopened_from: old.id, actor: 'ui' });
    expect(res.boardEvents.map((e) => e.type)).toEqual(['card.moved', 'card.upserted']);
    expect(res.boardEvents[0]).toMatchObject({ from: 'done', to: 'queued' });
    expect(res.boardEvents[1]).toMatchObject({
      session_id: res.sessionId,
      card: { session_id: res.sessionId, status: 'queued', column: 'queued' },
    });
    // The old session is untouched.
    expect(await sessionRow(old.id)).toMatchObject({ status: 'done', machine_id: 'm-x' });
  });

  it('reopens a failed session too', async () => {
    const { session } = await finished('m-x', 'failed');
    expect((await reopenSession(db.pool, session.id, 'try again')).status).toBe('reopened');
  });

  it('409 unless terminal (done/failed) and the latest; 404 for an unknown session', async () => {
    const { session: old } = await finished('m-x');
    const res = await reopenSession(db.pool, old.id, 'one');
    expect(res.status).toBe('reopened');
    if (res.status !== 'reopened') return;
    // The old one is no longer the latest; the new one is not terminal.
    expect(await reopenSession(db.pool, old.id, 'two')).toEqual({
      status: 'conflict',
      reason: 'not the ticket’s latest session',
    });
    expect(await reopenSession(db.pool, res.sessionId, 'three')).toMatchObject({
      status: 'conflict',
    });
    const lost = await finished('m-x', 'lost');
    expect(await reopenSession(db.pool, lost.session.id, 'x')).toEqual({
      status: 'conflict',
      reason: 'the session is lost, not done or failed',
    });
    expect(await reopenSession(db.pool, randomUUID(), 'x')).toEqual({ status: 'not_found' });
  });

  it('two concurrent reopens of the same session: exactly one wins', async () => {
    const { session: old } = await finished('m-x');
    const results = await Promise.all([
      reopenSession(db.pool, old.id, 'a'),
      reopenSession(db.pool, old.id, 'b'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['conflict', 'reopened']);
  });
});

describe('claim of a reopened session (branch pin + resume)', () => {
  it('only the old machine claims it; its start resumes the same conversation with the text', async () => {
    const home = await registered();
    const other = await registered(`m2-${tag}`);
    const { session: old, ticket } = await finished(home.machineId);
    const res = await reopenSession(db.pool, old.id, 'Make it blue');
    if (res.status !== 'reopened') throw new Error(res.status);

    other.requestWork();
    expect((await other.next('no_work')).type).toBe('no_work');
    expect((await ticketRow(ticket.id)).status).toBe('ready');

    home.requestWork();
    const wa = await home.next('work_assignment');
    expect(wa.payload).toEqual({ ticket_id: ticket.id, session_id: res.sessionId });
    const row = await one<OutboxRow>(
      `SELECT * FROM outbox WHERE session_id = $1 AND kind = 'start_session'`,
      [res.sessionId],
    );
    const start = StartSessionPayloadSchema.parse(row.payload);
    expect(start).toMatchObject({
      workflow_state: 'implement',
      prompt: 'Make it blue',
      resume_claude_session_id: CLAUDE,
      branch: old.branch,
    });
    expect(await sessionRow(res.sessionId)).toMatchObject({
      status: 'assigned',
      machine_id: home.machineId,
      workflow_state: 'implement',
    });
    // Delivered like any start_session.
    expect(
      await gateway.transport.send(home.machineId, commandEnvelopeForOutboxRow(row, randomUUID())),
    ).toBe('sent');
    expect((await home.next('start_session')).payload.resume_claude_session_id).toBe(CLAUDE);
  });
});

// ---------------------------------------------------------------- REST

describe('REST: GET /transcript and POST /reopen', () => {
  let api: ApiHandle;
  let base: string;
  let answer: (machine: string, sid: string) => TranscriptFetchResult;
  let transcripts: FakeTranscriptSource;
  let outputBus: InMemoryOutputBus;

  beforeEach(async () => {
    answer = () => ({ status: 'ok', chunks: CHUNKS, truncated: false });
    transcripts = new FakeTranscriptSource((m, s) => answer(m, s));
    outputBus = new InMemoryOutputBus();
    api = createApi({
      db: db.pool,
      engine: new FakeEngineService(),
      boardBus,
      outputBus,
      transcripts,
    });
    await api.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await api.close();
  });

  const get = async (path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const post = async (path: string, body: unknown) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('200 with the chunks, synthetic seq 0..n-1 and the transcript ts', async () => {
    const { session } = await finished('m-rest');
    const res = await get(`/api/sessions/${session.id}/transcript`);
    expect(res.status).toBe(200);
    const body = TranscriptResponseSchema.parse(res.body);
    expect(body).toEqual({
      machine_id: 'm-rest',
      truncated: false,
      chunks: CHUNKS.map((c, i) => ({ session_id: session.id, seq: i, ...c })),
    });
    expect(transcripts.calls).toEqual([{ machineId: 'm-rest', sessionId: session.id }]);
  });

  it('404 unknown session; 404 no_transcript; 503 offline / no machine; 504 timeout', async () => {
    expect((await get(`/api/sessions/${randomUUID()}/transcript`)).status).toBe(404);
    expect((await get('/api/sessions/not-a-uuid/transcript')).status).toBe(404);
    const { session } = await finished('m-rest');
    const path = `/api/sessions/${session.id}/transcript`;

    answer = () => ({ status: 'error', error: 'no_transcript' });
    expect(await get(path)).toMatchObject({
      status: 404,
      body: { error: { code: 'no_transcript' } },
    });
    answer = () => ({ status: 'error', error: 'unknown_session' });
    expect(await get(path)).toMatchObject({
      status: 404,
      body: { error: { code: 'no_transcript' } },
    });
    answer = () => ({ status: 'offline' });
    expect(await get(path)).toMatchObject({
      status: 503,
      body: { error: { code: 'machine_offline', message: 'machine m-rest is offline' } },
    });
    answer = () => ({ status: 'timeout' });
    expect(await get(path)).toMatchObject({ status: 504, body: { error: { code: 'timeout' } } });

    await db.pool.query('UPDATE session SET machine_id = NULL WHERE id = $1', [session.id]);
    expect(await get(path)).toMatchObject({
      status: 503,
      body: { error: { code: 'machine_offline' } },
    });
  });

  it('POST /reopen: 202 {session_id} + the text as a user chunk; 409; 404; 400', async () => {
    const { session } = await finished('m-rest');
    const published: string[] = [];
    const unsub = boardBus.subscribe((e) => published.push(e.type));
    const res = await post(`/api/sessions/${session.id}/reopen`, { text: '  Make it blue  ' });
    unsub();
    expect(res.status).toBe(202);
    const { session_id } = ReopenSessionResponseSchema.parse(res.body);
    expect(published).toEqual(['card.moved', 'card.upserted']);
    expect(outputBus.snapshot(session_id).map((c) => [c.stream, c.text])).toEqual([
      ['user', 'Make it blue'],
    ]);
    expect((await sessionRow(session_id)).pending_answer).toEqual({
      input_request_id: null,
      answer: 'Make it blue',
    });

    expect(await post(`/api/sessions/${session.id}/reopen`, { text: 'again' })).toMatchObject({
      status: 409,
      body: { error: { code: 'conflict' } },
    });
    expect((await post(`/api/sessions/${randomUUID()}/reopen`, { text: 'x' })).status).toBe(404);
    expect((await post(`/api/sessions/${session_id}/reopen`, { text: '   ' })).status).toBe(400);
  });
});
