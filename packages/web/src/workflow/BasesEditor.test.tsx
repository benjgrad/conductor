// @vitest-environment jsdom
import {
  AVAILABLE_WORKFLOW_FEATURES,
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
} from '@conductor/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import V7_DRAFT from '../../../../docs/design/workflows/conductor.v7.draft.json';
import { BasesEditor } from './BasesEditor.js';
import { issueAt, validateColumns } from './columns.js';

// ADR-0039 (B3, FR-3): the designer's Bases section, on the v7 draft.

afterEach(cleanup);

const V7 = WorkflowDefinitionSchema.parse(V7_DRAFT);
const ON = [...AVAILABLE_WORKFLOW_FEATURES, 'bases' as const];

function Harness({
  start,
  features = ON,
  queuedUses = {},
  onDef,
}: {
  start: WorkflowDefinition;
  features?: typeof AVAILABLE_WORKFLOW_FEATURES;
  queuedUses?: Record<string, number>;
  onDef?: (d: WorkflowDefinition) => void;
}) {
  const [def, setDef] = useState(start);
  return (
    <BasesEditor
      definition={def}
      issues={validateColumns(def, features)}
      queuedUses={queuedUses}
      features={features}
      onChange={(d) => {
        setDef(d);
        onDef?.(d);
      }}
    />
  );
}

const open = () => fireEvent.click(screen.getByRole('button', { name: /Bases \(/ }));
const rowOf = (name: string) =>
  screen
    .getAllByLabelText<HTMLInputElement>('Name')
    .find((i) => i.value === name)!
    .closest('li') as HTMLElement;

describe('BasesEditor (ADR-0039, B3)', () => {
  it('lists the bases with their mode, the per-kind defaults, and the pr_into warning', () => {
    render(<Harness start={structuredClone(V7)} />);
    open();
    expect(screen.getByRole('button', { name: 'Bases (4)' })).toBeTruthy();
    const sprint = rowOf('sprint');
    expect(within(sprint).getByRole<HTMLInputElement>('radio', { name: 'A command' }).checked).toBe(
      true,
    );
    expect(within(sprint).getByText(/Warning: .*without pr_into/)).toBeTruthy();
    expect(within(rowOf('master')).getByLabelText<HTMLInputElement>('Branch').value).toBe('master');
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Work' }).value).toBe('sprint');
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Personal' }).value).toBe(
      'default',
    );
    expect(screen.queryByText(/Not available yet/)).toBeNull();
  });

  it('add, rename (the default follows) and delete', () => {
    let last: WorkflowDefinition = V7;
    render(<Harness start={structuredClone(V7)} onDef={(d) => (last = d)} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Add base' }));
    expect(Object.keys(last.bases!)).toContain('base');
    const name = within(rowOf('sprint')).getByLabelText('Name');
    fireEvent.change(name, { target: { value: 'sprint-latest' } });
    fireEvent.blur(name);
    expect(last.base_default).toEqual({ work: 'sprint-latest', personal: 'default' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete base master' }));
    expect(Object.keys(last.bases!)).toEqual(['default', 'sprint-latest', 'hotfix', 'base']);
  });

  it('refuses deleting a base a default or a queued ticket names, with the reason', () => {
    render(<Harness start={structuredClone(V7)} queuedUses={{ sprint: 2, hotfix: 1 }} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Delete base sprint' }));
    expect(within(rowOf('sprint')).getByRole('alert').textContent).toBe(
      'Can’t delete “sprint”: it is the default for work tickets, and 2 queued tickets use it.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete base hotfix' }));
    expect(within(rowOf('hotfix')).getByRole('alert').textContent).toMatch(
      /1 queued ticket uses it/,
    );
  });

  it('switching to a command shows its timeout and PR target; an empty one is a problem', () => {
    render(<Harness start={structuredClone(V7)} />);
    open();
    const master = rowOf('master');
    fireEvent.click(within(master).getByRole('radio', { name: 'A command' }));
    expect(within(master).getByLabelText('Timeout')).toBeTruthy();
    expect(within(master).getByLabelText('PR into')).toBeTruthy();
    expect(within(master).getByText(/the command is empty/)).toBeTruthy();
  });

  it('a default naming no base shows rule 26 inline', () => {
    const d = structuredClone(V7);
    d.base_default = { work: 'nope' };
    render(
      <BasesEditor
        definition={d}
        issues={[issueAt(d, 'base_default.work', 'rule 26: base "nope" is not in bases')]}
        features={ON}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('rule 26: base "nope" is not in bases');
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Work' }).value).toBe('nope');
  });

  it('while bases are not available: says so, and rule 14 shows on the rows', () => {
    render(<Harness start={structuredClone(V7)} features={AVAILABLE_WORKFLOW_FEATURES} />);
    expect(screen.getByText(/Not available yet/)).toBeTruthy();
    expect(screen.getAllByText(/bases are not available yet/).length).toBeGreaterThan(0);
  });
});
