import { createServer, type AddressInfo } from 'node:net';
import {
  createApi,
  FakeEngineService,
  InMemoryBoardBus,
  InMemoryOutputBus,
} from '@conductor/orchestrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, passwordAuth } from '../../../orchestrator/test/auth/helpers.js';
// Aliased: the react-hooks lint (on for web) reads a use* call as a hook; this is vitest wiring.
import { useTestDatabase as testDatabase } from '../../../orchestrator/test/db.js';
import { ApiRequestError, type ApiClient } from './client.js';
import { createHttpApi } from './http.js';

// M2-T15b1 (FR-5): the web client's admin calls against the real /api/admin/* routes, in
// password mode on a loopback public URL (so Host and Origin are the real ones). The fetch
// wrapper plays the browser: it sends Origin and keeps the session cookie. Needs `pnpm db:up`.

const db = testDatabase();
const PASSWORD = 'correct horse battery staple';

type Api = ReturnType<typeof createApi>;
let api: Api;
let client: ApiClient;
let admin: { userId: string; accountId: string; email: string };
let member: { userId: string; accountId: string; email: string };

/** A free loopback port: the public URL must name it before createApi. */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  api = createApi({
    db: db.pool,
    engine: new FakeEngineService(),
    boardBus: new InMemoryBoardBus(),
    outputBus: new InMemoryOutputBus(),
    auth: passwordAuth(base),
    security: {},
  });
  await api.listen(port, '127.0.0.1');

  admin = await createUser(db.pool, { password: PASSWORD, admin: true });
  member = await createUser(db.pool, { password: PASSWORD });
  await db.pool.query(
    "INSERT INTO account_member (account_id, user_id, role) VALUES ($1, $2, 'member')",
    [admin.accountId, member.userId],
  );

  let cookie: string | null = null;
  const browserFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('origin', base);
    if (cookie !== null) headers.set('cookie', cookie);
    const res = await fetch(input, { ...init, headers });
    const set = res.headers.getSetCookie()[0];
    if (set !== undefined) cookie = set.split(';')[0]!;
    return res;
  };
  client = createHttpApi({ baseUrl: base, fetch: browserFetch });
  await client.login({ email: admin.email, password: PASSWORD });
});

afterAll(async () => {
  await api.close();
});

describe('admin client ↔ real /api/admin/* routes', () => {
  it('lists users, creates, lists and revokes invites, makes a reset link, unlocks, disables', async () => {
    const users = await client.listUsers();
    expect(users.map((u) => u.email).sort()).toEqual([admin.email, member.email].sort());

    const invite = await client.createInvite({ days: 1, admin: false });
    expect(invite.url).toMatch(/\/signup\?invite=/);
    const invites = await client.listInvites();
    expect(invites.map((i) => i.id)).toEqual([invite.id]);
    expect(invites[0]!.revoked_at).toBeNull();
    expect(await client.revokeInvite(invite.id)).toEqual({ ok: true });
    expect((await client.listInvites())[0]!.revoked_at).not.toBeNull();

    const link = await client.createResetLink(member.userId);
    expect(link.url).toMatch(/\/reset\?token=/);
    expect(await client.unlockUser(member.userId)).toEqual({ ok: true });
    expect(await client.disableUser(member.userId)).toEqual({ ok: true });
    const after = await client.listUsers();
    expect(after.find((u) => u.id === member.userId)!.disabled_at).not.toBeNull();
  });

  it("another account's user → ApiRequestError 404 not_found", async () => {
    const stranger = await createUser(db.pool, { password: PASSWORD });
    const err = await client.disableUser(stranger.userId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(404);
    expect((err as ApiRequestError).code).toBe('not_found');
  });
});
