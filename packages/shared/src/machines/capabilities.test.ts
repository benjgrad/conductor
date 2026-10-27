import { describe, expect, it } from 'vitest';
import { cliVersionAtLeast, GH_MIN_VERSION } from './capabilities.js';

describe('cliVersionAtLeast / GH_MIN_VERSION (M2-T10)', () => {
  it('the floor is 2.40.0 (U-076: a safe floor, not a verified minimum)', () => {
    expect(GH_MIN_VERSION).toBe('2.40.0');
  });

  it('compares numerically, not as strings', () => {
    expect(cliVersionAtLeast('2.9.0', '2.40.0')).toBe(false);
    expect(cliVersionAtLeast('2.14.0', '2.40.0')).toBe(false);
    expect(cliVersionAtLeast('2.39.9', '2.40.0')).toBe(false);
    expect(cliVersionAtLeast('2.40.0', '2.40.0')).toBe(true);
    expect(cliVersionAtLeast('2.40.1', '2.40.0')).toBe(true);
    expect(cliVersionAtLeast('2.103.3', '2.40.0')).toBe(true);
    expect(cliVersionAtLeast('3.0.0', '2.40.0')).toBe(true);
    expect(cliVersionAtLeast('1.99.99', '2.40.0')).toBe(false);
    expect(cliVersionAtLeast('v2.40.0', '2.40.0')).toBe(true);
    expect(cliVersionAtLeast('2.40.0+build.5', '2.40.0')).toBe(true);
  });

  it('a pre-release sorts below its release', () => {
    expect(cliVersionAtLeast('2.40.0-rc.1', '2.40.0')).toBe(false);
    expect(cliVersionAtLeast('2.41.0-beta', '2.40.0')).toBe(true);
    expect(cliVersionAtLeast('2.40.0-rc.2', '2.40.0-rc.1')).toBe(true);
    expect(cliVersionAtLeast('2.40.0-rc.1', '2.40.0-rc.10')).toBe(false);
  });

  it('garbage is never enough', () => {
    for (const v of [
      '',
      'unknown',
      '2.40',
      '2',
      'gh version 2.40.0',
      '2.40.0.1',
      'x.y.z',
      null,
      undefined,
    ]) {
      expect(cliVersionAtLeast(v, '2.40.0'), String(v)).toBe(false);
    }
    expect(cliVersionAtLeast('2.40.0', 'garbage')).toBe(false);
  });
});
