// M1-T07 acceptance: agent asks → input_request row → answer posted via REST → the agent gets it
// and continues. The whole orchestrator is the real thing started by `main()` (real createDb,
// engine, gateway, API, outbox dispatcher, timeout sweep) on a per-run Postgres database; the
// daemon is the real Daemon (@conductor/daemon) over a real WebSocket, with the in-memory
// FakeClaudeDriver (no Claude process) and a FakeCommandRunner (build/test exit 0) under it.
// The process-boundary fake Claude and the full E2E suite are M1-T10.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Daemon,
  FakeClaudeDriver,
  FakeCommandRunner,
  loadConfig,
  NO_OUTCOME_NUDGE,
  type FakeClaudeScript,
} from '@conductor/daemon';
import { API_PATHS, NO_OUTCOME_QUESTION } from '@conductor/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  InputRequestRow,
  MachineRow,
  OutboxRow,
  SessionRow,
  TicketRow,
} from '../../src/db/types.js';
import { main, type Orchestrator } from '../../src/main.js';
import { useTestDatabase } from '../db.js';

const db = useTestDatabase();
const workflowPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/design/workflows/m1_basic.v1.json',
);

let tmp: string;
let repo: string;
let webDir: string;
let port: number;
let orch: Orchestrator;
let tag: string;
const daemons: Daemon[] = [];

beforeAll(async () => {
  await db.pool.query(
    `INSERT INTO workflow_definition (id, version, definition) VALUES ('m1_basic', 1, $1)`,
    [readFileSync(workflowPath, 'utf8')],
  );
});

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'conductor-t07-'));
  repo = join(tmp, 'origin');
  mkdirSync(repo);
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  g('init', '--quiet', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'test');
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  g('add', '.');
  g('commit', '--quiet', '-m', 'init');
  webDir = join(tmp, 'web');
  mkdirSync(join(webDir, 'assets'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>conductor</title>');
  writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)');
  tag = `t-${randomUUID().slice(0, 8)}`;
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
  for (const d of daemons.splice(0)) d.stop();
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

/**
 * `hasConversation`: whether a resumed Claude conversation is on this machine. The in-memory fake
 * writes no transcripts, so by default every conversation counts as here.
 */
function startDaemon(
  driver: FakeClaudeDriver,
  hasConversation: (cwd: string, claudeSessionId: string) => boolean = () => true,
): Daemon {
  const config = loadConfig({
    CONDUCTOR_ORCHESTRATOR_URL: `ws://127.0.0.1:${port}${API_PATHS.daemonWs}`,
    CONDUCTOR_ROOT: join(tmp, 'root'),
    CONDUCTOR_MACHINE_ID: `m-${tag}`,
    CONDUCTOR_TAGS: tag,
    CONDUCTOR_MAX_SESSIONS: '1',
    CONDUCTOR_PORT_POOL: '43000-43029',
    CONDUCTOR_MIN_FREE_MEM_MB: '0',
    CONDUCTOR_WORK_POLL_MS: '100',
    CONDUCTOR_ALLOW_LOCAL_REPOS: '1', // the fixture repo is a local path (M1-T14)
  });
  config.reconnect = { initialMs: 20, maxMs: 100, factor: 2 };
  config.endGraceMs = 200;
  const runner = new FakeCommandRunner(2, true); // npm run build / npm test: exit 0
  const d = new Daemon({
    config,
    driver,
    createCommandRunner: () => runner,
    sysinfo: () => ({ cpuFree: 4, memFreeMb: 8000, diskFreeMb: 50_000 }),
    claudeCodeVersion: '2.1.308',
    log: () => {},
    hasConversation,
    // M2-T16a: the claim routes on capabilities; the fake driver is this machine's `claude`.
    scanInventory: () =>
      Promise.resolve({ repos: [], capabilities: [{ kind: 'claude', version: '2.1.308' }] }),
  });
  daemons.push(d);
  d.start();
  return d;
}

const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
const post = (path: string, body: unknown) =>
  api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function createTicket(): Promise<string> {
  const res = await post(API_PATHS.tickets, {
    title: 'Add /health',
    body: 'Return 200',
    repo,
    workflow_id: 'm1_basic',
    kind: 'work',
    required_tags: [tag],
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const one = async <R extends object>(sql: string, args: unknown[]): Promise<R | undefined> =>
  (await db.pool.query<R & Record<string, unknown>>(sql, args)).rows[0];
const sessionOf = (ticketId: string) =>
  one<SessionRow>('SELECT * FROM session WHERE ticket_id = $1', [ticketId]);

async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The session parked on its open question: the input_request the agent's question created. */
async function parked(ticketId: string): Promise<{ s: SessionRow; req: InputRequestRow }> {
  const s = await until(async () => {
    const row = await sessionOf(ticketId);
    return row?.status === 'needs_input' ? row : null;
  });
  const req = await one<InputRequestRow>(
    'SELECT * FROM input_request WHERE session_id = $1 AND answer IS NULL',
    [s.id],
  );
  return { s, req: req! };
}

async function answer(sessionId: string, inputRequestId: string, text: string): Promise<void> {
  const res = await post(API_PATHS.sessionInput(sessionId), {
    input_request_id: inputRequestId,
    answer: text,
  });
  expect(res.status).toBe(202);
}

const done = (ticketId: string) =>
  until(async () => {
    const s = await sessionOf(ticketId);
    return s?.status === 'done' ? s : null;
  });

const outboxRows = async (sessionId: string) =>
  (
    await db.pool.query<OutboxRow>('SELECT * FROM outbox WHERE session_id = $1 ORDER BY id', [
      sessionId,
    ])
  ).rows;

const askThenComplete: FakeClaudeScript = {
  turns: [
    [{ say: 'Looking at the server.' }, { askUser: 'Which port should /health use?' }],
    (reply) => [{ say: `Using ${reply}.` }, { completeState: { port: reply } }],
  ],
};

describe('ask_user → needs_input → REST answer → agent continues (M1-T07)', () => {
  it('live process: the answer goes to stdin via send_input and the workflow finishes', async () => {
    const driver = new FakeClaudeDriver(askThenComplete);
    startDaemon(driver);
    const ticketId = await createTicket();

    const { s, req } = await parked(ticketId);
    expect(req).toMatchObject({
      kind: 'agent_question',
      question: 'Which port should /health use?',
      return_to: 'implement',
    });
    expect(s).toMatchObject({ workflow_state: 'needs_input', agent_process_live: true });
    expect(driver.last!.exited).toBe(false); // parked, alive and idle

    await answer(s.id, req.id, '8080');
    const end = await done(ticketId);

    // One Claude process the whole time: the answer was written into it.
    expect(driver.sessions).toHaveLength(1);
    expect(driver.last!.inputs).toEqual(['8080']);
    expect(end).toMatchObject({ workflow_state: 'done', pending_answer: null });
    expect(end.context).toMatchObject({ implement: { port: '8080' } });
    expect((await one<TicketRow>('SELECT * FROM ticket WHERE id = $1', [ticketId]))!.status).toBe(
      'done',
    );
    expect(
      await one<InputRequestRow>('SELECT * FROM input_request WHERE id = $1', [req.id]),
    ).toMatchObject({ answer: '8080', answered_by: 'ui' });

    const rows = await until(async () => {
      const r = await outboxRows(s.id);
      return r.every((o) => o.status === 'acked') ? r : null;
    });
    expect(rows.map((o) => o.kind)).toEqual(['start_session', 'send_input', 'run_cmd', 'run_cmd']);
    // U-039: the acked start_session keeps its payload minus the prompt.
    expect(rows[0]!.payload.prompt).toBeNull();
    expect(rows[0]!.payload).toMatchObject({ workflow_state: 'implement', ticket_id: ticketId });
    expect(rows[1]!.payload).toMatchObject({ input_request_id: req.id, text: '8080' });
    // U-032: the CLI version from register.
    expect(
      (await one<MachineRow>('SELECT * FROM machine WHERE id = $1', [`m-${tag}`]))!
        .claude_code_version,
    ).toBe('2.1.308');
  });

  it('process gone: the answer resumes the Claude session with prompt = pending_answer', async () => {
    const driver = new FakeClaudeDriver(askThenComplete);
    startDaemon(driver);
    const ticketId = await createTicket();
    const { s, req } = await parked(ticketId);

    // The parked process dies (crash, reboot): agent.exited while parked clears the live flag.
    driver.last!.kill();
    await until(async () => (await sessionOf(ticketId))?.agent_process_live === false);
    expect((await sessionOf(ticketId))!.status).toBe('needs_input');

    await answer(s.id, req.id, '9090');
    const end = await done(ticketId);

    expect(driver.starts).toHaveLength(2);
    expect(driver.starts[1]).toMatchObject({
      resume: true,
      claudeSessionId: driver.starts[0]!.claudeSessionId,
      // pending_answer.answer, bare: the resumed conversation already has the question.
      prompt: '9090',
    });
    expect(driver.sessions[0]!.inputs).toEqual([]);
    expect(end.context).toMatchObject({ implement: { port: '9090' } });
    expect(end.pending_answer).toBeNull();
    const starts = (await outboxRows(s.id)).filter((o) => o.kind === 'start_session');
    expect(starts).toHaveLength(2);
    expect(starts[1]!.payload).toMatchObject({
      resume_claude_session_id: driver.starts[0]!.claudeSessionId,
    });
  });

  it('no_conversation: an answer whose conversation is not on this machine continues in a fresh one', async () => {
    // A fresh conversation gets the full prompt with the answer in it, and finishes with it.
    const driver = new FakeClaudeDriver((opts) =>
      opts.prompt.includes('## Answer from a human')
        ? { turns: [[{ completeState: { fresh: opts.prompt } }]] }
        : askThenComplete,
    );
    const asked: string[] = [];
    startDaemon(driver, (_cwd, id) => {
      asked.push(id);
      return false; // as on a machine the conversation never ran on
    });
    const ticketId = await createTicket();
    const { s, req } = await parked(ticketId);
    const first = driver.starts[0]!.claudeSessionId;
    driver.last!.kill();
    await until(async () => (await sessionOf(ticketId))?.agent_process_live === false);

    await answer(s.id, req.id, '7070');
    const end = await done(ticketId);

    expect(asked).toEqual([first]);
    // Refused before spawning: the second start is a fresh Claude session.
    expect(driver.starts).toHaveLength(2);
    expect(driver.starts[1]!.resume).toBe(false);
    expect(driver.starts[1]!.claudeSessionId).not.toBe(first);
    const fresh = (end.context as { implement?: { fresh?: string } }).implement?.fresh ?? '';
    expect(fresh).toContain('## Answer from a human\n\n7070');
    expect(fresh).toContain('Return 200'); // the full state prompt (ticket body)
    expect(end.claude_session_id).toBe(driver.starts[1]!.claudeSessionId);

    const starts = (await outboxRows(s.id)).filter((o) => o.kind === 'start_session');
    expect(starts.map((o) => [o.status, o.last_error])).toEqual([
      ['acked', null],
      ['failed', 'no_conversation'],
      ['acked', null],
    ]);
    expect(starts[1]!.payload).toMatchObject({ resume_claude_session_id: first });
    expect(starts[2]!.payload).toMatchObject({ resume_claude_session_id: null });
    const reset = await one<{ payload: unknown }>(
      "SELECT payload FROM event WHERE session_id = $1 AND type = 'conversation.reset'",
      [s.id],
    );
    expect(reset?.payload).toEqual({ claude_session_id: first, reason: 'not_on_machine' });
  });

  it('no outcome twice (U-028): one nudge, then an agent_question; the answer continues it', async () => {
    const driver = new FakeClaudeDriver({
      turns: [
        [{ say: 'I changed server.ts.' }],
        [{ say: 'It should work now.' }], // the nudge's turn: still no outcome
        (reply) => [{ completeState: { note: reply } }],
      ],
    });
    startDaemon(driver);
    const ticketId = await createTicket();
    const { s, req } = await parked(ticketId);
    expect(req).toMatchObject({
      kind: 'agent_question',
      question: `${NO_OUTCOME_QUESTION}\n\nLast output:\nI changed server.ts.\nIt should work now.`,
      return_to: 'implement',
    });
    expect(driver.last!.inputs).toEqual([NO_OUTCOME_NUDGE]);

    await answer(s.id, req.id, 'Call complete_state.');
    const end = await done(ticketId);
    expect(driver.sessions).toHaveLength(1);
    expect(driver.last!.inputs).toEqual([NO_OUTCOME_NUDGE, 'Call complete_state.']);
    expect(end.context).toMatchObject({ implement: { note: 'Call complete_state.' } });
  });
});

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
