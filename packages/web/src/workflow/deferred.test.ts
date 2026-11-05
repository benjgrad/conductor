import { describe, expect, it } from 'vitest';
import {
  isDeferred,
  oldVersionWarning,
  visibleIssues,
  withDeferred,
  withoutDeferred,
  withoutUnder,
} from './deferred.js';

const base = 'states.planning.on.plan_ready.requires';

describe('deferred validation (UXR-71)', () => {
  it('hides problems at and under a new item, not at a sibling with a longer index', () => {
    const d = new Set([`${base}.checks.1`]);
    expect(isDeferred(`${base}.checks.1`, d)).toBe(true);
    expect(isDeferred(`${base}.checks.1.name`, d)).toBe(true);
    expect(isDeferred(`${base}.checks.10.name`, d)).toBe(false);
    expect(isDeferred(`${base}.checks`, d)).toBe(false);
    const issues = [{ path: `${base}.checks.1.cmd` }, { path: `${base}.checks.0.cmd` }];
    expect(visibleIssues(issues, d)).toEqual([{ path: `${base}.checks.0.cmd` }]);
    expect(visibleIssues(issues, new Set())).toEqual(issues);
  });

  it('adds, removes and drops a whole list', () => {
    let d: ReadonlySet<string> = new Set();
    d = withDeferred(d, `${base}.checks.0`);
    d = withDeferred(d, `${base}.checks.1`);
    d = withDeferred(d, `${base}.review.items.0`);
    expect(withDeferred(d, `${base}.checks.0`)).toBe(d);
    expect([...withoutDeferred(d, `${base}.checks.0`)]).toHaveLength(2);
    expect(withoutDeferred(d, 'nope')).toBe(d);
    expect([...withoutUnder(d, `${base}.checks`)]).toEqual([`${base}.review.items.0`]);
    expect(withoutUnder(d, `${base}.conditions`)).toBe(d);
  });
});

describe('oldVersionWarning (UXR-70)', () => {
  it('is null on the latest', () => {
    expect(oldVersionWarning(3, 3, [1, 2, 3])).toBeNull();
  });
  it('names the range of newer versions', () => {
    expect(oldVersionWarning(1, 3, [1, 2, 3])).toBe(
      'This starts from v1: saving undoes the changes in v2–v3.',
    );
  });
  it('names a single newer version', () => {
    expect(oldVersionWarning(2, 3, [1, 2, 3])).toBe(
      'This starts from v2: saving undoes the changes in v3.',
    );
  });
  it('starts the range at the next saved version (gaps allowed)', () => {
    expect(oldVersionWarning(1, 7, [1, 4, 7])).toBe(
      'This starts from v1: saving undoes the changes in v4–v7.',
    );
  });
});
