// R11: GitHub webhook deliveries through the real API in password mode (no cookie, no Origin, as
// GitHub sends them): the signature, the account's secret, dedup by X-GitHub-Delivery, and the
// sessions a delivery wakes (their next check comes forward to now; the sweep then fires it).
// Needs `pnpm db:up`.
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import {
  API_PATHS,
  GithubWebhookSecretCreatedSchema,
  GithubWebhookStatusSchema,
  PR_CONTEXT_KEY,
  STEP_CONTEXT_KEY,
  TicketDtoSchema,
  type EngineEvent,
} from '@conductor/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EngineService } from '../src/contracts.js';
import type { GithubWebhookDeliveryRow, SessionRow } from '../src/db/types.js';
import { sweepOnce } from '../src/engine/sweep.js';
import { signGithubPayload } from '../src/github-webhook/signature.js';
import { rotateWebhookSecret } from '../src/github-webhook/store.js';
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
import { seedBase } from './engine/fixtures.js';

const db = useTestDatabase();
const auth = passwordAuth(HTTPS_URL);
const PASSWORD = 'correct horse battery staple';
const MIN = 60_000;
let t = new Date('2026-11-11T12:00:00.000Z').getTime();
const now = () => new Date(t);

let api: TestApi;
let mine: { cookie: string; accountId: string };
let other: { accountId: string };
let secret: string;

const REPO = 'github.com/acme/app';
const PR7 = 'https://github.com/acme/app/pull/7';
const BRANCH = 'conductor/fix-1';

/** A raw POST as GitHub sends it: public Host, no Origin, no cookie. */
function deliver(
  accountId: string,
  event: string,
  payload: unknown,
  opts: { deliveryId?: string; sign?: string | null; contentType?: string; body?: string } = {},
): Promise<Res> {
  const body = opts.body ?? JSON.stringify(payload);
  const sig = opts.sign === undefined ? signGithubPayload(secret, body) : opts.sign;
  const headers: Record<string, string> = {
    host: auth.mode === 'password' ? auth.publicHost : '',
    'content-type': opts.contentType ?? 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    'user-agent': 'GitHub-Hookshot/abc',
    'x-github-event': event,
    'x-github-delivery': opts.deliveryId ?? randomUUID(),
    ...(sig !== null ? { 'x-hub-signature-256': sig } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: api.port,
        agent: false,
        method: 'POST',
        path: API_PATHS.githubWebhookDelivery(accountId),
        headers,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (text += d));
        res.on('end', () => {
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
    req.end(body);
  });
}

const checkSuite = (o: { prs?: number[]; branch?: string; action?: string } = {}) => ({
  action: o.action ?? 'completed',
  repository: { full_name: 'acme/app' },
  check_suite: {
    head_branch: o.branch ?? 'unrelated',
    pull_requests: (o.prs ?? []).map((number) => ({ number })),
  },
});

/** A live session of `accountId`: in a PR gate's conditions phase, or watched in a human state. */
async function session(
  accountId: string,
  kind: 'conditions' | 'watch',
  o: { repo?: string; pr?: string | null; branch?: string; dueIn?: number } = {},
): Promise<string> {
  const ticketId = randomUUID();
  const id = randomUUID();
  await db.pool.query(
    'INSERT INTO ticket (id, account_id, repo, title, body, workflow_id, workflow_version, status) ' +
      "VALUES ($1, $2, $3, 'T', 'b', 'm1_basic', 1, 'in_progress')",
    [ticketId, accountId, o.repo ?? REPO],
  );
  const pr = o.pr === undefined ? PR7 : o.pr;
  const context = {
    ...(pr !== null ? { [PR_CONTEXT_KEY]: { pr_url: pr } } : {}),
    ...(kind === 'conditions' ? { [STEP_CONTEXT_KEY]: { phase: 'conditions' } } : {}),
  };
  const due = new Date(t + (o.dueIn ?? 10 * MIN));
  await db.pool.query(
    `INSERT INTO session (id, account_id, ticket_id, workflow_id, workflow_version, status,
                          workflow_state, branch, context, state_deadline, watch_deadline)
     VALUES ($1, $2, $3, 'm1_basic', 1, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      accountId,
      ticketId,
      kind === 'conditions' ? 'waiting_external' : 'needs_input',
      kind === 'conditions' ? 'implementing' : 'in_review',
      o.branch ?? `branch-${id.slice(0, 8)}`,
      JSON.stringify(context),
      kind === 'conditions' ? due : null,
      kind === 'watch' ? due : null,
    ],
  );
  return id;
}

const row = async (id: string) =>
  (await db.pool.query<SessionRow>('SELECT * FROM session WHERE id = $1', [id])).rows[0]!;
const deliveries = async () =>
  (await db.pool.query<GithubWebhookDeliveryRow>('SELECT * FROM github_webhook_delivery')).rows;

beforeAll(async () => {
  await seedBase(db.pool);
  api = await startApi({ db: db.pool, auth, now });
  const u = await createUser(db.pool, { password: PASSWORD });
  const login = await api.send('POST', API_PATHS.authLogin, {
    body: { email: u.email, password: PASSWORD },
  });
  expect(login.status).toBe(200);
  mine = { cookie: cookieOf(login), accountId: u.accountId };
  other = { accountId: (await createUser(db.pool, { password: PASSWORD })).accountId };
});

afterAll(async () => {
  await api.close();
});

beforeEach(async () => {
  t += 60 * MIN; // later than every earlier test's deadlines
  // Only this test's sessions have a check ahead.
  await db.pool.query('UPDATE session SET state_deadline = NULL, watch_deadline = NULL');
});

describe('the account secret (REST)', () => {
  it('GET shows the URL and no secret; POST makes one, shown once', async () => {
    const as = { headers: { cookie: mine.cookie } };
    const before = GithubWebhookStatusSchema.parse(
      (await api.send('GET', API_PATHS.githubWebhook, as)).json,
    );
    expect(before).toEqual({
      url: `${HTTPS_URL}/api/webhooks/github/${mine.accountId}`,
      configured: false,
      rotated_at: null,
      last_delivery_at: null,
    });
    const made = await api.send('POST', API_PATHS.githubWebhookSecret, { ...as, body: {} });
    expect(made.status).toBe(200);
    const created = GithubWebhookSecretCreatedSchema.parse(made.json);
    expect(created.url).toBe(before.url);
    secret = created.secret;
    const after = await api.send('GET', API_PATHS.githubWebhook, as);
    expect(after.json).toMatchObject({ configured: true });
    expect(after.text).not.toContain(secret);
  });

  it('needs a session', async () => {
    expect((await api.send('GET', API_PATHS.githubWebhook)).status).toBe(401);
  });

  it('the other JSON routes still parse their bodies (the raw parser is this plugin only)', async () => {
    const res = await api.send('POST', API_PATHS.tickets, {
      headers: { cookie: mine.cookie },
      body: { title: 'Parsed', body: 'b', repo: REPO, kind: 'personal' },
    });
    expect(res.status).toBe(201);
    expect(TicketDtoSchema.parse(res.json).title).toBe('Parsed');
  });
});

describe('a delivery', () => {
  it('is refused without a valid signature, and nothing is recorded', async () => {
    const id = await session(mine.accountId, 'conditions');
    const before = await deliveries();
    for (const sign of [null, signGithubPayload('wrong secret', '{}'), 'sha1=abc']) {
      const res = await deliver(mine.accountId, 'check_suite', checkSuite({ prs: [7] }), { sign });
      expect(res.status).toBe(401);
      expect(res.json.error?.code).toBe('unauthorized');
    }
    expect(await deliveries()).toEqual(before);
    expect((await row(id)).state_deadline!.getTime()).toBe(t + 10 * MIN);
  });

  it('404s for an account with no secret, or no account', async () => {
    expect((await deliver(other.accountId, 'ping', {})).status).toBe(404);
    expect((await deliver(randomUUID(), 'ping', {})).status).toBe(404);
    expect((await deliver('not-a-uuid', 'ping', {})).status).toBe(404);
  });

  it('answers the ping GitHub sends when the hook is added', async () => {
    const res = await deliver(mine.accountId, 'ping', { zen: 'Speak like a human.' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, nudged: 0 });
  });

  it('refuses a form-encoded delivery (the content type must be JSON)', async () => {
    const body = 'payload=' + encodeURIComponent('{}');
    const res = await deliver(mine.accountId, 'check_suite', null, {
      body,
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(res.status).toBe(415);
  });

  it('needs X-GitHub-Event and a JSON body', async () => {
    expect((await deliver(mine.accountId, '', {})).status).toBe(400);
    expect((await deliver(mine.accountId, 'check_suite', null, { body: '{nope' })).status).toBe(
      400,
    );
  });

  it('check_suite completed wakes the matching PR gate and watch, nothing else (FR-2)', async () => {
    const gate = await session(mine.accountId, 'conditions');
    const byBranch = await session(mine.accountId, 'watch', { pr: null, branch: BRANCH });
    const watched = await session(mine.accountId, 'watch');
    const otherPr = await session(mine.accountId, 'watch', {
      pr: 'https://github.com/acme/app/pull/8',
    });
    const otherRepo = await session(mine.accountId, 'conditions', {
      repo: 'github.com/acme/other',
      pr: 'https://github.com/acme/other/pull/7',
      branch: BRANCH,
    });
    const otherAccount = await session(other.accountId, 'conditions');

    const res = await deliver(
      mine.accountId,
      'check_suite',
      checkSuite({ prs: [7], branch: BRANCH }),
    );
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ ok: true, nudged: 3 });

    expect((await row(gate)).state_deadline!.getTime()).toBe(t);
    expect((await row(byBranch)).watch_deadline!.getTime()).toBe(t);
    expect((await row(watched)).watch_deadline!.getTime()).toBe(t);
    for (const id of [otherPr])
      expect((await row(id)).watch_deadline!.getTime()).toBe(t + 10 * MIN);
    for (const id of [otherRepo, otherAccount]) {
      expect((await row(id)).state_deadline!.getTime()).toBe(t + 10 * MIN);
    }
    // Nothing was decided: status and state are as they were.
    expect(await row(gate)).toMatchObject({
      status: 'waiting_external',
      workflow_state: 'implementing',
    });

    // The sweep fires them as usual (event → sessions → the normal evaluation).
    const fired: { id: string; event: EngineEvent }[] = [];
    const engine = {
      applyEvent: (id: string, event: EngineEvent) => {
        fired.push({ id, event });
        return Promise.resolve({ status: 'applied' });
      },
    } as unknown as EngineService;
    await sweepOnce({ db: db.pool, engine, now });
    expect(fired.map((f) => [f.id, f.event.type]).sort()).toEqual(
      [
        [gate, 'timer.fired'],
        [byBranch, 'watch.fired'],
        [watched, 'watch.fired'],
      ].sort(),
    );
  });

  it('a merged PR wakes every watch on the repo (the default branch moved)', async () => {
    const watched = await session(mine.accountId, 'watch', {
      pr: 'https://github.com/acme/app/pull/8',
    });
    const gate = await session(mine.accountId, 'conditions', {
      pr: 'https://github.com/acme/app/pull/8',
    });
    const res = await deliver(mine.accountId, 'pull_request', {
      action: 'closed',
      repository: { full_name: 'acme/app' },
      pull_request: { html_url: PR7, head: { ref: BRANCH }, merged: true },
    });
    expect(res.json).toEqual({ ok: true, nudged: 1 });
    expect((await row(watched)).watch_deadline!.getTime()).toBe(t);
    expect((await row(gate)).state_deadline!.getTime()).toBe(t + 10 * MIN);
  });

  it('an event or action that settles nothing is acknowledged and ignored', async () => {
    const gate = await session(mine.accountId, 'conditions');
    for (const [event, payload] of [
      ['check_suite', checkSuite({ prs: [7], action: 'requested' })],
      ['push', { ref: 'refs/heads/main' }],
    ] as const) {
      const res = await deliver(mine.accountId, event, payload);
      expect(res.status).toBe(202);
      expect(res.json).toEqual({ ok: true, nudged: 0, ignored: true });
    }
    expect((await row(gate)).state_deadline!.getTime()).toBe(t + 10 * MIN);
  });

  it('is deduplicated by X-GitHub-Delivery (FR-4)', async () => {
    const gate = await session(mine.accountId, 'conditions');
    const deliveryId = randomUUID();
    const first = await deliver(mine.accountId, 'check_suite', checkSuite({ prs: [7] }), {
      deliveryId,
    });
    expect(first.json).toEqual({ ok: true, nudged: 1 });
    expect((await row(gate)).state_deadline!.getTime()).toBe(t);

    // The poll re-armed it; a redelivery of the same delivery changes nothing.
    await db.pool.query('UPDATE session SET state_deadline = $2 WHERE id = $1', [
      gate,
      new Date(t + 5 * MIN),
    ]);
    const again = await deliver(mine.accountId, 'check_suite', checkSuite({ prs: [7] }), {
      deliveryId,
    });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ ok: true, nudged: 0, duplicate: true });
    expect((await row(gate)).state_deadline!.getTime()).toBe(t + 5 * MIN);
    const recorded = (await deliveries()).filter((d) => d.delivery_id === deliveryId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      account_id: mine.accountId,
      event: 'check_suite',
      sessions_nudged: 1,
    });

    // A new delivery id wakes it again.
    const fresh = await deliver(mine.accountId, 'check_suite', checkSuite({ prs: [7] }));
    expect(fresh.json).toEqual({ ok: true, nudged: 1 });
  });

  it('prunes deliveries older than a week', async () => {
    const old = randomUUID();
    await db.pool.query(
      "INSERT INTO github_webhook_delivery (delivery_id, account_id, event, received_at) VALUES ($1, $2, 'check_run', $3)",
      [old, mine.accountId, new Date(t - 8 * 24 * 60 * MIN)],
    );
    await deliver(mine.accountId, 'push', {});
    expect((await deliveries()).some((d) => d.delivery_id === old)).toBe(false);
  });

  it('a rotated secret takes over at once', async () => {
    const before = secret;
    secret = await rotateWebhookSecret(db.pool, mine.accountId, now());
    expect((await deliver(mine.accountId, 'ping', {})).status).toBe(200);
    expect(
      (await deliver(mine.accountId, 'ping', {}, { sign: signGithubPayload(before, '{}') })).status,
    ).toBe(401);
  });
});
