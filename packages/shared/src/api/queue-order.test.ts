import { describe, expect, it } from 'vitest';
import { compareQueued, isReorderable, moveInOrder, type QueuedLike } from './queue-order.js';

const t = (
  ticket_id: string,
  priority: number,
  created_at: string,
  queue_position: number | null = null,
): QueuedLike => ({ ticket_id, priority, created_at, queue_position });

const order = (xs: QueuedLike[]) => [...xs].sort(compareQueued).map((x) => x.ticket_id);

describe('compareQueued', () => {
  it('with nothing ranked: priority, highest first, then oldest first', () => {
    expect(
      order([
        t('a', 0, '2026-01-01T00:00:00Z'),
        t('b', 5, '2026-01-03T00:00:00Z'),
        t('c', 5, '2026-01-02T00:00:00Z'),
        t('d', -1, '2025-01-01T00:00:00Z'),
      ]),
    ).toEqual(['c', 'b', 'a', 'd']);
  });

  it('puts hand-ranked tickets first, by position, whatever their priority', () => {
    expect(
      order([
        t('high', 9, '2026-01-01T00:00:00Z'),
        t('r2', 0, '2026-01-01T00:00:00Z', 2),
        t('r1', -3, '2026-01-05T00:00:00Z', 1),
        t('low', 0, '2025-01-01T00:00:00Z'),
      ]),
    ).toEqual(['r1', 'r2', 'high', 'low']);
  });

  it('breaks full ties by id, and an absent position is unranked', () => {
    const same = '2026-01-01T00:00:00Z';
    expect(
      order([
        { ticket_id: 'b', priority: 0, created_at: same },
        t('a', 0, same),
        t('c', 0, same, 4),
      ]),
    ).toEqual(['c', 'a', 'b']);
  });
});

describe('moveInOrder', () => {
  const ids = ['a', 'b', 'c', 'd'];
  it('moves to the top, the bottom and the middle', () => {
    expect(moveInOrder(ids, 'c', 0)).toEqual(['c', 'a', 'b', 'd']);
    expect(moveInOrder(ids, 'a', 3)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveInOrder(ids, 'a', 99)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveInOrder(ids, 'd', 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(moveInOrder(ids, 'b', -4)).toEqual(['b', 'a', 'c', 'd']);
  });
  it('returns the same list for the same place or an unknown id', () => {
    expect(moveInOrder(ids, 'b', 1)).toBe(ids);
    expect(moveInOrder(ids, 'x', 0)).toBe(ids);
  });
});

describe('isReorderable', () => {
  it('only a Queued card with no session or a queued one', () => {
    expect(isReorderable({ column: 'queued', status: null })).toBe(true);
    expect(isReorderable({ column: 'queued', status: 'queued' })).toBe(true);
    expect(isReorderable({ column: 'queued', status: 'assigned' })).toBe(false);
    expect(isReorderable({ column: 'planning', status: null })).toBe(false);
  });
});
