// @vitest-environment jsdom
// 11-web-ui §Phone layout (Detail panel): the phone's ticket strip (Brief, Plan, Edit) and its
// sheets, through DetailPanel on the mock API, against the desktop panel that keeps BriefCard.
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

async function open(sessionId: string, fullScreen = true) {
  const api = createMockApi({ replyDelayMs: 0 });
  const transition = vi.spyOn(api, 'transition');
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

describe('ticket strip (phone)', () => {
  it('replaces the Brief card and the Edit ticket row; Brief shows its short tally', async () => {
    const { panel } = await open(SEED_IDS.running.session);
    expect(panel.queryByRole('region', { name: 'Brief' })).toBeNull();
    expect(document.querySelector('section.brief')).toBeNull();
    expect(document.querySelector('.edit-ticket')).toBeNull();
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

  it('Edit opens the ticket editor in a sheet; Cancel closes it', async () => {
    await open(SEED_IDS.planApproval.session);
    fireEvent.click(strip().getByRole('button', { name: 'Edit ticket' }));
    const sheet = within(screen.getByRole('dialog', { name: 'Edit ticket' }));
    fireEvent.click(await sheet.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('desktop panel (unchanged)', () => {
  it('keeps the Brief card and has no strip', async () => {
    const { panel } = await open(SEED_IDS.planApproval.session, false);
    expect(document.querySelector('section.brief')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Ticket' })).toBeNull();
    expect(panel.queryByRole('button', { name: 'Open plan' })).toBeNull();
    expect(document.querySelector('.plan-text.clamped-phone')).toBeNull();
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
