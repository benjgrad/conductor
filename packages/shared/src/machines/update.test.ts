import { describe, expect, it } from 'vitest';
import { LATEST_DAEMON_FIXTURE } from '../protocol/fixtures.js';
import {
  DAEMON_TARBALL_MAX_BYTES,
  daemonTarballMatches,
  EXIT_RESTART_FOR_UPDATE,
  LatestDaemonSchema,
  MachineUpdateAlertDtoSchema,
  UPDATE_DRAIN_COOLDOWN_MS,
  UPDATE_MAX_DRAIN_ATTEMPTS,
  UPDATE_MAX_DRAIN_MS,
  UPDATE_MAX_TRIAL_ATTEMPTS,
  UPDATE_TRIAL_REGISTER_MS,
} from './update.js';

describe('auto-update constants (ADR-0021)', () => {
  it('match the ADR', () => {
    expect(EXIT_RESTART_FOR_UPDATE).toBe(75);
    expect(UPDATE_MAX_DRAIN_MS).toBe(21_600_000);
    expect(UPDATE_TRIAL_REGISTER_MS).toBe(120_000);
    expect(UPDATE_MAX_DRAIN_ATTEMPTS).toBe(3);
    expect(UPDATE_DRAIN_COOLDOWN_MS).toBe(3_600_000);
    expect(UPDATE_MAX_TRIAL_ATTEMPTS).toBe(2);
    expect(DAEMON_TARBALL_MAX_BYTES).toBe(100 * 1024 * 1024);
  });
});

describe('daemonTarballMatches', () => {
  it.each([
    ['conductor-daemon-0.3.0.tgz', '0.3.0', true],
    ['conductor-daemon-0.3.0+abc1234.tgz', '0.3.0+abc1234', true],
    ['conductor-daemon-0.3.0-x86_64-unknown-linux-gnu.tgz', '0.3.0', true],
    ['conductor-daemon-0.3.0-rc.1-aarch64-apple-darwin.tgz', '0.3.0-rc.1', true],
    ['conductor-daemon-0.3.0-x86_64-pc-windows-msvc.tgz', '0.3.0', true],
    ['conductor-daemon-1.2.30.tgz', '1.2.3', false],
    ['conductor-daemon-1.2-3.tgz', '1.2', false], // a one-segment target
    ['conductor-daemon-0.3.0-X86_64-Apple-Darwin.tgz', '0.3.0', false],
    ['conductor-daemon-0.3.0.tar.gz', '0.3.0', false],
    ['conductor-daemon-0.4.0.tgz', '0.3.0', false],
    ['../conductor-daemon-0.3.0.tgz', '0.3.0', false],
    ['conductor-daemon-0.3.0.tgz', '0.3.0/..', false],
  ])('%s for %s → %s', (file, version, ok) => {
    expect(daemonTarballMatches(file, version)).toBe(ok);
  });
});

describe('LatestDaemonSchema', () => {
  const ok = LATEST_DAEMON_FIXTURE;

  it('the fixture parses', () => {
    expect(LatestDaemonSchema.parse(ok)).toEqual(ok);
  });

  it.each([
    ['a path', { file: '../x.tgz' }],
    ['a slash', { file: 'a/b.tgz' }],
    ['another version in file', { file: 'conductor-daemon-9.9.9.tgz' }],
    ['an upper-case sha', { sha256: ok.sha256.toUpperCase() }],
    ['a short sha', { sha256: ok.sha256.slice(1) }],
    ['size 0', { size: 0 }],
    ['an oversize build', { size: DAEMON_TARBALL_MAX_BYTES + 1 }],
    ['a version with a slash', { version: 'a/b' }],
  ])('refuses %s', (_name, bad) => {
    expect(LatestDaemonSchema.safeParse({ ...ok, ...bad }).success).toBe(false);
  });
});

describe('MachineUpdateAlertDtoSchema', () => {
  const ok = {
    kind: 'update_failed',
    version: '0.3.0',
    stage: 'download',
    error: 'HTTP 404',
    at: '2026-11-03T12:00:00.000Z',
  };

  it('parses, and refuses a bad stage or a long error', () => {
    expect(MachineUpdateAlertDtoSchema.parse(ok)).toEqual(ok);
    expect(MachineUpdateAlertDtoSchema.safeParse({ ...ok, stage: 'switch' }).success).toBe(false);
    expect(MachineUpdateAlertDtoSchema.safeParse({ ...ok, error: 'x'.repeat(501) }).success).toBe(
      false,
    );
  });
});
