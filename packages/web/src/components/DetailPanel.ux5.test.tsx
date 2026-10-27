// @vitest-environment jsdom
// UX-5: the session panel while conductor runs a move step's checks (FR-3), the build-slot wait
// (FR-5), and the failed item in UX-4's "Step failed" block (FR-4).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mockChecking, SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { App } from '../App.js';

afterEach(cleanup);

async function open(title: string) {
  const api = createMockApi({ replyDelayMs: 0 });
  render(<App api={api} />);
  fireEvent.click(await screen.findByRole('button', { name: title }));
  const el = await screen.findByRole('complementary', { name: 'Session detail' });
  const panel = within(el);
  await panel.findByRole('log');
  return { api, panel, el };
}

const statusOf = (banner: HTMLElement, label: string) =>
  within(banner).getByText(label).closest('li')!.getAttribute('data-status');

describe('Conductor is running checks (UX-5)', () => {
  it('FR-3: the banner at the top of Messages, the agent not "running", live via SSE', async () => {
    const { api, panel, el } = await open('Conductor checks demo');
    const banner = await panel.findByRole('region', { name: 'Conductor is running checks' });
    // At the top of Messages: before the Brief and the thread.
    const messages = el.querySelector('.messages-tab')!;
    expect(messages.firstElementChild).toBe(banner);
    expect(within(banner).getByText(/Checks before PR ready for review/)).toBeTruthy();
    expect(statusOf(banner, 'Unit tests')).toBe('running');
    expect(within(banner).getByText(/When the checks pass, conductor opens the PR/)).toBeTruthy();

    const head = el.querySelector('.detail-head')!;
    expect(within(head as HTMLElement).getByText('Conductor is checking')).toBeTruthy();
    expect(within(head as HTMLElement).queryByText('running')).toBeNull();
    expect(head.querySelector('svg')!.getAttribute('class')).toContain('avatar-idle');

    // The engine finishes "Unit tests": card.upserted on the board stream, the panel follows.
    act(() => api.updateCard(SEED_IDS.checking.session, { checking: mockChecking(3) }));
    await waitFor(() => {
      const b = panel.getByRole('region', { name: 'Conductor is running checks' });
      expect(statusOf(b, 'Unit tests')).toBe('passed');
      expect(statusOf(b, 'Build passes')).toBe('running');
    });
    expect(
      within(
        screen.getByText('Conductor checks demo', { selector: '.card-title' }).closest('article')!,
      ).getByText('Conductor is checking · Build passes (4/5)'),
    ).toBeTruthy();
  });

  it('FR-5: a build-slot wait says so on the card and in the banner, then clears via SSE', async () => {
    const { api, panel } = await open('Waiting for a build slot');
    const card = () =>
      within(
        screen
          .getByText('Waiting for a build slot', { selector: '.card-title' })
          .closest('article')!,
      );
    expect(card().getByText('Conductor is checking · waiting for a build slot')).toBeTruthy();
    const banner = await panel.findByRole('region', { name: 'Conductor is running checks' });
    expect(
      within(banner).getByText(/Checks run one at a time on this machine to protect it/),
    ).toBeTruthy();

    // The slot frees up (gateway `card.badge`, no updated_at change): both follow.
    act(() => api.updateCard(SEED_IDS.buildSlot.session, { badges: ['checking'] }));
    await waitFor(() =>
      expect(card().getByText('Conductor is checking · Typecheck (1/5)')).toBeTruthy(),
    );
    await waitFor(() => expect(panel.queryByText(/Checks run one at a time/)).toBeNull());
  });

  it('a session outside a step shows no banner', async () => {
    const { panel } = await open('Add pagination to /orders');
    expect(panel.queryByRole('region', { name: 'Conductor is running checks' })).toBeNull();
  });

  it('FR-4: UX-4\'s "Step failed" shows the failed item and its first error line', async () => {
    const { panel } = await open('Add CSV export');
    const pending = await panel.findByRole('region', { name: 'Pending input' });
    expect(within(pending).getByText('Step failed')).toBeTruthy();
    const line = pending.querySelector('.step-failed-item')!;
    expect(line.querySelector('strong')!.textContent).toBe('PR opened');
    expect(line.textContent).toBe(
      'PR opened: gh: GraphQL: No commits between main and conductor/b2000000 (createPullRequest).',
    );
  });
});
