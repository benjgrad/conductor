// R4: the daemon's side of `run_gate`: the checks of a transition (with the repo override
// applied) and the record of the call, then its outcome. Password mode, so the machine-credential
// and session rules of the real deployment apply. Needs `pnpm db:up`.
import { request } from 'node:http';
import {
  API_PATHS,
  CONDUCTOR_V4_DEF,
  DAEMON_FEATURE_RUN_GATE,
  EnrollResponseSchema,
  EnrollmentTokenCreatedSchema,
  RUN_GATE_INSTRUCTION,
  RunGateSpecSchema,
  TicketDtoSchema,
  selfCheckSpecOf,
} from '@conductor/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setRepoChecks } from '../src/api/repo-checks.js';
import { loadAdvisorRows } from '../src/advisor/queries.js';
import { RUN_GATE_FALLBACK_NOTE, withRunGateFeature } from '../src/engine/run-gate.js';
import {
  HTTPS_URL,
  cookieOf,
  createUser,
  passwordAuth,
  startApi,
  type Res,
  type TestApi,
} from './auth/helpers.js';
import { useTestDatabase } from './db.js';

const db = useTestDatabase();
const PASSWORD = 'correct horse battery staple';
const auth = passwordAuth(HTTPS_URL);
const WORKFLOW = 'conductor_run_gate_test';
const SHIP = 'personal_pr_ready_for_review';
const SHA = 'a'.repeat(40);

let api: TestApi;
let a: { cookie: string; accountId: string };
/** Two machines of `a`'s account, enrolled once (the enroll route is rate-limited). */
let mine: Awaited<ReturnType<typeof enroll>>;
let other: Awaited<ReturnType<typeof enroll>>;

/** A raw request (node:http) with the public Host and Origin; a header set to '' is left out. */
function raw(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: api.port,
        agent: false,
        method,
        path,
        headers: Object.fromEntries(
          Object.entries({
            host: auth.mode === 'password' ? auth.publicHost : '',
            origin: HTTPS_URL,
            ...(opts.body !== undefined
              ? {
                  'content-type': 'application/json',
                  'content-length': String(Buffer.byteLength(opts.body)),
                }
              : {}),
            ...opts.headers,
          }).filter(([, v]) => v !== ''),
        ),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Res['json'] = {};
          try {
            json = JSON.parse(text) as Res['json'];
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

async function signIn(): Promise<{ cookie: string; accountId: string }> {
  const u = await createUser(db.pool, { password: PASSWORD });
  const res = await api.send('POST', API_PATHS.authLogin, {
    body: { email: u.email, password: PASSWORD },
  });
  expect(res.status).toBe(200);
  return { cookie: cookieOf(res), accountId: u.accountId };
}

const as = (who: { cookie: string }) => ({ headers: { cookie: who.cookie } });

async function createTicket(repo = 'github.com/acme/app') {
  const res = await api.send('POST', API_PATHS.tickets, {
    ...as(a),
    body: { title: 'Fix it', body: 'fix', repo, kind: 'personal' },
  });
  return TicketDtoSchema.parse(res.json);
}

async function enroll(who: { cookie: string }) {
  const t = await api.send('POST', API_PATHS.machineEnrollmentTokens, { ...as(who), body: {} });
  const { token } = EnrollmentTokenCreatedSchema.parse(t.json);
  const e = await api.send('POST', API_PATHS.machinesEnroll, {
    body: { token, hostname: 'h', os: 'linux', arch: 'x64', daemon_version: '0.1.0' },
  });
  expect(e.status).toBe(201);
  return EnrollResponseSchema.parse(e.json);
}

async function session(ticketId: string, state = 'implementing', status = 'running') {
  const r = await db.pool.query<{ id: string }>(
    'INSERT INTO session (ticket_id, workflow_id, workflow_version, workflow_state, status, ' +
      'machine_id, account_id) SELECT $1, $4, 1, $5, $2, $3, t.account_id ' +
      'FROM ticket t WHERE t.id = $1 RETURNING id',
    [ticketId, status, mine.machine_id, WORKFLOW, state],
  );
  return r.rows[0]!.id;
}

const post = (path: string, credential: string | undefined, body: Record<string, unknown>) =>
  raw('POST', path, {
    headers: { origin: '', ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
    body: JSON.stringify(body),
  });
const gate = (sid: string, body: Record<string, unknown>, credential = mine.credential) =>
  post(API_PATHS.daemonSessionGate(sid), credential, body);
const result = (sid: string, body: Record<string, unknown>, credential = mine.credential) =>
  post(API_PATHS.daemonSessionGateResult(sid), credential, body);

beforeAll(async () => {
  const def = structuredClone(CONDUCTOR_V4_DEF) as unknown as { id: string };
  def.id = WORKFLOW;
  await db.pool.query(
    'INSERT INTO workflow_definition (id, version, definition) VALUES ($1, 1, $2)',
    [WORKFLOW, JSON.stringify(def)],
  );
  api = await startApi({ db: db.pool, auth });
  a = await signIn();
  mine = await enroll(a);
  other = await enroll(a);
});

afterAll(async () => {
  await api.close();
});

describe('POST daemon gate (the checks to run)', () => {
  it("returns the workflow's checks of the transition and records the call", async () => {
    const t = await createTicket();
    const sid = await session(t.id);
    const res = await gate(sid, { transition: SHIP, sha: SHA });
    expect(res.status, res.text).toBe(201);
    const spec = RunGateSpecSchema.parse(res.json);
    const want = selfCheckSpecOf(CONDUCTOR_V4_DEF, 'implementing', SHIP, null)!;
    expect(spec).toMatchObject({ transition: SHIP, title: want.title, setup: want.setup });
    expect(spec.checks).toEqual(want.checks);
    const row = await db.pool.query(
      'SELECT session_id, ticket_id, workflow_state, transition, sha, finished_at, passed ' +
        'FROM self_check_run WHERE id = $1',
      [spec.run_id],
    );
    expect(row.rows[0]).toEqual({
      session_id: sid,
      ticket_id: t.id,
      workflow_state: 'implementing',
      transition: SHIP,
      sha: SHA,
      finished_at: null,
      passed: null,
    });
  });

  it("applies the repo's check override, setup included", async () => {
    const repo = 'github.com/acme/override';
    const set = await setRepoChecks(
      db.pool,
      a.accountId,
      { repo, setup: 'make deps', checks: [{ name: 'Lint', cmd: 'make lint', timeout: '5m' }] },
      null,
    );
    expect(set.ok).toBe(true);
    const sid = await session((await createTicket(repo)).id);
    const spec = RunGateSpecSchema.parse((await gate(sid, { transition: SHIP, sha: SHA })).json);
    expect(spec.setup).toBe('make deps');
    expect(spec.checks).toEqual([{ name: 'Lint', cmd: 'make lint', timeout: '5m' }]);
  });

  it('401 without a credential; 404 for another machine or a finished session', async () => {
    const t = await createTicket();
    const sid = await session(t.id);
    const body = { transition: SHIP, sha: SHA };
    expect((await gate(sid, body, '')).status).toBe(401);
    expect((await gate(sid, body, other.credential)).status).toBe(404);
    const done = await session((await createTicket()).id, 'implementing', 'done');
    expect((await gate(done, body)).status).toBe(404);
    const cookie = await raw('POST', API_PATHS.daemonSessionGate(sid), {
      headers: { cookie: a.cookie },
      body: JSON.stringify(body),
    });
    expect(cookie.status).toBe(401);
  });

  it('400 for a bad body, an unknown transition or one without checks; 409 outside an agent state', async () => {
    const sid = await session((await createTicket()).id);
    expect((await gate(sid, { transition: SHIP, sha: 'nope' })).status).toBe(400);
    const unknown = await gate(sid, { transition: 'merge_it', sha: SHA });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error?.message).toContain('not a transition you can take here');
    // A work-only transition is not offered on a personal ticket.
    expect((await gate(sid, { transition: 'pr_ready_for_review', sha: SHA })).status).toBe(400);
    const none = await gate(sid, { transition: 'ask_user', sha: SHA });
    expect(none.status).toBe(400);
    expect(none.json.error?.message).toContain('runs no checks');
    expect(none.json.error?.message).toContain(SHIP);
    const human = await session((await createTicket()).id, 'needs_input', 'needs_input');
    expect((await gate(human, { transition: SHIP, sha: SHA })).status).toBe(409);
    const count = await db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM self_check_run WHERE session_id = ANY($1)',
      [[sid, human]],
    );
    expect(count.rows[0]!.n).toBe(0);
  });
});

describe('POST daemon gate-result (the outcome)', () => {
  it('records the outcome once; a second report is a no-op; another session is 404', async () => {
    const t = await createTicket();
    const sid = await session(t.id);
    const spec = RunGateSpecSchema.parse((await gate(sid, { transition: SHIP, sha: SHA })).json);
    const outcome = {
      run_id: spec.run_id,
      passed: false,
      duration_ms: 1200,
      setup: { cmd: 'npm ci', status: 'pass' },
      results: [
        { name: 'Build passes', status: 'fail', exit_code: 1, timed_out: false, duration_ms: 900 },
      ],
    };
    const r1 = await result(sid, outcome);
    expect(r1.status, r1.text).toBe(200);
    expect((await result(sid, { ...outcome, passed: true })).status).toBe(200);
    const row = await db.pool.query<{
      passed: boolean;
      duration_ms: number;
      results: { results: { status: string }[] };
      finished: boolean;
    }>(
      'SELECT passed, duration_ms, results, finished_at IS NOT NULL AS finished FROM self_check_run WHERE id = $1',
      [spec.run_id],
    );
    expect(row.rows[0]).toMatchObject({ passed: false, duration_ms: 1200, finished: true });
    expect(row.rows[0]!.results.results[0]!.status).toBe('fail');
    const sid2 = await session((await createTicket()).id);
    expect((await result(sid2, outcome)).status).toBe(404);
    expect((await result(sid, outcome, other.credential)).status).toBe(404);

    // Process metrics read the runs (FR-5).
    const rows = await loadAdvisorRows(db.pool, { accountId: a.accountId, windowDays: 1 });
    const mineRows = (rows.self_checks ?? []).filter((r) => r.session_id === sid);
    expect(mineRows).toEqual([
      { session_id: sid, ticket_id: t.id, transition: SHIP, passed: false },
    ]);
  });
});

describe('withRunGateFeature', () => {
  it('appends the note for a machine without run_gate, only when the prompt asks for it', async () => {
    const payload = { prompt: `Implement.\n${RUN_GATE_INSTRUCTION}` };
    const m = mine;
    await db.pool.query('UPDATE machine SET features = $2 WHERE id = $1', [m.machine_id, []]);
    expect(await withRunGateFeature(db.pool, payload, `machine:${m.machine_id}`)).toEqual({
      prompt: payload.prompt + RUN_GATE_FALLBACK_NOTE,
    });
    await db.pool.query('UPDATE machine SET features = $2 WHERE id = $1', [
      m.machine_id,
      [DAEMON_FEATURE_RUN_GATE],
    ]);
    expect(await withRunGateFeature(db.pool, payload, `machine:${m.machine_id}`)).toBe(payload);
    const plain = { prompt: 'Plan it.' };
    expect(await withRunGateFeature(db.pool, plain, 'machine:nope')).toBe(plain);
  });
});
