import { describe, expect, it } from 'vitest';
import { applyRepoChecks, PIN_CHECK, type GateSpec } from '../engine/move-step.js';
import { repoChecksKey } from '../api/rest.js';
import { CONDUCTOR_V4_DEF } from './conductor.js';
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
