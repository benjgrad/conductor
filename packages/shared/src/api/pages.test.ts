import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V4_DEF } from '../workflow/conductor.js';
import type { AgentState } from '../workflow/schema.js';
import {
  hostedPageId,
  isPageUrl,
  pageLimitsOf,
  pagesOfContext,
  PageRefSchema,
  PublishPageRequestSchema,
} from './pages.js';

// ADR-0038: reading the pages an agent attached back from the session's context.

describe('PageRefSchema', () => {
  it('takes https, and http only on loopback', () => {
    expect(isPageUrl('https://claude.ai/public/artifacts/abc')).toBe(true);
    expect(isPageUrl('http://127.0.0.1:8787/p/x')).toBe(true);
    expect(isPageUrl('http://localhost:8787/p/x')).toBe(true);
    for (const bad of [
      'http://example.com/p',
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://x',
      'https://u:p@x.com/',
      'not a url',
    ]) {
      expect(isPageUrl(bad), bad).toBe(false);
    }
  });

  it('bounds the title', () => {
    expect(PageRefSchema.safeParse({ url: 'https://a.b/', title: 'x'.repeat(200) }).success).toBe(
      true,
    );
    expect(PageRefSchema.safeParse({ url: 'https://a.b/', title: 'x'.repeat(201) }).success).toBe(
      false,
    );
    expect(PageRefSchema.safeParse({ url: 'https://a.b/', title: '  ' }).success).toBe(false);
  });
});

describe('pagesOfContext', () => {
  const limits = new Map([
    ['planning', 2],
    ['implementing', 1],
  ]);
  const page = (n: number) => ({ url: `https://h.example/${n}`, title: `Page ${n}` });

  it('reads each state up to its limit, in context order, dropping malformed entries', () => {
    const out = pagesOfContext(
      {
        planning: { plan: 'p', pages: [{ url: 'javascript:x', title: 't' }, page(1), page(2), page(3)] },
        implementing: { summary: 's', pages: [page(4), page(5)] },
        unlisted: { pages: [page(6)] },
        __qa: { pages: [page(7)] },
      },
      limits,
    );
    expect(out.map((p) => [p.state, p.url])).toEqual([
      ['planning', 'https://h.example/1'],
      ['planning', 'https://h.example/2'],
      ['implementing', 'https://h.example/4'],
    ]);
  });

  it('dedups by url and never throws on odd shapes', () => {
    expect(
      pagesOfContext({ planning: { pages: [page(1), page(1)] } }, limits).map((p) => p.url),
    ).toEqual(['https://h.example/1']);
    expect(pagesOfContext({ planning: { pages: 'x' } }, limits)).toEqual([]);
    expect(pagesOfContext(null, limits)).toEqual([]);
  });

  it('pageLimitsOf names only states with a pages entry', () => {
    const def = structuredClone(CONDUCTOR_V4_DEF);
    (def.states.planning as AgentState).result = ['plan', { pages: { max: 3 } }];
    expect([...pageLimitsOf(def)]).toEqual([['planning', 3]]);
  });
});

describe('hostedPageId', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  it('matches only <origin>/p/<uuid>', () => {
    expect(hostedPageId(`https://c.example/p/${id}?t=x`, 'https://c.example')).toBe(id);
    expect(hostedPageId(`https://other.example/p/${id}`, 'https://c.example')).toBeNull();
    expect(hostedPageId(`https://c.example/p/${id}/x`, 'https://c.example')).toBeNull();
    expect(hostedPageId('https://c.example/p/nope', 'https://c.example')).toBeNull();
  });
});

describe('PublishPageRequestSchema', () => {
  it('bounds ttl_days to 1..30 and refuses extra keys', () => {
    const ok = { title: 't', html: '<p>x</p>' };
    expect(PublishPageRequestSchema.safeParse({ ...ok, ttl_days: 30 }).success).toBe(true);
    expect(PublishPageRequestSchema.safeParse({ ...ok, ttl_days: 31 }).success).toBe(false);
    expect(PublishPageRequestSchema.safeParse({ ...ok, x: 1 }).success).toBe(false);
  });
});
