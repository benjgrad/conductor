// @vitest-environment jsdom
// 06 §Plan approval in the session panel: a `plan_needs_approval` request gets the plan panel
// instead of the generic request and transition buttons; without the answer option, the generic.
import type { SessionDetail } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { DetailPanel } from './DetailPanel.js';

afterEach(cleanup);

const PLAN = '1. Raised beds on the south side\n2. Order soil';

async function open(patch: (d: SessionDetail) => SessionDetail) {
  const api = createMockApi({ replyDelayMs: 0 });
  const get = api.getSession.bind(api);
  api.getSession = async (sid) => patch(await get(sid));
  const transition = vi.spyOn(api, 'transition');
  const sid = SEED_IDS.transitions.session;
  render(<DetailPanel api={api} sessionId={sid} version="1" onClose={() => undefined} />);
  const el = await screen.findByRole('complementary', { name: 'Session detail' });
  await within(el).findByRole('log');
  return { el, panel: within(el), transition, sid };
}

const asPlan = (d: SessionDetail): SessionDetail => ({
  ...d,
  context: { planning: { plan: PLAN, summary: 'garden' } },
  pending_input: { ...d.pending_input!, origin_transition: 'plan_needs_approval' },
});

describe('DetailPanel: plan approval (06 §Plan approval)', () => {
  it('shows the plan panel and hides the generic transition buttons', async () => {
    const { el, panel, transition, sid } = await open(asPlan);
    const plan = await panel.findByRole('region', { name: 'Plan to approve' });
    expect(within(plan).getByText('Raised beds on the south side')).toBeTruthy();
    expect(panel.queryByRole('region', { name: 'Pending input' })).toBeNull();
    // The only "Move to" group is the one inside the collapsed Other actions.
    const groups = panel.queryAllByRole('group', { name: 'Move to', hidden: true });
    expect(groups).toHaveLength(1);
    expect(plan.contains(groups[0]!)).toBe(true);
    expect(el.querySelector('.detail .transitions:not(.plan-approval .transitions)')).toBeNull();

    fireEvent.click(within(plan).getByRole('button', { name: 'Approve plan' }));
    await waitFor(() =>
      expect(transition).toHaveBeenCalledWith(sid, {
        name: 'answer',
        text: 'Plan approved. Proceed: call complete_state with plan_ready and this plan.',
      }),
    );
  });

  it('without the $return_to answer option it falls back to the generic request', async () => {
    const { panel } = await open((d) => {
      const p = asPlan(d);
      return {
        ...p,
        card: {
          ...p.card,
          human_transitions: p.card.human_transitions.filter((o) => o.name !== 'answer'),
        },
      };
    });
    expect(await panel.findByRole('region', { name: 'Pending input' })).toBeTruthy();
    expect(panel.queryByRole('region', { name: 'Plan to approve' })).toBeNull();
    expect(panel.getByRole('group', { name: 'Move to' })).toBeTruthy();
  });

  it('an ordinary question keeps the generic request and buttons', async () => {
    const { panel } = await open((d) => d);
    expect(await panel.findByRole('region', { name: 'Pending input' })).toBeTruthy();
    expect(panel.queryByRole('region', { name: 'Plan to approve' })).toBeNull();
    const group = panel.getByRole('group', { name: 'Move to' });
    expect(within(group).getByRole('button', { name: /Back with this answer/ })).toBeTruthy();
  });
});
