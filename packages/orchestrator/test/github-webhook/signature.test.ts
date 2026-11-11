// R11: GitHub's `X-Hub-Signature-256` check. Pure.
import { describe, expect, it } from 'vitest';
import {
  newWebhookSecret,
  signGithubPayload,
  verifyGithubSignature,
} from '../../src/github-webhook/signature.js';

// GitHub's documented example (docs.github.com, "Validating webhook deliveries").
const SECRET = "It's a Secret to Everybody";
const BODY = Buffer.from('Hello, World!');
const SIG = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

describe('verifyGithubSignature', () => {
  it("accepts GitHub's documented test vector", () => {
    expect(verifyGithubSignature(SECRET, BODY, SIG)).toBe(true);
    expect(signGithubPayload(SECRET, BODY)).toBe(SIG);
  });

  it('accepts upper-case hex and surrounding whitespace', () => {
    expect(
      verifyGithubSignature(SECRET, BODY, ` ${SIG.toUpperCase().replace('SHA256', 'sha256')} `),
    ).toBe(true);
  });

  it.each([
    ['a wrong secret', 'another secret', BODY, SIG],
    ['a tampered body', SECRET, Buffer.from('Hello, World?'), SIG],
    ['a missing header', SECRET, BODY, undefined],
    ['the SHA-1 form', SECRET, BODY, 'sha1=' + SIG.slice('sha256='.length, 'sha256='.length + 40)],
    ['no prefix', SECRET, BODY, SIG.slice('sha256='.length)],
    ['non-hex', SECRET, BODY, 'sha256=' + 'z'.repeat(64)],
    ['a short digest', SECRET, BODY, SIG.slice(0, -2)],
    ['a long digest', SECRET, BODY, SIG + '00'],
    ['a repeated header', SECRET, BODY, [SIG, SIG]],
    ['an empty secret', '', BODY, signGithubPayload('', BODY)],
  ] as const)('refuses %s', (_name, secret, body, header) => {
    expect(verifyGithubSignature(secret, body, header as string | string[] | undefined)).toBe(
      false,
    );
  });
});

describe('newWebhookSecret', () => {
  it('is 64 hex characters and fresh each time', () => {
    const a = newWebhookSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(newWebhookSecret()).not.toBe(a);
  });
});
