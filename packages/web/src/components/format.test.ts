import type { BoardCard, BoardColumnKind, SessionStatus } from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { cardMeta, STATUS_LABELS, usd } from './format';

describe('usd', () => {
  it('rounds to cents but never shows non-zero spend as $0.00 (TD-080)', () => {
    expect(usd(0)).toBe('$0.00');
    expect(usd(0.0023)).toBe('<$0.01');
    expect(usd(0.01)).toBe('$0.01');
    expect(usd(1.234)).toBe('$1.23');
  });
});

type MetaCard = Pick<BoardCard, 'workflow_state' | 'workflow_id' | 'status' | 'badges'>;
const metaCard = (over: Partial<MetaCard> = {}): MetaCard => ({
  workflow_state: 'some_state',
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
    // FR-1: the state differs from the column, so it stays.
    expect(meta.stateLabel).toBe('some_state');
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
    // A custom title that matches the state name after stateLabel.
    expect(s('ready_to_ship', { id: 'shipping', title: 'Ready to ship', kind: 'human' })).toBe(
      undefined,
    );
    expect(s('implementing', queued)).toBe('implementing');
    // A state the board folds into another column.
    expect(s('qa_command', implementing)).toBe('qa_command');
    expect(s('implementing → build (review)', implementing)).toBe(
      'Reviewing: implementing → build',
    );
    expect(s(null, queued)).toBe('conductor');
  });
});
