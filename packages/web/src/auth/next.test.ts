import { describe, expect, it } from 'vitest';
import { afterSignIn } from './next.js';

describe('afterSignIn', () => {
  it('loads the OAuth consent page from the server (ADR-0028)', () => {
    const next = '/oauth/authorize?client_id=c&redirect_uri=x';
    expect(afterSignIn(next)).toEqual({ path: next, reload: true });
  });

  it('stays in the SPA for its own paths', () => {
    expect(afterSignIn('/#/workflows')).toEqual({ path: '/#/workflows', reload: false });
    expect(afterSignIn(null)).toEqual({ path: '/', reload: false });
  });

  it('never leaves the origin', () => {
    expect(afterSignIn('//evil.com/oauth/')).toEqual({ path: '/', reload: false });
  });
});
