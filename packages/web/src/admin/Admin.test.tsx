// @vitest-environment jsdom
import { localMeResponse, ME_RESPONSE_FIXTURE } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockApi, MOCK_INVITE_TOKENS, type MockApi } from '../api/mock.js';
import { App } from '../App.js';
import { ADMINS_ONLY, NEW_ACCOUNTS_NOTE } from './Admin.js';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

async function openAccountMenu(name: string) {
  fireEvent.click(await screen.findByRole('button', { name }));
  return within(screen.getByRole('menu', { name: 'Account' }));
}

async function renderAdmin(api: MockApi = createMockApi({ auth: 'password' })) {
  render(<App api={api} />);
  const menu = await openAccountMenu('Ben');
  fireEvent.click(menu.getByRole('menuitem', { name: 'Admin' }));
  await screen.findByRole('region', { name: 'Users' });
  return api;
}

const inviteRows = () =>
  within(screen.getByRole('region', { name: 'Invites' }))
    .getAllByRole('row')
    .slice(1);

describe('admin page', () => {
  it("shows a created invite's URL once, and it is gone after closing", async () => {
    await renderAdmin();
    expect(window.location.hash).toBe('#/admin');
    expect(inviteRows()).toHaveLength(2);

    const form = within(screen.getByRole('form', { name: 'New invite' }));
    fireEvent.change(form.getByLabelText('Email (optional)'), {
      target: { value: 'sam@example.com' },
    });
    fireEvent.change(form.getByLabelText('Days'), { target: { value: '3' } });
    fireEvent.click(form.getByRole('checkbox', { name: 'Admin' }));
    fireEvent.click(form.getByRole('button', { name: 'New invite' }));

    const dialog = within(await screen.findByRole('dialog', { name: 'Invite link' }));
    const url = dialog.getByLabelText<HTMLInputElement>('Link').value;
    expect(url).toMatch(/^http:\/\/localhost\/signup\?invite=mock-/);
    expect(dialog.getByText(/shown once/)).toBeTruthy();
    await waitFor(() => expect(inviteRows()).toHaveLength(3));
    const row = within(inviteRows()[0]!);
    expect(row.getByText('sam@example.com')).toBeTruthy();
    expect(row.getByText('Yes')).toBeTruthy();

    fireEvent.click(dialog.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Invite link' })).toBeNull();
    expect(screen.queryByDisplayValue(url)).toBeNull();
    expect(document.body.innerHTML).not.toContain(url);
  });

  it('notes beside New invite that general sign-up arrives with M2-T15b', async () => {
    await renderAdmin();
    const invites = within(screen.getByRole('region', { name: 'Invites' }));
    expect(invites.getByText(NEW_ACCOUNTS_NOTE)).toBeTruthy();
  });

  it('revokes an open invite', async () => {
    await renderAdmin();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke invite for dana@example.com' }));
    await waitFor(() => expect(within(inviteRows()[1]!).getByText('revoked')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Revoke invite for dana@example.com' })).toBeNull();
  });

  it('reset link, unlock and disable (after a confirm) on a user', async () => {
    const api = createMockApi({ auth: 'password' });
    await api.logout();
    await api.signup({
      invite: MOCK_INVITE_TOKENS.open,
      email: 'sam@example.com',
      display_name: 'Sam',
      password: 'a long enough passphrase',
    });
    await api.login({ email: 'ben@example.com', password: 'correct horse battery' });
    api.lockUser('sam@example.com');
    await renderAdmin(api);

    // No disabling yourself.
    expect(screen.queryByRole('button', { name: 'Disable ben@example.com' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reset link for sam@example.com' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Reset link' }));
    expect(dialog.getByLabelText<HTMLInputElement>('Link').value).toMatch(/\/reset\?token=/);
    fireEvent.click(dialog.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Reset link' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Unlock sam@example.com' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Unlock sam@example.com' })).toBeNull(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Disable sam@example.com' }));
    const confirm = within(screen.getByRole('alertdialog', { name: 'Disable user' }));
    fireEvent.click(confirm.getByRole('button', { name: 'Disable' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Disable sam@example.com' })).toBeNull(),
    );
    expect(
      (await api.listUsers()).find((u) => u.email === 'sam@example.com')?.disabled_at,
    ).not.toBeNull();
  });

  it("non-admins don't see the menu entry, and the page refuses them", async () => {
    const api = createMockApi({ auth: 'password' });
    api.me = () =>
      Promise.resolve({
        ...ME_RESPONSE_FIXTURE,
        user: { ...ME_RESPONSE_FIXTURE.user, display_name: 'Dana', is_admin: false },
      });
    render(<App api={api} />);
    const menu = await openAccountMenu('Dana');
    expect(menu.queryByRole('menuitem', { name: 'Admin' })).toBeNull();
    expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeTruthy();

    window.location.hash = '#/admin';
    expect((await screen.findByRole('alert')).textContent).toBe(ADMINS_ONLY);
  });
});

describe('account menu', () => {
  it('local mode: no sign-out, password change or admin; only the Connect Claude link', async () => {
    render(<App api={createMockApi()} />);
    const menu = await openAccountMenu(localMeResponse().user.display_name);
    expect(menu.queryAllByRole('menuitem').map((el) => el.textContent)).toEqual(['Connect Claude']);
  });

  it('signs out and lands on /signin', async () => {
    const api = createMockApi({ auth: 'password' });
    render(<App api={api} />);
    const menu = await openAccountMenu('Ben');
    fireEvent.click(menu.getByRole('menuitem', { name: 'Sign out' }));
    await screen.findByRole('form', { name: 'Sign in' });
    expect(window.location.pathname).toBe('/signin');
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
  });

  it('change password: a wrong current password is an error, not a sign-out', async () => {
    render(<App api={createMockApi({ auth: 'password' })} />);
    const menu = await openAccountMenu('Ben');
    fireEvent.click(menu.getByRole('menuitem', { name: 'Change password' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Change password' }));
    fireEvent.change(dialog.getByLabelText('Current password'), { target: { value: 'nope' } });
    fireEvent.change(dialog.getByLabelText('New password'), {
      target: { value: 'a different passphrase' },
    });
    fireEvent.change(dialog.getByLabelText('Confirm new password'), {
      target: { value: 'a different passphrase' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Change password' }));
    expect((await dialog.findByRole('alert')).textContent).toBe('Your current password is wrong.');
    expect(window.location.pathname).toBe('/');

    fireEvent.change(dialog.getByLabelText('Current password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Change password' }));
    expect((await dialog.findByRole('status')).textContent).toMatch(/Password changed/);
  });
});
