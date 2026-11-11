// @vitest-environment jsdom
import {
  transitionObject,
  validateWorkflow,
  WorkflowDefinitionSchema,
  type Concurrency,
  type WorkflowDefinition,
} from '@conductor/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConcurrencyFields } from './ConcurrencyFields.js';
import { describeTransition, normalizeRequires, setRequires } from './transitions.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read at run time, not imported: the deploy image has no docs/ (.dockerignore) and its
// `tsc -b` typechecks tests, so a static import of a docs/ file breaks `pnpm build`.
const V6_DRAFT: unknown = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../../../docs/design/workflows/conductor.v6.draft.json'),
    'utf8',
  ),
);

// ADR-0037 P4 (T7): the "One at a time" section on an agent's transition (`requires.concurrency`),
// round-tripped through validateWorkflow.

afterEach(cleanup);

const V6 = WorkflowDefinitionSchema.parse(V6_DRAFT);
const FROM = 'implementing';
const NAME = 'pr_ready_for_review';

const concOf = (d: WorkflowDefinition): Concurrency | undefined => {
  const s = d.states[FROM]!;
  if (s.type === 'terminal') return undefined;
  return transitionObject(s.on![NAME]!).requires?.concurrency;
};

/** v6 with the PR-ready transition's concurrency removed (the panel starts off). */
function without(): WorkflowDefinition {
  const d = structuredClone(V6);
  const s = d.states[FROM]!;
  if (s.type === 'terminal') throw new Error('agent');
  const r = transitionObject(s.on![NAME]!).requires!;
  return setRequires(d, FROM, NAME, { ...r, concurrency: undefined });
}

/** The fields for v6's PR-ready transition, editing a live copy through setRequires. */
function panel(start: WorkflowDefinition): () => WorkflowDefinition {
  let latest = start;
  function Host() {
    const [def, setDef] = useState(start);
    const s = def.states[FROM]!;
    const r = s.type === 'terminal' ? {} : (transitionObject(s.on![NAME]!).requires ?? {});
    return (
      <ConcurrencyFields
        uid="t"
        definition={def}
        value={r.concurrency}
        onChange={(next) => {
          latest = setRequires(def, FROM, NAME, { ...r, concurrency: next });
          setDef(latest);
        }}
        issues={[]}
      />
    );
  }
  render(<Host />);
  return () => latest;
}

const ok = (d: WorkflowDefinition) => {
  const res = validateWorkflow(d);
  return res.ok ? [] : res.errors.map((e) => `${e.rule} ${e.path.join('.')}: ${e.message}`);
};

describe('ConcurrencyFields (One at a time)', () => {
  it('the v6 draft validates without allowUnavailable (rule 14 lifted by T7)', () => {
    expect(ok(V6)).toEqual([]);
    expect(concOf(V6)).toMatchObject({ key: '$repo', max_in_flight: 1, scope: ['in_review'] });
  });

  it('turning it on adds a valid default; editing it round-trips; turning it off removes it', () => {
    const read = panel(without());
    expect(concOf(read())).toBeUndefined();
    fireEvent.click(screen.getByLabelText(/Hold this move/));
    expect(concOf(read())).toEqual({
      key: '$repo',
      max_in_flight: 1,
      scope: ['in_review'],
      order: 'oldest_first',
      overlap: 'planned_files',
      hold_timeout: '1d',
    });
    expect(ok(read())).toEqual([]);

    fireEvent.change(screen.getByLabelText('Same'), { target: { value: '$repo+$kind' } });
    fireEvent.change(screen.getByLabelText('At most (tickets)'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Wait at most'), { target: { value: '12h' } });
    fireEvent.click(screen.getByLabelText('Needs input'));
    fireEvent.click(screen.getByLabelText(/Only when their planned files overlap/));
    const edited = concOf(read())!;
    expect(edited).toMatchObject({ key: '$repo+$kind', max_in_flight: 2, hold_timeout: '12h' });
    expect([...edited.scope].sort()).toEqual(['in_review', 'needs_input']);
    expect(edited.overlap).toBeUndefined();
    expect(ok(read())).toEqual([]);

    fireEvent.click(screen.getByLabelText(/Hold this move/));
    expect(concOf(read())).toBeUndefined();
    expect(ok(read())).toEqual([]);
  });

  it('a requires with only concurrency is kept, with its poll', () => {
    const conc = concOf(V6)!;
    expect(normalizeRequires({ concurrency: conc, condition_poll: '1m' })).toEqual({
      concurrency: conc,
      condition_poll: '1m',
    });
    expect(normalizeRequires({ condition_poll: '1m' })).toBeUndefined();
  });

  it('shows its problems next to the fields', () => {
    function Host() {
      return (
        <ConcurrencyFields
          uid="t"
          definition={V6}
          value={concOf(V6)}
          onChange={() => {}}
          issues={[{ suffix: '.scope.0', message: 'concurrency scope "x" is not a state' }]}
        />
      );
    }
    render(<Host />);
    expect(screen.getByRole('alert').textContent).toContain('is not a state');
  });
});

describe('describeTransition with a hold (ADR-0037 P4)', () => {
  it('says the move waits its turn first', () => {
    const text = describeTransition(V6, FROM, NAME);
    expect(text).toContain(
      ': wait while 1 other ticket on the repo touching the same files is in In review (at most',
    );
  });
});
