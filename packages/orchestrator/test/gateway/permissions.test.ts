// M2-T29c: permission prompts end to end inside the orchestrator (ADR-0023; 10-contracts
// §Permission prompts). A fake daemon on the real gateway, the real API on the same server, the
// real EngineService and real Postgres (`pnpm db:up`).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_PATHS,
  BoardResponseSchema,
  DEFAULT_PERMISSION_TIMEOUT_MS,
  LOCAL_USER_ID,
  PermissionRequestDtoSchema,
  PermissionRequestListResponseSchema,
  SessionDetailSchema,
  type BoardCard,
  type BoardSseEvent,
  type JsonObject,
} from '@conductor/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../../src/api/index.js';
import {
  commandEnvelopeForOutboxRow,
  InMemoryBoardBus,
  InMemoryOutputBus,
} from '../../src/contracts.js';
import type { OutboxRow, PermissionRequestRow, SessionRow, TicketRow } from '../../src/db/types.js';
import { DECISION_REFUSED_LINE, createGateway } from '../../src/gateway/index.js';
import type { ApiHandle, GatewayHandle } from '../../src/main.js';
import { NOT_RUNNING_MESSAGE, sweepPermissionTimeouts } from '../../src/permissions/store.js';
import { useTestDatabase } from '../db.js';
import { FakeDaemon } from './fake-daemon.js';
import { RecordingEngine } from './recording-engine.js';

const db = useTestDatabase();
const workflowPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/design/workflows/m1_basic.v1.json',
);

let api: ApiHandle;
let base: string;
let port: number;
let gateway: GatewayHandle;
let engine: RecordingEngine;
let boardBus: InMemoryBoardBus;
let outputBus: InMemoryOutputBus;
let daemons: FakeDaemon[];
let machineId: string;
let tag: string;
let board: BoardSseEvent[];

beforeAll(async () => {
  await db.pool.query(
    `INSERT INTO workflow_definition (id, version, definition) VALUES ('m1_basic', 1, $1)
     ON CONFLICT DO NOTHING`,
    [readFileSync(workflowPath, 'utf8')],
  );
});

beforeEach(async () => {
  boardBus = new InMemoryBoardBus();
  board = [];
  boardBus.subscribe((e) => board.push(e));
  engine = new RecordingEngine(db.pool, boardBus);
  outputBus = new InMemoryOutputBus();
  gateway = createGateway({ db: db.pool, engine, boardBus, outputBus });
  api = createApi({
    db: db.pool,
    engine,
    boardBus,
    outputBus,
    machineTransport: gateway.transport,
  });
  gateway.attach(api.server);
  await api.listen(0, '127.0.0.1');
  port = (api.server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  daemons = [];
  tag = `t-${randomUUID().slice(0, 8)}`;
  machineId = `m-${tag}`;
});

afterEach(async () => {
  await Promise.all(daemons.map((d) => d.close()));
  await gateway.close();
  await api.close();
});

// ------------------------------------------------------------------ helpers

async function registered(): Promise<FakeDaemon> {
  const d = await FakeDaemon.connect(port, machineId);
  daemons.push(d);
  d.register({ tags: ['mac', tag] });
  await d.next('registered');
  return d;
}

const one = async <R extends object>(sql: string, args: unknown[]): Promise<R> =>
  (await db.pool.query<R & Record<string, unknown>>(sql, args)).rows[0]!;
const sessionRow = (id: string) => one<SessionRow>('SELECT * FROM session WHERE id = $1', [id]);
const requestRow = (id: string) =>
  one<PermissionRequestRow>('SELECT * FROM permission_request WHERE id = $1', [id]);

/** A running session whose agent process is live (start acked, `started` applied). */
async function live(d: FakeDaemon) {
  const t = await one<TicketRow>(
    `INSERT INTO ticket (repo, title, workflow_id, required_tags) VALUES
       ('github.com/x/app', 'perm', 'm1_basic', $1) RETURNING *`,
    [[tag]],
  );
  d.requestWork();
  const wa = await d.next('work_assignment');
  const sid = wa.payload.session_id;
  const token = wa.fencing_token;
  const row = await one<OutboxRow>(
    `SELECT * FROM outbox WHERE session_id = $1 AND kind = 'start_session'`,
    [sid],
  );
  expect(
    await gateway.transport.send(machineId, commandEnvelopeForOutboxRow(row, randomUUID())),
  ).toBe('sent');
  await d.next('start_session');
  d.ack(row.command_id, true, undefined, sid, token);
  d.sessionEvent(1, sid, token, {
    kind: 'started',
    data: {
      command_id: row.command_id,
      worktree_path: '/w',
      branch: 'b',
      port_range: { base: 41000, count: 10 },
    },
  });
  await d.settle();
  expect(await sessionRow(sid)).toMatchObject({ status: 'running', agent_process_live: true });
  board.length = 0;
  return { sid, token, ticketId: t.id, startId: row.command_id };
}

function permissionRequest(
  d: FakeDaemon,
  seq: number,
  sid: string,
  token: number,
  over: { request_id?: string; tool?: string; input?: JsonObject; session_id?: string } = {},
) {
  const requestId = over.request_id ?? randomUUID();
  const msgId = randomUUID();
  d.sendRaw({
    type: 'permission_request',
    msg_id: msgId,
    seq,
    session_id: sid,
    fencing_token: token,
    payload: {
      request_id: requestId,
      session_id: over.session_id ?? sid,
      tool: over.tool ?? 'Bash',
      input: over.input ?? { command: 'pnpm exec tsc -b' },
      suggestions: [{ type: 'addRules', behavior: 'allow' }],
      tool_use_id: 'toolu_1',
      expires_at: new Date(Date.now() + DEFAULT_PERMISSION_TIMEOUT_MS).toISOString(),
    },
  });
  return { requestId, msgId };
}

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(path: string) {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
}

const decide = (requestId: string, body: unknown) =>
  post(API_PATHS.permissionDecision(requestId), body);

/** The last card.upserted for the session on the board bus. */
function lastCard(sid: string): BoardCard | undefined {
  const cards = board.filter(
    (e): e is Extract<BoardSseEvent, { type: 'card.upserted' }> =>
      e.type === 'card.upserted' && e.session_id === sid,
  );
  return cards.at(-1)?.card;
}

async function boardCard(sid: string): Promise<BoardCard> {
  const res = await get(API_PATHS.board);
  const parsed = BoardResponseSchema.parse(res.body);
  return parsed.columns.flatMap((c) => c.cards).find((c) => c.session_id === sid)!;
}

/** No more frames of `type` arrive within a short wait. */
async function noFrame(d: FakeDaemon, type: Parameters<FakeDaemon['next']>[0]) {
  await d.settle();
  await expect(d.next(type, 200)).rejects.toThrow(/timed out/);
}

// ------------------------------------------------------------------ the request

describe('permission_request (gateway)', () => {
  it('stores a pending request and sets needs_permission on the card in the same tx', async () => {
    const d = await registered();
    const { sid, token } = await live(d);
    const { requestId } = permissionRequest(d, 2, sid, token);
    await d.settle();

    const row = await requestRow(requestId);
    expect(row).toMatchObject({
      session_id: sid,
      machine_id: machineId,
      fencing_token: String(token),
      tool: 'Bash',
      status: 'pending',
      always_rule: 'Bash(pnpm exec tsc -b)',
      tool_use_id: 'toolu_1',
      decided_by: null,
    });
    expect(row.suggestions).toEqual([{ type: 'addRules', behavior: 'allow' }]);
    expect((await sessionRow(sid)).status).toBe('running');

    const card = lastCard(sid)!;
    expect(card).toMatchObject({
      status: 'running',
      sub_status: 'needs_permission',
      permission: {
        request_id: requestId,
        tool: 'Bash',
        summary: 'pnpm exec tsc -b',
        pending_count: 1,
      },
    });
    // The board and the session detail derive the same fields.
    expect((await boardCard(sid)).permission).toEqual(card.permission);
    const detail = SessionDetailSchema.parse((await get(`/api/sessions/${sid}`)).body);
    expect(detail.card.sub_status).toBe('needs_permission');

    // A second request: the oldest stays on the card, the count goes up.
    permissionRequest(d, 3, sid, token, { tool: 'mcp__github__create_issue', input: { t: 1 } });
    await d.settle();
    expect(lastCard(sid)!.permission).toMatchObject({ request_id: requestId, pending_count: 2 });
  });

  it('dedupes on (machine_id, seq) and on request_id', async () => {
    const d = await registered();
    const { sid, token } = await live(d);
    const { requestId } = permissionRequest(d, 2, sid, token);
    await d.settle();
    const events = board.length;
    // The same seq again (a replay) and the same request_id under a new seq change nothing.
    permissionRequest(d, 2, sid, token, { request_id: requestId, input: { command: 'x' } });
    permissionRequest(d, 3, sid, token, { request_id: requestId, input: { command: 'y' } });
    await d.settle();
    expect(board.length).toBe(events);
    const rows = await db.pool.query('SELECT input FROM permission_request WHERE session_id = $1', [
      sid,
    ]);
    expect(rows.rows).toEqual([{ input: { command: 'pnpm exec tsc -b' } }]);
    expect(
      (await one<{ last_seq: string }>('SELECT last_seq FROM machine WHERE id = $1', [machineId]))
        .last_seq,
    ).toBe('3');
  });

  it('a session that is not running an agent: stored denied by conductor, deny sent at once', async () => {
    const d = await registered();
    const { sid, token } = await live(d);
    d.sessionEvent(2, sid, token, { kind: 'ask_user', data: { question: 'why?' } });
    await d.settle();
    expect((await sessionRow(sid)).status).toBe('needs_input');
    board.length = 0;

    const { requestId } = permissionRequest(d, 3, sid, token);
    const frame = await d.next('permission_decision');
    expect(frame.session_id).toBe(sid);
    expect(frame.fencing_token).toBe(token);
    expect(frame.payload).toMatchObject({
      request_id: requestId,
      behavior: 'deny',
      scope: 'once',
      message: NOT_RUNNING_MESSAGE,
    });
    const row = await requestRow(requestId);
    expect(row).toMatchObject({
      status: 'denied',
      behavior: 'deny',
      scope: 'once',
      decided_by: null,
      message: NOT_RUNNING_MESSAGE,
      decision_command_id: frame.payload.command_id,
    });
    expect(row.resolved_at).not.toBeNull();
    // The card does not change.
    expect(board).toEqual([]);
  });

  it('refuses a mismatched payload.session_id, an unowned session and a stale token', async () => {
    const d = await registered();
    const { sid, token } = await live(d);
    const bad = permissionRequest(d, 2, sid, token, { session_id: randomUUID() });
    expect((await d.next('protocol_error')).payload).toMatchObject({
      code: 'invalid_message',
      ref_msg_id: bad.msgId,
    });
    const unknown = permissionRequest(d, 3, randomUUID(), token);
    expect((await d.next('protocol_error')).payload).toMatchObject({
      code: 'unknown_session',
      ref_msg_id: unknown.msgId,
    });
    permissionRequest(d, 4, sid, token - 1);
    expect((await d.next('kill')).payload.reason).toBe('stale_fencing_token');
    await d.settle();
    expect(
      (await db.pool.query('SELECT 1 FROM permission_request WHERE session_id = $1', [sid]))
        .rowCount,
    ).toBe(0);
  });
});

// ------------------------------------------------------------------ the decision

describe('POST /api/permission-requests/:id/decision', () => {
  it('allow once: records it, clears the card, sends permission_decision; idempotent', async () => {
    const d = await registered();
    const { sid, token } = await live(d);
    const { requestId } = permissionRequest(d, 2, sid, token);
    await d.settle();
    board.length = 0;

    const res = await decide(requestId, { behavior: 'allow', scope: 'once' });
    expect(res.status).toBe(200);
    const dto = PermissionRequestDtoSchema.parse(res.body);
    expect(dto).toMatchObject({
      id: requestId,
      status: 'allowed',
      decision: { behavior: 'allow', scope: 'once', rule: null, decided_by: LOCAL_USER_ID },
    });
    expect(dto.resolved_at).not.toBeNull();

    const frame = await d.next('permission_decision');
    expect(frame.session_id).toBe(sid);
    expect(frame.fencing_token).toBe(token);
    expect(frame.payload).toEqual({
      command_id: (await requestRow(requestId)).decision_command_id,
      request_id: requestId,
      behavior: 'allow',
      scope: 'once',
    });

    const card = lastCard(sid)!;
    expect(card.sub_status).toBeUndefined();
    expect(card.permission).toBeUndefined();
    expect((await boardCard(sid)).sub_status).toBeUndefined();

    // The same decision again: 200 with the stored decision, no second command.
    const again = await decide(requestId, { behavior: 'allow', scope: 'once' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(res.body);
    await noFrame(d, 'permission_decision');
    // A different one: 409.
    const other = await decide(requestId, { behavior: 'deny', scope: 'once' });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ error: { code: 'permission_not_pending' } });
  });

  it('allow always: records the exact rule on the ticket and sends it', async () => {
    const d = await registered();
    const { sid, token, ticketId } = await live(d);
    const { requestId } = permissionRequest(d, 2, sid, token);
    await d.settle();

    const res = await decide(requestId, { behavior: 'allow', scope: 'always' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'allowed',
      decision: { scope: 'always', rule: 'Bash(pnpm exec tsc -b)' },
    });
    const frame = await d.next('permission_decision');
    expect(frame.payload).toMatchObject({ scope: 'always', rule: 'Bash(pnpm exec tsc -b)' });
    const t = await one<TicketRow>('SELECT * FROM ticket WHERE id = $1', [ticketId]);
    expect(t.session_allow).toEqual(['Bash(pnpm exec tsc -b)']);

    // The same rule again (another request) is not appended twice.
    const second = permissionRequest(d, 3, sid, token);
    await d.settle();
    expect((await decide(second.requestId, { behavior: 'allow', scope: 'always' })).status).toBe(
      200,
    );
    expect(
      (await one<TicketRow>('SELECT * FROM ticket WHERE id = $1', [ticketId])).session_allow,
    ).toEqual(['Bash(pnpm exec tsc -b)']);
  });

  it('deny with a note; always without an exact rule is 400; a deny is never always', async () => {
    const d = await registered();
    const { sid, token } = await live(d);
    const { requestId } = permissionRequest(d, 2, sid, token, {
      tool: 'Read',
      input: { file_path: '/etc/hosts' },
    });
    await d.settle();
    const noRule = await decide(requestId, { behavior: 'allow', scope: 'always' });
    expect(noRule.status).toBe(400);
    expect(noRule.body).toMatchObject({ error: { code: 'bad_request' } });
    expect((await decide(requestId, { behavior: 'deny', scope: 'always' })).status).toBe(400);
    expect(
      (await decide(requestId, { behavior: 'deny', scope: 'once', message: '  ' })).status,
    ).toBe(400);
    expect((await requestRow(requestId)).status).toBe('pending');

    const res = await decide(requestId, {
      behavior: 'deny',
      scope: 'once',
      message: '  Not on this machine.  ',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'denied',
      always_rule: null,
      decision: { behavior: 'deny', scope: 'once', message: 'Not on this machine.' },
    });
    const frame = await d.next('permission_decision');
    expect(frame.payload).toMatchObject({ behavior: 'deny', message: 'Not on this machine.' });
  });

  it('404 for an unknown id, a non-uuid, or another account’s request', async () => {
    const d = await registered();
    const { sid, token, ticketId } = await live(d);
    const { requestId } = permissionRequest(d, 2, sid, token);
    await d.settle();
    expect((await decide(randomUUID(), { behavior: 'allow', scope: 'once' })).status).toBe(404);
    expect((await decide('nope', { behavior: 'allow', scope: 'once' })).status).toBe(404);

    const other = await one<{ id: string }>(
      "INSERT INTO account (name) VALUES ('other') RETURNING id",
      [],
    );
    const original = (await one<TicketRow>('SELECT * FROM ticket WHERE id = $1', [ticketId]))
      .account_id;
    await db.pool.query('UPDATE ticket SET account_id = $2 WHERE id = $1', [ticketId, other.id]);
    try {
      expect((await decide(requestId, { behavior: 'allow', scope: 'once' })).status).toBe(404);
      expect((await get(API_PATHS.sessionPermissionRequests(sid))).status).toBe(404);
    } finally {
      await db.pool.query('UPDATE ticket SET account_id = $2 WHERE id = $1', [ticketId, original]);
    }
    expect((await requestRow(requestId)).status).toBe('pending');
  });

  it('a machine that is not connected: the decision is stored, nothing is sent', async () => {
    const d = await registered();
    const { sid, token } = await live(d);
    const { requestId } = permissionRequest(d, 2, sid, token);
    await d.settle();
    await d.close();
    const res = await decide(requestId, { behavior: 'allow', scope: 'once' });
    expect(res.status).toBe(200);
    expect((await requestRow(requestId)).status).toBe('allowed');
  });
});

describe('GET /api/sessions/:id/permission-requests', () => {
  it('lists the session’s requests oldest first, as DTOs', async () => {
    const d = await registered();
    const { sid, token } = await live(d);
    const a = permissionRequest(d, 2, sid, token);
    await d.settle();
    const b = permissionRequest(d, 3, sid, token, {
      tool: 'WebFetch',
      input: { url: 'https://docs.github.com/x' },
    });
    await d.settle();
    await decide(a.requestId, { behavior: 'allow', scope: 'once' });

    const res = await get(API_PATHS.sessionPermissionRequests(sid));
    expect(res.status).toBe(200);
    const list = PermissionRequestListResponseSchema.parse(res.body);
    expect(list.requests.map((r) => [r.id, r.status, r.always_rule])).toEqual([
      [a.requestId, 'allowed', 'Bash(pnpm exec tsc -b)'],
      [b.requestId, 'pending', 'WebFetch(domain:docs.github.com)'],
    ]);
    expect((await get(API_PATHS.sessionPermissionRequests(randomUUID()))).status).toBe(404);
  });
});

// ------------------------------------------------------------------ expiry

describe('expiry', () => {
  it('timeout: the sweep expires it at expires_at and clears the card; a late decision is 409', async () => {
    const d = await registered();
    const { sid, token } = await live(d);
    const { requestId } = permissionRequest(d, 2, sid, token);
    await d.settle();
    expect(await sweepPermissionTimeouts({ db: db.pool, boardBus, now: () => new Date() })).toBe(0);
    board.length = 0;

    const later = new Date(Date.now() + DEFAULT_PERMISSION_TIMEOUT_MS + 1000);
    expect(
      await sweepPermissionTimeouts({ db: db.pool, boardBus, now: () => later }),
    ).toBeGreaterThanOrEqual(1);
    expect(await requestRow(requestId)).toMatchObject({
      status: 'expired',
      expired_reason: 'timeout',
    });
    expect(lastCard(sid)!.sub_status).toBeUndefined();
    const late = await decide(requestId, { behavior: 'allow', scope: 'once' });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ error: { code: 'permission_not_pending' } });
    await noFrame(d, 'permission_decision');
  });

  it('agent_gone: the agent process exits', async () => {
    const d = await registered();
    const { sid, token, startId } = await live(d);
    const { requestId } = permissionRequest(d, 2, sid, token);
    await d.settle();
    board.length = 0;
    d.sessionEvent(3, sid, token, {
      kind: 'exit',
      data: { command_id: startId, code: null, signal: 'daemon_restart' },
    });
    await d.settle();
    expect(await requestRow(requestId)).toMatchObject({
      status: 'expired',
      expired_reason: 'agent_gone',
    });
    expect(lastCard(sid)!.sub_status).toBeUndefined();
  });

  it('session_moved: the session parks (ask_user) or is cancelled', async () => {
    const d = await registered();
    const { sid, token } = await live(d);
    const { requestId } = permissionRequest(d, 2, sid, token);
    await d.settle();
    board.length = 0;
    d.sessionEvent(3, sid, token, { kind: 'ask_user', data: { question: 'why?' } });
    await d.settle();
    expect(await requestRow(requestId)).toMatchObject({
      status: 'expired',
      expired_reason: 'session_moved',
    });
    const card = lastCard(sid)!;
    expect(card.status).toBe('needs_input');
    expect(card.sub_status).toBeUndefined();
  });

  it('an unrelated event (spend) keeps the request pending and the card set', async () => {
    const d = await registered();
    const { sid, token } = await live(d);
    const { requestId } = permissionRequest(d, 2, sid, token);
    await d.settle();
    d.sessionEvent(3, sid, token, {
      kind: 'spend',
      data: {
        claude_session_id: 'c1',
        total_usd: 0.5,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
      },
    });
    await d.settle();
    expect((await requestRow(requestId)).status).toBe('pending');
    expect(lastCard(sid)!.sub_status).toBe('needs_permission');
  });

  it('unknown_permission_request: a pending request expires agent_gone; a decided one keeps it', async () => {
    const d = await registered();
    const { sid, token } = await live(d);
    const { requestId } = permissionRequest(d, 2, sid, token);
    await d.settle();
    await decide(requestId, { behavior: 'allow', scope: 'once' });
    const frame = await d.next('permission_decision');
    d.ack(frame.payload.command_id, false, 'unknown_permission_request', sid, token);
    await d.settle();
    expect((await requestRow(requestId)).status).toBe('allowed');
    expect(outputBus.snapshot(sid).map((c) => c.text)).toContain(DECISION_REFUSED_LINE);

    // A still-pending request whose command was refused (not reachable through the routes, which
    // decide in the same tx; covered for the contract's "if it is still pending").
    const p = permissionRequest(d, 3, sid, token);
    await d.settle();
    const commandId = randomUUID();
    await db.pool.query('UPDATE permission_request SET decision_command_id = $2 WHERE id = $1', [
      p.requestId,
      commandId,
    ]);
    board.length = 0;
    d.ack(commandId, false, 'unknown_permission_request', sid, token);
    await d.settle();
    expect(await requestRow(p.requestId)).toMatchObject({
      status: 'expired',
      expired_reason: 'agent_gone',
    });
    expect(lastCard(sid)!.sub_status).toBeUndefined();
  });
});
