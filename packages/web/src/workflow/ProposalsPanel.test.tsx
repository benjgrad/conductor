// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../api/client.js';
import { mockChangeProposals } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { ProposalsPanel } from './ProposalsPanel.js';

// ADR-0033 P3 (MA-T07): the change-proposal list under the workflow editor, on the mock API.

afterEach(cleanup);

const [REPO, WORKFLOW] = mockChangeProposals(new Date());

function setup(api = createMockApi(), dirty = false) {
  const onWorkflowApplied = vi.fn();
  render(<ProposalsPanel api={api} dirty={dirty} onWorkflowApplied={onWorkflowApplied} />);
  return { api, onWorkflowApplied };
}
const row = async (title: string) =>
  screen.findByRole('button', { name: new RegExp(title) }, { timeout: 5_000 });

describe('ProposalsPanel', () => {
  it('lists open proposals; All shows the applied one too', async () => {
    setup();
    await row(REPO!.title);
    expect(screen.queryByRole('button', { name: new RegExp(WORKFLOW!.title) })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Show' }), { target: { value: 'all' } });
    await row(WORKFLOW!.title);
  });

  it('expands to the diff, evidence, effect and rollback; Apply asks first', async () => {
    const { api } = setup();
    const apply = vi.spyOn(api, 'applyChangeProposal');
    fireEvent.click(await row(REPO!.title));
    await screen.findByRole('table');
    expect(screen.getByText(REPO!.rationale)).toBeTruthy();
    expect(screen.getByText(REPO!.evidence[0]!.text)).toBeTruthy();
    expect(screen.getByText(REPO!.rollback)).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(1 + REPO!.diff.changes.length);

    fireEvent.click(screen.getByRole('button', { name: 'Apply…' }));
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm apply' }));
    await screen.findByRole('status');
    expect(apply).toHaveBeenCalledWith(REPO!.id);
    expect(screen.getByRole('status').textContent).toBe('Applied.');
    // It left the open list.
    await waitFor(() => expect(screen.getByText('No open proposals.')).toBeTruthy());
  });

  it('reject removes it from the open list', async () => {
    setup();
    fireEvent.click(await row(REPO!.title));
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(screen.getByText('No open proposals.')).toBeTruthy());
  });

  it('shows an applied proposal’s review, and a refusal as an alert', async () => {
    const api = createMockApi();
    setup(api);
    fireEvent.change(screen.getByRole('combobox', { name: 'Show' }), { target: { value: 'all' } });
    fireEvent.click(await row(WORKFLOW!.title));
    const review = await screen.findByLabelText('Review');
    expect(review.textContent).toContain('It moved the expected way.');
    expect(screen.queryByRole('button', { name: 'Apply…' })).toBeNull();

    api.reviewChangeProposal = () =>
      Promise.reject(new ApiRequestError(409, 'wrong_state', 'Only an applied proposal'));
    fireEvent.click(screen.getByRole('button', { name: 'Check the effect' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Only an applied proposal');
  });

  it('warns about a workflow change, and tells the editor to reload once applied', async () => {
    const api = createMockApi();
    const proposed = { ...WORKFLOW!, status: 'proposed' as const, review: null };
    api.listChangeProposals = () =>
      Promise.resolve({ proposals: [proposed], next_cursor: null, total: 1 });
    api.getChangeProposal = () => Promise.resolve(proposed);
    api.applyChangeProposal = () =>
      Promise.resolve({ ...proposed, status: 'applied', applied_version: 6 });
    const { onWorkflowApplied } = setup(api, true);
    fireEvent.click(await row(WORKFLOW!.title));
    const notes = await screen.findAllByRole('note');
    expect(notes.map((n) => n.textContent).join(' ')).toMatch(/unsaved edits/);
    expect(notes.map((n) => n.textContent).join(' ')).toMatch(/every account/);
    const detail = within(screen.getByRole('region', { name: 'Change proposals' }));
    fireEvent.click(detail.getByRole('button', { name: 'Apply…' }));
    fireEvent.click(detail.getByRole('button', { name: 'Confirm apply' }));
    await waitFor(() => expect(onWorkflowApplied).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status').textContent).toBe('Applied as v6.');
  });
});
