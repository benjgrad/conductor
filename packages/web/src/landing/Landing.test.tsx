// @vitest-environment jsdom
// Support Signup: the public landing page (/welcome) and the onboarding tour.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockApi, MOCK_INVITE_TOKENS } from '../api/mock.js';
import { App } from '../App.js';
import { TOUR_PAGES } from '../onboarding/Tour.js';
import { FEATURES, TAGLINE } from './content.js';
import { LANDING_PATH } from './Landing.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('landing page', () => {
  it('a signed-out visit to / lands on /welcome, with the pitch, every feature and Sign in', async () => {
    render(<App api={createMockApi({ auth: 'password', signedIn: false })} />);
    expect(await screen.findByRole('heading', { level: 1, name: TAGLINE })).toBeTruthy();
    expect(window.location.pathname).toBe(LANDING_PATH);
    for (const f of FEATURES) {
      expect(screen.getByRole('heading', { level: 3, name: f.title })).toBeTruthy();
    }
    expect(screen.getByText(/invite-only/)).toBeTruthy();
    const signIn = screen.getAllByRole('link', { name: 'Sign in' });
    expect(signIn.length).toBeGreaterThan(0);
    expect(signIn.every((a) => a.getAttribute('href') === '/signin')).toBe(true);
    fireEvent.click(signIn[0]!);
    await screen.findByRole('form', { name: 'Sign in' });
    expect(window.location.pathname).toBe('/signin');
  });

  it('a signed-out deep link still goes to sign-in and comes back (next)', async () => {
    window.history.replaceState(null, '', '/#/workflows');
    render(<App api={createMockApi({ auth: 'password', signedIn: false })} />);
    await screen.findByRole('form', { name: 'Sign in' });
    expect(new URLSearchParams(window.location.search).get('next')).toBe('/#/workflows');
  });

  it('a signed-in visit to / is the board, not the landing page', async () => {
    render(<App api={createMockApi({ auth: 'password' })} />);
    await screen.findByRole('button', { name: 'Ben' });
    expect(window.location.pathname).toBe('/');
    expect(screen.queryByRole('heading', { level: 1, name: TAGLINE })).toBeNull();
  });
});

describe('onboarding tour', () => {
  async function signUp() {
    window.history.replaceState(null, '', `/signup?invite=${MOCK_INVITE_TOKENS.open}`);
    render(<App api={createMockApi({ auth: 'password', signedIn: false })} />);
    const form = within(await screen.findByRole('form', { name: 'Sign up' }));
    fireEvent.change(form.getByLabelText('Email'), { target: { value: 'sam@example.com' } });
    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'Sam' } });
    fireEvent.change(form.getByLabelText('Password'), {
      target: { value: 'a long enough passphrase' },
    });
    fireEvent.click(form.getByRole('button', { name: 'Create account' }));
    return within(await screen.findByRole('dialog', { name: 'Getting started' }));
  }

  it('opens after sign-up, walks every feature, and ends at setting up a machine', async () => {
    const tour = await signUp();
    expect(tour.getByRole('heading', { name: 'Welcome to Conductor, Sam' })).toBeTruthy();
    expect(tour.getByText(`1 of ${TOUR_PAGES}`)).toBeTruthy();
    for (const f of FEATURES) {
      fireEvent.click(tour.getByRole('button', { name: 'Next' }));
      expect(tour.getByRole('heading', { name: f.title })).toBeTruthy();
    }
    fireEvent.click(tour.getByRole('button', { name: 'Next' }));
    expect(tour.getByRole('heading', { name: 'Start with a machine' })).toBeTruthy();
    fireEvent.click(tour.getByRole('button', { name: 'Back' }));
    expect(tour.getByRole('heading', { name: FEATURES.at(-1)!.title })).toBeTruthy();
    fireEvent.click(tour.getByRole('button', { name: 'Next' }));
    fireEvent.click(tour.getByRole('button', { name: 'Set up a machine' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Getting started' })).toBeNull(),
    );
    expect(window.location.hash).toBe('#/setup');
  });

  it('shows once: Skip closes it for good, and the account menu opens it again', async () => {
    const tour = await signUp();
    fireEvent.click(tour.getByRole('button', { name: 'Skip' }));
    expect(screen.queryByRole('dialog', { name: 'Getting started' })).toBeNull();
    expect(Object.keys(localStorage).filter((k) => k.startsWith('conductor.tour'))).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Sam' }));
    const menu = within(screen.getByRole('menu', { name: 'Account' }));
    fireEvent.click(menu.getByRole('menuitem', { name: 'Getting started' }));
    const again = within(await screen.findByRole('dialog', { name: 'Getting started' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Getting started' })).toBeNull(),
    );
    expect(again).toBeTruthy();
  });

  it('an existing user signing in sees no tour', async () => {
    render(<App api={createMockApi({ auth: 'password' })} />);
    await screen.findByRole('button', { name: 'Ben' });
    expect(screen.queryByRole('dialog', { name: 'Getting started' })).toBeNull();
  });
});
