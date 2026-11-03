// @vitest-environment jsdom
// ADR-0034: the "Proposed tickets" box in the session panel: queue (optionally edited) or dismiss
// each follow-up ticket the agent proposed, one by one.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { DetailPanel } from './DetailPanel.js';
import { PROPOSED_TICKETS_LABEL } from './ProposedTickets.js';

afterEach(cleanup);

const SID = SEED_IDS.running.session;

async function open() {
  const api = createMockApi({ replyDelayMs: 0 });
  const [docs, lint] = api.proposeTickets(SID, [
    { title: 'Add API docs', body: 'Document **every** route.', why: 'Nobody can find them.' },
    { title: 'Fix lint warnings' },
  ]);
  const accept = vi.spyOn(api, 'acceptProposal');
  const dismiss = vi.spyOn(api, 'dismissProposal');
  render(<DetailPanel api={api} sessionId={SID} version="1" onClose={() => undefined} />);
  const el = await screen.findByRole('complementary', { name: 'Session detail' });
  const box = await within(el).findByRole('region', { name: PROPOSED_TICKETS_LABEL });
  return { api, accept, dismiss, docs: docs!, lint: lint!, box: within(box) };
}

describe('ProposedTickets (ADR-0034)', () => {
  it('lists each proposal with its why and Markdown body', async () => {
    const { box } = await open();
    const docs = box.getByRole('group', { name: 'Proposed: Add API docs' });
    expect(within(docs).getByText('Nobody can find them.')).toBeTruthy();
    expect(within(docs).getByText('every', { selector: 'strong' })).toBeTruthy();
    expect(box.getByRole('group', { name: 'Proposed: Fix lint warnings' })).toBeTruthy();
  });

  it('Queue ticket accepts it as is; the decided list shows it with a link', async () => {
    const { box, accept, docs, api } = await open();
    const group = within(box.getByRole('group', { name: 'Proposed: Add API docs' }));
    fireEvent.click(group.getByRole('button', { name: 'Queue ticket' }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith(docs, {}));
    await waitFor(() =>
      expect(box.queryByRole('group', { name: 'Proposed: Add API docs' })).toBeNull(),
    );
    const link = box.getByRole('link', { name: 'open' });
    const ticketId = link.getAttribute('href')!.replace('#/?ticket=', '');
    const board = await api.getBoard();
    const queued = board.columns.find((c) => c.id === 'queued')!.cards;
    expect(queued.find((c) => c.ticket_id === ticketId)?.title).toBe('Add API docs');
  });

  it('Edit first sends only the changed fields', async () => {
    const { box, accept, docs } = await open();
    const group = within(box.getByRole('group', { name: 'Proposed: Add API docs' }));
    fireEvent.click(group.getByRole('button', { name: 'Edit first' }));
    fireEvent.change(group.getByLabelText('Title'), { target: { value: 'Document the API' } });
    fireEvent.click(group.getByRole('button', { name: 'Queue ticket' }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith(docs, { title: 'Document the API' }));
  });

  it('Dismiss drops it', async () => {
    const { box, dismiss, lint } = await open();
    const group = within(box.getByRole('group', { name: 'Proposed: Fix lint warnings' }));
    fireEvent.click(group.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith(lint));
    await waitFor(() =>
      expect(box.queryByRole('group', { name: 'Proposed: Fix lint warnings' })).toBeNull(),
    );
    expect(box.getByText(/Dismissed: Fix lint warnings/)).toBeTruthy();
  });
});
