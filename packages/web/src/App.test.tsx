// @vitest-environment jsdom
import { BOARD_SSE_FIXTURES } from '@conductor/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SEED_IDS } from './api/mock-data.js';
import { createMockApi } from './api/mock.js';
import { App } from './App.js';

afterEach(cleanup);

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
  it('maps cards to columns per 06', async () => {
    await renderApp();
    expect(cardTitles('Queued')).toEqual(['Hotfix: crash on empty cart', 'Add /health']);
    expect(cardTitles('Running')).toEqual([
      'Add pagination to /orders',
      'Migrate settings page to new form lib',
    ]);
    expect(cardTitles('Waiting (external)')).toEqual(['Bump node to 22 in CI']);
    expect(cardTitles('Done')).toEqual(['Rename user.fullname']);
    // `lost` shows in Failed.
    expect(cardTitles('Failed')).toEqual(['Upgrade webpack']);
  });

  it('lists needs-input oldest question first, with the question badge', async () => {
    await renderApp();
    expect(cardTitles('Needs input')).toEqual(['Fix flaky checkout test', 'Add audit log table']);
    const col = within(column('Needs input'));
    expect(col.getByText(/Retries exhausted/)).toBeTruthy();
    expect(col.getByText(BOARD_SSE_FIXTURES['input.requested'].question)).toBeTruthy();
  });

  it('shows the build-slot badge on a running card', async () => {
    await renderApp();
    const card = within(column('Running')).getByText('Migrate settings page to new form lib');
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

    await waitFor(() => expect(cardTitles('Needs input')).toEqual(['Fix flaky checkout test']));
    expect(cardTitles('Running')).toContain('Add audit log table');
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

  it('non-agent kinds get quick actions: abort', async () => {
    await renderApp();
    const panel = within(await openCard('Fix flaky checkout test'));
    fireEvent.click(await panel.findByRole('button', { name: 'Abort' }));
    await waitFor(() => expect(cardTitles('Failed')).toContain('Fix flaky checkout test'));
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
    fireEvent.change(form.getByLabelText('Title'), { target: { value: 'Add dark mode' } });
    fireEvent.change(form.getByLabelText('Priority'), { target: { value: '9' } });
    fireEvent.click(form.getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => expect(cardTitles('Queued')[0]).toBe('Add dark mode'));
    expect(screen.queryByRole('form', { name: 'Create ticket' })).toBeNull();
  });
});
