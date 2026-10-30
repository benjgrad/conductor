// @vitest-environment jsdom
import {
  BOARD_CARD_NEEDS_INPUT_FIXTURE,
  BOARD_CARD_NEEDS_PERMISSION_FIXTURE,
  BOARD_CARD_PENDING_FIXTURE,
  type BoardCard,
  type InputRequestDto,
} from '@conductor/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { mockChecking } from '../api/mock-data.js';
import type { BoardState } from '../board/board.js';
import { agentName } from './agent-identity.js';
import { Board } from './Board.js';
import { boardLayoutKey } from './board-layout.js';
import { PLAN_APPROVED_TEXT, PREVIEW_MAX } from './request-preview.js';
import { implementerReport, REPORT_PROSE_LINE } from './review-fixture.js';

afterEach(cleanup);

// UX-9 NFR-2: `agentName` runs once per card render, so it counts them.
vi.mock('./agent-identity.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('./agent-identity.js')>();
  return { ...m, agentName: vi.fn(m.agentName) };
});

const PR = 'https://github.com/benjgrad/conductor/pull/42';
const BASE = BOARD_CARD_NEEDS_INPUT_FIXTURE;

function card(
  n: number,
  input: Partial<InputRequestDto>,
  over: Partial<BoardCard> = {},
): BoardCard {
  const hex = n.toString(16).padStart(12, '0');
  return {
    ...BASE,
    ticket_id: `a1000000-0000-4000-8000-${hex}`,
    session_id: `b2000000-0000-4000-8000-${hex}`,
    title: `Card ${n}`,
    human_transitions: [],
    input_request: {
      ...BASE.input_request!,
      id: `c3000000-0000-4000-8000-${hex}`,
      session_id: `b2000000-0000-4000-8000-${hex}`,
      ...input,
    },
    ...over,
  };
}

function board(cards: BoardCard[]): BoardState {
  return { cards: new Map(cards.map((c) => [c.ticket_id, c])), lastEventId: 0 };
}

function renderCards(cards: BoardCard[], onSelect = vi.fn()) {
  const r = render(<Board board={board(cards)} selectedSessionId={null} onSelect={onSelect} />);
  return { ...r, onSelect };
}

const article = (title: string) =>
  within(screen.getByText(title).closest('article') as HTMLElement);

const STEP_ERROR = 'Conductor could not PR opened to enter "Needs input": gh: 422 Unprocessable.';

describe('board card request preview (UX-4)', () => {
  it('FR-1: a 60-line report previews from after the TASK/BRANCH/STATUS header, bounded', () => {
    const report = implementerReport(60);
    expect(report.split('\n')).toHaveLength(60);
    const { container, onSelect } = renderCards([
      card(1, { question: report, origin_transition: 'personal_pr_ready_for_review' }),
    ]);
    const preview = container.querySelector('.card-preview')!;
    const text = preview.querySelector('.card-preview-text')!.textContent;
    // The real shape goes from the header straight into ACCEPTANCE: the summary leads instead.
    expect(text.startsWith('complete · Acceptance 8/10, gates ✓ · 1 for review')).toBe(true);
    expect(text.endsWith(REPORT_PROSE_LINE)).toBe(true);
    expect(text).not.toMatch(/^ACCEPTANCE|TASK:|BRANCH:|STATUS:|evidence/);
    expect(text.length).toBeLessThanOrEqual(PREVIEW_MAX);
    // ≤ 3 lines: the string is bounded, and Board.css clamps the box to 3 lines.
    expect(preview.className).toBe('card-preview');
    fireEvent.click(preview);
    expect(onSelect).toHaveBeenCalledWith('b2000000-0000-4000-8000-000000000001');
  });

  it('FR-1: a real question shows its first sentence', () => {
    renderCards([
      card(1, {
        question: 'Should I use pg or sqlite? The tradeoffs:\n- pg: …\n- sqlite: …',
        origin_transition: null,
      }),
    ]);
    const a = article('Card 1');
    expect(a.getByText('Should I use pg or sqlite?')).toBeTruthy();
    expect(a.queryByText(/tradeoffs/)).toBeNull();
  });

  it('FR-2: a review request says "Ready for review" with a prominent PR link, no "Question"', () => {
    renderCards([
      card(
        1,
        { question: implementerReport(), origin_transition: 'personal_pr_ready_for_review' },
        { pr_url: PR },
      ),
      card(2, { question: 'Which DB?', origin_transition: 'scope_changed' }),
      card(3, { question: 'Which port?' }),
    ]);
    const review = article('Card 1');
    expect(review.getByText(/^Ready for review ·/)).toBeTruthy();
    expect(review.queryByText(/Question/)).toBeNull();
    const links = review.getAllByRole('link', { name: /pull request/i });
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe(PR);
    expect(links[0]!.className).toBe('card-pr-link');
    // A real question (a named question transition, or no origin from an older server).
    expect(article('Card 2').getByText(/^Question ·/)).toBeTruthy();
    expect(article('Card 3').getByText(/^Question ·/)).toBeTruthy();
    expect(article('Card 2').queryByText(/Ready for review/)).toBeNull();
  });

  it('FR-3: a failed open_pr step says "Step failed" with the first error line', () => {
    const question = `${STEP_ERROR}\nstderr: validation failed\n\nRetry, skip, or abort?`;
    renderCards([
      card(1, { kind: 'retries_exhausted', question, origin_transition: null, step_failed: true }),
      // An older server: no step_failed field, recognised from the text.
      card(2, { kind: 'retries_exhausted', question }),
    ]);
    for (const title of ['Card 1', 'Card 2']) {
      const a = article(title);
      expect(a.getByText(/^Step failed ·/).className).toContain('badge-step-failed');
      expect(a.getByText(STEP_ERROR)).toBeTruthy();
      expect(a.queryByText(/stderr/)).toBeNull();
    }
  });

  it('NFR-3: the full text is the accessible name; the label is text', () => {
    const report = implementerReport(60);
    renderCards([card(1, { question: report, origin_transition: 'pr_ready_for_review' })]);
    const button = screen.getByRole('button', { name: /NOTES: more detail on line 59\./ });
    expect(button.getAttribute('aria-label')).toBe(`Ready for review: ${report}`);
    expect(button.getAttribute('title')).toBe(report);
    expect(screen.getByText(/^Ready for review ·/).tagName).toBe('SPAN');
  });

  it('NFR-4: 200 cards × 5,000-character reports render with bounded previews', () => {
    const long = `${implementerReport()}\n${'Detail '.repeat(800)}`.slice(0, 5000);
    expect(long).toHaveLength(5000);
    const cards = Array.from({ length: 200 }, (_, i) =>
      card(i + 1, { question: long, origin_transition: 'personal_pr_ready_for_review' }),
    );
    const t0 = performance.now();
    const { container } = renderCards(cards);
    const ms = performance.now() - t0;
    const previews = container.querySelectorAll('.card-preview');
    expect(previews).toHaveLength(200);
    // jsdom does no layout: the no-jump guarantee is Board.css (3-line clamp, fixed max-height)
    // plus a bounded preview string, so a card's height never depends on the report's length.
    for (const p of previews) {
      expect(p.className).toBe('card-preview');
      expect(p.querySelector('.card-preview-text')!.textContent.length).toBeLessThanOrEqual(
        PREVIEW_MAX,
      );
    }
    // A ceiling, not a benchmark: wall-clock time under a loaded run is 2.6–3.6 s (lead QA).
    expect(ms).toBeLessThan(10_000);
  });
});

describe('board card in a gate step (UX-5)', () => {
  const step = (n: number, over: Partial<BoardCard> = {}): BoardCard => ({
    ...card(n, {}),
    input_request: null,
    status: 'running',
    workflow_state: 'implementing → needs_input (move: personal_pr_ready_for_review)',
    column: 'implementing',
    badges: ['checking'],
    checking: mockChecking(2),
    ...over,
  });

  it('FR-2: says "Conductor is checking · Unit tests (3/5)", not "running"; the agent is idle', () => {
    renderCards([step(1)]);
    const a = article('Card 1');
    expect(a.getByText('Conductor is checking · Unit tests (3/5)')).toBeTruthy();
    expect(a.queryByText('running')).toBeNull();
    expect(a.queryByText(/move: personal_pr_ready_for_review/)).toBeNull();
    const agent = screen.getByText('Card 1').closest('article')!.querySelector('.card-agent')!;
    expect(agent.querySelector('svg')!.getAttribute('class')).toContain('avatar-idle');
    expect(agent.textContent).toContain('(idle)');
    expect(agent.getAttribute('title')).toMatch(/is idle: conductor is checking/);
  });

  it('FR-5: waiting for a build slot reads so, once, and the agent is still idle', () => {
    renderCards([
      step(1, { badges: ['waiting_for_build_slot', 'checking'], checking: mockChecking(0) }),
    ]);
    const a = article('Card 1');
    expect(a.getByText('Conductor is checking · waiting for a build slot')).toBeTruthy();
    expect(a.queryByText('waiting for build slot')).toBeNull();
    expect(a.queryByText('running')).toBeNull();
    const avatar = screen.getByText('Card 1').closest('article')!.querySelector('.card-agent svg')!;
    expect(avatar.getAttribute('class')).toContain('avatar-idle');
  });

  it('a running card outside a step keeps its status and build-slot badge; the agent is not idle', () => {
    renderCards([
      step(1, {
        badges: ['waiting_for_build_slot'],
        checking: null,
        workflow_state: 'implementing',
      }),
    ]);
    const a = article('Card 1');
    // The Implementing column says it visually; screen readers still hear it (NFR-2).
    expect(a.getByText('running').className).toBe('visually-hidden');
    expect(document.querySelector('.status-running')).toBeNull();
    expect(a.getByText('waiting for build slot')).toBeTruthy();
    const avatar = screen.getByText('Card 1').closest('article')!.querySelector('.card-agent svg')!;
    expect(avatar.getAttribute('class')).not.toContain('avatar-idle');
  });

  it('an older server (checking without items) falls back to the target title', () => {
    renderCards([
      step(1, { checking: { to: 'needs_input', title: 'Needs input', phase: 'checks' } }),
    ]);
    expect(article('Card 1').getByText('Conductor is checking · Needs input')).toBeTruthy();
  });

  it('the conditions phase keeps the "waiting for" checklist', () => {
    renderCards([
      step(1, {
        status: 'waiting_external',
        checking: BOARD_CARD_PENDING_FIXTURE.checking,
        pending: BOARD_CARD_PENDING_FIXTURE.pending,
      }),
    ]);
    const a = article('Card 1');
    expect(a.getByRole('group', { name: 'Waiting for Ready for testing' })).toBeTruthy();
    expect(a.queryByText(/Conductor is checking/)).toBeNull();
  });

  it('FR-4: the summary and the checking badge never both show', () => {
    renderCards([
      step(1),
      step(2, {
        status: 'waiting_external',
        checking: { ...mockChecking(0), phase: 'conditions' },
      }),
    ]);
    const conductor = screen.getByText('Card 1').closest('article')!;
    expect(conductor.querySelector('.status-conductor')).not.toBeNull();
    expect(conductor.querySelector('.badge-checking')).toBeNull();
    const conditions = screen.getByText('Card 2').closest('article')!;
    expect(conditions.querySelector('.status-conductor')).toBeNull();
  });
});

/** Text a sighted user sees: `.visually-hidden` spans left out. */
function visibleText(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('.visually-hidden').forEach((n) => n.remove());
  return copy.textContent;
}

describe('board card says only what its column does not (UX card cleanup)', () => {
  it('FR-1/FR-2: a needs-input card in Needs input says "needs input" once, in the heading', () => {
    renderCards([card(1, {})]);
    const column = screen.getByRole('region', { name: 'Needs input' });
    expect(visibleText(column).match(/needs[ _]input/gi)).toHaveLength(1);
    const meta = column.querySelector('article .card-meta')!;
    expect(visibleText(meta)).not.toMatch(/needs[ _]input/i);
    // NFR-2: screen readers still hear the status.
    expect(meta.querySelector('.visually-hidden')!.textContent).toBe('needs input');
  });

  it('FR-1: a state that is not the column stays', () => {
    renderCards([
      card(
        1,
        {},
        { input_request: null, column: 'queued', status: 'assigned', workflow_state: 'planning' },
      ),
    ]);
    const meta = screen.getByText('Card 1').closest('article')!.querySelector('.card-meta')!;
    expect(visibleText(meta)).toContain('planning');
    expect(visibleText(meta)).toContain('assigned');
  });

  it('FR-4: a failed card in Done says "failed" once', () => {
    renderCards([
      card(1, {}, { input_request: null, column: 'done', status: 'failed', badges: ['failed'] }),
    ]);
    const a = screen.getByText('Card 1').closest('article')!;
    expect(visibleText(a).match(/failed/g)).toHaveLength(1);
    expect(a.querySelector('.badge-failed')).not.toBeNull();
  });
});

describe('board card: plan approval (06 §Plan approval)', () => {
  const SID = 'b2000000-0000-4000-8000-000000000001';
  const transitions = BASE.human_transitions;
  const planCard = (over: Partial<BoardCard> = {}) =>
    card(
      1,
      { question: 'Raised beds cost $400. Approve?', origin_transition: 'plan_needs_approval' },
      { human_transitions: transitions, ...over },
    );
  type Post = ApiClient['transition'];

  function renderWithApi(
    cards: BoardCard[],
    transition: Post = vi.fn<Post>(() => Promise.resolve({ ok: true as const })),
  ) {
    const onSelect = vi.fn();
    const api = { transition } as unknown as ApiClient;
    render(<Board board={board(cards)} selectedSessionId={null} onSelect={onSelect} api={api} />);
    return { onSelect, transition };
  }

  it('shows the "Plan to approve" label and badge instead of the generic buttons', () => {
    renderWithApi([planCard()]);
    const a = article('Card 1');
    const badge = a.getByText(/^Plan to approve · /);
    expect(badge.className).toContain('badge-plan-approval');
    expect(a.getByRole('button', { name: /^Plan to approve: Raised beds/ })).toBeTruthy();
    expect(a.getByRole('group', { name: 'Plan to approve' })).toBeTruthy();
    expect(a.queryByRole('group', { name: 'Move to' })).toBeNull();
    expect(a.queryByRole('button', { name: /Back with this answer/ })).toBeNull();
  });

  it('Approve plan posts exactly {name: answer option, text: PLAN_APPROVED_TEXT}, busy while in flight', async () => {
    let resolve!: (v: { ok: true }) => void;
    const transition = vi.fn<Post>(() => new Promise<{ ok: true }>((r) => (resolve = r)));
    renderWithApi([planCard()], transition);
    const approve = article('Card 1').getByRole<HTMLButtonElement>('button', {
      name: 'Approve plan',
    });
    fireEvent.click(approve);
    expect(approve.disabled).toBe(true);
    fireEvent.click(approve); // in flight: not posted twice
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith(SID, { name: 'answer', text: PLAN_APPROVED_TEXT });
    expect(PLAN_APPROVED_TEXT).toBe(
      'Plan approved. Proceed: call complete_state with plan_ready and this plan.',
    );
    resolve({ ok: true });
    await waitFor(() => expect(approve.disabled).toBe(false));
    expect(article('Card 1').queryByRole('alert')).toBeNull();
  });

  it('a rejected Approve plan shows the error', async () => {
    const transition = vi.fn<Post>(() => Promise.reject(new Error('session moved on')));
    renderWithApi([planCard()], transition);
    fireEvent.click(article('Card 1').getByRole('button', { name: 'Approve plan' }));
    expect((await article('Card 1').findByRole('alert')).textContent).toContain('session moved on');
    expect(
      article('Card 1').getByRole<HTMLButtonElement>('button', { name: 'Approve plan' }).disabled,
    ).toBe(false);
  });

  it('Review plan selects the session (opens the panel) without posting', () => {
    const { onSelect, transition } = renderWithApi([planCard()]);
    fireEvent.click(article('Card 1').getByRole('button', { name: 'Review plan' }));
    expect(onSelect).toHaveBeenCalledWith(SID);
    expect(transition).not.toHaveBeenCalled();
  });

  it('without a matching answer option: the generic TransitionButtons', () => {
    renderWithApi([
      planCard({ human_transitions: transitions.filter((o) => o.name !== 'answer') }),
    ]);
    const a = article('Card 1');
    expect(a.getByText(/^Plan to approve · /)).toBeTruthy();
    expect(a.queryByRole('button', { name: 'Approve plan' })).toBeNull();
    expect(a.queryByRole('button', { name: 'Review plan' })).toBeNull();
    const group = a.getByRole('group', { name: 'Move to' });
    expect(within(group).getByRole('button', { name: /Waiting on someone else/ })).toBeTruthy();
  });

  it('an ordinary question keeps the generic buttons', () => {
    renderWithApi([
      card(1, { origin_transition: 'scope_changed' }, { human_transitions: transitions }),
    ]);
    const a = article('Card 1');
    expect(a.queryByRole('button', { name: 'Approve plan' })).toBeNull();
    expect(a.getByRole('button', { name: /Back with this answer/ })).toBeTruthy();
  });
});

describe('board card: needs permission (ADR-0023)', () => {
  it('shows the tool and how many more are waiting; the summary is the title', () => {
    const c = BOARD_CARD_NEEDS_PERMISSION_FIXTURE;
    renderCards([{ ...c, permission: { ...c.permission!, pending_count: 3 } }]);
    const badge = article(c.title).getByText(/needs permission:/);
    expect(badge.textContent).toBe(`needs permission: ${c.permission!.tool} (+2)`);
    expect(badge.getAttribute('title')).toBe(c.permission!.summary);
  });

  it('no badge without the sub-status', () => {
    const c: BoardCard = { ...BOARD_CARD_NEEDS_PERMISSION_FIXTURE };
    delete c.sub_status;
    delete c.permission;
    renderCards([c]);
    expect(article(c.title).queryByText(/needs permission:/)).toBeNull();
  });
});

describe('collapsible columns (UX-9)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const KEY = boardLayoutKey('conductor');
  const region = (name: string) => screen.getByRole('region', { name });
  const toggle = (name: string) =>
    region(name).querySelector<HTMLButtonElement>('h2 > button.column-toggle')!;
  const expandAll = () => screen.queryByRole('button', { name: 'Expand all' });
  const done = (n: number) => card(n, {}, { input_request: null, column: 'done' });
  const planning = (n: number) =>
    card(n, {}, { input_request: null, column: 'planning', status: 'running' });
  const tracks = (container: HTMLElement) =>
    (container.querySelector('.board') as HTMLElement).style.gridTemplateColumns;
  const renderBoard = (cards: BoardCard[], workflow?: string) =>
    render(
      <Board
        board={board(cards)}
        selectedSessionId={null}
        onSelect={vi.fn()}
        {...(workflow ? { workflow } : {})}
      />,
    );

  it('FR-1/FR-2: the toggle hides the cards and leaves a strip with the count', () => {
    const { container } = renderBoard([done(1), done(2)]);
    const button = toggle('Done');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const body = document.getElementById(button.getAttribute('aria-controls')!)!;
    expect(region('Done').contains(body)).toBe(true);
    expect(within(region('Done')).getAllByRole('article')).toHaveLength(2);
    expect(tracks(container)).not.toContain('--column-strip-width');

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(region('Done').className).toContain('collapsed');
    expect(within(region('Done')).queryAllByRole('article')).toHaveLength(0);
    expect(body.hidden).toBe(true);
    expect(button.textContent).toContain('Done');
    expect(button.querySelector('.count')!.textContent).toBe('2');
    // The strip's track: the last column (Done) is narrow, the others keep their width.
    expect(tracks(container).split(' ').at(-1)).toBe('var(--column-strip-width)');
    expect(tracks(container).split('minmax(180px, 1fr)')).toHaveLength(6);

    // FR-2: the strip is the button, so clicking it expands the column.
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(within(region('Done')).getAllByRole('article')).toHaveLength(2);
  });

  it('FR-3: collapsed columns survive a remount, per workflow', () => {
    const { unmount } = renderBoard([done(1)]);
    fireEvent.click(toggle('Done'));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['done']);
    unmount();
    renderBoard([done(1)]);
    expect(toggle('Done').getAttribute('aria-expanded')).toBe('false');
    expect(within(region('Done')).queryAllByRole('article')).toHaveLength(0);
    cleanup();
    renderBoard([done(1)], 'other');
    expect(toggle('Done').getAttribute('aria-expanded')).toBe('true');
  });

  it('FR-3: an id that is no longer a column is ignored, and bad storage is harmless', () => {
    localStorage.setItem(KEY, JSON.stringify(['gone', 'done', 7]));
    const { container, unmount } = renderBoard([done(1)]);
    expect(toggle('Done').getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('section.column')).toHaveLength(6);
    expect(container.querySelector('[data-column="gone"]')).toBeNull();
    expect(container.querySelectorAll('.column.collapsed')).toHaveLength(1);
    // Saving keeps only the columns there are.
    fireEvent.click(toggle('Planning'));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['done', 'planning']);
    unmount();

    localStorage.setItem(KEY, '{not json');
    const garbage = renderBoard([done(1)]);
    expect(toggle('Done').getAttribute('aria-expanded')).toBe('true');
    garbage.unmount();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    renderBoard([done(1)]);
    expect(toggle('Done').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle('Done'));
    expect(toggle('Done').getAttribute('aria-expanded')).toBe('false');
  });

  it('FR-4: a collapsed human column shows a dot when its count rises', () => {
    const r = renderBoard([card(1, {}), done(10)]);
    fireEvent.click(toggle('Needs input'));
    fireEvent.click(toggle('Done'));
    expect(document.querySelector('.column-attention')).toBeNull();

    const rerender = (cards: BoardCard[]) =>
      r.rerender(<Board board={board(cards)} selectedSessionId={null} onSelect={vi.fn()} />);
    rerender([card(1, {}), card(2, {}), done(10), done(11)]);
    const dot = region('Needs input').querySelector('.column-attention');
    expect(dot).not.toBeNull();
    expect(toggle('Needs input').contains(dot)).toBe(true);
    // Never on a column that isn't human.
    expect(region('Done').querySelector('.column-attention')).toBeNull();

    // Expanding takes it away; collapsed again, it waits for the next rise.
    fireEvent.click(toggle('Needs input'));
    fireEvent.click(toggle('Needs input'));
    expect(document.querySelector('.column-attention')).toBeNull();
    // A drop then a rise back shows it again.
    rerender([card(1, {}), done(10), done(11)]);
    expect(document.querySelector('.column-attention')).toBeNull();
    rerender([card(1, {}), card(2, {}), done(10), done(11)]);
    expect(region('Needs input').querySelector('.column-attention')).not.toBeNull();
  });

  it('FR-4: a column restored collapsed is not news on mount', () => {
    localStorage.setItem(KEY, JSON.stringify(['needs_input']));
    renderBoard([card(1, {}), card(2, {})]);
    expect(document.querySelector('.column-attention')).toBeNull();
  });

  it('FR-5: Expand all appears when a column is collapsed and expands them all', () => {
    renderBoard([done(1), planning(2)]);
    expect(expandAll()).toBeNull();
    fireEvent.click(toggle('Done'));
    fireEvent.click(toggle('Planning'));
    expect(document.querySelectorAll('.column.collapsed')).toHaveLength(2);
    fireEvent.click(expandAll()!);
    expect(document.querySelectorAll('.column.collapsed')).toHaveLength(0);
    expect(expandAll()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('NFR-1: each toggle is a native button that keeps focus when it toggles', () => {
    renderBoard([done(1)]);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.column-toggle')];
    expect(buttons).toHaveLength(6);
    for (const b of buttons) {
      // A <button type="button"> without tabindex: Tab reaches it, Enter/Space click it.
      expect(b.type).toBe('button');
      expect(b.hasAttribute('tabindex')).toBe(false);
      expect(b.disabled).toBe(false);
    }
    const button = toggle('Done');
    button.focus();
    fireEvent.click(button);
    expect(document.activeElement).toBe(button);
    expect(toggle('Done')).toBe(button);
    fireEvent.click(button);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('NFR-2: toggling a column does not re-render the cards of the others', () => {
    const p = planning(1);
    renderBoard([p, done(2)]);
    const name = vi.mocked(agentName);
    name.mockClear();
    fireEvent.click(toggle('Done'));
    fireEvent.click(toggle('Done'));
    expect(name.mock.calls.some(([id]) => id === p.ticket_id)).toBe(false);
    // The toggled column's own cards do render again when it expands.
    expect(name.mock.calls.some(([id]) => id === done(2).ticket_id)).toBe(true);
  });
});
