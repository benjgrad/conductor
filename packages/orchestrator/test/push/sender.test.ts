// The sender's failure formatting (pure): what the test route and the outbox say when a push
// service refuses a send, e.g. Apple's 403 for a bad VAPID subject.
import webpush from 'web-push';
import { describe, expect, it } from 'vitest';
import { endpointHost, failureOf } from '../../src/push/sender.js';

const APPLE = 'https://web.push.apple.com/QGuQyavXutnMH-secret-token';

describe('failureOf', () => {
  it("adds the push service's JSON reason to the status (Apple)", () => {
    const err = new webpush.WebPushError(
      'Received unexpected response code',
      403,
      {},
      '{"reason":"BadJwtToken"}',
      APPLE,
    );
    expect(failureOf(err)).toEqual({
      ok: false,
      gone: false,
      status: 403,
      error: 'http_403 BadJwtToken',
    });
  });

  it('uses a text body as is, clipped, and never the endpoint', () => {
    const err = new webpush.WebPushError('x', 400, {}, `  bad\n${'y'.repeat(500)}`, APPLE);
    const f = failureOf(err);
    expect(f.error.startsWith('http_400 bad y')).toBe(true);
    expect(f.error.length).toBeLessThanOrEqual('http_400 '.length + 200);
    expect(f.error).not.toContain('secret-token');
  });

  it('marks 404 / 410 gone, with no body', () => {
    expect(failureOf(new webpush.WebPushError('gone', 410, {}, '', APPLE))).toEqual({
      ok: false,
      gone: true,
      status: 410,
      error: 'http_410',
    });
  });

  it('a network error has no status', () => {
    expect(failureOf(new Error('ETIMEDOUT'))).toEqual({
      ok: false,
      gone: false,
      status: null,
      error: 'ETIMEDOUT',
    });
  });
});

it('endpointHost keeps only the host', () => {
  expect(endpointHost(APPLE)).toBe('web.push.apple.com');
  expect(endpointHost('not a url')).toBe('invalid-endpoint');
});
