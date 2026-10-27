// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockApi, MOCK_ADMIN } from '../api/mock.js';
import { App } from '../App.js';
import { INVALID_RESET } from './errors.js';
import { PASSWORDS_DIFFER } from './Reset.js';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

async function resetUrl() {
  const api = createMockApi({ auth: 'password' });
  const admin = (await api.listUsers()).find((u) => u.email === MOCK_ADMIN.email)!;
  const link = await api.createResetLink(admin.id);
  await api.logout();
  const url = new URL(link.url);
  return { api, path: url.pathname + url.search };
}

function fill(formEl: HTMLElement, password: string, confirm: string) {
  const form = within(formEl);
  fireEvent.change(form.getByLabelText('New password'), { target: { value: password } });
  fireEvent.change(form.getByLabelText('Confirm password'), { target: { value: confirm } });
}

describe('/reset', () => {
  it('without a token says the link is not valid', () => {
    window.history.replaceState(null, '', '/reset');
    render(<App api={createMockApi({ auth: 'password', signedIn: false })} />);
    expect(screen.getByRole('alert').textContent).toBe(INVALID_RESET);
  });

  it('a mismatch blocks submit; a match sets the password and offers sign-in', async () => {
    const { api, path } = await resetUrl();
    window.history.replaceState(null, '', path);
    render(<App api={api} />);
    const formEl = screen.getByRole('form', { name: 'Reset password' });
    const form = within(formEl);
    const submit = form.getByRole<HTMLButtonElement>('button', { name: 'Set password' });
    fill(formEl, 'a brand new passphrase', 'a brand new passphras');
    expect(form.getByText(PASSWORDS_DIFFER)).toBeTruthy();
    expect(submit.disabled).toBe(true);

    fill(formEl, 'a brand new passphrase', 'a brand new passphrase');
    fireEvent.click(submit);
    expect((await screen.findByRole('status')).textContent).toMatch(/Password changed/);
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/signin');
    await api.login({ email: MOCK_ADMIN.email, password: 'a brand new passphrase' });
  });

  it('a used link says it is no longer valid', async () => {
    const { api, path } = await resetUrl();
    const token = new URLSearchParams(path.split('?')[1]).get('token')!;
    await api.resetPassword({ token, password: 'a brand new passphrase' });
    window.history.replaceState(null, '', path);
    render(<App api={api} />);
    const formEl = screen.getByRole('form', { name: 'Reset password' });
    fill(formEl, 'another new passphrase', 'another new passphrase');
    fireEvent.click(within(formEl).getByRole('button', { name: 'Set password' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/not valid or has expired/);
  });
});
