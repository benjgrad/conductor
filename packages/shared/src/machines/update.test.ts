import { describe, expect, it } from 'vitest';
import { LATEST_DAEMON_FIXTURE } from '../protocol/fixtures.js';
import {
  DAEMON_TARBALL_MAX_BYTES,
  DAEMON_TARBALL_RE,
  EXIT_RESTART_FOR_UPDATE,
  LatestDaemonSchema,
  UPDATE_DRAIN_COOLDOWN_MS,
  UPDATE_MAX_DRAIN_ATTEMPTS,
  UPDATE_MAX_DRAIN_MS,
  UPDATE_MAX_TRIAL_ATTEMPTS,
  UPDATE_TRIAL_REGISTER_MS,
  UpdateStageSchema,
  daemonTarballName,
} from './update.js';

describe('daemon auto-update constants (ADR-0021)', () => {
  it('have the ADR values', () => {
    expect(EXIT_RESTART_FOR_UPDATE).toBe(75);
    expect(UPDATE_MAX_DRAIN_MS).toBe(21_600_000);
    expect(UPDATE_TRIAL_REGISTER_MS).toBe(120_000);
    expect(UPDATE_MAX_DRAIN_ATTEMPTS).toBe(3);
    expect(UPDATE_DRAIN_COOLDOWN_MS).toBe(3_600_000);
    expect(UPDATE_MAX_TRIAL_ATTEMPTS).toBe(2);
    expect(DAEMON_TARBALL_MAX_BYTES).toBe(104_857_600);
    expect(UpdateStageSchema.options).toEqual([
      'download',
      'verify',
      'unpack',
      'drain_timeout',
      'trial',
    ]);
  });
});

describe('LatestDaemonSchema', () => {
  const ok = LATEST_DAEMON_FIXTURE;

  it('parses the fixture; the tarball name matches the regex', () => {
    expect(LatestDaemonSchema.parse(ok)).toEqual(ok);
    expect(daemonTarballName(ok.version)).toBe(ok.file);
    for (const v of ['0.3.0', '1.0.0-rc.1', '0.2.0+eafa213']) {
      expect(DAEMON_TARBALL_RE.test(daemonTarballName(v))).toBe(true);
    }
  });

  it.each([
    ['file ../x.tgz', { file: '../x.tgz' }],
    ['file .tar.gz', { file: 'conductor-daemon-0.3.0+4c5d6e7.tar.gz' }],
    ['file with a slash', { file: 'conductor-daemon-a/b.tgz' }],
    ['a version not in file', { version: '0.3.1' }],
    ['file of another version', { file: 'conductor-daemon-0.3.1.tgz' }],
    ['uppercase sha256', { sha256: 'AB'.repeat(32) }],
    ['short sha256', { sha256: 'a'.repeat(63) }],
    ['long sha256', { sha256: 'a'.repeat(65) }],
    ['size 0', { size: 0 }],
    ['size over the cap', { size: DAEMON_TARBALL_MAX_BYTES + 1 }],
    ['fractional size', { size: 1.5 }],
    ['empty version', { version: '', file: 'conductor-daemon-.tgz' }],
    ['version ../x', { version: '../x', file: 'conductor-daemon-../x.tgz' }],
    ['version starting with a dot', { version: '.1', file: 'conductor-daemon-.1.tgz' }],
  ])('refuses %s', (_name, patch) => {
    expect(LatestDaemonSchema.safeParse({ ...ok, ...patch }).success).toBe(false);
  });

  it('accepts the size cap exactly', () => {
    expect(LatestDaemonSchema.safeParse({ ...ok, size: DAEMON_TARBALL_MAX_BYTES }).success).toBe(
      true,
    );
  });
});
