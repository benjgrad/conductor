import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  isS256Challenge,
  redirectUriMatches,
  redirectUriProblem,
  verifyPkceS256,
} from './secrets.js';

describe('verifyPkceS256', () => {
  // RFC 7636 Appendix B.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  it('accepts the RFC 7636 test vector', () => {
    expect(isS256Challenge(challenge)).toBe(true);
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it('refuses a wrong or malformed verifier', () => {
    expect(verifyPkceS256(verifier.replace('d', 'e'), challenge)).toBe(false);
    expect(verifyPkceS256('short', challenge)).toBe(false);
    expect(verifyPkceS256(challenge, challenge)).toBe(false); // `plain` would accept this
  });
});

describe('redirect URIs', () => {
  it.each([
    ['https://claude.ai/api/mcp/auth_callback', null],
    ['http://127.0.0.1:33418/callback', null],
    ['http://localhost:9999/cb', null],
    ['http://[::1]:5000/cb', null],
    ['http://example.com/cb', 'must be https:// (http:// only on a loopback host)'],
    ['myapp://callback', 'must be https:// (http:// only on a loopback host)'],
    ['https://claude.ai/cb#x', 'must not have a fragment'],
    ['https://user:pw@claude.ai/cb', 'must not carry credentials'],
    ['not a url', 'is not a URL'],
  ])('%s → %s', (uri, problem) => {
    expect(redirectUriProblem(uri)).toBe(problem);
  });

  it('matches exactly, or a loopback URI on any port (RFC 8252)', () => {
    const reg = ['https://claude.ai/cb', 'http://127.0.0.1:1000/callback'];
    expect(redirectUriMatches(reg, 'https://claude.ai/cb')).toBe(true);
    expect(redirectUriMatches(reg, 'https://claude.ai/cb2')).toBe(false);
    expect(redirectUriMatches(reg, 'https://claude.ai:444/cb')).toBe(false);
    expect(redirectUriMatches(reg, 'http://127.0.0.1:54321/callback')).toBe(true);
    expect(redirectUriMatches(reg, 'http://127.0.0.1:54321/other')).toBe(false);
    expect(redirectUriMatches(reg, 'http://localhost:1000/callback')).toBe(false);
  });
});

describe('escapeHtml', () => {
  it('escapes markup and quotes', () => {
    expect(escapeHtml(`<b a="1">'&`)).toBe('&lt;b a=&quot;1&quot;&gt;&#39;&amp;');
  });
});
