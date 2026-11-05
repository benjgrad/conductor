// UXR-88: the Steps rows, from moves + context.
import { BOARD_CARD_FIXTURE, type MoveDto, type SessionDetail } from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { CONDUCTOR } from '../api/mock-data.js';
import { formatDuration, resultMarkdown, steps } from './steps.js';

const at = (min: number) => new Date(Date.UTC(2026, 10, 4, 10, min)).toISOString();
const move = (
  min: number,
  from: string | null,
  to: string,
  transition: string | null,
): MoveDto => ({
  at: at(min),
  from,
  to,
  transition,
  reason: null,
  actor: null,
});

const detail = (
  moves: MoveDto[],
  context: SessionDetail['context'],
  status: SessionDetail['card']['status'] = 'done',
): SessionDetail =>
  ({
    card: { ...BOARD_CARD_FIXTURE, status },
    workflow: CONDUCTOR,
    context,
    moves,
  }) as unknown as SessionDetail;

describe('steps', () => {
  it('has one row per visit, with its title, outcome and duration', () => {
    const rows = steps(
      detail(
        [
          move(0, null, 'planning', null),
          move(5, 'planning', 'implementing', 'done'),
          move(65, 'implementing', 'done', 'done'),
        ],
        { planning: { plan: 'P', summary: 'S' }, __qa: { round: 1 } },
      ),
    );
    expect(rows.map((r) => [r.state, r.durationMs, r.leftAt === null])).toEqual([
      ['planning', 5 * 60_000, false],
      ['implementing', 60 * 60_000, false],
      ['done', null, true],
    ]);
    expect(rows[0]!.title).toBe(CONDUCTOR.states.planning!.title ?? 'Planning');
    expect(rows[0]!.outcome).toBe('Done');
    expect(rows[0]!.result).toEqual({ plan: 'P', summary: 'S' });
    expect(rows[1]!.result).toBeNull();
    expect(rows[2]!.outcome).toBeNull();
  });

  it('times the current step only while the session runs', () => {
    const moves = [move(0, null, 'planning', null)];
    expect(steps(detail(moves, {}, 'running'), Date.parse(at(3)))[0]!.durationMs).toBe(180_000);
    expect(steps(detail(moves, {}, 'needs_input'), Date.parse(at(3)))[0]!.durationMs).toBeNull();
  });

  it('gives a revisited state its result on the last visit only', () => {
    const rows = steps(
      detail(
        [
          move(0, null, 'implementing', null),
          move(5, 'implementing', 'needs_input', 'ask_user'),
          move(6, 'needs_input', 'implementing', null),
        ],
        { implementing: { summary: 'second' } },
        'running',
      ),
    );
    expect(rows.map((r) => [r.visit, r.result, r.replaced])).toEqual([
      [1, null, true],
      [1, null, false],
      [2, { summary: 'second' }, false],
    ]);
    expect(rows[1]!.outcome).toBeNull();
  });

  it('has no rows without moves', () => {
    expect(steps(detail([], { planning: { plan: 'P' } }))).toEqual([]);
  });
});

describe('resultMarkdown', () => {
  it('puts the summary first, then the plan, then other fields by name', () => {
    expect(
      resultMarkdown({
        checks: { build: 'ok' },
        plan: '1. do it',
        summary: 'Did it.',
        proposed_tickets: [{ title: 'More', repo: 'r', why: 'w' }],
        pr_note: 'see PR',
        files: ['a.ts', 'b.ts'],
      }),
    ).toBe(
      [
        'Did it.',
        '**Plan**\n\n1. do it',
        '**Checks**\n\n```json\n{\n  "build": "ok"\n}\n```',
        '**Proposed tickets**\n\n- More (r)',
        '**Pr note**\n\nsee PR',
        '**Files**\n\n- a.ts\n- b.ts',
      ].join('\n\n'),
    );
  });
});

describe('formatDuration', () => {
  it.each([
    [12_000, '12s'],
    [200_000, '3m 20s'],
    [180_000, '3m'],
    [15 * 60_000 + 5_000, '15m'],
    [64 * 60_000, '1h 4m'],
    [120 * 60_000, '2h'],
  ])('%i ms → %s', (ms, text) => expect(formatDuration(ms)).toBe(text));
});
