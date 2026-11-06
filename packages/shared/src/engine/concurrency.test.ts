import { describe, expect, it } from 'vitest';
import { ConcurrencySchema } from '../workflow/schema.js';
import {
  filesOverlap,
  globsOverlap,
  heldVerdict,
  holdersOf,
  sessionPlannedFiles,
  shortTicketId,
  type HolderCandidate,
} from './concurrency.js';
import { MOVE_STEP_FIXTURE } from './fixtures.js';
import type { GateStep } from './types.js';

// ADR-0037 P4 (T7): the pure parts of `requires.concurrency`.

const conc = (extra: Record<string, unknown> = {}) =>
  ConcurrencySchema.parse({
    key: '$repo',
    max_in_flight: 1,
    scope: ['in_review'],
    overlap: 'planned_files',
    hold_timeout: '1d',
    ...extra,
  });

const T = (min: number) => new Date(Date.UTC(2026, 10, 6, 12, min)).toISOString();

const step = (over: Partial<GateStep>): GateStep => ({
  ...MOVE_STEP_FIXTURE,
  to: 'in_review',
  ...over,
});

const cand = (id: string, over: Partial<HolderCandidate> = {}): HolderCandidate => ({
  session_id: id,
  ticket_id: `t-${id}`,
  kind: null,
  workflow_state: 'in_review',
  step: null,
  files: ['src/a.ts'],
  ...over,
});

const self = { session_id: 'me', kind: null, files: ['src/**'], started_at: T(10) };

describe('globsOverlap', () => {
  it.each([
    ['src/a.ts', 'src/a.ts', true],
    ['src/**', 'src/web/App.tsx', true],
    ['src/web/App.tsx', 'src/**', true],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/web/a.ts', false],
    ['src/a.ts', 'src/b.ts', false],
    ['packages/web/**', 'packages/daemon/**', false],
    ['packages/*/src/a.ts', 'packages/web/**', true],
    ['docs/**', 'packages/**', false],
    ['**/*.md', 'packages/**', true],
  ])('%s vs %s → %s', (a, b, want) => {
    expect(globsOverlap(a, b)).toBe(want);
    expect(globsOverlap(b, a)).toBe(want);
  });
});

describe('filesOverlap: no evidence, no claim', () => {
  it('null or empty on either side is no overlap', () => {
    expect(filesOverlap(null, ['a'])).toBe(false);
    expect(filesOverlap(['a'], undefined)).toBe(false);
    expect(filesOverlap([], ['a'])).toBe(false);
    expect(filesOverlap(['a', 'b/**'], ['c', 'b/x.ts'])).toBe(true);
  });
});

describe('sessionPlannedFiles', () => {
  it("reads the planning state's files; null without a plan or without files", () => {
    expect(
      sessionPlannedFiles({ planning: { plan: '# P', files: ['a.ts', 'a.ts'] } }, null),
    ).toEqual(['a.ts']);
    expect(sessionPlannedFiles({ planning: { plan: '# P' } }, null)).toBeNull();
    expect(sessionPlannedFiles({ implementing: { summary: 'x' } }, null)).toBeNull();
    expect(sessionPlannedFiles({ planning: { plan: '# P', files: ['../x'] } }, null)).toBeNull();
  });
});

describe('holdersOf', () => {
  it('a session in a scope state holds; out of scope or itself does not', () => {
    const got = holdersOf(self, conc(), [
      cand('a'),
      cand('b', { workflow_state: 'implementing' }),
      cand('me'),
    ]);
    expect(got.map((c) => c.session_id)).toEqual(['a']);
  });

  it('a released move on its way into scope holds; one into another state does not', () => {
    const got = holdersOf(self, conc(), [
      cand('a', { workflow_state: 'x', step: step({ phase: 'checks', started_at: T(20) }) }),
      cand('b', { workflow_state: 'x', step: step({ phase: 'checks', to: 'needs_input' }) }),
    ]);
    expect(got.map((c) => c.session_id)).toEqual(['a']);
  });

  it('oldest first: an older held move holds, a younger one does not', () => {
    const got = holdersOf(self, conc(), [
      cand('older', { workflow_state: 'x', step: step({ phase: 'held', started_at: T(5) }) }),
      cand('younger', { workflow_state: 'x', step: step({ phase: 'held', started_at: T(15) }) }),
    ]);
    expect(got.map((c) => c.session_id)).toEqual(['older']);
  });

  it('two held moves never wait on each other (tie broken by session id)', () => {
    const a = cand('a', { workflow_state: 'x', step: step({ phase: 'held', started_at: T(10) }) });
    const z = cand('z', { workflow_state: 'x', step: step({ phase: 'held', started_at: T(10) }) });
    const meA = { ...self, session_id: 'a' };
    const meZ = { ...self, session_id: 'z' };
    expect(holdersOf(meA, conc(), [z])).toEqual([]);
    expect(holdersOf(meZ, conc(), [a]).map((c) => c.session_id)).toEqual(['a']);
  });

  it('planned_files: only intersecting lists; a side without files never holds or is held', () => {
    expect(holdersOf(self, conc(), [cand('a', { files: ['docs/x.md'] })])).toEqual([]);
    expect(holdersOf(self, conc(), [cand('a', { files: null })])).toEqual([]);
    expect(holdersOf({ ...self, files: null }, conc(), [cand('a')])).toEqual([]);
  });

  it('without overlap, the key alone holds (files ignored)', () => {
    const c = conc({ overlap: undefined });
    expect(holdersOf({ ...self, files: null }, c, [cand('a', { files: null })])).toHaveLength(1);
  });

  it('$repo+$kind also compares the kind', () => {
    const c = conc({ key: '$repo+$kind' });
    const me = { ...self, kind: 'work' };
    const got = holdersOf(me, c, [cand('a', { kind: 'work' }), cand('b', { kind: 'personal' })]);
    expect(got.map((x) => x.session_id)).toEqual(['a']);
  });

  it('sorted oldest first', () => {
    const got = holdersOf(self, conc({ max_in_flight: 3 }), [
      cand('b', { workflow_state: 'x', step: step({ phase: 'checks', started_at: T(8) }) }),
      cand('a', { workflow_state: 'x', step: step({ phase: 'checks', started_at: T(2) }) }),
    ]);
    expect(got.map((x) => x.session_id)).toEqual(['a', 'b']);
  });
});

describe('heldVerdict', () => {
  const hold = { deadline: T(60) };
  it('below max releases; at max holds until the deadline, then times out', () => {
    expect(heldVerdict({ max_in_flight: 1 }, [], new Date(T(70)), hold)).toBe('release');
    expect(heldVerdict({ max_in_flight: 2 }, [1], new Date(T(10)), hold)).toBe('release');
    expect(heldVerdict({ max_in_flight: 1 }, [1], new Date(T(10)), hold)).toBe('hold');
    expect(heldVerdict({ max_in_flight: 1 }, [1, 2], new Date(T(60)), hold)).toBe('timeout');
  });

  it('short ticket ids are the first 8 characters', () => {
    expect(shortTicketId('abcd1234-0000-4000-8000-000000000000')).toBe('abcd1234');
  });
});
