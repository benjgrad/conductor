// @vitest-environment jsdom
// UX-7: the Details tab in STAR order (Situation, Task, Action, Result, Technical details).
import type { MoveDto, SessionDetail } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockApi } from '../api/mock.js';
import { SEED_IDS } from '../api/mock-data.js';
import { DetailPanel } from './DetailPanel.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const BODY = [
  '## Goal',
  'Paginate the orders list.',
  '',
  '## Context',
  'The orders page times out for big shops.',
  '',
  '## Functional requirements',
  '- FR-1 Cursor pagination on /orders',
  '',
  '## Non-functional requirements',
  '- NFR-1 Under 200 ms per page',
  '',
  '## Out of scope',
  'The admin export.',
  '',
  '## Verification',
  '| Req | How |',
  '|---|---|',
  '| FR-1 | a test |',
  '| NFR-1 | a benchmark |',
].join('\n');

const at = (min: number) => new Date(Date.UTC(2026, 9, 27, 10, min)).toISOString();

const MOVES: MoveDto[] = [
  { at: at(0), from: null, to: 'planning', transition: null, reason: null, actor: null },
  {
    at: at(5),
    from: 'planning',
    to: 'implementing',
    transition: 'plan_ready',
    reason: 'The plan is ready.',
    actor: 'agent',
  },
  {
    at: at(10),
    from: 'implementing',
    to: 'needs_input',
    transition: 'ask_user',
    reason: 'Offset or cursor?',
    actor: 'agent',
  },
  {
    at: at(12),
    from: 'needs_input',
    to: 'implementing',
    transition: null,
    reason: null,
    actor: null,
  },
  {
    at: at(30),
    from: 'implementing',
    to: 'needs_input',
    transition: 'personal_pr_ready_for_review',
    reason: 'Implemented and tested.',
    actor: 'agent',
  },
];

const ANSWERED = {
  id: 'c3000000-0000-4000-8000-0000000000f1',
  kind: 'agent_question',
  question: 'Offset or cursor?',
  created_at: at(10),
  answer: 'Cursor, please.',
  answered_at: at(12),
  truncated: false,
} as const;

type Patch = (d: SessionDetail) => SessionDetail;

/** The panel on `session`, its detail patched; on the Details tab once loaded. */
async function open(session: string, patch: Patch = (d) => d) {
  const api = createMockApi({ replyDelayMs: 0 });
  const get = api.getSession.bind(api);
  const state = { patch };
  api.getSession = async (sid) => state.patch(await get(sid));
  const view = (version: string) => (
    <DetailPanel api={api} sessionId={session} version={version} onClose={() => undefined} />
  );
  const r = render(view('1'));
  fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
  await screen.findByRole('heading', { level: 3, name: /^Situation/ });
  return { api, state, rerender: (version: string) => r.rerender(view(version)) };
}

const region = (name: string) => within(screen.getByRole('region', { name }));
const toggle = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

describe('Situation (FR-1)', () => {
  it("shows a new-format ticket's Context", async () => {
    await open(SEED_IDS.running.session, (d) => ({ ...d, ticket_body: BODY }));
    const s = region('Situation');
    expect(s.getByText('The orders page times out for big shops.', { selector: 'p' })).toBeTruthy();
    expect(s.getByText('Add pagination to /orders')).toBeTruthy();
  });

  it("shows a legacy ticket's first paragraph, its repo and kind", async () => {
    await open(SEED_IDS.review.session, (d) => ({
      ...d,
      ticket_body: 'Rename the field everywhere.\n\nAlso in the docs.',
    }));
    const s = region('Situation');
    expect(s.getByText('Rename the field everywhere.', { selector: 'p' })).toBeTruthy();
    expect(s.queryByText('Also in the docs.')).toBeNull();
    expect(s.getByText('github.com/benjgrad/fixture-app')).toBeTruthy();
    expect(s.getByText('Personal')).toBeTruthy();
  });

  it('cuts a long context with "more ▸"', async () => {
    const context = Array.from({ length: 9 }, (_, i) => `- line ${i + 1}`).join('\n');
    await open(SEED_IDS.running.session, (d) => ({
      ...d,
      ticket_body: `## Goal\nG\n\n## Context\n${context}`,
    }));
    const s = region('Situation');
    expect(s.queryByText('line 9')).toBeNull();
    fireEvent.click(s.getByRole('button', { name: 'Show more of the situation' }));
    expect(s.getByText('line 9')).toBeTruthy();
  });
});

describe('Task (FR-2)', () => {
  it('shows the Goal, FR and NFR; Out of scope is collapsed', async () => {
    await open(SEED_IDS.running.session, (d) => ({ ...d, ticket_body: BODY }));
    const t = region('Task');
    expect(t.getByText('Paginate the orders list.', { selector: 'p' })).toBeTruthy();
    expect(t.getByRole('list', { name: 'Functional' }).textContent).toContain(
      'Cursor pagination on /orders',
    );
    expect(t.getByRole('list', { name: 'Non-functional' }).textContent).toContain('Under 200 ms');
    const oos = t.getByRole('button', { name: /^Out of scope/ });
    expect(oos.getAttribute('aria-expanded')).toBe('false');
    expect(t.queryByText('The admin export.')).toBeNull();
    fireEvent.click(oos);
    expect(t.getByText('The admin export.')).toBeTruthy();
  });

  it('a legacy ticket shows as written, cut after 8 lines', async () => {
    const body = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}.`).join('\n\n');
    await open(SEED_IDS.running.session, (d) => ({ ...d, ticket_body: body }));
    const t = region('Task');
    expect(t.getByText('Line 1.')).toBeTruthy();
    expect(t.queryByText('Line 12.')).toBeNull();
    fireEvent.click(t.getByRole('button', { name: 'Show more of the ticket' }));
    expect(t.getByText('Line 12.')).toBeTruthy();
  });
});

describe('Action (FR-3)', () => {
  const withMoves: Patch = (d) => ({
    ...d,
    moves: MOVES,
    input_requests: [ANSWERED],
    pending_input: null,
    context: { planning: { plan: 'Add a cursor.\nUse it.\nTest it.\nShip it.' } },
  });

  it('is a timeline in order, in plain words, with reasons and the answer', async () => {
    await open(SEED_IDS.review.session, withMoves);
    const a = region('Action');
    expect(a.queryAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(a.getByRole('button', { name: 'Show 2 earlier' }));
    const items = a.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toHaveLength(5);
    expect(items[0]).toContain('Started in Planning');
    expect(items[1]).toContain('Plan ready — The plan is ready.');
    expect(items[1]).toContain('Add a cursor.');
    expect(items[2]).toMatch(/asked — Offset or cursor\?/);
    expect(items[3]).toContain('You answered: Cursor, please.');
    expect(items[4]).toContain('Ready for review — Implemented and tested.');
  });

  it('the plan shows its first lines, then "Full plan ▸"', async () => {
    await open(SEED_IDS.review.session, withMoves);
    const a = region('Action');
    fireEvent.click(a.getByRole('button', { name: 'Show 2 earlier' }));
    expect(a.queryByText('Ship it.')).toBeNull();
    fireEvent.click(a.getByRole('button', { name: /^Full plan/ }));
    expect(a.getByText(/Ship it\./)).toBeTruthy();
  });
});

describe('Result (FR-4)', () => {
  it('a review request: Ready for review, the PR link, the acceptance summary', async () => {
    await open(SEED_IDS.review.session);
    const r = region('Result');
    expect(r.getByText('Ready for review', { selector: '.chip' })).toBeTruthy();
    expect(r.getByRole('link', { name: 'Open pull request ↗' }).getAttribute('href')).toBe(
      'https://github.com/benjgrad/conductor/pull/42',
    );
    expect(r.getByText(/Acceptance 8\/10/)).toBeTruthy();
    expect(r.getByText(/Your call: review the PR/)).toBeTruthy();
  });

  it('a done session shows Done', async () => {
    await open(SEED_IDS.done.session);
    expect(region('Result').getByText('Done', { selector: '.chip' })).toBeTruthy();
  });

  it('a failed step shows its first error', async () => {
    await open(SEED_IDS.stepFailed.session);
    expect(region('Result').getByText(/No commits between main and/)).toBeTruthy();
  });
});

describe('Technical details (FR-5)', () => {
  it('session id, worktree and raw JSON are only inside the collapsed section', async () => {
    const worktree = '/Users/ben/wt/b2000000';
    await open(SEED_IDS.running.session, (d) => ({
      ...d,
      worktree_path: worktree,
      context: { implement: { summary: 'Added a cursor.' } },
    }));
    const tech = toggle('Technical details');
    expect(tech.getAttribute('aria-expanded')).toBe('false');
    for (const text of [SEED_IDS.running.session, worktree]) {
      expect(screen.getByText(text).closest('[hidden]')).not.toBeNull();
    }
    expect(screen.queryByRole('button', { name: 'View raw JSON' })).toBeNull();
    fireEvent.click(tech);
    const t = region('Technical details');
    expect(t.getByText(SEED_IDS.running.session)).toBeTruthy();
    expect(t.getByText(worktree)).toBeTruthy();
    expect(t.getByRole('button', { name: 'View raw JSON' })).toBeTruthy();
    expect(t.getByRole('region', { name: 'Moves' })).toBeTruthy();
  });
});

describe('open state (FR-6)', () => {
  it('Situation, Task and Action open; Technical closed; Result has no toggle', async () => {
    await open(SEED_IDS.running.session);
    expect(toggle('Situation').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('Task').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('Action').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('Technical details').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /^Result/ })).toBeNull();
    // A collapsed section keeps its one-line summary (the Context's first line, as plain text).
    fireEvent.click(toggle('Situation'));
    expect(toggle('Situation').getAttribute('aria-expanded')).toBe('false');
    expect(toggle('Situation').querySelector('.star-summary')?.textContent).toMatch(/^[^-#*\s]/);
  });

  it('is remembered per session across a remount', async () => {
    await open(SEED_IDS.running.session);
    fireEvent.click(toggle('Task'));
    fireEvent.click(toggle('Technical details'));
    cleanup();
    await open(SEED_IDS.running.session);
    expect(toggle('Task').getAttribute('aria-expanded')).toBe('false');
    expect(toggle('Technical details').getAttribute('aria-expanded')).toBe('true');
    cleanup();
    // Another session has its own (default) state.
    await open(SEED_IDS.review.session);
    expect(toggle('Task').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('accessibility (NFR-3)', () => {
  it('one h3 per section, disclosure buttons with aria-expanded', async () => {
    await open(SEED_IDS.running.session);
    const h3 = screen.getAllByRole('heading', { level: 3 });
    expect(h3.map((h) => h.querySelector('.star-title')?.textContent)).toEqual([
      'Situation',
      'Task',
      'Action',
      'Result',
      'Technical details',
    ]);
    for (const name of ['Situation', 'Task', 'Action', 'Technical details']) {
      const b = toggle(name);
      expect(b.closest('h3')).not.toBeNull();
      expect(b.getAttribute('aria-controls')).toBeTruthy();
    }
  });
});

describe('live (NFR-4)', () => {
  it('a card update adds a timeline entry without collapsing open sections', async () => {
    const first = MOVES.slice(0, 2);
    const { state, rerender } = await open(SEED_IDS.review.session, (d) => ({
      ...d,
      moves: first,
      pending_input: null,
    }));
    fireEvent.click(toggle('Technical details'));
    fireEvent.click(toggle('Task'));
    expect(region('Action').getAllByRole('listitem')).toHaveLength(2);

    state.patch = (d) => ({ ...d, moves: MOVES.slice(0, 3), pending_input: null });
    rerender('2');
    await waitFor(() => expect(region('Action').getAllByRole('listitem')).toHaveLength(3));
    expect(region('Action').getByText(/Offset or cursor\?/)).toBeTruthy();
    expect(toggle('Technical details').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('Task').getAttribute('aria-expanded')).toBe('false');
    expect(toggle('Situation').getAttribute('aria-expanded')).toBe('true');
  });
});
