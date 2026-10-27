// M2-T15a: invites and GET /auth/invites/:token (ADR-0017 §Invites). Needs `pnpm db:up`.
import { createHash } from 'node:crypto';
import { InvitePreviewSchema } from '@conductor/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { DAY_MS, createInvite, previewInvite } from '../../src/auth/invites.js';
import { newSessionToken } from '../../src/auth/sessions.js';
import { useTestDatabase } from '../db.js';
import { LOOPBACK_URL, fakeClock, passwordAuth, startApi, type TestApi } from './helpers.js';

const db = useTestDatabase();
const publicUrl = new URL(LOOPBACK_URL);
const INVALID = { valid: false, expires_at: null };
let api: TestApi | null = null;

afterEach(async () => {
  await api?.close();
  api = null;
});

describe('createInvite', () => {
  it('stores only the SHA-256 of a 256-bit token and returns the signup URL', async () => {
    const now = new Date();
    const inv = await createInvite(db.pool, { publicUrl, now, email: ' Dana@Example.com ' });
    expect(inv.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(inv.token, 'base64url')).toHaveLength(32);
    expect(inv.url).toBe(`${LOOPBACK_URL}/signup?invite=${inv.token}`);
    expect(inv.expires_at.getTime() - now.getTime()).toBe(7 * DAY_MS);
    const row = await db.pool.query<{ token_hash: Buffer; email: string; whole: string }>(
      'SELECT token_hash, email, invite::text AS whole FROM invite WHERE id = $1',
      [inv.id],
    );
    expect(row.rows[0]!.token_hash).toEqual(createHash('sha256').update(inv.token).digest());
    expect(row.rows[0]!.email).toBe('dana@example.com');
    expect(row.rows[0]!.whole).not.toContain(inv.token);
  });

  it('days must be 1..30', async () => {
    const now = new Date();
    await expect(createInvite(db.pool, { publicUrl, now, days: 0 })).rejects.toThrow(RangeError);
    await expect(createInvite(db.pool, { publicUrl, now, days: 31 })).rejects.toThrow(RangeError);
    await expect(createInvite(db.pool, { publicUrl, now, days: 1.5 })).rejects.toThrow(RangeError);
    const inv = await createInvite(db.pool, { publicUrl, now, days: 30 });
    expect(inv.expires_at.getTime() - now.getTime()).toBe(30 * DAY_MS);
  });
});

describe('previewInvite', () => {
  it('open → valid with the expiry and pinned email only', async () => {
    const now = new Date();
    const inv = await createInvite(db.pool, {
      publicUrl,
      now,
      email: 'pinned@example.com',
      isAdmin: true,
      claimsAccount: '00000000-0000-4000-8000-000000000001',
    });
    const p = await previewInvite(db.pool, inv.token, now);
    expect(p).toEqual({
      valid: true,
      email: 'pinned@example.com',
      expires_at: inv.expires_at.toISOString(),
    });
    expect(InvitePreviewSchema.strict().safeParse(p).success).toBe(true);
    const open = await createInvite(db.pool, { publicUrl, now });
    expect(await previewInvite(db.pool, open.token, now)).toEqual({
      valid: true,
      expires_at: open.expires_at.toISOString(),
    });
  });

  it('expired, used, revoked, unknown or malformed → exactly {valid: false, expires_at: null}', async () => {
    const clock = fakeClock();
    const expired = await createInvite(db.pool, { publicUrl, now: clock.now(), days: 1 });
    const used = await createInvite(db.pool, { publicUrl, now: clock.now() });
    const revoked = await createInvite(db.pool, { publicUrl, now: clock.now() });
    await db.pool.query('UPDATE invite SET used_at = now() WHERE id = $1', [used.id]);
    await db.pool.query('UPDATE invite SET revoked_at = now() WHERE id = $1', [revoked.id]);
    clock.advance(DAY_MS);
    for (const token of [expired.token, used.token, revoked.token, newSessionToken(), 'x', '']) {
      expect(await previewInvite(db.pool, token, clock.now())).toEqual(INVALID);
    }
  });
});

describe('GET /auth/invites/:token', () => {
  it('password mode: 200 with the preview, 200 invalid for anything else', async () => {
    const now = new Date();
    const inv = await createInvite(db.pool, { publicUrl, now, email: 'p@example.com' });
    api = await startApi({ db: db.pool, auth: passwordAuth(LOOPBACK_URL) });
    const ok = await api.send('GET', `/auth/invites/${inv.token}`);
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.json).sort()).toEqual(['email', 'expires_at', 'valid']);
    expect(ok.json).toEqual({
      valid: true,
      email: 'p@example.com',
      expires_at: inv.expires_at.toISOString(),
    });
    const bad = await api.send('GET', `/auth/invites/${newSessionToken()}`);
    expect(bad.status).toBe(200);
    expect(bad.json).toEqual(INVALID);
  });

  it('local mode: no such route', async () => {
    api = await startApi({ db: db.pool, auth: { mode: 'local' } });
    expect((await api.send('GET', `/auth/invites/${newSessionToken()}`)).status).toBe(404);
  });
});
