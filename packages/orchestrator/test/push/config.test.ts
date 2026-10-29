// UX-15: the VAPID config, the notification payload and `conductor-admin vapid-keys`. No database.
import { describe, expect, it } from 'vitest';
import { runVapidKeys } from '../../src/auth/admin-commands.js';
import { ConfigError } from '../../src/auth/config.js';
import { parsePushConfig } from '../../src/push/config.js';
import { clip, needsInputPayload, PUSH_QUESTION_MAX } from '../../src/push/payload.js';
import { generateVapidKeys } from '../../src/push/sender.js';

const keys = generateVapidKeys();
const env = (over: Record<string, string | undefined> = {}) => ({
  CONDUCTOR_VAPID_PUBLIC_KEY: keys.publicKey,
  CONDUCTOR_VAPID_PRIVATE_KEY: keys.privateKey,
  CONDUCTOR_VAPID_SUBJECT: 'mailto:ops@example.test',
  ...over,
});

describe('parsePushConfig', () => {
  it('all unset (or empty) → null: push disabled', () => {
    expect(parsePushConfig({})).toBeNull();
    expect(
      parsePushConfig({
        CONDUCTOR_VAPID_PUBLIC_KEY: '',
        CONDUCTOR_VAPID_PRIVATE_KEY: ' ',
        CONDUCTOR_VAPID_SUBJECT: '',
      }),
    ).toBeNull();
  });

  it('a full set parses', () => {
    expect(parsePushConfig(env())).toEqual({
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: 'mailto:ops@example.test',
    });
  });

  it('a partial set throws naming the missing variable', () => {
    expect(() => parsePushConfig(env({ CONDUCTOR_VAPID_PRIVATE_KEY: undefined }))).toThrow(
      /CONDUCTOR_VAPID_PRIVATE_KEY/,
    );
    expect(() => parsePushConfig(env({ CONDUCTOR_VAPID_SUBJECT: '' }))).toThrow(ConfigError);
  });

  it('rejects a bad subject or key', () => {
    expect(() => parsePushConfig(env({ CONDUCTOR_VAPID_SUBJECT: 'ops@example.test' }))).toThrow(
      /CONDUCTOR_VAPID_SUBJECT/,
    );
    expect(() => parsePushConfig(env({ CONDUCTOR_VAPID_PUBLIC_KEY: keys.privateKey }))).toThrow(
      /CONDUCTOR_VAPID_PUBLIC_KEY/,
    );
    expect(() => parsePushConfig(env({ CONDUCTOR_VAPID_PRIVATE_KEY: 'not base64!' }))).toThrow(
      /CONDUCTOR_VAPID_PRIVATE_KEY/,
    );
  });
});

describe('payload (FR-5)', () => {
  it('clips by code points, with an ellipsis', () => {
    expect(clip('short', 10)).toBe('short');
    const emoji = '😀'.repeat(130);
    const out = clip(emoji, PUSH_QUESTION_MAX);
    expect([...out]).toHaveLength(PUSH_QUESTION_MAX);
    expect(out.endsWith('…')).toBe(true);
    expect(clip('a\n\n  b', 10)).toBe('a b');
  });

  it('carries only title, body, url and tag', () => {
    const p = needsInputPayload({
      ticketId: 't-1',
      ticketTitle: 'Fix login',
      agent: 'planning',
      question: 'Which provider?',
      inputRequestId: 'ir-1',
    });
    expect(p).toEqual({
      title: 'Fix login',
      body: 'planning: Which provider?',
      url: '/#/?ticket=t-1',
      tag: 'ir-1',
    });
    expect(
      needsInputPayload({
        ticketId: 't',
        ticketTitle: 'T',
        agent: null,
        question: 'Q',
        inputRequestId: 'i',
      }).body,
    ).toBe('Q');
  });
});

describe('conductor-admin vapid-keys', () => {
  it('prints a key pair the config accepts', () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(
      runVapidKeys(
        [],
        (l) => out.push(l),
        (l) => err.push(l),
      ),
    ).toBe(0);
    expect(err).toEqual([]);
    const parsed = Object.fromEntries(
      out.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    expect(Object.keys(parsed)).toEqual([
      'CONDUCTOR_VAPID_PUBLIC_KEY',
      'CONDUCTOR_VAPID_PRIVATE_KEY',
      'CONDUCTOR_VAPID_SUBJECT',
    ]);
    expect(parsePushConfig(parsed)).not.toBeNull();
  });

  it('takes no arguments', () => {
    const err: string[] = [];
    expect(
      runVapidKeys(
        ['x'],
        () => undefined,
        (l) => err.push(l),
      ),
    ).toBe(2);
    expect(err[0]).toMatch(/usage/);
  });
});
