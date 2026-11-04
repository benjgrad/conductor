// @vitest-environment jsdom
// 06 §Proposed tickets: the agent's follow-up proposals on a Needs input ticket, and the board
// card's count badge.
import {
  proposalId,
  type ApproveProposalRequest,
  type DismissProposalRequest,
  type TicketProposal,
} from '@conductor/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_PROPOSED_TICKETS, SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { App } from '../App.js';
import { DetailPanel } from './DetailPanel.js';
import { ProposedTickets, visibleProposals } from './ProposedTickets.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const REVIEW_TITLE = 'Board cards: review requests vs questions';
const [FIRST, SECOND] = MOCK_PROPOSED_TICKETS as [
  { title: string; repo: string; why: string },
  { title: string; repo: string; why: string },
];

const proposal = (over: Partial<TicketProposal> = {}): TicketProposal => ({
  id: proposalId('implementing', FIRST.title, FIRST.repo),
  state: 'implementing',
  ...FIRST,
  status: 'pending',
  created_ticket_id: null,
  ...over,
});

/** The section's header button: the proposals start collapsed. */
const toggle = () => screen.getByRole('button', { name: /^Proposed follow-up tickets/ });
const expand = () => fireEvent.click(toggle());

/** The mock API, recording approve / dismiss calls. */
function recordingApi() {
  const api = createMockApi({ replyDelayMs: 0 });
  const approves: [string, ApproveProposalRequest][] = [];
  const dismisses: [string, DismissProposalRequest][] = [];
  const approve = api.approveProposal.bind(api);
  const dismiss = api.dismissProposal.bind(api);
  api.approveProposal = (id, req) => {
    approves.push([id, req]);
    return approve(id, req);
  };
  api.dismissProposal = (id, req) => {
    dismisses.push([id, req]);
    return dismiss(id, req);
  };
  return { api, approves, dismisses };
}

describe('visibleProposals', () => {
  it('only pending ones, and only in Needs input', () => {
    const ps = [
      proposal(),
      proposal({ id: 'b', status: 'approved' }),
      proposal({ id: 'c', status: 'dismissed' }),
    ];
    expect(visibleProposals('needs_input', ps).map((p) => p.id)).toEqual([ps[0]!.id]);
    expect(visibleProposals('implementing', ps)).toEqual([]);
    expect(visibleProposals('planning', ps)).toEqual([]);
    expect(visibleProposals('needs_input', undefined)).toEqual([]);
  });
});

describe('ProposedTickets', () => {
  const parent = SEED_IDS.review.ticket;

  it('renders a card per proposal: title, repo, why and the state', () => {
    const { api } = recordingApi();
    render(
      <ProposedTickets api={api} ticketId={parent} ticketTitle="Parent" proposals={[proposal()]} />,
    );
    expand();
    const card = within(screen.getByRole('listitem', { name: FIRST.title }));
    expect(card.getByText(FIRST.repo)).toBeTruthy();
    expect(card.getByText(FIRST.why)).toBeTruthy();
    expect(card.getByText('Proposed in implementing')).toBeTruthy();
    expect(card.getByRole('button', { name: 'Approve…' })).toBeTruthy();
    expect(card.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  it('renders nothing without proposals', () => {
    const { api } = recordingApi();
    const { container } = render(
      <ProposedTickets api={api} ticketId={parent} ticketTitle="Parent" proposals={[]} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('Approve opens an editor prefilled with the title and body, and sends the edits', async () => {
    const { api, approves } = recordingApi();
    let done = 0;
    const p = proposal();
    render(
      <ProposedTickets
        api={api}
        ticketId={parent}
        ticketTitle="Parent"
        proposals={[p]}
        onDone={() => done++}
      />,
    );
    expand();
    fireEvent.click(screen.getByRole('button', { name: 'Approve…' }));
    const form = within(screen.getByRole('form', { name: `Approve ${FIRST.title}` }));
    const title = form.getByLabelText<HTMLInputElement>('Title');
    const body = form.getByLabelText<HTMLTextAreaElement>('Description');
    expect(title.value).toBe(FIRST.title);
    expect(body.value).toContain(FIRST.why);
    expect(body.value).toContain(`/#/?ticket=${parent}`);
    fireEvent.change(title, { target: { value: 'Edited title' } });
    fireEvent.change(body, { target: { value: 'Edited body' } });
    fireEvent.click(form.getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => expect(done).toBe(1));
    expect(approves).toEqual([
      [parent, { proposal_id: p.id, title: 'Edited title', body: 'Edited body' }],
    ]);
    expect(screen.queryByRole('listitem', { name: FIRST.title })).toBeNull();
  });

  it('starts collapsed with the count; opening it is remembered per ticket', () => {
    const { api } = recordingApi();
    const two = [proposal(), proposal({ id: 'second', title: SECOND.title })];
    const { unmount } = render(
      <ProposedTickets api={api} ticketId={parent} ticketTitle="Parent" proposals={two} />,
    );
    // The section keeps its name; the cards are hidden until it is opened.
    expect(screen.getByRole('region', { name: 'Proposed follow-up tickets' })).toBeTruthy();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(toggle().textContent).toContain('2');
    expect(screen.queryByRole('listitem')).toBeNull();
    expand();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(localStorage.getItem(`conductor.proposals.open.${parent}`)).toBe('open');
    unmount();
    render(<ProposedTickets api={api} ticketId={parent} ticketTitle="Parent" proposals={two} />);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    // Closing it again hides the cards, and is remembered too.
    expand();
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(localStorage.getItem(`conductor.proposals.open.${parent}`)).toBe('closed');
    cleanup();
    // Another ticket starts collapsed.
    render(<ProposedTickets api={api} ticketId="other" ticketTitle="Other" proposals={two} />);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('Dismiss posts the proposal id and hides the card', async () => {
    const { api, dismisses } = recordingApi();
    const p = proposal();
    render(<ProposedTickets api={api} ticketId={parent} ticketTitle="Parent" proposals={[p]} />);
    expand();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(dismisses).toEqual([[parent, { proposal_id: p.id }]]));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: FIRST.title })).toBeNull());
  });
});

describe('on the board and in the panel', () => {
  const column = (name: string) => screen.getByRole('region', { name });
  const reviewCard = () =>
    within(column('Needs input')).getByText(REVIEW_TITLE).closest('article') as HTMLElement;

  it('the Needs input card shows the pending count, which drops on a dismiss', async () => {
    const { api } = recordingApi();
    render(<App api={api} />);
    await screen.findByText(REVIEW_TITLE);
    // The seed has two well-formed proposals and one malformed (dropped).
    expect(within(reviewCard()).getByText('2 proposed')).toBeTruthy();
    // No other card has the badge.
    expect(screen.getAllByText(/\d+ proposed$/)).toHaveLength(1);

    fireEvent.click(within(reviewCard()).getByRole('button', { name: REVIEW_TITLE }));
    const panel = within(await screen.findByRole('complementary', { name: 'Session detail' }));
    const section = within(
      await panel.findByRole('region', { name: 'Proposed follow-up tickets' }),
    );
    expand();
    expect(section.getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual([
      FIRST.title,
      SECOND.title,
    ]);
    fireEvent.click(
      within(section.getByRole('listitem', { name: FIRST.title })).getByRole('button', {
        name: 'Dismiss',
      }),
    );
    await waitFor(() => expect(within(reviewCard()).getByText('1 proposed')).toBeTruthy());
  });

  it('approving queues a new ticket and leaves the parent in Needs input', async () => {
    const { api } = recordingApi();
    render(<App api={api} />);
    await screen.findByText(REVIEW_TITLE);
    fireEvent.click(within(reviewCard()).getByRole('button', { name: REVIEW_TITLE }));
    const panel = within(await screen.findByRole('complementary', { name: 'Session detail' }));
    await panel.findByRole('region', { name: 'Proposed follow-up tickets' });
    expand();
    const card = within(await panel.findByRole('listitem', { name: SECOND.title }));
    fireEvent.click(card.getByRole('button', { name: 'Approve…' }));
    fireEvent.click(card.getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => expect(within(column('Queued')).getByText(SECOND.title)).toBeTruthy());
    expect(within(column('Needs input')).getByText(REVIEW_TITLE)).toBeTruthy();
    await waitFor(() => expect(within(reviewCard()).getByText('1 proposed')).toBeTruthy());
  });

  it('a ticket outside Needs input shows no proposals', async () => {
    const { api } = recordingApi();
    const get = api.getSession.bind(api);
    // The same session, as if it were back in Implementing with its proposals still stored.
    api.getSession = async (id) => {
      const d = await get(id);
      return { ...d, card: { ...d.card, column: 'implementing', proposals_pending: undefined } };
    };
    render(
      <DetailPanel api={api} sessionId={SEED_IDS.review.session} version="v" onClose={() => {}} />,
    );
    const panel = within(await screen.findByRole('complementary', { name: 'Session detail' }));
    await panel.findByRole('log');
    expect((await get(SEED_IDS.review.session)).proposals).toHaveLength(2);
    expect(panel.queryByRole('region', { name: 'Proposed follow-up tickets' })).toBeNull();
  });
});
