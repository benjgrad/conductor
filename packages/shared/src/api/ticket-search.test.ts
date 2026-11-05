import { describe, expect, it } from 'vitest';
import { TicketSearchQuerySchema, ticketSearchGroup } from './rest.js';

describe('TicketSearchQuerySchema (UXR-85)', () => {
  it('defaults to every status, 20 per page, from the start', () => {
    expect(TicketSearchQuerySchema.parse({})).toEqual({ status: ['all'], limit: 20, cursor: 0 });
  });

  it('parses a comma-separated status list, deduplicated', () => {
    const q = TicketSearchQuerySchema.parse({ status: 'done,cancelled,done', limit: '5' });
    expect(q.status).toEqual(['done', 'cancelled']);
    expect(q.limit).toBe(5);
  });

  it('trims q, and an empty q is no filter', () => {
    expect(TicketSearchQuerySchema.parse({ q: '  fix  ' }).q).toBe('fix');
    expect(TicketSearchQuerySchema.parse({ q: '   ' }).q).toBeUndefined();
  });

  it('rejects an unknown status, a bad limit or a negative cursor', () => {
    expect(TicketSearchQuerySchema.safeParse({ status: 'nope' }).success).toBe(false);
    expect(TicketSearchQuerySchema.safeParse({ status: '' }).success).toBe(false);
    expect(TicketSearchQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(TicketSearchQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
    expect(TicketSearchQuerySchema.safeParse({ cursor: '-1' }).success).toBe(false);
  });

  it('groups failed tickets with the open ones', () => {
    expect(ticketSearchGroup('failed')).toBe('open');
    expect(ticketSearchGroup('done')).toBe('done');
    expect(ticketSearchGroup('cancelled')).toBe('cancelled');
  });
});
