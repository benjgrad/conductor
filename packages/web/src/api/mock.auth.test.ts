import {
  AdminUserListResponseSchema,
  InviteListResponseSchema,
  localMeResponse,
  MeResponseSchema,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { createMockApi, MOCK_ADMIN, MOCK_INVITE_TOKENS } from './mock.js';

// M2-T05: the mock's accounts (10-contracts §Accounts and web auth).

const now = () => new Date('2026-10-22T12:00:00.000Z');

describe('mock ApiClient auth', () => {
  it('local mode: me is the local user and admin calls are refused', async () => {
    const api = createMockApi({ now });
    expect(await api.me()).toEqual(localMeResponse());
    await expect(api.listUsers()).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('password mode: one admin, two open invites, contract-valid rows', async () => {
    const api = createMockApi({ now, auth: 'password' });
    const me = MeResponseSchema.parse(await api.me());
    expect(me).toMatchObject({ auth_mode: 'password', user: { is_admin: true } });
    const users = AdminUserListResponseSchema.parse(await api.listUsers());
    expect(users.map((u) => [u.email, u.is_admin])).toEqual([[MOCK_ADMIN.email, true]]);
    const invites = InviteListResponseSchema.parse(await api.listInvites());
    expect(invites.map((i) => i.email)).toEqual([null, 'dana@example.com']);
  });

  it('login: the same 401 for a wrong password and an unknown email; logout ends the session', async () => {
    const api = createMockApi({ now, auth: 'password', signedIn: false });
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    const wrong = { status: 401, message: 'Email or password is wrong' };
    await expect(api.login({ email: MOCK_ADMIN.email, password: 'nope' })).rejects.toMatchObject(
      wrong,
    );
    await expect(
      api.login({ email: 'who@example.com', password: MOCK_ADMIN.password }),
    ).rejects.toMatchObject(wrong);
    await api.login({ email: MOCK_ADMIN.email, password: MOCK_ADMIN.password });
    expect((await api.me()).user.email).toBe(MOCK_ADMIN.email);
    await api.logout();
    await expect(api.listUsers()).rejects.toMatchObject({ status: 401 });
  });

  it('sign-up: the pinned email is enforced, the invite is single use, the user is not admin', async () => {
    const api = createMockApi({ now, auth: 'password', signedIn: false });
    expect(await api.previewInvite(MOCK_INVITE_TOKENS.pinned)).toMatchObject({
      valid: true,
      email: 'dana@example.com',
    });
    expect(await api.previewInvite('nope')).toEqual({ valid: false, expires_at: null });
    const req = {
      invite: MOCK_INVITE_TOKENS.pinned,
      email: 'sam@example.com',
      display_name: 'Sam',
      password: 'a long enough passphrase',
    };
    await expect(api.signup(req)).rejects.toMatchObject({ status: 400 });
    await expect(
      api.signup({ ...req, email: 'dana@example.com', password: 'short' }),
    ).rejects.toMatchObject({ status: 400, details: [{ path: 'password' }] });
    const me = await api.signup({ ...req, email: 'dana@example.com' });
    expect(me.user).toMatchObject({ email: 'dana@example.com', is_admin: false });
    expect((await api.previewInvite(MOCK_INVITE_TOKENS.pinned)).valid).toBe(false);
    await expect(api.listInvites()).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('admin: invites, reset links, unlock and disable', async () => {
    const api = createMockApi({ now, auth: 'password' });
    const created = await api.createInvite({ days: 2 });
    const token = new URL(created.url).searchParams.get('invite')!;
    expect((await api.previewInvite(token)).valid).toBe(true);
    await api.revokeInvite(created.id);
    expect((await api.previewInvite(token)).valid).toBe(false);
    await expect(api.revokeInvite(crypto.randomUUID())).rejects.toMatchObject({ status: 404 });

    // A second user to act on.
    await api.logout();
    await api.signup({
      invite: MOCK_INVITE_TOKENS.open,
      email: 'sam@example.com',
      display_name: 'Sam',
      password: 'a long enough passphrase',
    });
    await api.login({ email: MOCK_ADMIN.email, password: MOCK_ADMIN.password });
    api.lockUser('sam@example.com');
    const sam = (await api.listUsers()).find((u) => u.email === 'sam@example.com')!;
    expect(sam.locked).toBe(true);
    await api.unlockUser(sam.id);

    const link = await api.createResetLink(sam.id);
    const resetToken = new URL(link.url).searchParams.get('token')!;
    await api.resetPassword({ token: resetToken, password: 'a different passphrase' });
    await expect(
      api.resetPassword({ token: resetToken, password: 'a different passphrase' }),
    ).rejects.toMatchObject({ status: 400 });

    await api.disableUser(sam.id);
    const after = (await api.listUsers()).find((u) => u.id === sam.id)!;
    expect(after).toMatchObject({ locked: false });
    expect(after.disabled_at).not.toBeNull();
  });

  it('changePassword: 401 for a wrong current password', async () => {
    const api = createMockApi({ now, auth: 'password' });
    await expect(
      api.changePassword({ current: 'wrong', new: 'a different passphrase' }),
    ).rejects.toMatchObject({ status: 401 });
    await api.changePassword({ current: MOCK_ADMIN.password, new: 'a different passphrase' });
  });
});
