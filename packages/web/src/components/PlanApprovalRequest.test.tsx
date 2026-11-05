// @vitest-environment jsdom
// 06 §Plan approval: the "Plan to approve" panel (PlanApprovalRequest.tsx).
import type { SessionDetail } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { FRESH_CONVERSATION_LABEL } from './FreshConversation.js';
import {
  PLAN_APPROVAL_LABEL,
  PLAN_MISSING_TEXT,
  PlanApprovalRequest,
} from './PlanApprovalRequest.js';
import { agentStatesOf, planOptions } from './request-preview.js';

afterEach(cleanup);

const PLAN = '## Steps\n\n1. Add **raised beds** on the south side\n2. Order soil';
const QUESTION = 'Raised beds need a **budget** of $400. Approve?';

/** conductor v5's Plan review buttons (return_to planning). */
const V5_PLAN_REVIEW = [
  { name: 'revise_plan', title: 'Revise plan', goto: 'planning', needs_text: true },
  { name: 'approve_plan', title: 'Approve plan', goto: 'implementing', needs_text: false },
];

/**
 * The "Plan the garden" seed (conductor v2, return_to planning), asked by plan_needs_approval.
 * `humanTransitions` replaces the card's buttons (v5: `V5_PLAN_REVIEW`).
 */
async function setup(
  context: SessionDetail['context'] = { planning: { plan: PLAN, summary: 's' } },
  humanTransitions?: SessionDetail['card']['human_transitions'],
) {
  const api = createMockApi({ replyDelayMs: 0 });
  const base = await api.getSession(SEED_IDS.transitions.session);
  const detail: SessionDetail = {
    ...base,
    card: { ...base.card, human_transitions: humanTransitions ?? base.card.human_transitions },
    context,
    pending_input: {
      ...base.pending_input!,
      question: QUESTION,
      origin_transition: 'plan_needs_approval',
    },
  };
  const transition = vi.spyOn(api, 'transition');
  // The mock seed doesn't offer v5's transitions; the post is what is under test.
  if (humanTransitions) transition.mockResolvedValue({ ok: true });
  const fresh = vi.spyOn(api, 'freshConversation');
  const onDone = vi.fn();
  const plan = planOptions(
    detail.card.human_transitions,
    detail.return_to,
    agentStatesOf(detail.workflow),
  )!;
  render(
    <PlanApprovalRequest
      api={api as ApiClient}
      detail={detail}
      agent="Robin"
      request={detail.pending_input!}
      plan={plan}
      onDone={onDone}
    />,
  );
  const panel = within(screen.getByRole('region', { name: PLAN_APPROVAL_LABEL }));
  return { api, detail, transition, fresh, onDone, panel, sessionId: detail.card.session_id! };
}

describe('PlanApprovalRequest (06 §Plan approval)', () => {
  it('shows the badge, the question and the plan as Markdown, visible by default', async () => {
    const { panel } = await setup();
    expect(panel.getByText(PLAN_APPROVAL_LABEL, { selector: '.request-chip' })).toBeTruthy();
    expect(panel.getByText('Robin asks')).toBeTruthy();
    expect(panel.getByText('budget', { selector: 'strong' })).toBeTruthy();
    const plan = within(panel.getByRole('region', { name: 'The plan' }));
    expect(plan.getByText('Steps', { selector: '.md-h' })).toBeTruthy();
    expect(plan.getByText('raised beds', { selector: 'strong' })).toBeTruthy();
    expect(plan.getAllByRole('listitem')).toHaveLength(2);
    expect(panel.queryByText(PLAN_MISSING_TEXT)).toBeNull();
  });

  it('a plan with a markdown table renders the table inside the plan', async () => {
    const plan = '| File | Change |\n|---|---|\n| `a.ts` | add **x** |';
    const { panel } = await setup({ planning: { plan } });
    const region = panel.getByRole('region', { name: 'The plan' });
    const table = region.querySelector('.md-table-wrap table')!;
    expect(table).toBeTruthy();
    expect(within(table as HTMLElement).getAllByRole('columnheader')).toHaveLength(2);
    expect(within(table as HTMLElement).getByText('x', { selector: 'strong' })).toBeTruthy();
  });

  it('a long plan is clamped behind "Show full plan"', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `${i + 1}. step ${i + 1}`).join('\n');
    const { panel } = await setup({ planning: { plan: long } });
    const region = panel.getByRole('region', { name: 'The plan' });
    expect(region.querySelector('.plan-text.clamped')).not.toBeNull();
    fireEvent.click(panel.getByRole('button', { name: 'Show full plan' }));
    expect(region.querySelector('.plan-text.clamped')).toBeNull();
    expect(panel.getByRole('button', { name: 'Show less' })).toBeTruthy();
  });

  it('falls back to a note when the plan was not recorded', async () => {
    const { panel } = await setup({});
    expect(panel.getByText(PLAN_MISSING_TEXT)).toBeTruthy();
    expect(panel.queryByRole('region', { name: 'The plan' })).toBeNull();
    // Still answerable.
    expect(panel.getByRole('button', { name: 'Approve plan' })).toBeTruthy();
  });

  it('v5: Approve plan posts approve_plan with no text; Request changes posts revise_plan', async () => {
    const { transition, onDone, panel, sessionId } = await setup(undefined, V5_PLAN_REVIEW);
    // approve_plan is the Approve button, not an "Other action".
    expect(panel.queryByText('Other actions')).toBeNull();
    fireEvent.click(panel.getByRole('button', { name: 'Approve plan' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(transition).toHaveBeenCalledWith(sessionId, { name: 'approve_plan' });

    fireEvent.click(panel.getByRole('button', { name: 'Request changes…' }));
    const form = within(panel.getByRole('form', { name: 'Request changes' }));
    fireEvent.change(form.getByLabelText('What should change in the plan?'), {
      target: { value: 'Split step 2.' },
    });
    fireEvent.click(form.getByRole('button', { name: 'Request changes' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(2));
    expect(transition).toHaveBeenLastCalledWith(sessionId, {
      name: 'revise_plan',
      text: 'Changes requested to the plan:\n\nSplit step 2.',
    });
  });

  it('Approve plan posts the answer transition with the exact approval text', async () => {
    const { transition, onDone, panel, sessionId } = await setup();
    fireEvent.click(panel.getByRole('button', { name: 'Approve plan' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith(sessionId, {
      name: 'answer',
      text: 'Plan approved. Proceed: call complete_state with plan_ready and this plan.',
    });
  });

  it('Request changes… requires text and posts the prefixed feedback', async () => {
    const { transition, onDone, panel, sessionId } = await setup();
    fireEvent.click(panel.getByRole('button', { name: 'Request changes…' }));
    const form = within(panel.getByRole('form', { name: 'Request changes' }));
    const box = form.getByLabelText<HTMLTextAreaElement>('What should change in the plan?');
    expect(box.required).toBe(true);
    const submit = form.getByRole<HTMLButtonElement>('button', { name: 'Request changes' });
    expect(submit.disabled).toBe(true);
    fireEvent.change(box, { target: { value: '   ' } });
    expect(submit.disabled).toBe(true);
    fireEvent.submit(box.form!);
    expect(transition).not.toHaveBeenCalled();

    fireEvent.change(box, { target: { value: '  Use in-ground beds instead.  ' } });
    fireEvent.click(submit);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(transition).toHaveBeenCalledWith(sessionId, {
      name: 'answer',
      text: 'Changes requested to the plan:\n\nUse in-ground beds instead.',
    });
  });

  it('Back closes the feedback box without posting; an error is shown', async () => {
    const { transition, panel } = await setup();
    fireEvent.click(panel.getByRole('button', { name: 'Request changes…' }));
    fireEvent.click(panel.getByRole('button', { name: 'Back' }));
    expect(panel.queryByRole('form', { name: 'Request changes' })).toBeNull();
    expect(transition).not.toHaveBeenCalled();

    transition.mockRejectedValueOnce(new Error('session moved on'));
    fireEvent.click(panel.getByRole('button', { name: 'Approve plan' }));
    expect((await panel.findByRole('alert')).textContent).toContain('session moved on');
  });

  it('the other actions are collapsed under "Other actions" but still post', async () => {
    const { transition, onDone, panel, sessionId } = await setup();
    const details = panel.getByText('Other actions').closest('details')!;
    expect(details.open).toBe(false);
    const other = within(details);
    // Not the answer twice: only the remaining options.
    expect(other.queryByRole('button', { name: /Back with this answer/ })).toBeNull();
    expect(other.getByRole('button', { name: /Waiting on someone else/ })).toBeTruthy();
    fireEvent.click(panel.getByText('Other actions'));
    fireEvent.click(other.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(transition).toHaveBeenCalledWith(sessionId, { name: 'done' });
  });

  it('offers "Start fresh conversation…" as a secondary action', async () => {
    const { panel } = await setup();
    const button = panel.getByRole('button', { name: `${FRESH_CONVERSATION_LABEL}…` });
    expect(button.className).not.toContain('prominent');
  });
});
