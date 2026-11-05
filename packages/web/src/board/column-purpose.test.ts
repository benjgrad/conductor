import { describe, expect, it } from 'vitest';
import { columnPurpose } from './column-purpose.js';

describe('columnPurpose (UXR-54)', () => {
  it.each([
    ['queued', 'queued', 'Tickets waiting for a machine.'],
    ['planning', 'agent', 'Agents plan tickets here.'],
    ['implementing', 'agent', 'Agents do the work here.'],
    ['needs_input', 'human', 'Tickets waiting on you.'],
    ['waiting_external', 'event', 'Waiting on a PR review or CI.'],
    ['done', 'terminal', 'Finished tickets.'],
  ] as const)('the conductor column %s', (id, kind, text) => {
    expect(columnPurpose({ id, kind })).toBe(text);
  });

  it.each([
    ['agent', 'An agent works on tickets here.'],
    ['command', 'Checks run here.'],
    ['event', 'Waiting on something outside conductor.'],
    ['connector', 'Waiting on another service.'],
    ['human', 'Tickets waiting on you.'],
    ['terminal', 'Finished tickets.'],
  ] as const)('another workflow falls back by kind: %s', (kind, text) => {
    expect(columnPurpose({ id: 'my_state', kind })).toBe(text);
  });

  it('ignores inherited keys', () => {
    expect(columnPurpose({ id: 'toString', kind: 'agent' })).toBe('An agent works on tickets here.');
  });

  it('every line is short enough for a column', () => {
    for (const kind of ['agent', 'command', 'event', 'connector', 'human', 'terminal'] as const) {
      expect(columnPurpose({ id: 'x', kind }).length).toBeLessThanOrEqual(45);
    }
  });
});
