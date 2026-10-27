// @vitest-environment jsdom
import type { BoardCard } from '@conductor/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mockChecking } from '../api/mock-data.js';
import {
  checkingAnnouncement,
  checkingSummary,
  ConductorCheckBanner,
  failedItemOfQuestion,
  firstErrorLine,
} from './ConductorChecks.js';

afterEach(cleanup);

type Step = Pick<BoardCard, 'checking' | 'badges'>;
const at = (current: number, badges: BoardCard['badges'] = ['checking']): Step => ({
  checking: mockChecking(current),
  badges,
});

describe('checkingSummary / checkingAnnouncement (UX-5)', () => {
  it('names the running item and its position', () => {
    expect(checkingSummary(at(2))).toBe('Conductor is checking · Unit tests (3/5)');
    expect(checkingAnnouncement(at(2))).toBe('Unit tests: running (3 of 5)');
    expect(checkingSummary(at(4))).toBe('Conductor is checking · PR opened (5/5)');
  });

  it('FR-5: waiting for a build slot', () => {
    const s = at(0, ['waiting_for_build_slot', 'checking']);
    expect(checkingSummary(s)).toBe('Conductor is checking · waiting for a build slot');
    expect(checkingAnnouncement(s)).toBe('Conductor is waiting for a build slot');
  });

  it('no running item: the last item that started', () => {
    const c = mockChecking(2);
    const failed: Step = {
      badges: ['checking'],
      checking: {
        ...c,
        current: null,
        items: c.items!.map((i, n) => (n === 2 ? { ...i, status: 'failed' } : i)),
      },
    };
    expect(checkingAnnouncement(failed)).toBe('Unit tests: failed (3 of 5)');
  });
});

describe('firstErrorLine', () => {
  it('prefers a line that looks like an error, else the first line', () => {
    expect(firstErrorLine('\n> vitest run\n FAIL src/a.test.ts > adds\nmore')).toBe(
      'FAIL src/a.test.ts > adds',
    );
    expect(firstErrorLine('[warn] src/x.ts\n[warn] Code style issues')).toBe('[warn] src/x.ts');
    expect(firstErrorLine('  \n ')).toBeNull();
    expect(firstErrorLine(null)).toBeNull();
    expect(firstErrorLine(`error ${'x'.repeat(300)}`)!.length).toBe(200);
  });
});

describe('failedItemOfQuestion (FR-4: the engine wording, TD-152)', () => {
  it("a check unmet after the retries: its name and the output's first error line", () => {
    const q = [
      'Requirements to take "PR ready for review" (implementing → needs_input) were not met after 4 attempts (retry limit 3):',
      '- Tests pass: `pnpm test` failed (exit code 1)',
      '',
      'Last output of "Tests pass":',
      ' RUN  v5.0.5',
      ' FAIL  src/api/cards.test.ts > derives column',
      'AssertionError: expected 1 to be 2',
      '',
      'Retry, skip, or abort?',
    ].join('\n');
    expect(failedItemOfQuestion(q)).toEqual({
      item: 'Tests pass',
      error: 'FAIL  src/api/cards.test.ts > derives column',
    });
  });

  it('without output: the reason', () => {
    const q =
      'Requirements to take "X" (a → b) were not met after 1 attempt (retry limit 0):\n- Committed work: Uncommitted changes in the worktree\n\nRetry, skip, or abort?';
    expect(failedItemOfQuestion(q)).toEqual({
      item: 'Committed work',
      error: 'Uncommitted changes in the worktree',
    });
  });

  it('a failed action (stepFail) and a refused check', () => {
    expect(
      failedItemOfQuestion(
        'Conductor could not open the pull request (open_pr) to take "PR ready for review" (implementing → needs_input): gh: HTTP 422 Validation Failed. Retry, skip, or abort?',
      ),
    ).toEqual({
      item: 'open the pull request (open_pr)',
      error: 'gh: HTTP 422 Validation Failed.',
    });
    expect(
      failedItemOfQuestion(
        'Could not run the check "Build passes" (`npm run build`) to take "X" (a → b): the daemon refused it (busy). Retry, skip, or abort?',
      ),
    ).toEqual({ item: 'Build passes', error: 'the daemon refused it (busy)' });
  });

  it('anything else → null', () => {
    expect(failedItemOfQuestion('Should I use pg or sqlite?')).toBeNull();
  });
});

describe('ConductorCheckBanner (FR-3, NFR-3)', () => {
  it('lists the items with their status in text, and the note', () => {
    render(<ConductorCheckBanner card={at(2)} agent="Ada" />);
    const region = within(screen.getByRole('region', { name: 'Conductor is running checks' }));
    expect(region.getByText('Checks before PR ready for review', { exact: false })).toBeTruthy();
    const items = region.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      '✓Typecheck · passed',
      '✓Lint · passed',
      '◌Unit tests · running',
      '◻Build passes · to do',
      '◻PR opened · to do',
    ]);
    expect(region.getByText(/When the checks pass, conductor opens the PR/)).toBeTruthy();
    expect(region.getByText(/Ada has finished its part; it isn't running/)).toBeTruthy();
  });

  it('a failed item shows its name and first error line', () => {
    const c = mockChecking(2);
    const card: Step = {
      badges: ['checking'],
      checking: {
        ...c,
        current: null,
        items: c.items!.map((i, n) =>
          n === 2
            ? { ...i, status: 'failed', detail: 'RUN v5\nError: expected 1 to be 2\nat x' }
            : i,
        ),
      },
    };
    render(<ConductorCheckBanner card={card} agent="Ada" />);
    const failed = screen.getByText('Unit tests').closest('li')!;
    expect(failed.textContent).toBe('✗Unit tests · failed: Error: expected 1 to be 2');
  });

  it('FR-5: explains the build-slot wait', () => {
    render(
      <ConductorCheckBanner card={at(0, ['waiting_for_build_slot', 'checking'])} agent="Ada" />,
    );
    expect(screen.getByText(/Checks run one at a time on this machine to protect it/)).toBeTruthy();
  });

  it('the polite live region changes once per item change, not on an identical re-render', async () => {
    const { container, rerender } = render(<ConductorCheckBanner card={at(2)} agent="Ada" />);
    const live = container.querySelector('[aria-live="polite"]')!;
    expect(live.getAttribute('aria-atomic')).toBe('true');
    expect(live.textContent).toBe('Unit tests: running (3 of 5)');
    const changes: string[] = [];
    const observer = new MutationObserver(() => changes.push(live.textContent ?? ''));
    observer.observe(live, { childList: true, characterData: true, subtree: true });
    const flush = () => new Promise((r) => setTimeout(r, 0));

    rerender(<ConductorCheckBanner card={at(2)} agent="Ada" />); // e.g. only updated_at changed
    await flush();
    expect(changes).toEqual([]);

    rerender(<ConductorCheckBanner card={at(3)} agent="Ada" />); // Unit tests passed, Build runs
    await flush();
    rerender(<ConductorCheckBanner card={at(3)} agent="Ada" />);
    await flush();
    expect(live.textContent).toBe('Build passes: running (4 of 5)');
    expect(new Set(changes)).toEqual(new Set(['Build passes: running (4 of 5)']));
    observer.disconnect();
  });
});
