import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema } from './schema.js';
import { validateWorkflow } from './validate.js';

// Ticket "NCNG-2546 Imran": docs/design/workflows/conductor.v9.json is the live v8 (read back with
// get_workflow) plus a human "Done" move on Waiting external, beside Approved. Implementing has no
// route to Done, so a ticket sent back from Waiting external to "call it done" could only take
// ready_for_testing again: rerun the gate and land in Waiting external once more.

type Raw = {
  version: number;
  states: Record<string, { type: string; on?: Record<string, unknown> }>;
};

const v9 = JSON.parse(
  readFileSync(
    new URL('../../../../docs/design/workflows/conductor.v9.json', import.meta.url),
    'utf8',
  ),
) as Raw;

describe('conductor v9 (Waiting external has a Done move)', () => {
  it('parses and passes every rule with no options (as the save path checks it)', () => {
    expect(WorkflowDefinitionSchema.safeParse(v9).error).toBeUndefined();
    const res = validateWorkflow(v9);
    expect(res.ok ? [] : res.errors).toEqual([]);
  });

  it('Waiting external offers a human Done next to Approved and Back to Implementing', () => {
    const on = v9.states.waiting_external!.on!;
    expect(on.done).toEqual({ goto: 'done', title: 'Done', actor: 'human', notify: 'never' });
    expect(on['ui.approve']).toEqual({ goto: 'done', title: 'Approved', notify: 'never' });
    expect(on.back_to_implementing).toMatchObject({ goto: 'implementing', actor: 'human' });
  });

  it('only a human reaches Done: no Implementing transition goes there', () => {
    const on = v9.states.implementing!.on!;
    for (const [name, t] of Object.entries(on)) {
      const goto = typeof t === 'string' ? t : (t as { goto: string }).goto;
      expect(goto, name).not.toBe('done');
    }
  });
});
