import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V4_DEF } from '../workflow/conductor.js';
import {
  proposalLimitsOf,
  proposalId,
  proposalsOfContext,
  proposalTicketBody,
  withDecisions,
} from './proposals.js';
import { SessionDetailSchema, TicketDetailSchema } from './rest.js';

const good = { title: 'Speed up CI', repo: 'github.com/acme/app', why: 'Builds take 20 minutes.' };

describe('proposalsOfContext', () => {
  it('reads valid entries from every result, with a stable id and the state', () => {
    const ps = proposalsOfContext({
      planning: { plan: 'x', proposed_tickets: [good] },
      implementing: {
        summary: 'y',
        proposed_tickets: [{ title: 'Docs', repo: 'github.com/acme/app', why: 'Out of date' }],
      },
    });
    expect(ps).toEqual([
      { id: proposalId('planning', good.title, good.repo), state: 'planning', ...good },
      {
        id: proposalId('implementing', 'Docs', 'github.com/acme/app'),
        state: 'implementing',
        title: 'Docs',
        repo: 'github.com/acme/app',
        why: 'Out of date',
      },
    ]);
  });

  it('absent proposed_tickets: none, nothing else read', () => {
    expect(proposalsOfContext({ planning: { plan: 'x', summary: 'y' } })).toEqual([]);
    expect(proposalsOfContext({})).toEqual([]);
    expect(proposalsOfContext(null)).toEqual([]);
  });

  it('drops malformed entries quietly and keeps the good ones', () => {
    const ps = proposalsOfContext({
      planning: {
        proposed_tickets: [
          { title: 'no why', repo: 'r' },
          { title: 42, repo: 'r', why: 'w' },
          { title: '  ', repo: 'r', why: 'w' },
          'a string',
          null,
          [good],
          good,
        ],
      },
      a: { proposed_tickets: 'not an array' },
      b: { proposed_tickets: good },
      c: { proposed_tickets: null },
    });
    expect(ps.map((p) => p.title)).toEqual([good.title]);
  });

  it('trims fields', () => {
    const [p] = proposalsOfContext({
      s: { proposed_tickets: [{ title: ' T ', repo: ' r ', why: ' w ' }] },
    });
    expect(p).toMatchObject({ title: 'T', repo: 'r', why: 'w' });
  });

  it('reads at most three per state', () => {
    const many = [1, 2, 3, 4, 5].map((n) => ({ ...good, title: `T${n}` }));
    const ps = proposalsOfContext({ planning: { proposed_tickets: many } });
    expect(ps.map((p) => p.title)).toEqual(['T1', 'T2', 'T3']);
  });

  it('skips conductor bookkeeping and, given agent states, other keys', () => {
    const ctx = {
      __qa: { proposed_tickets: [good] },
      planning: { proposed_tickets: [good] },
      gate: { proposed_tickets: [{ ...good, title: 'from a gate' }] },
    };
    expect(proposalsOfContext(ctx).map((p) => p.state)).toEqual(['planning', 'gate']);
    expect(proposalsOfContext(ctx, new Map([['planning', 3]])).map((p) => p.state)).toEqual([
      'planning',
    ]);
  });

  it('reads each state up to its limit; a limit of 0 reads nothing (ADR-0034)', () => {
    const many = [1, 2, 3, 4, 5].map((n) => ({ ...good, title: `T${n}` }));
    const ctx = { planning: { proposed_tickets: many }, implementing: { proposed_tickets: many } };
    const limits = new Map([
      ['planning', 5],
      ['implementing', 0],
    ]);
    expect(proposalsOfContext(ctx, limits).map((p) => `${p.state}:${p.title}`)).toEqual(
      many.map((m) => `planning:${m.title}`),
    );
  });

  it('keeps a duplicate once', () => {
    const ps = proposalsOfContext({ planning: { proposed_tickets: [good, good] } });
    expect(ps).toHaveLength(1);
  });
});

describe('proposalId', () => {
  it('is 16 hex, deterministic, and differs by state, title and repo', () => {
    const id = proposalId('planning', 'T', 'r');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(proposalId('planning', 'T', 'r')).toBe(id);
    expect(proposalId('implementing', 'T', 'r')).not.toBe(id);
    expect(proposalId('planning', 'T2', 'r')).not.toBe(id);
    expect(proposalId('planning', 'T', 'r2')).not.toBe(id);
    // The fields are hashed as a JSON array: "a\nb" + "c" is not "a" + "b\nc".
    expect(proposalId('s', 'a\nb', 'c')).not.toBe(proposalId('s', 'a', 'b\nc'));
  });

  it('known value: FNV-1a 64 of the JSON array (pins the algorithm across node and browsers)', () => {
    let h = 0xcbf29ce484222325n;
    for (const b of new TextEncoder().encode('["","",""]'))
      h = ((h ^ BigInt(b)) * 0x100000001b3n) & ((1n << 64n) - 1n);
    expect(proposalId('', '', '')).toBe(h.toString(16).padStart(16, '0'));
  });
});

describe('proposalLimitsOf', () => {
  it('lists the conductor workflow agent states only, 3 each while follow_ups is unset', () => {
    const s = proposalLimitsOf(CONDUCTOR_V4_DEF);
    expect(s.get('planning')).toBe(3);
    expect(s.get('implementing')).toBe(3);
    expect(s.has('needs_input')).toBe(false);
  });

  it('follow_ups sets the limit: max when on, 0 when off (ADR-0034)', () => {
    const def = structuredClone(CONDUCTOR_V4_DEF);
    const agent = (name: string) => {
      const st = def.states[name]!;
      if (st.type !== 'agent') throw new Error(name);
      return st;
    };
    agent('planning').follow_ups = { enabled: false, max: 3 };
    agent('implementing').follow_ups = { enabled: true, max: 7 };
    const s = proposalLimitsOf(def);
    expect(s.get('planning')).toBe(0);
    expect(s.get('implementing')).toBe(7);
  });
});

describe('withDecisions / proposalTicketBody', () => {
  it('no decision is pending; decisions carry their status and ticket', () => {
    const ps = proposalsOfContext({
      planning: { proposed_tickets: [good, { ...good, title: 'Other' }] },
    });
    const tid = '00000000-0000-4000-8000-000000000001';
    const out = withDecisions(
      ps,
      new Map([[ps[0]!.id, { status: 'approved', created_ticket_id: tid }]]),
    );
    expect(out.map((p) => [p.status, p.created_ticket_id])).toEqual([
      ['approved', tid],
      ['pending', null],
    ]);
  });

  it('the body has the why and a link to the parent', () => {
    const body = proposalTicketBody(
      { why: 'Because.', state: 'planning' },
      { id: 'abc', title: 'Parent' },
    );
    expect(body).toContain('Because.');
    expect(body).toContain('[Parent](/#/?ticket=abc)');
    expect(body).toContain('`planning`');
  });

  it('detail schemas accept proposals and parse without them', () => {
    expect(TicketDetailSchema.shape.proposals.safeParse(undefined).success).toBe(true);
    expect(SessionDetailSchema.shape.proposals.safeParse([]).success).toBe(true);
  });
});
