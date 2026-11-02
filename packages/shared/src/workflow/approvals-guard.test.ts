import { describe, expect, it } from 'vitest';
import { approvalsWeakened } from './approvals-guard.js';
import type { WorkflowDefinition } from './schema.js';

// ADR-0030 §Amendment: an MCP save may not remove or bypass a human approval. Pure.

type States = WorkflowDefinition['states'];
const migration = { id: 'migration', label: 'Approve migration', paths: ['**/migrations/**'] };
const merge = {
  goto: 'done',
  actor: 'human' as const,
  requires: { approvals: [migration], actions: ['merge_pr' as const] },
};

const defOf = (on: Record<string, unknown>): { states: States } => ({
  states: {
    ready: { type: 'human', on } as unknown as States[string],
    done: { type: 'terminal' } as unknown as States[string],
  },
});
const PREV = defOf({ merge, send_back: { goto: 'ready', actor: 'human' } });

describe('approvalsWeakened', () => {
  it('is empty when the approvals are kept (keys in any order) or added', () => {
    expect(approvalsWeakened(PREV, PREV)).toEqual([]);
    const reordered = { paths: ['**/migrations/**'], label: 'Approve migration', id: 'migration' };
    const more = { id: 'schema', label: 'Approve schema', paths: ['schema/**'] };
    const next = defOf({
      merge: { ...merge, requires: { ...merge.requires, approvals: [more, reordered] } },
    });
    expect(approvalsWeakened(PREV, next)).toEqual([]);
  });

  it('flags a transition that lost its approvals, or is gone', () => {
    const next = defOf({ merge: { goto: 'done', actor: 'human' } });
    expect(approvalsWeakened(PREV, next)).toEqual(['ready.merge']);
    expect(approvalsWeakened(PREV, defOf({}))).toEqual(['ready.merge']);
    expect(approvalsWeakened(PREV, { states: {} })).toEqual(['ready.merge']);
  });

  it('flags a renamed transition to the same target without the approvals', () => {
    const next = defOf({ ship: { goto: 'done', actor: 'human' } });
    expect(approvalsWeakened(PREV, next)).toEqual(['ready.merge', 'ready.ship']);
  });

  it('flags a new transition to the same target without them, but not one elsewhere', () => {
    const next = defOf({ merge, shortcut: 'done', back: { goto: 'ready', actor: 'human' } });
    expect(approvalsWeakened(PREV, next)).toEqual(['ready.shortcut']);
  });

  it('ignores a previous version without approvals', () => {
    const plain = defOf({ merge: { goto: 'done', actor: 'human' } });
    expect(approvalsWeakened(plain, defOf({}))).toEqual([]);
  });
});
