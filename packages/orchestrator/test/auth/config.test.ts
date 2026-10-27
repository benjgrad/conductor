// M2-T08: the startup config parser (ADR-0017 §Modes). Startup errors name the variable.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BIND_HOST,
  PLAIN_COOKIE_NAME,
  SECURE_COOKIE_NAME,
  parseServerConfig,
} from '../../src/auth/config.js';

describe('parseServerConfig', () => {
  it('defaults to local mode on 127.0.0.1 with no trusted proxy', () => {
    expect(parseServerConfig({})).toEqual({
      bindHost: DEFAULT_BIND_HOST,
      trustedProxy: null,
      auth: { mode: 'local' },
    });
    expect(parseServerConfig({ CONDUCTOR_AUTH: '' }).auth.mode).toBe('local');
    expect(parseServerConfig({ CONDUCTOR_BIND_HOST: '::1' }).bindHost).toBe('::1');
    expect(parseServerConfig({ CONDUCTOR_BIND_HOST: 'localhost' }).bindHost).toBe('localhost');
  });

  it('refuses local mode on a non-loopback bind', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.2', 'conductor.example']) {
      expect(() =>
        parseServerConfig({ CONDUCTOR_AUTH: 'local', CONDUCTOR_BIND_HOST: host }),
      ).toThrow(/^CONDUCTOR_BIND_HOST=/);
    }
    expect(() => parseServerConfig({ CONDUCTOR_BIND_HOST: '0.0.0.0' })).toThrow(/local mode/);
  });

  it('refuses password mode without CONDUCTOR_PUBLIC_URL', () => {
    expect(() => parseServerConfig({ CONDUCTOR_AUTH: 'password' })).toThrow(
      /^CONDUCTOR_PUBLIC_URL is required/,
    );
  });

  it('password mode: https public URL → __Host- secure cookie; any bind host', () => {
    const cfg = parseServerConfig({
      CONDUCTOR_AUTH: 'password',
      CONDUCTOR_PUBLIC_URL: 'https://Conductor.Example.com/',
      CONDUCTOR_BIND_HOST: '0.0.0.0',
      CONDUCTOR_TRUSTED_PROXY: '192.168.80.1',
    });
    expect(cfg.bindHost).toBe('0.0.0.0');
    expect(cfg.trustedProxy).toBe('192.168.80.1');
    expect(cfg.auth).toMatchObject({
      mode: 'password',
      publicOrigin: 'https://conductor.example.com',
      publicHost: 'conductor.example.com',
      cookie: { name: SECURE_COOKIE_NAME, secure: true },
    });
  });

  it('password mode: http only for loopback, with the plain cookie', () => {
    const cfg = parseServerConfig({
      CONDUCTOR_AUTH: 'password',
      CONDUCTOR_PUBLIC_URL: 'http://127.0.0.1:7400',
    });
    expect(cfg.auth).toMatchObject({
      publicOrigin: 'http://127.0.0.1:7400',
      publicHost: '127.0.0.1:7400',
      cookie: { name: PLAIN_COOKIE_NAME, secure: false },
    });
    for (const url of [
      'http://conductor.example',
      'ftp://127.0.0.1',
      'not a url',
      'https://u:p@conductor.example',
      'https://conductor.example/app',
      'https://conductor.example/?x=1',
    ]) {
      expect(
        () => parseServerConfig({ CONDUCTOR_AUTH: 'password', CONDUCTOR_PUBLIC_URL: url }),
        url,
      ).toThrow(/^CONDUCTOR_PUBLIC_URL=/);
    }
  });

  it('refuses the M1 allow-lists in password mode, a bad mode and a bad proxy address', () => {
    const pw = { CONDUCTOR_AUTH: 'password', CONDUCTOR_PUBLIC_URL: 'https://c.example' };
    expect(() => parseServerConfig({ ...pw, CONDUCTOR_ALLOWED_ORIGINS: 'https://x' })).toThrow(
      /^CONDUCTOR_ALLOWED_ORIGINS/,
    );
    expect(() => parseServerConfig({ ...pw, CONDUCTOR_ALLOWED_HOSTS: 'x' })).toThrow(
      /^CONDUCTOR_ALLOWED_HOSTS/,
    );
    expect(() => parseServerConfig({ CONDUCTOR_AUTH: 'github' })).toThrow(/^CONDUCTOR_AUTH=github/);
    expect(() => parseServerConfig({ CONDUCTOR_TRUSTED_PROXY: 'gateway' })).toThrow(
      /^CONDUCTOR_TRUSTED_PROXY=gateway/,
    );
    // local mode keeps the M1-T14 allow-lists
    expect(parseServerConfig({ CONDUCTOR_ALLOWED_HOSTS: 'conductor.lan' }).auth.mode).toBe('local');
  });
});
