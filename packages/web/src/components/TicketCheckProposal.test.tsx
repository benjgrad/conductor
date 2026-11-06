// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockChangeProposals } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { TicketCheckProposal } from './TicketCheckProposal.js';

// An agent's proposed repo checks on its ticket: shown with the diff, applied only by a click.

afterEach(cleanup);

const TICKET = '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2';
const [, REPO] = mockChangeProposals(new Date());

function api() {
  const base = createMockApi();
  const p = { ...REPO!, ticket_id: TICKET };
  return {
    ...base,
    listChangeProposals: vi.fn(() =>
      Promise.resolve({ proposals: [p], next_cursor: null, total: 1 }),
    ),
    getChangeProposal: vi.fn(() => Promise.resolve(p)),
    applyChangeProposal: vi.fn(() => Promise.resolve({ ...p, status: 'applied' as const })),
    rejectChangeProposal: vi.fn(() => Promise.resolve({ ...p, status: 'rejected' as const })),
  };
}

describe('TicketCheckProposal', () => {
  it('shows the ticket’s proposal with its diff; Apply applies it', async () => {
    const a = api();
    const onDone = vi.fn();
    render(<TicketCheckProposal api={a} ticketId={TICKET} onDone={onDone} />);
    await screen.findByRole('list', { name: `Changes in ${REPO!.title}` });
    expect(a.listChangeProposals).toHaveBeenCalledWith({
      kind: 'repo_checks',
      status: 'proposed',
      ticketId: TICKET,
    });
    expect(a.applyChangeProposal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply checks' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(a.applyChangeProposal).toHaveBeenCalledWith(REPO!.id);
  });

  it('renders nothing without a proposal', async () => {
    const a = {
      ...api(),
      listChangeProposals: vi.fn(() =>
        Promise.resolve({ proposals: [], next_cursor: null, total: 0 }),
      ),
    };
    const { container } = render(<TicketCheckProposal api={a} ticketId={TICKET} />);
    await waitFor(() => expect(a.listChangeProposals).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
