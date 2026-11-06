// @vitest-environment jsdom
import {
  validateWorkflow,
  WorkflowDefinitionSchema,
  type Watch,
  type WorkflowDefinition,
} from '@conductor/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { setWatch, watchOfColumn } from './columns.js';
import { WatchFields } from './WatchFields.js';

// ADR-0037 P1 (T6): the "While here, keep checking" panel on a human or event column.

afterEach(cleanup);

// Read at run time, not imported: the deploy image's build context has no docs/ (.dockerignore),
// and `tsc -b` there typechecks this file, so a static import of the draft breaks `pnpm build`.
const V6_DRAFT: unknown = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../../../docs/design/workflows/conductor.v6.draft.json'),
    'utf8',
  ),
);
const V6 = WorkflowDefinitionSchema.parse(V6_DRAFT);

/** v6 without the T7 concurrency (not available yet), so it validates without allowUnavailable. */
function v6(): WorkflowDefinition {
  const d = structuredClone(V6);
  for (const s of Object.values(d.states)) {
    if (s.type === 'terminal') continue;
    for (const t of Object.values(s.on ?? {})) {
      if (typeof t === 'object' && t.requires?.concurrency) delete t.requires.concurrency;
    }
  }
  return d;
}

/** The panel for `state`, editing a live copy; returns a reader for the latest definition. */
function panel(start: WorkflowDefinition, state: string): () => WorkflowDefinition {
  let latest = start;
  function Host() {
    const [def, setDef] = useState(start);
    return (
      <WatchFields
        uid="t"
        definition={def}
        state={state}
        onChange={(next) => {
          latest = next;
          setDef(next);
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

describe('WatchFields', () => {
  it('v6 without concurrency validates (the base for these tests)', () => {
    expect(ok(v6())).toEqual([]);
  });

  it('the v6 in_review and needs_input watches render and are left as they are', () => {
    const d = v6();
    panel(d, 'in_review');
    expect(screen.getByRole('checkbox', { name: /Keep checking/ })).toHaveProperty('checked', true);
    expect(screen.getByLabelText('Back to')).toHaveProperty('value', 'implementing');
    expect(screen.getByLabelText('Up to (times)')).toHaveProperty('value', '3');
    expect(screen.getByRole('checkbox', { name: /Come back to In review/ })).toHaveProperty(
      'checked',
      true,
    );
    cleanup();
    panel(d, 'needs_input');
    expect(screen.getByRole('radio', { name: 'Notify me' })).toHaveProperty('checked', true);
    expect(screen.getByText(/once per stay/)).toBeTruthy();
  });

  it('turning it on, adding a condition, setting every field: valid, and round-trips', () => {
    const base = setWatch(v6(), 'in_review', null);
    const read = panel(base, 'in_review');
    fireEvent.click(screen.getByRole('checkbox', { name: /Keep checking/ }));
    expect(watchOfColumn(read(), 'in_review')).toMatchObject({
      conditions: [{ type: 'pr_mergeable' }],
      on_broken: { goto: 'implementing', retries: 2, else: 'needs_input' },
    });
    fireEvent.change(screen.getByLabelText('Add watched condition'), {
      target: { value: 'cmd' },
    });
    fireEvent.change(screen.getByLabelText('Check every'), { target: { value: '5m' } });
    fireEvent.change(screen.getByLabelText('Up to (times)'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Come back to In review/ }));
    const w = watchOfColumn(read(), 'in_review')!;
    expect(w).toMatchObject({
      poll: '5m',
      conditions: [{ type: 'pr_mergeable' }, { type: 'cmd' }],
      on_broken: { goto: 'implementing', retries: 3, return_to: '$self', else: 'needs_input' },
    });
    expect(ok(read())).toEqual([]);
    // Through JSON (what a save sends) and back: the same watch.
    const again = WorkflowDefinitionSchema.parse(JSON.parse(JSON.stringify(read())));
    expect(watchOfColumn(again, 'in_review')).toEqual(w);
  });

  it('"Notify me" is the escalate form; back to "Send it back" restores a move', () => {
    const read = panel(v6(), 'in_review');
    fireEvent.click(screen.getByRole('radio', { name: 'Notify me' }));
    expect(watchOfColumn(read(), 'in_review')!.on_broken).toEqual({ notify: 'escalate' });
    expect(ok(read())).toEqual([]);
    fireEvent.click(screen.getByRole('radio', { name: 'Send it back' }));
    expect((watchOfColumn(read(), 'in_review')!.on_broken as { goto: string }).goto).toBe(
      'implementing',
    );
  });

  it('age_below is offered here (only allowed in a watch) and turning it off removes the watch', () => {
    const read = panel(v6(), 'needs_input');
    const options = within(screen.getByLabelText('Add watched condition'))
      .getAllByRole('option')
      .map((o) => o.getAttribute('value'));
    expect(options).toContain('age_below');
    fireEvent.click(screen.getByRole('checkbox', { name: /Keep checking/ }));
    expect(watchOfColumn(read(), 'needs_input')).toBeNull();
    const w: Watch | undefined = (read().states.needs_input as { watch?: Watch }).watch;
    expect(w).toBeUndefined();
  });
});
