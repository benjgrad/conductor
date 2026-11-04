import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V4_DEF } from '../workflow/conductor.js';
import {
  capDiff,
  clipValue,
  DIFF_VALUE_CLIP,
  diffRepoChecks,
  diffWorkflow,
  stableJson,
} from './diff.js';

// ADR-0033 P3: the structural diff a change proposal shows. Pure.

const clone = <T>(v: T): T => structuredClone(v);

describe('diffWorkflow', () => {
  it('an identical definition (even with keys reordered, or another version) is no change', () => {
    const def = clone(CONDUCTOR_V4_DEF) as unknown as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(def).reverse());
    expect(diffWorkflow(def, { ...reordered, version: 99 })).toEqual([]);
  });

  it('shows added, removed and changed states and transitions, sorted by path', () => {
    const before = {
      id: 'w',
      start: 'a',
      states: {
        a: { type: 'agent', prompt: 'do it', on: { done: 'b', fail: 'c' } },
        b: { type: 'terminal' },
        c: { type: 'terminal' },
      },
    };
    const after = {
      id: 'w',
      start: 'a',
      states: {
        a: { type: 'agent', prompt: 'do it well', on: { done: { goto: 'b', retries: 2 } } },
        b: { type: 'terminal' },
        d: { type: 'terminal' },
      },
    };
    expect(diffWorkflow(before, after)).toEqual([
      { op: 'change', path: 'states.a.on.done', before: 'b', after: { goto: 'b', retries: 2 } },
      { op: 'remove', path: 'states.a.on.fail', before: 'c' },
      { op: 'change', path: 'states.a.prompt', before: 'do it', after: 'do it well' },
      { op: 'remove', path: 'states.c', before: { type: 'terminal' } },
      { op: 'add', path: 'states.d', after: { type: 'terminal' } },
    ]);
  });

  it('walks into a transition object field by field', () => {
    const t = (retries: number) => ({
      states: { a: { on: { done: { goto: 'b', retries, requires: { checks: [] } } } } },
    });
    expect(diffWorkflow(t(1), t(3))).toEqual([
      { op: 'change', path: 'states.a.on.done.retries', before: 1, after: 3 },
    ]);
  });

  it('clips long values', () => {
    const long = 'x'.repeat(1_000);
    const [c] = diffWorkflow(
      { states: { a: { prompt: 'p' } } },
      { states: { a: { prompt: long } } },
    );
    expect((c!.after as string).length).toBe(DIFF_VALUE_CLIP);
    expect((c!.after as string).endsWith('…')).toBe(true);
  });
});

describe('diffRepoChecks', () => {
  const build = { name: 'build', cmd: 'npm run build' };
  const test = { name: 'test', cmd: 'npm test' };

  it('no override on either side, or the same one, is no change', () => {
    expect(diffRepoChecks(null, null)).toEqual([]);
    expect(diffRepoChecks({ checks: [build] }, { checks: [build] })).toEqual([]);
  });

  it('a new override, and clearing one', () => {
    expect(diffRepoChecks(null, { setup: '', checks: [build] })).toEqual([
      { op: 'add', path: 'checks.build', after: build },
      { op: 'add', path: 'override', after: { setup: '', checks: [build] } },
      { op: 'add', path: 'setup', after: '' },
    ]);
    expect(diffRepoChecks({ checks: [build] }, null)).toEqual([
      { op: 'remove', path: 'checks.build', before: build },
      { op: 'remove', path: 'override', before: { checks: [build] } },
    ]);
  });

  it('matches checks by name: changed command, timeout, a move, an added one', () => {
    const before = { checks: [build, test] };
    const after = {
      checks: [
        { ...test, timeout: '20m' },
        { ...build, cmd: 'pnpm build' },
        { name: 'lint', cmd: 'x' },
      ],
    };
    expect(diffRepoChecks(before, after)).toEqual([
      { op: 'change', path: 'checks.build.cmd', before: 'npm run build', after: 'pnpm build' },
      { op: 'change', path: 'checks.build.position', before: 1, after: 2 },
      { op: 'add', path: 'checks.lint', after: { name: 'lint', cmd: 'x' } },
      { op: 'change', path: 'checks.test.position', before: 2, after: 1 },
      { op: 'add', path: 'checks.test.timeout', after: '20m' },
    ]);
  });
});

describe('helpers', () => {
  it('capDiff keeps the first max and counts the rest', () => {
    const changes = Array.from({ length: 5 }, (_, i) => ({ op: 'add' as const, path: `p${i}` }));
    expect(capDiff(changes, 2)).toEqual({ changes: changes.slice(0, 2), more_changes: 3 });
    expect(capDiff(changes)).toEqual({ changes, more_changes: 0 });
  });

  it('stableJson ignores key order and undefined; clipValue keeps short objects', () => {
    expect(stableJson({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe('{"a":[1,{"d":2}],"b":1}');
    expect(clipValue({ a: 1 })).toEqual({ a: 1 });
    expect(clipValue(3)).toBe(3);
  });
});
