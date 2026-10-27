// @vitest-environment jsdom
import { PASSWORD_TOO_SHORT } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockApi, MOCK_INVITE_TOKENS } from '../api/mock.js';
import { App } from '../App.js';
import { INVALID_INVITE } from './errors.js';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

function renderSignUp(url: string) {
  window.history.replaceState(null, '', url);
  const api = createMockApi({ auth: 'password', signedIn: false });
  render(<App api={api} />);
  return api;
}

describe('/signup', () => {
  it('an invalid invite shows the message and no form', async () => {
    renderSignUp('/signup?invite=not-a-token');
    expect((await screen.findByRole('alert')).textContent).toBe(INVALID_INVITE);
    expect(screen.queryByRole('form', { name: 'Sign up' })).toBeNull();
  });

  it('a missing invite shows the same message', () => {
    renderSignUp('/signup');
    expect(screen.getByRole('alert').textContent).toBe(INVALID_INVITE);
    expect(screen.queryByRole('form', { name: 'Sign up' })).toBeNull();
  });

  it('a pinned email is filled in and read-only', async () => {
    renderSignUp(`/signup?invite=${MOCK_INVITE_TOKENS.pinned}`);
    const form = within(await screen.findByRole('form', { name: 'Sign up' }));
    const email = form.getByLabelText<HTMLInputElement>('Email');
    expect(email.value).toBe('dana@example.com');
    expect(email.readOnly).toBe(true);
  });

  it('a short password shows the problem and blocks submit', async () => {
    renderSignUp(`/signup?invite=${MOCK_INVITE_TOKENS.pinned}`);
    const form = within(await screen.findByRole('form', { name: 'Sign up' }));
    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'Dana' } });
    fireEvent.change(form.getByLabelText('Password'), { target: { value: 'short' } });
    expect(form.getByText(PASSWORD_TOO_SHORT)).toBeTruthy();
    const submit = form.getByRole<HTMLButtonElement>('button', { name: 'Create account' });
    expect(submit.disabled).toBe(true);

    fireEvent.change(form.getByLabelText('Password'), {
      target: { value: 'a long enough passphrase' },
    });
    expect(form.queryByText(PASSWORD_TOO_SHORT)).toBeNull();
    expect(submit.disabled).toBe(false);
  });

  it('signs up with an open invite and lands on the board, signed in', async () => {
    renderSignUp(`/signup?invite=${MOCK_INVITE_TOKENS.open}`);
    const form = within(await screen.findByRole('form', { name: 'Sign up' }));
    expect(form.getByLabelText<HTMLInputElement>('Email').readOnly).toBe(false);
    fireEvent.change(form.getByLabelText('Email'), { target: { value: 'sam@example.com' } });
    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'Sam' } });
    fireEvent.change(form.getByLabelText('Password'), {
      target: { value: 'a long enough passphrase' },
    });
    fireEvent.click(form.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(await screen.findByRole('button', { name: 'Sam' })).toBeTruthy();
  });
});
