// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD_SSE_FIXTURES, localMeResponse } from '@conductor/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiRequestError, type StreamHandlers } from './api/client.js';
import { SEED_IDS } from './api/mock-data.js';
import { createMockApi } from './api/mock.js';
import { App } from './App.js';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

const column = (name: string) => screen.getByRole('region', { name });
const cardTitles = (name: string) =>
  within(column(name))
    .queryAllByRole('article')
    .map((a) => a.querySelector('.card-title')?.textContent);

async function renderApp() {
  const api = createMockApi();
  render(<App api={api} />);
  await screen.findByText('Add pagination to /orders');
  return api;
}

function openCard(title: string) {
  fireEvent.click(screen.getByRole('button', { name: title }));
  return screen.findByRole('complementary', { name: 'Session detail' });
}

describe('kanban board', () => {
  it('maps cards to the conductor columns (ADR-0010; old m1_* states by type)', async () => {
    await renderApp();
    expect(cardTitles('Queued')).toEqual(['Hotfix: crash on empty cart', 'Add /health']);
    expect(cardTitles('Implementing')).toEqual([
      // UX-5: conductor running a move step's checks (the agent has exited).
      'Conductor checks demo',
      'Add pagination to /orders',
      'Waiting for a build slot',
      'Migrate settings page to new form lib',
      // ADR-0011: held in its source column while the move's conditions run.
      'Ship the /health endpoint',
    ]);
    expect(cardTitles('Waiting external')).toEqual(['Bump node to 22 in CI']);
    // `lost` lands in Done with a badge.
    expect(cardTitles('Done')).toEqual(['Rename user.fullname', 'Upgrade webpack']);
  });

  it('lists needs-input oldest question first, with the question badge', async () => {
    await renderApp();
    expect(cardTitles('Needs input')).toEqual([
      'Fix flaky checkout test',
      'Board cards: review requests vs questions',
      'Add CSV export',
      'Plan the garden',
      'Add audit log table',
    ]);
    const col = within(column('Needs input'));
    expect(col.getByText(/Retries exhausted/)).toBeTruthy();
    expect(col.getByText(BOARD_SSE_FIXTURES['input.requested'].question)).toBeTruthy();
  });

  it('shows the build-slot badge on a running card', async () => {
    await renderApp();
    const card = within(column('Implementing')).getByText('Migrate settings page to new form lib');
    expect(
      within(card.closest('article') as HTMLElement).getByText('waiting for build slot'),
    ).toBeTruthy();
  });

  it('moves a card when a board event arrives', async () => {
    const api = await renderApp();
    act(() => {
      api.requestInput(SEED_IDS.running.session, 'agent_question', 'Offset or cursor?');
    });
    await waitFor(() =>
      expect(cardTitles('Needs input')).toEqual([
        'Fix flaky checkout test',
        'Board cards: review requests vs questions',
        'Add CSV export',
        'Plan the garden',
        'Add audit log table',
        'Add pagination to /orders',
      ]),
    );
  });
});

describe('detail panel', () => {
  it('answer flow: answer the question, card leaves Needs input', async () => {
    await renderApp();
    const panel = within(await openCard('Add audit log table'));
    await panel.findByText(BOARD_SSE_FIXTURES['input.requested'].question);
    // Agent questions get the answer box only, no quick actions.
    expect(panel.queryByRole('group', { name: 'Quick actions' })).toBeNull();
    const send = panel.getByRole('button', { name: 'Send answer' });
    expect((send as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(panel.getByLabelText('Answer'), { target: { value: 'Postgres 16' } });
    fireEvent.click(send);

    await waitFor(() =>
      expect(cardTitles('Needs input')).toEqual([
        'Fix flaky checkout test',
        'Board cards: review requests vs questions',
        'Add CSV export',
        'Plan the garden',
      ]),
    );
    expect(cardTitles('Implementing')).toContain('Add audit log table');
    await waitFor(() => expect(panel.queryByLabelText('Answer')).toBeNull());
    fireEvent.click(panel.getByRole('tab', { name: 'Details' }));
    expect(panel.getByText('implement', { selector: '[aria-current="step"]' })).toBeTruthy();
  });

  it('shows a 409 when the request was already answered elsewhere', async () => {
    const api = await renderApp();
    const panel = within(await openCard('Add audit log table'));
    await panel.findByLabelText('Answer');
    // Someone else answers first; the panel still shows the stale request until it refetches.
    const { session, input } = SEED_IDS.askNewer;
    const answerFromElsewhere = api.answer.bind(api);
    // Swap answer so the panel's call races a prior answer.
    api.answer = async (sid, req) => {
      await answerFromElsewhere(session, { input_request_id: input, answer: 'other tab' });
      return answerFromElsewhere(sid, req);
    };
    fireEvent.change(panel.getByLabelText('Answer'), { target: { value: 'mine' } });
    fireEvent.click(panel.getByRole('button', { name: 'Send answer' }));
    expect((await panel.findByRole('alert')).textContent).toMatch(/input_already_answered/);
  });

  it('non-agent kinds get quick actions: skip to a state', async () => {
    await renderApp();
    const panel = within(await openCard('Fix flaky checkout test'));
    const actions = within(await panel.findByRole('group', { name: 'Quick actions' }));
    expect(actions.getByRole('button', { name: 'Retry test' })).toBeTruthy();
    fireEvent.change(actions.getByLabelText('Skip to state'), { target: { value: 'done' } });
    fireEvent.click(actions.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(cardTitles('Done')).toContain('Fix flaky checkout test'));
  });

  it('shows state, context, spend/time and live output', async () => {
    const api = await renderApp();
    const panel = within(await openCard('Bump node to 22 in CI'));
    // Messages is the default tab; state, context and spend live under Details.
    await panel.findByRole('log');
    fireEvent.click(panel.getByRole('tab', { name: 'Details' }));
    expect(await panel.findByText('https://github.com/benjgrad/fixture-app/pull/7')).toBeTruthy();
    expect(panel.getByText('await_approval', { selector: '[aria-current="step"]' })).toBeTruthy();
    expect(panel.getByText('$0.90 / $5.00')).toBeTruthy();
    expect(panel.getByText(/\/ 120m$/)).toBeTruthy();
    fireEvent.click(panel.getByRole('tab', { name: 'Messages' }));
    act(() => api.pushOutput(SEED_IDS.approval.session, 'PR checks green\n'));
    expect(await panel.findByText('PR checks green')).toBeTruthy();

    fireEvent.click(panel.getByRole('tab', { name: 'Details' }));
    fireEvent.click(panel.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(cardTitles('Done')).toContain('Bump node to 22 in CI'));
  });
});

describe('create ticket', () => {
  it('creates a ticket that lands in Queued via the board stream', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'New ticket' }));
    const form = within(screen.getByRole('form', { name: 'Create ticket' }));
    // The Repo field fills in with the account's top repo (GET /api/repos).
    await waitFor(() =>
      expect(form.getByRole<HTMLInputElement>('combobox', { name: 'Repo' }).value).not.toBe(''),
    );
    fireEvent.change(form.getByLabelText('Title'), { target: { value: 'Add dark mode' } });
    fireEvent.change(form.getByLabelText('Priority'), { target: { value: '9' } });
    fireEvent.click(form.getByRole('radio', { name: 'Work' }));
    fireEvent.click(form.getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => expect(cardTitles('Queued')[0]).toBe('Add dark mode'));
    expect(screen.queryByRole('form', { name: 'Create ticket' })).toBeNull();
  });
});

describe('top nav icons (UX-11)', () => {
  const me = localMeResponse().user;
  const controls = [
    ['link', 'Board'],
    ['link', 'Workflow'],
    ['link', 'Machines'],
    ['link', 'Add a machine'],
    ['link', 'Help'],
    ['button', 'New ticket'],
    ['button', me.display_name],
  ] as const;
  const icon = (el: HTMLElement) => el.querySelector('svg[aria-hidden="true"]');

  it('every control has an icon and keeps its accessible name', async () => {
    await renderApp();
    await screen.findByRole('button', { name: me.display_name });
    for (const [role, name] of controls) {
      expect(icon(screen.getByRole(role, { name })), name).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('button', { name: 'New ticket' }));
    expect(icon(screen.getByRole('button', { name: 'Close form' }))).toBeTruthy();
  });

  it('compact mode hides the labels and keeps the names', async () => {
    // jsdom applies no imported CSS (and vitest turns `?raw` CSS into ''), so load the real
    // stylesheet from disk to compute the cascade.
    const style = document.createElement('style');
    style.textContent = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');
    document.head.append(style);
    try {
      render(<App api={createMockApi()} compact />);
      await screen.findByText('Add pagination to /orders');
      await screen.findByRole('button', { name: me.display_name });
      const header = document.querySelector<HTMLElement>('header.topbar.compact');
      expect(header).toBeTruthy();
      const labels = header?.querySelectorAll<HTMLElement>('.nav-label') ?? [];
      expect(labels.length).toBe(controls.length);
      for (const label of labels) expect(getComputedStyle(label).display).toBe('none');
      for (const [role, name] of controls) {
        const el = screen.getByRole(role, { name });
        expect(icon(el), name).toBeTruthy();
        expect(el.title).toBe(name === me.display_name ? me.email : name);
      }
    } finally {
      style.remove();
    }
  });

  it('the bar is sticky on desktop, not only on a phone', async () => {
    // jsdom matches no `max-width` media rule, so this checks the base .topbar rule.
    const style = document.createElement('style');
    style.textContent = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');
    document.head.append(style);
    try {
      render(<App api={createMockApi()} />);
      await screen.findByRole('button', { name: me.display_name });
      const header = document.querySelector<HTMLElement>('header.topbar')!;
      expect(header.classList.contains('compact')).toBe(false);
      expect(getComputedStyle(header).position).toBe('sticky');
      expect(getComputedStyle(header).top).toBe('0px');
    } finally {
      style.remove();
    }
  });
});

describe('session (M2-T05)', () => {
  const unauthorized = () => new ApiRequestError(401, 'unauthorized', 'Sign in to continue');
  const signInNext = () => {
    expect(window.location.pathname).toBe('/signin');
    return new URLSearchParams(window.location.search).get('next');
  };

  it('a 401 from /api/board redirects to /signin?next=/', async () => {
    const api = createMockApi();
    api.getBoard = () => Promise.reject(unauthorized());
    render(<App api={api} />);
    await screen.findByRole('form', { name: 'Sign in' });
    expect(signInNext()).toBe('/');
  });

  it('a 401 from /api/me at start redirects, keeping the view in `next`', async () => {
    window.history.replaceState(null, '', '/#/workflows');
    const api = createMockApi({ auth: 'password', signedIn: false });
    render(<App api={api} />);
    await screen.findByRole('form', { name: 'Sign in' });
    expect(signInNext()).toBe('/#/workflows');
  });

  it('a board stream error re-probes /api/me and redirects only on its 401', async () => {
    const api = createMockApi();
    let handlers: StreamHandlers<unknown> | undefined;
    const stream = api.streamBoard.bind(api);
    api.streamBoard = (from, h) => {
      handlers = h as StreamHandlers<unknown>;
      return stream(from, h);
    };
    render(<App api={api} />);
    await screen.findByText('Add pagination to /orders');

    act(() => handlers?.onError?.(new Error('board stream disconnected')));
    await screen.findByRole('alert');
    expect(window.location.pathname).toBe('/');

    api.me = () => Promise.reject(unauthorized());
    act(() => handlers?.onError?.(new Error('board stream disconnected')));
    await screen.findByRole('form', { name: 'Sign in' });
    expect(signInNext()).toBe('/');
  });

  it('/admin is the admin view', async () => {
    window.history.replaceState(null, '', '/admin');
    render(<App api={createMockApi({ auth: 'password' })} />);
    await screen.findByRole('region', { name: 'Users' });
    expect(window.location.pathname + window.location.hash).toBe('/#/admin');
  });

  it("shows a retry when /api/me can't be reached", async () => {
    const api = createMockApi();
    const me = api.me.bind(api);
    api.me = () => Promise.reject(new TypeError('Failed to fetch'));
    render(<App api={api} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Can't reach the server/);
    api.me = me;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Add pagination to /orders');
  });
});
