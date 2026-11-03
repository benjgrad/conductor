// ADR-0032: /api/schedules (password mode). The routes are thin over schedules/store.ts (covered by
// schedules.test.ts); this checks the HTTP surface: auth, status codes, bodies and account scope.
// Needs `pnpm db:up`.
import {
  API_PATHS,
  RunScheduleResponseSchema,
  ScheduleDtoSchema,
  ScheduleListResponseSchema,
} from '@conductor/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HTTPS_URL,
  cookieOf,
  createUser,
  passwordAuth,
  startApi,
  type TestApi,
} from './auth/helpers.js';
import { useTestDatabase } from './db.js';

const db = useTestDatabase();
const PASSWORD = 'correct horse battery staple';
let api: TestApi | null = null;

afterEach(async () => {
  await api?.close();
  api = null;
});

async function signIn(t: TestApi) {
  const u = await createUser(db.pool, { password: PASSWORD });
  const res = await t.send('POST', API_PATHS.authLogin, {
    body: { email: u.email, password: PASSWORD },
  });
  expect(res.status).toBe(200);
  return { cookie: cookieOf(res), email: u.email };
}

/** A JSON body on DELETE: node sends it chunked unless the length is given. */
const del = (t: TestApi, cookie: string, path: string) =>
  t.send('DELETE', path, { headers: { cookie, 'content-length': '2' }, body: {} });

describe('/api/schedules', () => {
  it('needs a session', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    expect((await api.send('GET', API_PATHS.schedules)).status).toBe(401);
  });

  it('create, read, edit, run now and delete, scoped to the account', async () => {
    api = await startApi({ db: db.pool, auth: passwordAuth(HTTPS_URL) });
    const a = await signIn(api);
    const b = await signIn(api);
    const created = await api.send('POST', API_PATHS.schedules, {
      headers: { cookie: a.cookie },
      body: {
        name: 'PR sweep',
        cron: '0 9 * * 1-5',
        timezone: 'Europe/London',
        title: 'Keep PRs and Jira up to date',
        body: 'Use the mtd skills.',
        repo: 'https://github.com/acme/app.git',
        kind: 'work',
      },
    });
    expect(created.status).toBe(201);
    const dto = ScheduleDtoSchema.parse(created.json);
    expect(dto).toMatchObject({ repo: 'github.com/acme/app', created_by: a.email });
    expect(dto.warnings).toEqual(['no_machine_has_repo']);

    const bad = await api.send('POST', API_PATHS.schedules, {
      headers: { cookie: a.cookie },
      body: { name: 'x', cron: '* * * * *', title: 't', repo: 'github.com/a/b', kind: 'work' },
    });
    expect([bad.status, (bad.json as { error: { code: string } }).error.code]).toEqual([
      400,
      'bad_request',
    ]);

    const list = ScheduleListResponseSchema.parse(
      (await api.send('GET', API_PATHS.schedules, { headers: { cookie: a.cookie } })).json,
    );
    expect(list.schedules.map((s) => s.id)).toEqual([dto.id]);
    const listB = ScheduleListResponseSchema.parse(
      (await api.send('GET', API_PATHS.schedules, { headers: { cookie: b.cookie } })).json,
    );
    expect(listB.schedules).toEqual([]);
    const getB = await api.send('GET', API_PATHS.schedule(dto.id), {
      headers: { cookie: b.cookie },
    });
    expect(getB.status).toBe(404);

    const patched = await api.send('PATCH', API_PATHS.schedule(dto.id), {
      headers: { cookie: a.cookie },
      body: { title: 'Sweep', expected_updated_at: dto.updated_at },
    });
    expect(patched.status).toBe(200);
    expect(ScheduleDtoSchema.parse(patched.json).title).toBe('Sweep');

    const run = await api.send('POST', API_PATHS.scheduleRun(dto.id), {
      headers: { cookie: a.cookie },
      body: {},
    });
    expect(run.status).toBe(201);
    const ran = RunScheduleResponseSchema.parse(run.json);
    const ticket = await api.send('GET', API_PATHS.ticket(ran.ticket_id), {
      headers: { cookie: a.cookie },
    });
    expect(ticket.json).toMatchObject({
      workflow_id: 'routine',
      schedule: { id: dto.id, name: 'PR sweep' },
    });
    const again = await api.send('POST', API_PATHS.scheduleRun(dto.id), {
      headers: { cookie: a.cookie },
      body: {},
    });
    expect([again.status, (again.json as { error: { code: string } }).error.code]).toEqual([
      409,
      'previous_run_open',
    ]);

    expect((await del(api, b.cookie, API_PATHS.schedule(dto.id))).status).toBe(404);
    expect((await del(api, a.cookie, API_PATHS.schedule(dto.id))).status).toBe(200);
    expect(
      (await api.send('GET', API_PATHS.schedule(dto.id), { headers: { cookie: a.cookie } })).status,
    ).toBe(404);
  });
});
