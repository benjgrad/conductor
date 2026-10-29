import { describe, expect, it } from 'vitest';
import { AGENT_NAMES, fnv1a, hireName, hireOrder } from './names.js';

const TICKET = '3b938add-1fbd-42e4-b9c9-6f065aa66825';

describe('hiring pool (UX-13a)', () => {
  it('has at least 150 unique names', () => {
    expect(AGENT_NAMES.length).toBeGreaterThanOrEqual(150);
    expect(new Set(AGENT_NAMES).size).toBe(AGENT_NAMES.length);
  });

  it('starts from the name web derived from the ticket id', () => {
    const first = AGENT_NAMES[fnv1a(`name:${TICKET}`) % AGENT_NAMES.length];
    expect(hireName(TICKET, new Set())).toBe(first);
    expect(hireOrder(TICKET)[0]).toBe(first);
  });

  it('is deterministic and visits every name once', () => {
    expect(hireOrder(TICKET)).toEqual(hireOrder(TICKET));
    expect(new Set(hireOrder(TICKET)).size).toBe(AGENT_NAMES.length);
  });

  it('skips taken names, walking forward and wrapping around', () => {
    const order = hireOrder(TICKET);
    expect(hireName(TICKET, new Set(order.slice(0, 3)))).toBe(order[3]);
    const start = AGENT_NAMES.indexOf(order[0]!);
    const tail = AGENT_NAMES.slice(start);
    expect(hireName(TICKET, new Set(tail))).toBe(AGENT_NAMES[0]);
  });

  it('is null when the whole pool is taken', () => {
    expect(hireName(TICKET, new Set(AGENT_NAMES))).toBeNull();
  });
});
