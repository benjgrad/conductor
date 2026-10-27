import { describe, expect, it } from 'vitest';
import {
  type Capability,
  CapabilityNameSchema,
  CapabilityRequirementSchema,
  CapabilitySchema,
  capabilityKey,
  capabilityKeys,
  cliVersionAtLeast,
  GH_MIN_VERSION,
  isCapabilityRequirement,
  satisfiesCapability,
} from './capabilities.js';

describe('CapabilityNameSchema: one rule for capabilities and requirements (M2-T10b)', () => {
  const named = (name: string): Capability[] => [
    { kind: 'cli', name, version: null, authed: false },
    { kind: 'cli', name, version: '1.0.0', authed: true },
    { kind: 'mcp', name },
    { kind: 'skill', name },
    { kind: 'agent', name },
    { kind: 'skill', name, repo: 'github.com/o/app' },
    { kind: 'agent', name, repo: 'github.com/o/app' },
  ];

  it('refuses `:`, `@`, whitespace, NUL, empty and over-long names in both schemas', () => {
    for (const bad of [
      '',
      'a:b',
      'x@y',
      'x@github.com/o/r',
      'a b',
      'a\tb',
      'a\nb',
      'a\0b',
      'x'.repeat(201),
    ]) {
      const label = JSON.stringify(bad);
      expect(CapabilityNameSchema.safeParse(bad).success, label).toBe(false);
      for (const c of named(bad)) {
        expect(CapabilitySchema.safeParse(c).success, `${c.kind} ${label}`).toBe(false);
      }
      for (const prefix of ['cli:', 'mcp:', 'skill:', 'agent:']) {
        // `skill:x@github.com/o/r` is the repo-scoped key of skill `x`, not a name with `@`.
        if (bad === 'x@github.com/o/r' && /^(?:skill|agent):$/.test(prefix)) continue;
        expect(isCapabilityRequirement(`${prefix}${bad}`), `${prefix}${label}`).toBe(false);
        expect(CapabilityRequirementSchema.safeParse(`${prefix}${bad}`).success).toBe(false);
      }
    }
  });

  it('a valid name round-trips name → key → requirement → match', () => {
    for (const name of ['slack', 'context7', 'my-server_1.0', 'ñandú', 'x'.repeat(200)]) {
      expect(CapabilityNameSchema.safeParse(name).success, name).toBe(true);
      for (const c of named(name)) {
        expect(CapabilitySchema.parse(c)).toEqual(c);
        const keys = capabilityKeys(c);
        for (const k of keys)
          expect(CapabilityRequirementSchema.safeParse(k).success, k).toBe(true);
        expect(satisfiesCapability(new Set(keys), capabilityKey(c), null)).toBe(true);
      }
      // A bare skill requirement is met by the ticket repo's skill.
      const scoped = new Set(capabilityKeys({ kind: 'skill', name, repo: 'github.com/o/app' }));
      expect(satisfiesCapability(scoped, `skill:${name}`, 'github.com/o/app')).toBe(true);
    }
  });
});

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
