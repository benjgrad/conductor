// 06 §Attachments: uploads (raw bytes, sniffed type), serving them, linking them to a ticket on
// create / edit, the daemon's credentialed download, the start_session payload and the sweep.
// Password mode, so the CSRF and session rules of the real deployment apply. Needs `pnpm db:up`.
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import {
  AGENT_ATTACHMENTS_PER_TICKET_MAX,
  API_PATHS,
  ATTACHMENT_MAX_IMAGE_BYTES,
  AttachmentDtoSchema,
  DAEMON_FEATURE_MESSAGE_ATTACHMENTS,
  DAEMON_FEATURE_TICKET_ATTACHMENTS,
  EnrollResponseSchema,
  EnrollmentTokenCreatedSchema,
  TicketDetailSchema,
  TicketDtoSchema,
  type AttachmentDto,
} from '@conductor/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  UNLINKED_TTL_MS,
  attachmentsFallbackNote,
  chatEchoText,
  sweepUnlinkedAttachments,
} from '../src/api/attachments.js';
import { messageAttachmentsFallbackNote, withStartAttachments } from '../src/engine/attachments.js';
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
import { InMemoryBoardBus } from '../src/contracts.js';
import { createEngineService } from '../src/engine/index.js';

const db = useTestDatabase();
const PASSWORD = 'correct horse battery staple';
const auth = passwordAuth(HTTPS_URL);

let api: TestApi;
let a: { cookie: string; accountId: string };
let b: { cookie: string; accountId: string };

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake png body'),
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

/** A raw request (node:http) with the public Host and Origin, so bytes and headers are exact. */
function raw(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: Buffer } = {},
): Promise<Res & { bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: api.port,
        agent: false,
        method,
        path,
        // A header set to '' is left out (the daemon sends no Origin).
        headers: Object.fromEntries(
          Object.entries({
            host: auth.mode === 'password' ? auth.publicHost : '',
            origin: HTTPS_URL,
            ...opts.headers,
          }).filter(([, v]) => v !== ''),
        ),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          const text = bytes.toString('utf8');
          let json: Res['json'] = {};
          try {
            json = JSON.parse(text) as Res['json'];
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json, bytes });
        });
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

const upload = (who: { cookie: string }, body: Buffer, name = 'Screen Shot.png') =>
  raw('POST', API_PATHS.attachments, {
    headers: {
      cookie: who.cookie,
      'content-type': 'application/octet-stream',
      'x-conductor-filename': encodeURIComponent(name),
    },
    body,
  });

async function uploaded(
  who: { cookie: string },
  body = PNG,
  name?: string,
): Promise<AttachmentDto> {
  const res = await upload(who, body, name);
  expect(res.status, res.text).toBe(201);
  return AttachmentDtoSchema.parse(res.json);
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

/** DELETE with a JSON `{}` and a Content-Length (node:http sends a DELETE body unframed otherwise). */
const del = (who: { cookie: string }, id: string) =>
  raw('DELETE', API_PATHS.attachment(id), {
    headers: { cookie: who.cookie, 'content-type': 'application/json', 'content-length': '2' },
    body: Buffer.from('{}'),
  });

async function createTicket(who: { cookie: string }, attachment_ids?: string[]) {
  return api.send('POST', API_PATHS.tickets, {
    ...as(who),
    body: {
      title: 'With pictures',
      body: 'see the mockup',
      repo: 'github.com/acme/app',
      kind: 'work',
      ...(attachment_ids ? { attachment_ids } : {}),
    },
  });
}

async function detail(who: { cookie: string }, id: string) {
  const res = await api.send('GET', API_PATHS.ticket(id), as(who));
  expect(res.status).toBe(200);
  return TicketDetailSchema.parse(res.json);
}

/** An enrolled machine of `who`'s account: its id and credential. */
async function enroll(who: { cookie: string }) {
  const t = await api.send('POST', API_PATHS.machineEnrollmentTokens, { ...as(who), body: {} });
  const { token } = EnrollmentTokenCreatedSchema.parse(t.json);
  const e = await api.send('POST', API_PATHS.machinesEnroll, {
    body: { token, hostname: 'h', os: 'linux', arch: 'x64', daemon_version: '0.1.0' },
  });
  expect(e.status).toBe(201);
  return EnrollResponseSchema.parse(e.json);
}

async function liveSession(
  ticketId: string,
  machineId: string | null,
  status = 'running',
): Promise<string> {
  const r = await db.pool.query<{ id: string }>(
    'INSERT INTO session (ticket_id, workflow_id, workflow_version, workflow_state, status, machine_id, account_id) ' +
      'SELECT $1, t.workflow_id, (SELECT max(version) FROM workflow_definition w WHERE w.id = t.workflow_id), ' +
      "'implementing', $2, $3, t.account_id FROM ticket t WHERE t.id = $1 RETURNING id",
    [ticketId, status, machineId],
  );
  return r.rows[0]!.id;
}

/** The daemon's upload of what its agent captured: no cookie, no Origin, its credential. */
const agentUpload = (
  sessionId: string,
  credential: string | undefined,
  body: Buffer,
  opts: { name?: string; caption?: string } = {},
) =>
  raw('POST', API_PATHS.daemonSessionAttachments(sessionId), {
    headers: {
      origin: '',
      'content-type': 'application/octet-stream',
      'x-conductor-filename': encodeURIComponent(opts.name ?? 'after.png'),
      ...(opts.caption !== undefined
        ? { 'x-conductor-caption': encodeURIComponent(opts.caption) }
        : {}),
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    },
    body,
  });

beforeAll(async () => {
  // The real engine: chat attachments ride on its send_message / send_input outbox rows.
  const boardBus = new InMemoryBoardBus();
  const { engine } = createEngineService({ db: db.pool, boardBus });
  api = await startApi({ db: db.pool, auth, engine, boardBus });
  a = await signIn();
  b = await signIn();
});

afterAll(async () => {
  await api.close();
});

describe('POST /api/attachments', () => {
  it('stores a PNG under a sanitized name and serves it back with safe headers', async () => {
    const dto = await uploaded(a, PNG, '../../evil name?.png');
    expect(dto).toMatchObject({
      name: 'evil name_.png',
      mime: 'image/png',
      size_bytes: PNG.length,
      source: 'human',
      session_id: null,
      url: API_PATHS.attachmentContent(dto.id),
    });
    const got = await raw('GET', dto.url, as(a));
    expect(got.status).toBe(200);
    expect(got.bytes.equals(PNG)).toBe(true);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(got.headers['content-disposition']).toBe("inline; filename*=UTF-8''evil%20name_.png");
  });

  it('refuses SVG / HTML (415) and a file over its type limit (413)', async () => {
    const svg = await upload(a, SVG, 'x.png');
    expect(svg.status).toBe(415);
    expect(svg.json.error?.code).toBe('attachment_type');
    const big = Buffer.concat([PNG, Buffer.alloc(ATTACHMENT_MAX_IMAGE_BYTES)]);
    const tooBig = await upload(a, big);
    expect(tooBig.status).toBe(413);
    expect(tooBig.json.error?.code).toBe('attachment_too_large');
  });

  it('CSRF: octet-stream elsewhere is 415, and the upload without Origin is 403', async () => {
    const elsewhere = await raw('POST', API_PATHS.tickets, {
      headers: { cookie: a.cookie, 'content-type': 'application/octet-stream' },
      body: PNG,
    });
    expect(elsewhere.status).toBe(415);
    const noOrigin = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: api.port,
          agent: false,
          method: 'POST',
          path: API_PATHS.attachments,
          headers: {
            host: auth.mode === 'password' ? auth.publicHost : '',
            cookie: a.cookie,
            'content-type': 'application/octet-stream',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(PNG);
    });
    expect(noOrigin).toBe(403);
    const anon = await upload({ cookie: '' }, PNG);
    expect(anon.status).toBe(401);
  });

  it("another account's attachment is 404", async () => {
    const dto = await uploaded(a);
    expect((await raw('GET', dto.url, as(b))).status).toBe(404);
    expect((await raw('GET', API_PATHS.attachmentContent('nope'), as(a))).status).toBe(404);
  });

  it('DELETE removes an unlinked upload only', async () => {
    const dto = await uploaded(a);
    const removed = await del(a, dto.id);
    expect(removed.status, removed.text).toBe(200);
    expect((await raw('GET', dto.url, as(a))).status).toBe(404);
    const linked = await uploaded(a);
    const t = TicketDtoSchema.parse((await createTicket(a, [linked.id])).json);
    const refused = await del(a, linked.id);
    expect(refused.status).toBe(409);
    expect((await detail(a, t.id)).attachments).toHaveLength(1);
  });
});

describe('linking to tickets', () => {
  it('create links them; the detail lists them; reusing one is 400 and creates nothing', async () => {
    const one = await uploaded(a, PNG, 'one.png');
    const two = await uploaded(a, PNG, 'two.png');
    const res = await createTicket(a, [one.id, two.id]);
    expect(res.status, res.text).toBe(201);
    const t = TicketDtoSchema.parse(res.json);
    expect((await detail(a, t.id)).attachments?.map((x) => x.name).sort()).toEqual([
      'one.png',
      'two.png',
    ]);

    const before = await db.pool.query('SELECT count(*)::int AS n FROM ticket');
    const again = await createTicket(a, [one.id]);
    expect(again.status).toBe(400);
    const after = await db.pool.query('SELECT count(*)::int AS n FROM ticket');
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("another account's upload can't be linked", async () => {
    const theirs = await uploaded(b);
    const res = await createTicket(a, [theirs.id]);
    expect(res.status).toBe(400);
  });

  it('PATCH adds and removes while editable; not in a non-editable column', async () => {
    const t = TicketDtoSchema.parse((await createTicket(a)).json);
    const d0 = await detail(a, t.id);
    expect(d0.attachments).toEqual([]);
    const add = await uploaded(a);
    const patched = await api.send('PATCH', API_PATHS.ticket(t.id), {
      ...as(a),
      body: { expected_updated_at: d0.updated_at, add_attachment_ids: [add.id] },
    });
    expect(patched.status, patched.text).toBe(200);
    const d1 = TicketDetailSchema.parse(patched.json);
    expect(d1.attachments?.map((x) => x.id)).toEqual([add.id]);
    const removed = await api.send('PATCH', API_PATHS.ticket(t.id), {
      ...as(a),
      body: { expected_updated_at: d1.updated_at, remove_attachment_ids: [add.id] },
    });
    expect(removed.status).toBe(200);
    expect(TicketDetailSchema.parse(removed.json).attachments).toEqual([]);

    // Implementing (an agent column) doesn't allow edits.
    await liveSession(t.id, null);
    const d2 = await detail(a, t.id);
    expect(d2.editable).toBe(false);
    const late = await uploaded(a);
    const refused = await api.send('PATCH', API_PATHS.ticket(t.id), {
      ...as(a),
      body: { expected_updated_at: d2.updated_at, add_attachment_ids: [late.id] },
    });
    expect(refused.status).toBe(403);
    expect(refused.json.error?.code).toBe('ticket_not_editable');
  });
});

describe('GET /api/daemon/attachments/:id/content', () => {
  it("the assigned machine's credential gets the bytes; another machine 404, none 401", async () => {
    const dto = await uploaded(a);
    const t = TicketDtoSchema.parse((await createTicket(a, [dto.id])).json);
    const mine = await enroll(a);
    const other = await enroll(a);
    await liveSession(t.id, mine.machine_id);
    const path = API_PATHS.daemonAttachmentContent(dto.id);
    // The daemon sends neither cookie nor Origin.
    const daemon = (credential?: string) =>
      raw('GET', path, {
        headers: { origin: '', ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
      });
    const ok = await daemon(mine.credential);
    expect(ok.status).toBe(200);
    expect(ok.bytes.equals(PNG)).toBe(true);
    expect((await daemon(other.credential)).status).toBe(404);
    expect((await daemon()).status).toBe(401);
    expect((await daemon('not-a-credential')).status).toBe(401);
  });

  it('a finished session no longer reads them', async () => {
    const dto = await uploaded(a);
    const t = TicketDtoSchema.parse((await createTicket(a, [dto.id])).json);
    const m = await enroll(a);
    await liveSession(t.id, m.machine_id, 'done');
    const res = await raw('GET', API_PATHS.daemonAttachmentContent(dto.id), {
      headers: { origin: '', authorization: `Bearer ${m.credential}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/daemon/sessions/:id/attachments', () => {
  it("stores the agent's capture on the ticket, filed under the session and state; idempotent", async () => {
    const t = TicketDtoSchema.parse((await createTicket(a)).json);
    const m = await enroll(a);
    const sessionId = await liveSession(t.id, m.machine_id);
    const before = await detail(a, t.id);
    const res = await agentUpload(sessionId, m.credential, PNG, {
      name: 'case1 before.png',
      caption: 'Before: case 1, mapped control',
    });
    expect(res.status, res.text).toBe(201);
    const dto = AttachmentDtoSchema.parse(res.json);
    expect(dto).toMatchObject({
      name: 'case1 before.png',
      source: 'agent',
      session_id: sessionId,
      workflow_state: 'implementing',
      caption: 'Before: case 1, mapped control',
    });
    const after = await detail(a, t.id);
    expect(after.attachments?.map((x) => x.id)).toEqual([dto.id]);
    expect(Date.parse(after.updated_at)).toBeGreaterThan(Date.parse(before.updated_at));
    const ev = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM event WHERE session_id = $1 AND type = 'card.upserted'",
      [sessionId],
    );
    expect(ev.rows[0]!.n).toBeGreaterThan(0);
    const bytes = await raw('GET', dto.url, as(a));
    expect(bytes.bytes.equals(PNG)).toBe(true);

    const again = await agentUpload(sessionId, m.credential, PNG, { name: 'renamed.png' });
    expect(again.status).toBe(200);
    expect(AttachmentDtoSchema.parse(again.json).id).toBe(dto.id);
    expect((await detail(a, t.id)).attachments).toHaveLength(1);

    // What an agent attached isn't handed back to the next agent as the human's.
    const payload = { prompt: 'Do it.' };
    expect(await withStartAttachments(db.pool, payload, t.id, `machine:${m.machine_id}`)).toBe(
      payload,
    );
  });

  it('401 without a credential; 404 for another machine, a finished session or a bad id', async () => {
    const t = TicketDtoSchema.parse((await createTicket(a)).json);
    const mine = await enroll(a);
    const other = await enroll(a);
    const live = await liveSession(t.id, mine.machine_id);
    expect((await agentUpload(live, undefined, PNG)).status).toBe(401);
    expect((await agentUpload(live, 'not-a-credential', PNG)).status).toBe(401);
    expect((await agentUpload(live, other.credential, PNG)).status).toBe(404);
    expect((await agentUpload('nope', mine.credential, PNG)).status).toBe(404);
    const t2 = TicketDtoSchema.parse((await createTicket(a)).json);
    const finished = await liveSession(t2.id, mine.machine_id, 'done');
    expect((await agentUpload(finished, mine.credential, PNG)).status).toBe(404);
    // A browser's cookie is not a machine credential.
    const cookie = await raw('POST', API_PATHS.daemonSessionAttachments(live), {
      headers: { cookie: a.cookie, 'content-type': 'application/octet-stream' },
      body: PNG,
    });
    expect(cookie.status).toBe(401);
  });

  it('refuses SVG (415) and an oversize image (413)', async () => {
    const t = TicketDtoSchema.parse((await createTicket(a)).json);
    const m = await enroll(a);
    const s = await liveSession(t.id, m.machine_id);
    const svg = await agentUpload(s, m.credential, SVG);
    expect(svg.status).toBe(415);
    const big = Buffer.concat([PNG, Buffer.alloc(ATTACHMENT_MAX_IMAGE_BYTES)]);
    expect((await agentUpload(s, m.credential, big)).status).toBe(413);
  });

  it("the agent's count limit is its own: it can't use up the human's slots", async () => {
    const human = await uploaded(a);
    const t = TicketDtoSchema.parse((await createTicket(a, [human.id])).json);
    const m = await enroll(a);
    const s = await liveSession(t.id, m.machine_id);
    for (let i = 0; i < AGENT_ATTACHMENTS_PER_TICKET_MAX; i++) {
      const png = Buffer.concat([PNG, Buffer.from(`#${i}`)]);
      const res = await agentUpload(s, m.credential, png);
      expect(res.status, res.text).toBe(201);
    }
    const over = await agentUpload(s, m.credential, Buffer.concat([PNG, Buffer.from('over')]));
    expect(over.status).toBe(400);
    expect(over.json.error?.code).toBe('attachment_limit');
    const n = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM attachment WHERE ticket_id = $1 AND source = 'agent'",
      [t.id],
    );
    expect(n.rows[0]!.n).toBe(AGENT_ATTACHMENTS_PER_TICKET_MAX);
  });
});

describe('start_session payload', () => {
  it('a machine with the feature gets the refs; without, a note on the prompt', async () => {
    const dto = await uploaded(a, PNG, 'mock.png');
    const t = TicketDtoSchema.parse((await createTicket(a, [dto.id])).json);
    const withFeature = await enroll(a);
    const without = await enroll(a);
    await db.pool.query('UPDATE machine SET features = $2 WHERE id = $1', [
      withFeature.machine_id,
      [DAEMON_FEATURE_TICKET_ATTACHMENTS],
    ]);
    const payload = { prompt: 'Do it.', tools: [] };
    const sha = createHash('sha256').update(PNG).digest('hex');
    const got = await withStartAttachments(
      db.pool,
      payload,
      t.id,
      `machine:${withFeature.machine_id}`,
    );
    expect(got).toEqual({
      ...payload,
      attachments: [
        { id: dto.id, name: 'mock.png', mime: 'image/png', size: PNG.length, sha256: sha },
      ],
    });
    const old = await withStartAttachments(db.pool, payload, t.id, `machine:${without.machine_id}`);
    expect(old).toEqual({
      ...payload,
      prompt:
        'Do it.' +
        attachmentsFallbackNote([
          { id: dto.id, name: 'mock.png', mime: 'image/png', size: 1, sha256: sha },
        ]),
    });
    expect(old.prompt).toContain('This ticket has 1 attachment (mock.png)');
    // No attachments: unchanged.
    const bare = TicketDtoSchema.parse((await createTicket(a)).json);
    expect(
      await withStartAttachments(db.pool, payload, bare.id, `machine:${without.machine_id}`),
    ).toBe(payload);
  });
});

describe('chat attachments (sent with a message, an answer or a reopen)', () => {
  // One machine row for the block (no WS here, and enrolling is rate limited); each test sets
  // its features.
  const m = { machine_id: randomUUID() };
  beforeAll(async () => {
    await db.pool.query(
      'INSERT INTO machine (id, account_id, name, hostname, os, arch, cpu_total, mem_total_mb, ' +
        'disk_free_mb, budget_cpu, budget_mem_mb, max_sessions, max_concurrent_builds, features) ' +
        "VALUES ($1, $2, 'Laptop', 'h', 'linux', 'x64', 8, 16000, 100000, 4, 8000, 2, 1, '{}')",
      [m.machine_id, a.accountId],
    );
  });

  /** A ticket of `a` with a running agent whose process is live on a machine (with `features`). */
  async function agentAtWork(features: string[]) {
    const t = TicketDtoSchema.parse((await createTicket(a)).json);
    await db.pool.query('UPDATE machine SET features = $2 WHERE id = $1', [m.machine_id, features]);
    const sessionId = await liveSession(t.id, m.machine_id);
    await db.pool.query(
      'UPDATE session SET agent_process_live = true, agent_command_id = gen_random_uuid() ' +
        'WHERE id = $1',
      [sessionId],
    );
    return { ticketId: t.id, sessionId, machineId: m.machine_id };
  }

  const sendMessage = (sessionId: string, body: object) =>
    api.send('POST', `/api/sessions/${sessionId}/messages`, { ...as(a), body });

  async function outboxPayload(sessionId: string, kind: string) {
    const r = await db.pool.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM outbox WHERE session_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 1',
      [sessionId, kind],
    );
    return r.rows[0]?.payload;
  }

  it('a message links them under the session and state; send_message carries the refs', async () => {
    const w = await agentAtWork([DAEMON_FEATURE_MESSAGE_ATTACHMENTS]);
    const dto = await uploaded(a, PNG, 'like this.png');
    const res = await sendMessage(w.sessionId, { text: 'Like this', attachment_ids: [dto.id] });
    expect(res.status, res.text).toBe(202);
    const after = await detail(a, w.ticketId);
    expect(after.attachments).toEqual([
      expect.objectContaining({
        id: dto.id,
        source: 'human',
        session_id: w.sessionId,
        workflow_state: 'implementing',
      }),
    ]);
    const sha = createHash('sha256').update(PNG).digest('hex');
    expect(await outboxPayload(w.sessionId, 'send_message')).toMatchObject({
      text: 'Like this',
      attachments: [
        { id: dto.id, name: 'like this.png', mime: 'image/png', size: PNG.length, sha256: sha },
      ],
    });
  });

  it('only files: the agent gets a sentence; without the feature, a note on the text', async () => {
    const w = await agentAtWork([]);
    const dto = await uploaded(a, PNG, 'only.png');
    const res = await sendMessage(w.sessionId, { text: '', attachment_ids: [dto.id] });
    expect(res.status, res.text).toBe(202);
    const payload = await outboxPayload(w.sessionId, 'send_message');
    expect(payload?.attachments).toBeUndefined();
    expect(payload?.text).toBe(
      'The human attached files to this message.' +
        messageAttachmentsFallbackNote([
          { id: dto.id, name: 'only.png', mime: 'image/png', size: 1, sha256: 'x' },
        ]),
    );
  });

  it('empty text without files is 400; an unknown or linked id is 400 and sends nothing', async () => {
    const w = await agentAtWork([DAEMON_FEATURE_MESSAGE_ATTACHMENTS]);
    expect((await sendMessage(w.sessionId, { text: '  ' })).status).toBe(400);
    const dto = await uploaded(a, PNG);
    expect((await sendMessage(w.sessionId, { text: 'x', attachment_ids: [dto.id] })).status).toBe(
      202,
    );
    const again = await sendMessage(w.sessionId, { text: 'y', attachment_ids: [dto.id] });
    expect(again.status).toBe(400);
    const other = await uploaded(b, PNG);
    expect((await sendMessage(w.sessionId, { text: 'y', attachment_ids: [other.id] })).status).toBe(
      400,
    );
    const sent = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM outbox WHERE session_id = $1 AND kind = 'send_message'",
      [w.sessionId],
    );
    expect(sent.rows[0]!.n).toBe(1);
  });

  it('a message the session refuses leaves the upload unlinked, to send again', async () => {
    const w = await agentAtWork([DAEMON_FEATURE_MESSAGE_ATTACHMENTS]);
    await db.pool.query('UPDATE session SET agent_process_live = false WHERE id = $1', [
      w.sessionId,
    ]);
    const dto = await uploaded(a, PNG);
    const res = await sendMessage(w.sessionId, { text: 'hi', attachment_ids: [dto.id] });
    expect(res.status).toBe(409);
    const row = await db.pool.query<{ ticket_id: string | null; session_id: string | null }>(
      'SELECT ticket_id, session_id FROM attachment WHERE id = $1',
      [dto.id],
    );
    expect(row.rows[0]).toEqual({ ticket_id: null, session_id: null });
  });

  it('a reopen links them under the new session, and its start carries them', async () => {
    const t = TicketDtoSchema.parse((await createTicket(a)).json);
    const old = await liveSession(t.id, null, 'done');
    const dto = await uploaded(a, PNG, 'redo.png');
    const res = await api.send('POST', `/api/sessions/${old}/reopen`, {
      ...as(a),
      body: { text: '', attachment_ids: [dto.id] },
    });
    expect(res.status, res.text).toBe(202);
    const fresh = (res.json as { session_id: string }).session_id;
    expect((await detail(a, t.id)).attachments).toEqual([
      expect.objectContaining({ id: dto.id, session_id: fresh, workflow_state: null }),
    ]);
    await db.pool.query('UPDATE machine SET features = $2 WHERE id = $1', [
      m.machine_id,
      [DAEMON_FEATURE_TICKET_ATTACHMENTS],
    ]);
    const got = await withStartAttachments(
      db.pool,
      { prompt: 'p' },
      t.id,
      `machine:${m.machine_id}`,
    );
    expect(got.attachments).toEqual([expect.objectContaining({ id: dto.id, name: 'redo.png' })]);
  });

  it("the chat bubble's text names each file on its own line", () => {
    expect(chatEchoText('Look', ['a.png', 'b.gif'])).toBe('Look\n\u{1F4CE} a.png\n\u{1F4CE} b.gif');
    expect(chatEchoText('', ['a.png'])).toBe('\u{1F4CE} a.png');
    expect(chatEchoText('Just text', [])).toBe('Just text');
  });
});

describe('sweepUnlinkedAttachments', () => {
  it('deletes unlinked uploads older than a day, keeps linked and recent ones', async () => {
    const old = await uploaded(a);
    const recent = await uploaded(a);
    const linked = await uploaded(a);
    await createTicket(a, [linked.id]);
    await db.pool.query(
      "UPDATE attachment SET created_at = now() - interval '2 days' WHERE id = ANY($1::uuid[])",
      [[old.id, linked.id]],
    );
    await sweepUnlinkedAttachments(db.pool, new Date());
    const left = await db.pool.query<{ id: string }>(
      'SELECT id FROM attachment WHERE id = ANY($1::uuid[])',
      [[old.id, recent.id, linked.id]],
    );
    expect(left.rows.map((r) => r.id).sort()).toEqual([recent.id, linked.id].sort());
    const content = await db.pool.query(
      'SELECT 1 FROM attachment_content WHERE attachment_id = $1',
      [old.id],
    );
    expect(content.rowCount).toBe(0);
    expect(UNLINKED_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});
