import { describe, expect, it } from 'vitest';
import { pageCounts, processMetrics } from './metrics.js';

// ADR-0038 (Insights FR-6): pages attached, per state and per ticket; no other metric.

describe('pageCounts', () => {
  it('sums per state and per ticket, the most first', () => {
    expect(
      pageCounts([
        { ticket_id: 't1', session_id: 's1', state: 'planning', count: 2 },
        { ticket_id: 't1', session_id: 's1', state: 'implementing', count: 1 },
        { ticket_id: 't2', session_id: 's2', state: 'planning', count: 1 },
        { ticket_id: 't3', session_id: 's3', state: 'planning', count: 0 },
      ]),
    ).toEqual({
      pages: {
        total: 4,
        by_state: { planning: 3, implementing: 1 },
        by_ticket: [
          { ticket_id: 't1', count: 3 },
          { ticket_id: 't2', count: 1 },
        ],
      },
    });
  });

  it('is absent from processMetrics when no page was attached', () => {
    const empty = { moves: [], checks: [], inputs: [], permissions: [] };
    expect(processMetrics(empty, 'state')).not.toHaveProperty('pages');
    expect(
      processMetrics(
        { ...empty, pages: [{ ticket_id: 't', session_id: 's', state: 'planning', count: 1 }] },
        'state',
      ).pages?.by_state,
    ).toEqual({ planning: 1 });
  });
});
