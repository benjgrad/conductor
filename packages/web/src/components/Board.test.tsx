// @vitest-environment jsdom
import {
  BOARD_CARD_NEEDS_INPUT_FIXTURE,
  type BoardCard,
  type InputRequestDto,
} from '@conductor/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardState } from '../board/board.js';
import { Board } from './Board.js';
import { PREVIEW_MAX } from './request-preview.js';
import { implementerReport, REPORT_PROSE_LINE } from './review-fixture.js';

afterEach(cleanup);

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
