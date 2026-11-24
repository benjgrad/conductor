// @vitest-environment jsdom
// ADR-0045: the Requirements section (RequirementsSection.tsx) on the mock's review card, whose
// checklist has a met, an unmet and an unchecked item and the implementer's proposal.
import { requirementsOfContext, type SessionDetail } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { PendingRequirementsProposal, RequirementsSection } from './RequirementsSection.js';

afterEach(cleanup);

async function setup() {
  const api = createMockApi({ replyDelayMs: 0 });
  const detail = await api.getSession(SEED_IDS.review.session);
  return { api, detail };
}

describe('RequirementsSection', () => {
  it('shows every item with its status in words, the reason and the count', async () => {
    const { api, detail } = await setup();
    render(<RequirementsSection api={api} detail={detail} onReload={() => {}} />);
    const section = screen.getByRole('region', { name: 'Requirements' });
    expect(within(section).getByText('2 of 4 met')).toBeTruthy();
    const items = within(section)
      .getAllByRole('listitem')
      .filter((li) => li.closest('.req-list'));
    expect(items.map((li) => li.querySelector('.req-status')?.textContent)).toEqual([
      'Met',
      'Met',
      'Not met',
      'Not checked yet',
    ]);
    expect(within(section).getByText('No legend change in the diff.')).toBeTruthy();
  });

  it('nothing without a checklist', async () => {
    const { api, detail } = await setup();
    const { container } = render(
      <RequirementsSection api={api} detail={{ ...detail, context: {} }} onReload={() => {}} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('applies the proposal: the removed item is gone and the rest keep their status', async () => {
    const { api, detail } = await setup();
    const onReload = vi.fn();
    render(<RequirementsSection api={api} detail={detail} onReload={onReload} />);
    const proposal = screen.getByRole('group', { name: 'Proposed requirements change' });
    expect(within(proposal).getByText(/The board legend explains both kinds/)).toBeTruthy();
    fireEvent.click(within(proposal).getByRole('button', { name: 'Apply proposed requirements' }));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
    const after = requirementsOfContext((await api.getSession(SEED_IDS.review.session)).context)!;
    expect(after.proposed).toBeNull();
    expect(after.items.map((i) => [i.text, i.status])).toEqual([
      ['A review request card looks different from a question card', 'met'],
      ['Each card says in words which kind it is, not only by colour', 'met'],
      ['Keyboard users can tell the kinds apart', 'pending'],
    ]);
  });

  it('Edit saves one requirement per line', async () => {
    const { api, detail } = await setup();
    const spy = vi.spyOn(api, 'setRequirements');
    render(<RequirementsSection api={api} detail={detail} onReload={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit requirements' }));
    fireEvent.change(screen.getByLabelText('One requirement per line'), {
      target: { value: 'First\n\nSecond' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save requirements' }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(SEED_IDS.review.session, { items: ['First', '', 'Second'] }),
    );
  });

  it('Edit is disabled while conductor reviews them, and absent once finished', async () => {
    const { api, detail } = await setup();
    const reviewing: SessionDetail = {
      ...detail,
      card: {
        ...detail.card,
        checking: {
          to: 'needs_input',
          title: 'Needs input',
          phase: 'review',
          label: 'Review',
          transition: null,
          items: [],
          current: 0,
        } as unknown as NonNullable<SessionDetail['card']['checking']>,
      },
    };
    const { unmount } = render(
      <RequirementsSection api={api} detail={reviewing} onReload={() => {}} />,
    );
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Edit requirements' }).disabled,
    ).toBe(true);
    expect(screen.getByText(/Conductor is reviewing them now/)).toBeTruthy();
    unmount();
    render(
      <RequirementsSection
        api={api}
        detail={{ ...detail, card: { ...detail.card, status: 'done' } }}
        onReload={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Edit requirements' })).toBeNull();
  });

  it('the pending proposal alone, for the Messages tab', async () => {
    const { api, detail } = await setup();
    render(<PendingRequirementsProposal api={api} detail={detail} onReload={() => {}} />);
    expect(screen.getByRole('button', { name: 'Keep current' })).toBeTruthy();
  });
});
