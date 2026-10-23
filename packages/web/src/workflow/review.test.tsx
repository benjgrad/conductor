// @vitest-environment jsdom
import { BOARD_CARD_FIXTURE, type WorkflowDetail } from '@conductor/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { Board } from '../components/Board.js';
import { detailVersions, parseReviewState, stateLabel } from './review.js';
import { SessionWorkflowDiagram } from './SessionWorkflowDiagram.js';

afterEach(cleanup);

const REVIEW = 'implement → build (review)';

describe('review state label (ADR-0009)', () => {
  it('parses "<from> → <to> (review)"', () => {
    expect(parseReviewState(REVIEW)).toEqual({ from: 'implement', to: 'build' });
    expect(parseReviewState('implement')).toBeNull();
    expect(parseReviewState(null)).toBeNull();
    expect(stateLabel(REVIEW)).toBe('Reviewing: implement → build');
    expect(stateLabel('build')).toBe('build');
  });

  it('shows "Reviewing: from → to" on the board card', () => {
    const card = {
      ...BOARD_CARD_FIXTURE,
      workflow_state: REVIEW,
      status: 'running' as const,
      column: 'running' as const,
    };
    render(
      <Board
        board={{ cards: new Map([[card.ticket_id, card]]), lastEventId: 0 }}
        selectedSessionId={null}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByText('Reviewing: implement → build')).toBeTruthy();
    expect(screen.queryByText(REVIEW)).toBeNull();
  });

  it('highlights the gated edge under review in the session diagram, not a state', async () => {
    const detail = await createMockApi().getSession(SEED_IDS.running.session);
    detail.card.workflow_state = REVIEW;
    render(<SessionWorkflowDiagram detail={detail} />);
    const svg = screen.getByRole('group', { name: /current state Reviewing: implement → build$/ });
    const current = svg.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0]!.getAttribute('data-edge')).toBe('implement/done/outcome');
    expect(current[0]!.getAttribute('class')).toContain('reviewing');
    expect(within(current[0] as HTMLElement).getByText(/\(under review\)$/)).toBeTruthy();
    expect(svg.querySelector('.wf-node.current')).toBeNull();
  });
});

describe('detailVersions', () => {
  const base = { id: 'w', version: 3, created_at: '2026-10-01T00:00:00.000Z' };
  const detail = (extra: object) => ({ ...base, ...extra }) as unknown as WorkflowDetail;

  it('reads the optional versions list defensively', () => {
    expect(detailVersions(detail({ versions: [3, 1] }))).toEqual([1, 3]);
    expect(detailVersions(detail({}))).toBeNull();
    expect(detailVersions(detail({ versions: [] }))).toBeNull();
    expect(detailVersions(detail({ versions: ['1'] }))).toBeNull();
  });
});
