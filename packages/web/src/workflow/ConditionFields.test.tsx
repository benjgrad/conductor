// @vitest-environment jsdom
import { CONDUCTOR_V2_DRAFT_DEF, validateWorkflow, type Condition } from '@conductor/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConditionRow } from './ConditionFields.js';

// ADR-0037 T5: the designer's fields for the new condition types and the no-CI policy select.

afterEach(cleanup);

/** validateWorkflow's errors (the v2 draft's own rule-17 one is the baseline). */
const errs = (d: unknown) => {
  const res = validateWorkflow(d);
  return res.ok ? [] : res.errors;
};
const BASE = errs(CONDUCTOR_V2_DRAFT_DEF);

/** Render one row; returns the last condition passed to onChange. */
function row(condition: Condition) {
  const seen: Condition[] = [];
  render(
    <ul>
      <ConditionRow
        condition={condition}
        i={0}
        n={1}
        onChange={(c) => seen.push(c)}
        onMove={() => undefined}
        onRemove={() => undefined}
        issuesAt={() => null}
      />
    </ul>,
  );
  return seen;
}

/** The one path these tests edit. */
interface Raw {
  states: {
    implementing: { on: { ready_for_testing: { requires: { conditions: Condition[] } } } };
  };
}

/** The v2 draft with ready_for_testing's checks condition replaced by `c`. */
function v2With(c: Condition) {
  const d = structuredClone(CONDUCTOR_V2_DRAFT_DEF) as unknown as Raw;
  const conds = d.states.implementing.on.ready_for_testing.requires.conditions;
  const i = conds.findIndex((x) => x.type === 'pr_checks_green');
  conds[i] = c;
  return d;
}

describe('ConditionRow (ADR-0037 T5)', () => {
  it('the no-CI policy select writes no_checks and drops the legacy no_checks_after', () => {
    const seen = row({ type: 'pr_checks_green', no_checks_after: '5m' });
    const select = screen.getByLabelText<HTMLSelectElement>('Condition 1 no CI policy');
    expect(select.value).toBe('pass');
    fireEvent.change(select, { target: { value: 'require_mergeable' } });
    const next = seen.at(-1)!;
    expect(next).toEqual({
      type: 'pr_checks_green',
      no_checks: { policy: 'require_mergeable', after: '5m' },
    });
    expect(errs(v2With(next))).toEqual(BASE);
  });

  it('clearing the duration removes the no-CI rule', () => {
    const seen = row({ type: 'pr_checks_green', no_checks: { policy: 'fail', after: '5m' } });
    fireEvent.change(screen.getByLabelText('Condition 1 no CI after'), { target: { value: '' } });
    expect(seen.at(-1)).toEqual({ type: 'pr_checks_green' });
  });

  it('a cmd edits its name, command, timeout and needs; the result validates', () => {
    let c: Condition = { type: 'cmd', name: 'Command', cmd: 'true', needs: 'setup' };
    const edits: [string, string][] = [
      ['Condition 1 name', 'Merges cleanly'],
      ['Condition 1 command', 'git merge-tree --write-tree origin/main HEAD'],
      ['Condition 1 timeout', '2m'],
      ['Condition 1 needs', 'checkout'],
    ];
    for (const [label, value] of edits) {
      const seen = row(c);
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
      c = seen.at(-1)!;
      cleanup();
    }
    expect(c).toEqual({
      type: 'cmd',
      name: 'Merges cleanly',
      cmd: 'git merge-tree --write-tree origin/main HEAD',
      timeout: '2m',
      needs: 'checkout',
    });
    const d = v2With({ type: 'pr_checks_green' });
    d.states.implementing.on.ready_for_testing.requires.conditions.push(c, {
      type: 'pr_mergeable',
    });
    expect(errs(d)).toEqual(BASE);
  });

  it('pr_mergeable reads as a sentence; age_below edits its max', () => {
    row({ type: 'pr_mergeable' });
    expect(screen.getByText('PR merges cleanly (GitHub)')).toBeTruthy();
    cleanup();
    const seen = row({ type: 'age_below', max: '2h' });
    fireEvent.change(screen.getByLabelText('Condition 1 max'), { target: { value: '30m' } });
    expect(seen.at(-1)).toEqual({ type: 'age_below', max: '30m' });
  });
});
