// @vitest-environment jsdom
import {
  BOARD_CARD_PENDING_FIXTURE,
  CONDUCTOR_V2_DRAFT_DEF,
  SESSION_MOVES_FIXTURE,
  TRANSITION_REQUEST_FIXTURES,
  type TransitionSessionRequest,
} from '@conductor/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { App } from '../App.js';
import { MovesList, PendingChecklist } from './transitions.js';

afterEach(cleanup);

const column = (name: string) => screen.getByRole('region', { name });
const cardIn = (col: string, title: string) =>
  within(column(col)).getByText(title).closest('article') as HTMLElement;

async function renderApp() {
  const api = createMockApi();
  const posts: [string, TransitionSessionRequest][] = [];
  const transition = api.transition.bind(api);
  api.transition = (sid, req) => {
    posts.push([sid, req]);
    return transition(sid, req);
  };
  render(<App api={api} />);
  await screen.findByText('Plan the garden');
  return { api, posts };
}

describe('pending-move checklist (ADR-0011)', () => {
  it('renders each item with its status, greying disabled ones, detail on hover', () => {
    const pending = {
      ...BOARD_CARD_PENDING_FIXTURE.pending!,
      items: [
        ...BOARD_CARD_PENDING_FIXTURE.pending!.items,
        { label: 'Jira says', status: 'unsupported' as const, detail: 'needs the jira CLI (M5)' },
      ],
    };
    render(<PendingChecklist pending={pending} />);
    const group = within(screen.getByRole('group', { name: 'Waiting for Ready for testing' }));
    const items = group.getAllByRole('listitem');
    expect(items.map((li) => [li.textContent, li.dataset.status])).toEqual([
      ['✓Build passes (met)', 'met'],
      ['✓Tests pass (met)', 'met'],
      ['✓PR opened (met)', 'met'],
      ['✓PR checks green (3/3) (met)', 'met'],
      ['◻PR approved (0/1) (not yet)', 'pending'],
      ['–Jira fields set: resolution (disabled)', 'disabled'],
      ['–Pipeline ci succeeded (disabled)', 'disabled'],
      ['?Jira says (not supported yet)', 'unsupported'],
    ]);
    expect(items.at(-1)!.title).toBe('needs the jira CLI (M5)');
    expect(items.at(-1)!.className).toContain('pending-item-unsupported');
  });

  it('shows the checklist and kind on the held card in its source column', async () => {
    await renderApp();
    const card = within(cardIn('Implementing', 'Ship the /health endpoint'));
    expect(card.getByText('Work')).toBeTruthy();
    const list = within(card.getByRole('group', { name: 'Waiting for Ready for testing' }));
    expect(list.getAllByRole('listitem')).toHaveLength(7);
    expect(list.getByText('PR approved (0/1)')).toBeTruthy();
    // `pending` supersedes the old `checking` badge.
    expect(card.queryByText(/checking requirements/)).toBeNull();
  });
});

describe('human transition buttons (ADR-0011)', () => {
  it('a Needs-input card has one button per human transition; Done posts {name} exactly', async () => {
    const { posts } = await renderApp();
    const card = within(cardIn('Needs input', 'Plan the garden'));
    expect(card.getByText('Personal')).toBeTruthy();
    const buttons = within(card.getByRole('group', { name: 'Move to' })).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Back with this answer…',
      'Waiting on someone else…',
      'Done',
    ]);
    fireEvent.click(card.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toStrictEqual([
      SEED_IDS.transitions.session,
      TRANSITION_REQUEST_FIXTURES.done,
    ]);
    await waitFor(() => expect(within(column('Done')).getByText('Plan the garden')).toBeTruthy());
  });

  it('a needs_text button asks for text first and posts {name, text} exactly', async () => {
    const { posts } = await renderApp();
    const card = within(cardIn('Needs input', 'Plan the garden'));
    fireEvent.click(card.getByRole('button', { name: /Waiting on someone else/ }));
    expect(posts).toEqual([]);
    const form = within(card.getByRole('form', { name: 'Waiting on someone else' }));
    const submit = form.getByRole<HTMLButtonElement>('button', { name: 'Waiting on someone else' });
    expect(submit.disabled).toBe(true);
    // Whitespace isn't text.
    fireEvent.change(form.getByRole('textbox'), { target: { value: '   ' } });
    expect(submit.disabled).toBe(true);
    fireEvent.submit(card.getByRole('form', { name: 'Waiting on someone else' }));
    expect(posts).toEqual([]);
    fireEvent.change(form.getByRole('textbox'), {
      target: { value: '  Dana is reviewing the API shape.  ' },
    });
    fireEvent.click(submit);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toStrictEqual([
      SEED_IDS.transitions.session,
      TRANSITION_REQUEST_FIXTURES.waiting_on_someone,
    ]);
    // In Waiting external it offers that state's human transition.
    await waitFor(() =>
      expect(
        within(cardIn('Waiting external', 'Plan the garden')).getByRole('button', {
          name: /Back to Implementing/,
        }),
      ).toBeTruthy(),
    );
  });

  it('the session panel shows the buttons above the composer, and no quick actions', async () => {
    const { posts } = await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Plan the garden' }));
    const panel = within(await screen.findByRole('complementary', { name: 'Session detail' }));
    const group = await panel.findByRole('group', { name: 'Move to' });
    expect(within(group).getAllByRole('button')).toHaveLength(3);
    expect(panel.queryByRole('group', { name: 'Quick actions' })).toBeNull();
    // The answer box remains (it answers for $return_to).
    expect(panel.getByLabelText('Answer')).toBeTruthy();
    fireEvent.click(within(group).getByRole('button', { name: /Back with this answer/ }));
    const form = within(panel.getByRole('form', { name: 'Back with this answer' }));
    fireEvent.change(form.getByLabelText('Your answer'), { target: { value: 'Raised beds' } });
    fireEvent.click(form.getByRole('button', { name: 'Back with this answer' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]![1]).toStrictEqual({ name: 'answer', text: 'Raised beds' });
  });

  it('shows the error when the server refuses the move', async () => {
    const { api } = await renderApp();
    api.transition = () => Promise.reject(new Error('transition "done" is not offered here'));
    const card = within(cardIn('Needs input', 'Plan the garden'));
    fireEvent.click(card.getByRole('button', { name: 'Done' }));
    expect((await card.findByRole('alert')).textContent).toMatch(/not offered/);
  });
});

describe('moves timeline (ADR-0011)', () => {
  it('renders "<time> <from> → <to> · <title> — <reason>" for every move', () => {
    render(<MovesList moves={SESSION_MOVES_FIXTURE} workflow={CONDUCTOR_V2_DRAFT_DEF} />);
    const rows = screen.getAllByRole('listitem').map((li) => {
      const t = li.querySelector('time')!;
      return li.textContent.slice(t.textContent.length).trim();
    });
    expect(rows).toEqual([
      'start → Planning',
      'Planning → Implementing · Plan ready — The plan names every file it changes. (agent)',
      'Implementing → implementing → waiting_external (move: ready_for_testing) · Ready for testing — The endpoint is implemented and tested. (agent)',
      'implementing → waiting_external (move: ready_for_testing) → Waiting external · Ready for testing — The endpoint is implemented and tested. (agent)',
    ]);
    expect(screen.getAllByRole('listitem')[1]!.querySelector('time')!.dateTime).toBe(
      SESSION_MOVES_FIXTURE[1]!.at,
    );
  });

  it('lists the session moves under Details', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Ship the /health endpoint' }));
    const panel = within(await screen.findByRole('complementary', { name: 'Session detail' }));
    await panel.findByRole('log');
    fireEvent.click(panel.getByRole('tab', { name: 'Details' }));
    const moves = within(panel.getByRole('region', { name: 'Moves' }));
    expect(moves.getAllByRole('listitem')).toHaveLength(3);
    expect(moves.getByText('— The plan names every file it changes.')).toBeTruthy();
    expect(moves.getAllByText('· Ready for testing')).toHaveLength(1);
  });
});
