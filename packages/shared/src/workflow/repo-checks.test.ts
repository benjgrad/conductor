import { describe, expect, it } from 'vitest';
import { applyRepoChecks, PIN_CHECK, type GateSpec } from '../engine/move-step.js';
import { repoChecksKey } from '../api/rest.js';
import { CONDUCTOR_V4_DEF } from './conductor.js';
import { checkPathsProblem, EntryCheckSchema } from './schema.js';
import { checksGatesOf, RepoChecksSchema, type RepoChecks } from './repo-checks.js';

// ADR-0030: per-repo check overrides: the schema, what they replace, the repo key.

const OVERRIDE: RepoChecks = {
  setup: '',
  checks: [
    { name: 'Web build', cmd: 'cd m-one && npm ci && npm run build', timeout: '15m' },
    { name: '.NET build', cmd: 'msbuild.exe Method.sln' },
  ],
};

const spec = (over: Partial<GateSpec>): GateSpec => ({
  title: 'PR ready for review',
  goal: 'take it',
  checks: [{ name: 'Build passes', cmd: 'npm run build' }],
  setup: null,
  review: null,
  actions: ['open_pr'],
  conditions: [],
  on_unmet: { goto: 'implementing', retries: 3, else: 'needs_input' },
  ...over,
});

describe('RepoChecksSchema', () => {
  it('accepts checks with an optional setup', () => {
    expect(RepoChecksSchema.parse(OVERRIDE)).toEqual(OVERRIDE);
    expect(RepoChecksSchema.parse({ checks: [{ name: 'T', cmd: 'make test' }] })).toEqual({
      checks: [{ name: 'T', cmd: 'make test' }],
    });
  });

  it.each([
    ['no checks', { checks: [] }],
    [
      'a duplicate name',
      { checks: [OVERRIDE.checks[0], { ...OVERRIDE.checks[1], name: 'Web build' }] },
    ],
    ['a blank command', { checks: [{ name: 'T', cmd: '  ' }] }],
    ['a bad timeout', { checks: [{ name: 'T', cmd: 'make', timeout: '10 minutes' }] }],
    ['an unknown key', { checks: [{ name: 'T', cmd: 'make' }], cwd: 'm-one' }],
    [
      '21 checks',
      { checks: Array.from({ length: 21 }, (_, i) => ({ name: `c${i}`, cmd: 'true' })) },
    ],
  ])('refuses %s', (_label, input) => {
    expect(RepoChecksSchema.safeParse(input).success).toBe(false);
  });
});

describe('applyRepoChecks', () => {
  it('replaces the checks and setup of a step with real checks', () => {
    const out = applyRepoChecks(spec({ setup: 'npm ci' }), OVERRIDE);
    expect(out.checks).toEqual(OVERRIDE.checks);
    expect(out.setup).toBe('');
    expect(out.actions).toEqual(['open_pr']);
  });

  it('an override without setup means auto-detect (null)', () => {
    const noSetup: RepoChecks = { checks: OVERRIDE.checks };
    expect(applyRepoChecks(spec({ setup: 'npm ci' }), noSetup).setup).toBeNull();
  });

  it('leaves pin-only, check-less and override-less specs alone', () => {
    const pinOnly = spec({ checks: [PIN_CHECK] });
    expect(applyRepoChecks(pinOnly, OVERRIDE)).toBe(pinOnly);
    const none = spec({ checks: [], actions: [] });
    expect(applyRepoChecks(none, OVERRIDE)).toBe(none);
    const plain = spec({});
    expect(applyRepoChecks(plain, null)).toBe(plain);
    expect(applyRepoChecks(plain, undefined)).toBe(plain);
  });
});

describe('checksGatesOf', () => {
  it('lists conductor v4’s shipping transitions, each with its own checks', () => {
    const gates = checksGatesOf(CONDUCTOR_V4_DEF);
    expect(gates.map((g) => g.at)).toEqual([
      'implementing.pr_ready_for_review',
      'implementing.personal_pr_ready_for_review',
      'implementing.ready_for_testing',
    ]);
    expect(gates[0]!.checks.map((c) => c.cmd)).toEqual(['npm run build', 'npm test']);
    expect(gates[0]!.setup).toBeNull();
  });
});

describe('repoChecksKey', () => {
  it('canonicalises and lower-cases; keeps a non-repo string as given', () => {
    expect(repoChecksKey('https://github.com/Acme/MethodUI.git')).toBe('github.com/acme/methodui');
    expect(repoChecksKey(' git@github.com:Acme/MethodUI.git ')).toBe('github.com/acme/methodui');
    expect(repoChecksKey('/tmp/Fixture')).toBe('/tmp/fixture');
  });
});

describe('check paths (R3)', () => {
  const base = { name: 'Cargo', cmd: 'cargo nextest run' };
  it('accepts up to 50 globs, trimmed', () => {
    const parsed = RepoChecksSchema.parse({
      checks: [{ ...base, paths: [' crates/** ', 'Cargo.*', 'rust-toolchain.toml'] }],
    });
    expect(parsed.checks[0]!.paths).toEqual(['crates/**', 'Cargo.*', 'rust-toolchain.toml']);
    const fifty = Array.from({ length: 50 }, (_, i) => `d${i}/**`);
    expect(RepoChecksSchema.safeParse({ checks: [{ ...base, paths: fifty }] }).success).toBe(true);
  });

  it('refuses more than 50, an empty list and globs that can never match a git path', () => {
    const bad = (paths: string[]) =>
      RepoChecksSchema.safeParse({ checks: [{ ...base, paths }] }).success;
    expect(bad(Array.from({ length: 51 }, (_, i) => `d${i}/**`))).toBe(false);
    expect(bad([])).toBe(false);
    for (const g of ['', '/abs/**', '../x', 'a/../b', 'crates\\x', 'a{b,c', 'x'.repeat(201)]) {
      expect(bad([g]), g).toBe(false);
    }
  });

  it('checkPathsProblem explains each refusal', () => {
    expect(checkPathsProblem('crates/**')).toBeNull();
    expect(checkPathsProblem('packages/{web,shared}/**')).toBeNull();
    expect(checkPathsProblem('src\\a.ts')).toMatch(/forward slashes/);
    expect(checkPathsProblem('/x')).toMatch(/relative to the repo root/);
    expect(checkPathsProblem('../x')).toMatch(/inside the repo/);
    expect(checkPathsProblem('a{b')).toMatch(/unclosed/);
  });

  it('a workflow check accepts paths too (requires.checks / entry.checks share the schema)', () => {
    expect(EntryCheckSchema.safeParse({ ...base, paths: ['crates/**'] }).success).toBe(true);
  });
});
