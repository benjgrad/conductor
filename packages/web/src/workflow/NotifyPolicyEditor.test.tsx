// @vitest-environment jsdom
import { WorkflowDefinitionSchema, type WorkflowDefinition } from '@conductor/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { NotifyPolicyEditor } from './NotifyPolicyEditor.js';

// ADR-0037 P6: the Notifications section's per-transition table.

afterEach(cleanup);

function def(withPolicy: boolean): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    id: 'w',
    version: 1,
    start: 'planning',
    budget: { usd: 1, minutes: 10, max_loop_retries: 1 },
    ...(withPolicy ? { notify: { default: 'once', engine_moves: 'never' } } : {}),
    states: {
      planning: {
        type: 'agent',
        title: 'Planning',
        prompt: 'p',
        on: { plan_ready: { goto: 'review', title: 'Plan ready' } },
      },
      review: {
        type: 'human',
        title: 'Review',
        on: { approve: { goto: 'done', actor: 'human', title: 'Approve', notify: false } },
      },
      done: { type: 'terminal' },
    },
  });
}

function mount(start: WorkflowDefinition, readOnly = false): () => WorkflowDefinition {
  let latest = start;
  function Host() {
    const [d, setD] = useState(start);
    return (
      <NotifyPolicyEditor
        definition={d}
        issues={[]}
        readOnly={readOnly}
        onChange={(next) => {
          latest = next;
          setD(next);
        }}
      />
    );
  }
  render(<Host />);
  fireEvent.click(screen.getByRole('button', { name: /Notifications/ }));
  return () => latest;
}

const select = (name: string) => screen.getByLabelText<HTMLSelectElement>(name);

describe('NotifyPolicyEditor per-transition table', () => {
  it('sets a transition to Never and counts it as silenced', () => {
    const read = mount(def(true));
    expect(screen.getByRole('button', { name: /Notifications/ }).textContent).toContain(
      '1 silenced',
    );
    expect(select('Notify: Planning → Plan ready').value).toBe('');
    fireEvent.change(select('Notify: Planning → Plan ready'), { target: { value: 'never' } });
    expect(read().states.planning).toMatchObject({ on: { plan_ready: { notify: 'never' } } });
    expect(screen.getByRole('button', { name: /Notifications/ }).textContent).toContain(
      '2 silenced',
    );
    expect(screen.getByText('(you)')).toBeTruthy();
  });

  it('offers Once per ticket only under a policy', () => {
    mount(def(false));
    const options = [...select('Notify: Review → Approve').options].map((o) => o.value);
    expect(options).toEqual(['', 'every', 'never']);
    expect(select('Notify: Review → Approve').value).toBe('never');
    expect(screen.getByText(/for Once per ticket/)).toBeTruthy();
  });

  it('read-only disables the selects', () => {
    mount(def(true), true);
    expect(select('Notify: Planning → Plan ready').disabled).toBe(true);
  });
});
