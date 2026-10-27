// M2-T15a FR-5: after the bootstrap sign-up (password mode), the `local` account's existing
// tickets are the new owner's board. Needs `pnpm db:up`.
import { afterEach, describe, expect, it } from 'vitest';
import { runAdminCli } from '../../src/auth/admin-commands.js';
import { useTestDatabase } from '../db.js';
import { seedSession } from '../engine/fixtures.js';
import { LOOPBACK_URL, cookieOf, passwordAuth, startApi, type TestApi } from './helpers.js';

const db = useTestDatabase();
let api: TestApi | null = null;

afterEach(async () => {
  await api?.close();
  api = null;
});

describe('bootstrap → sign-up → board', () => {
  it('shows a ticket that existed in `local` before anyone signed up', async () => {
    const { ticketId } = await seedSession(db.pool);
    const out: string[] = [];
    const code = await runAdminCli(['bootstrap'], {
      db: db.pool,
      publicUrl: new URL(LOOPBACK_URL),
      now: () => new Date(),
      out: (l) => out.push(l),
      err: (l) => out.push(l),
    });
    expect(code).toBe(0);
    const invite = new URL(/https?:\/\/\S+/.exec(out.join('\n'))![0]).searchParams.get('invite')!;

    api = await startApi({ db: db.pool, auth: passwordAuth(LOOPBACK_URL) });
    expect((await api.send('GET', '/api/board')).status).toBe(401);
    const signup = await api.send('POST', '/auth/signup', {
      body: {
        invite,
        email: 'ben@example.com',
        display_name: 'Ben',
        password: 'correct horse battery staple',
      },
    });
    expect(signup.status).toBe(201);
    const board = await api.send('GET', '/api/board', { headers: { cookie: cookieOf(signup) } });
    expect(board.status).toBe(200);
    expect(board.text).toContain(ticketId);
  });
});
