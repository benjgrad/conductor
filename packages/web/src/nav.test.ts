import { describe, expect, it } from 'vitest';
import { parseHash, routeHash, type Route } from './nav.js';

describe('parseHash / routeHash', () => {
  it('round-trips every view', () => {
    const routes: Route[] = [
      { view: 'board' },
      { view: 'workflows', workflowId: null },
      { view: 'workflows', workflowId: 'conductor' },
      { view: 'workflows', workflowId: null, proposalId: '7a1c-01' },
      { view: 'machines' },
      { view: 'insights' },
      { view: 'repo-checks', repo: 'github.com/acme/shop' },
      { view: 'admin' },
      { view: 'setup' },
    ];
    for (const r of routes) expect(parseHash(routeHash(r))).toEqual(r);
  });

  it('UXR-84: #/insights and a proposal to open on the Workflow page', () => {
    expect(routeHash({ view: 'insights' })).toBe('#/insights');
    expect(routeHash({ view: 'workflows', workflowId: null, proposalId: 'p 1' })).toBe(
      '#/workflows?proposal=p%201',
    );
    expect(parseHash('#/workflows?proposal=abc')).toEqual({
      view: 'workflows',
      workflowId: null,
      proposalId: 'abc',
    });
  });

  it('a query never changes the board or an encoded repo', () => {
    expect(parseHash('#/?ticket=t1')).toEqual({ view: 'board' });
    expect(parseHash('#/repo-checks/github.com%2Facme%2Fshop')).toEqual({
      view: 'repo-checks',
      repo: 'github.com/acme/shop',
    });
  });
});
