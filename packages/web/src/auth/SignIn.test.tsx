// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiRequestError } from '../api/client.js';
import { createMockApi, MOCK_ADMIN } from '../api/mock.js';
import { App } from '../App.js';
import { NETWORK, THROTTLED } from './errors.js';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

function renderSignIn(url: string) {
  window.history.replaceState(null, '', url);
  const api = createMockApi({ auth: 'password', signedIn: false });
  render(<App api={api} />);
  return api;
}

function signIn(password: string) {
  const form = within(screen.getByRole('form', { name: 'Sign in' }));
  fireEvent.change(form.getByLabelText('Email'), { target: { value: MOCK_ADMIN.email } });
  fireEvent.change(form.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(form.getByRole('button', { name: 'Sign in' }));
}

describe('/signin', () => {
  it('shows the generic error for a wrong password', async () => {
    renderSignIn('/signin');
    signIn('not the password');
    expect((await screen.findByRole('alert')).textContent).toBe('Email or password is wrong');
    expect(window.location.pathname).toBe('/signin');
  });

  it('shows the throttle message on 429', async () => {
    const api = renderSignIn('/signin');
    api.login = () => Promise.reject(new ApiRequestError(429, 'rate_limited', 'Too many requests'));
    signIn(MOCK_ADMIN.password);
    expect((await screen.findByRole('alert')).textContent).toBe(THROTTLED);
  });

  it('shows a network error when the server is unreachable', async () => {
    const api = renderSignIn('/signin');
    api.login = () => Promise.reject(new TypeError('Failed to fetch'));
    signIn(MOCK_ADMIN.password);
    expect((await screen.findByRole('alert')).textContent).toBe(NETWORK);
  });

  it('goes to a safe `next` after signing in', async () => {
    renderSignIn(`/signin?next=${encodeURIComponent('/#/workflows')}`);
    signIn(MOCK_ADMIN.password);
    await waitFor(() => expect(window.location.hash).toBe('#/workflows'));
    expect(window.location.pathname).toBe('/');
    const tab = await screen.findByRole('link', { name: 'Workflow' });
    expect(tab.getAttribute('aria-current')).toBe('page');
    expect(await screen.findByRole('button', { name: 'Ben' })).toBeTruthy();
  });

  it('ignores an off-site `next` (//evil.com) and goes to the board', async () => {
    const origin = window.location.origin;
    renderSignIn(`/signin?next=${encodeURIComponent('//evil.com')}`);
    signIn(MOCK_ADMIN.password);
    await screen.findByText('Add pagination to /orders');
    expect(window.location.href).toBe(`${origin}/`);
  });
});
