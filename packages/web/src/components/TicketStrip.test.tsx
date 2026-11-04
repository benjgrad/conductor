// @vitest-environment jsdom
// 11-web-ui §Phone layout (Detail panel): the ticket buttons (Brief, Plan, Edit) in the panel's
// tab row and their sheets, through DetailPanel on the mock API, on a phone and on desktop.
import type { SessionDetail } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOCK_PLAN, SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { DetailPanel } from './DetailPanel.js';
import { latestPlan, planText } from './plan.js';
import { PLAN_APPROVAL_LABEL } from './PlanApprovalRequest.js';
import { PLAN_APPROVED_TEXT } from './request-preview.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function open(
  sessionId: string,
  fullScreen = true,
  humanTransitions?: SessionDetail['card']['human_transitions'],
) {
  const api = createMockApi({ replyDelayMs: 0 });
  const transition = vi.spyOn(api, 'transition');
  if (humanTransitions) {
    // conductor v5's Plan review buttons on the mock's plan seed; the posts don't move it.
    const getSession = api.getSession.bind(api);
    vi.spyOn(api, 'getSession').mockImplementation(async (id) => {
      const d = await getSession(id);
      return { ...d, card: { ...d.card, human_transitions: humanTransitions } };
    });
    transition.mockResolvedValue({ ok: true });
  }
  render(
    <DetailPanel
      api={api}
      sessionId={sessionId}
      version="1"
      onClose={() => undefined}
      fullScreen={fullScreen}
    />,
  );
  const panel = within(await screen.findByRole('complementary', { name: 'Session detail' }));
  await panel.findByRole('log');
  return { api, panel, transition };
}

const strip = () => within(screen.getByRole('group', { name: 'Ticket' }));

describe('ticket buttons (phone)', () => {
  it('sit in the tab row, beside the two tabs; Brief shows its short tally', async () => {
    const { panel } = await open(SEED_IDS.running.session);
    expect(panel.queryByRole('region', { name: 'Brief' })).toBeNull();
    expect(document.querySelector('.edit-ticket')).toBeNull();
    // The tablist holds only the tabs; the buttons are its sibling in the same row.
    const tablist = panel.getByRole('tablist', { name: 'Session views' });
    expect(within(tablist).getAllByRole('tab')).toHaveLength(2);
    expect(tablist.parentElement!.contains(screen.getByRole('group', { name: 'Ticket' }))).toBe(
      true,
    );
    const brief = strip().getByRole('button', { name: /^Brief/ });
    // The UX-2 ticket: 4 requirements have no verification.
    expect(brief.textContent).toContain('⚠ 4');
    expect(brief.getAttribute('aria-haspopup')).toBe('dialog');
    // No plan in this session: no Plan button.
    expect(strip().queryByRole('button', { name: /Plan/ })).toBeNull();
  });

  it('Brief opens a sheet with the goal; Escape closes it and focus goes back', async () => {
    await open(SEED_IDS.running.session);
    const brief = strip().getByRole('button', { name: /^Brief/ });
    fireEvent.click(brief);
    expect(brief.getAttribute('aria-expanded')).toBe('true');
    const sheet = screen.getByRole('dialog', { name: 'Brief' });
    expect(within(sheet).getByText(/^Anyone opening a session sees/)).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: /Full ticket/ })).toBeTruthy();
    expect(document.activeElement).toBe(within(sheet).getByRole('button', { name: 'Close brief' }));
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(brief);
  });

  it('a plan to approve: "Plan to approve" opens the whole plan, and Approve plan posts', async () => {
    const { panel, transition } = await open(SEED_IDS.planApproval.session);
    const button = strip().getByRole('button', { name: PLAN_APPROVAL_LABEL });
    expect(button.className).toContain('to-approve');
    // The chat clamps the plan short and links to the sheet.
    const card = within(panel.getByRole('region', { name: PLAN_APPROVAL_LABEL }));
    expect(document.querySelector('.plan-text.clamped-phone')).toBeTruthy();
    fireEvent.click(card.getByRole('button', { name: 'Open plan' }));
    const sheet = within(screen.getByRole('dialog', { name: 'Plan' }));
    expect(sheet.getByText('Risks', { selector: '.md-h' })).toBeTruthy();
    expect(document.querySelector('.ticket-sheet .plan-text.clamped')).toBeNull();
    fireEvent.click(sheet.getByRole('button', { name: 'Approve plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(transition).toHaveBeenCalledWith(SEED_IDS.planApproval.session, {
      name: 'answer',
      text: PLAN_APPROVED_TEXT,
    });
  });

  it('v5 Plan review: Approve plan in the sheet posts approve_plan, Request changes revise_plan', async () => {
    const { transition } = await open(SEED_IDS.planApproval.session, true, [
      { name: 'revise_plan', title: 'Revise plan', goto: 'planning', needs_text: true },
      { name: 'approve_plan', title: 'Approve plan', goto: 'implementing', needs_text: false },
    ]);
    const openSheet = () => {
      fireEvent.click(strip().getByRole('button', { name: PLAN_APPROVAL_LABEL }));
      return within(screen.getByRole('dialog', { name: 'Plan' }));
    };
    let sheet = openSheet();
    fireEvent.click(sheet.getByRole('button', { name: 'Request changes…' }));
    fireEvent.change(sheet.getByLabelText('What should change in the plan?'), {
      target: { value: 'Drop step 3.' },
    });
    fireEvent.click(sheet.getByRole('button', { name: 'Request changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(transition).toHaveBeenLastCalledWith(SEED_IDS.planApproval.session, {
      name: 'revise_plan',
      text: 'Changes requested to the plan:\n\nDrop step 3.',
    });

    sheet = openSheet();
    fireEvent.click(sheet.getByRole('button', { name: 'Approve plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(transition).toHaveBeenLastCalledWith(SEED_IDS.planApproval.session, {
      name: 'approve_plan',
    });
  });

  it('Edit opens the ticket editor in a sheet; Cancel closes it', async () => {
    await open(SEED_IDS.planApproval.session);
    fireEvent.click(strip().getByRole('button', { name: 'Edit ticket' }));
    const sheet = within(screen.getByRole('dialog', { name: 'Edit ticket' }));
    fireEvent.click(await sheet.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('ticket buttons (desktop)', () => {
  it('the same buttons in the tab row; nothing above the chat', async () => {
    const { panel } = await open(SEED_IDS.planApproval.session, false);
    expect(panel.queryByRole('region', { name: 'Brief' })).toBeNull();
    expect(document.querySelector('.edit-ticket')).toBeNull();
    expect(strip().getByRole('button', { name: /^Brief/ })).toBeTruthy();
    expect(strip().getByRole('button', { name: PLAN_APPROVAL_LABEL })).toBeTruthy();
    expect(strip().getByRole('button', { name: 'Edit ticket' })).toBeTruthy();
    // The chat keeps its own "Show full plan" clamp on desktop.
    expect(panel.queryByRole('button', { name: 'Open plan' })).toBeNull();
    expect(document.querySelector('.plan-text.clamped-phone')).toBeNull();
  });

  it('a sheet covers either tab; picking a tab closes it', async () => {
    const { panel } = await open(SEED_IDS.running.session, false);
    const details = panel.getByRole('tab', { name: 'Details' });
    fireEvent.click(details);
    fireEvent.click(strip().getByRole('button', { name: /^Brief/ }));
    const sheet = screen.getByRole('dialog', { name: 'Brief' });
    expect(within(sheet).getByText(/^Anyone opening a session sees/)).toBeTruthy();
    // The full tally heads the sheet.
    expect(within(sheet).getByText('4 without verification')).toBeTruthy();
    expect(details.getAttribute('aria-selected')).toBe('true');
    const messages = panel.getByRole('tab', { name: 'Messages' });
    messages.focus();
    fireEvent.click(messages);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(messages.getAttribute('aria-selected')).toBe('true');
    // Focus stays on the tab that was picked, not back on Brief.
    expect(document.activeElement).toBe(messages);
  });
});

describe('latestPlan / planText', () => {
  const ctx = { planning: { plan: 'P1' }, review: { plan: 'P2' } };
  it('reads the asking state first, else any text plan, else nothing', () => {
    expect(latestPlan({ context: ctx, return_to: 'review' })).toBe('P2');
    expect(latestPlan({ context: ctx, return_to: null })).toBe('P1');
    expect(latestPlan({ context: { a: { plan: '  ' } }, return_to: 'a' })).toBe('  ');
    expect(latestPlan({ context: { b: { plan: '' } }, return_to: 'b' })).toBeUndefined();
    expect(latestPlan({ context: {}, return_to: null })).toBeUndefined();
    const json = { steps: [1] };
    expect(latestPlan({ context: { a: { plan: json } }, return_to: 'a' })).toBe(json);
    expect(latestPlan({ context: { x: { plan: MOCK_PLAN } }, return_to: 'a' })).toBe(MOCK_PLAN);
  });
  it('planText skips blank and non-text plans', () => {
    expect(planText({ a: { plan: ' ' }, b: { plan: { x: 1 } }, c: { plan: 'C' } }, 'a')).toBe('C');
    expect(planText({}, null)).toBeNull();
  });
});
