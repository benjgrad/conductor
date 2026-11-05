import type { BoardCard, BoardColumnKind, SessionStatus } from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { cardMeta, humanize, panelStatusLabel, STATUS_LABELS, usd } from './format';

describe('usd', () => {
  it('rounds to cents but never shows non-zero spend as $0.00 (TD-080)', () => {
    expect(usd(0)).toBe('$0.00');
    expect(usd(0.0023)).toBe('<$0.01');
    expect(usd(0.01)).toBe('$0.01');
    expect(usd(1.234)).toBe('$1.23');
  });
});

type MetaCard = Pick<
  BoardCard,
  'workflow_state' | 'workflow_id' | 'status' | 'badges' | 'state_title' | 'checking' | 'pending'
>;
const metaCard = (over: Partial<MetaCard> = {}): MetaCard => ({
  workflow_state: 'some_state',
  state_title: null,
  checking: null,
  pending: null,
  workflow_id: 'conductor',
  status: 'running',
  badges: [],
  ...over,
});

describe('cardMeta (UX card cleanup)', () => {
  const KINDS: BoardColumnKind[] = [
    'queued',
    'agent',
    'command',
    'event',
    'connector',
    'human',
    'terminal',
  ];
  const STATUSES = [...(Object.keys(STATUS_LABELS) as SessionStatus[]), null];
  // FR-2: the statuses a column of each kind already says.
  const IMPLIED: Record<BoardColumnKind, SessionStatus[]> = {
    queued: ['queued'],
    agent: ['running'],
    command: ['running'],
    connector: ['running'],
    event: ['waiting_external'],
    human: ['needs_input'],
    terminal: [],
  };
  const cases = KINDS.flatMap((kind) => STATUSES.map((status) => [kind, status] as const));

  it.each(cases)('FR-2: a %s column, status %s', (kind, status) => {
    const column = { id: `col_${kind}`, title: `Col ${kind}`, kind };
    const meta = cardMeta(metaCard({ status }), column);
    // FR-1: the state differs from the column, so it stays, in words (UXR-30).
    expect(meta.stateLabel).toBe('Some state');
    if (status === null) {
      expect(meta.statusLabel).toBeUndefined();
      expect(meta.srStatusLabel).toBeUndefined();
    } else if (IMPLIED[kind].includes(status)) {
      expect(meta.statusLabel).toBeUndefined();
      expect(meta.srStatusLabel).toBe(STATUS_LABELS[status]);
    } else {
      expect(meta.statusLabel).toBe(STATUS_LABELS[status]);
      expect(meta.srStatusLabel).toBeUndefined();
    }
  });

  it('FR-4: a failed / lost pill is dropped when the same badge says it', () => {
    const done = { id: 'done', title: 'Done', kind: 'terminal' as const };
    for (const status of ['failed', 'lost'] as const) {
      const meta = cardMeta(metaCard({ status, badges: [status] }), done);
      expect(meta.statusLabel).toBeUndefined();
      expect(meta.srStatusLabel).toBeUndefined();
    }
    expect(cardMeta(metaCard({ status: 'failed' }), done).statusLabel).toBe('failed');
  });

  it('FR-1: the state is hidden only when it is the column', () => {
    const needsInput = { id: 'needs_input', title: 'Needs input', kind: 'human' as const };
    const implementing = { id: 'implementing', title: 'Implementing', kind: 'agent' as const };
    const queued = { id: 'queued', title: 'Queued', kind: 'queued' as const };
    const s = (workflow_state: string | null, col: Parameters<typeof cardMeta>[1]) =>
      cardMeta(metaCard({ workflow_state }), col).stateLabel;
    expect(s('needs_input', needsInput)).toBeUndefined();
    // A custom title that matches the state name in words.
    expect(s('ready_to_ship', { id: 'shipping', title: 'Ready to ship', kind: 'human' })).toBe(
      undefined,
    );
    expect(s('implementing', queued)).toBe('Implementing');
    // A state the board folds into another column.
    expect(s('qa_command', implementing)).toBe('Qa command');
    expect(s('implementing → build (review)', implementing)).toBe(
      'Reviewing: Implementing → Build',
    );
  });

  it("UXR-30: the workflow's title, never an engine id", () => {
    const implementing = { id: 'implementing', title: 'Implementing', kind: 'agent' as const };
    const meta = (over: Partial<MetaCard>) => cardMeta(metaCard(over), implementing).stateLabel;
    expect(meta({ workflow_state: 'await_approval', state_title: 'Waiting for sign-off' })).toBe(
      'Waiting for sign-off',
    );
    // A title equal to the column's is not repeated.
    expect(meta({ workflow_state: 'implement', state_title: 'Implementing' })).toBeUndefined();
    // A synthetic gate-step label never shows, with or without its step.
    expect(
      meta({ workflow_state: 'implementing → waiting_external (move: ready_for_testing)' }),
    ).toBeUndefined();
    const pending = { transition: 'x', to: 'done', title: 'Done', items: [], note: null };
    expect(meta({ workflow_state: 'build', pending })).toBeUndefined();
    const checking = { to: 'done', title: 'Done', phase: 'checks' as const };
    expect(meta({ workflow_state: 'build', checking })).toBeUndefined();
    for (const state of ['await_approval', 'qa_command', 'needs_more_input']) {
      expect(meta({ workflow_state: state })).not.toContain('_');
    }
  });

  it('UXR-30: the workflow is named only when the board mixes workflows', () => {
    const queued = { id: 'queued', title: 'Queued', kind: 'queued' as const };
    const card = metaCard({ workflow_state: null, workflow_id: 'pr_flow', status: null });
    expect(cardMeta(card, queued).stateLabel).toBeUndefined();
    expect(cardMeta(card, queued, { showWorkflow: true }).stateLabel).toBe('Pr flow');
    const implementing = { id: 'implementing', title: 'Implementing', kind: 'agent' as const };
    expect(
      cardMeta(metaCard({ workflow_id: 'pr_flow', state_title: 'Build' }), implementing, {
        showWorkflow: true,
      }).stateLabel,
    ).toBe('Pr flow · Build');
  });
});

describe('humanize', () => {
  it('an engine id in words', () => {
    expect(humanize('await_approval')).toBe('Await approval');
    expect(humanize('conductor')).toBe('Conductor');
  });
});

describe('panelStatusLabel (UXR-40: one chip, in titles)', () => {
  const workflow = {
    states: { needs_input: { title: 'Needs input' }, ready_for_testing: { title: 'QA' } },
  } as never;

  it("the state's title, never the status beside it", () => {
    expect(panelStatusLabel('needs_input', 'needs_input', workflow)).toBe('Needs input');
    expect(panelStatusLabel('done', 'done', workflow)).toBe('Done');
    expect(panelStatusLabel('await_approval', 'needs_input')).toBe('Await approval');
  });

  it('a gate step in words; failed / lost added; no state → the status', () => {
    expect(
      panelStatusLabel('implementing → ready_for_testing (move: ship)', 'running', workflow),
    ).toBe('Checks before QA');
    expect(panelStatusLabel('implementing', 'failed', workflow)).toBe('Implementing · failed');
    expect(panelStatusLabel(null, 'queued')).toBe('Queued');
    expect(panelStatusLabel(null, null)).toBeNull();
  });
});
