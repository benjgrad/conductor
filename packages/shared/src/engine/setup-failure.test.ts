import { describe, expect, it } from 'vitest';
import {
  describeSource,
  setupFailureMessage,
  setupFailureSummary,
  setupSource,
  type SetupSource,
} from './setup-failure.js';

const REPO = 'github.com/a/b';
const base = { workflowSetup: null, at: 'the entry of "Review"', repo: REPO, meta: null };

describe('setupSource', () => {
  it('the override when it sets a setup (with who and when)', () => {
    expect(
      setupSource({
        ...base,
        repoChecks: { setup: 'make deps', checks: [{ name: 'x', cmd: 'x' }] },
        meta: { updated_at: '2026-11-06T14:28:00.000Z', updated_by: 'ben' },
      }),
    ).toEqual({
      type: 'override',
      repo: REPO,
      updated_at: '2026-11-06T14:28:00.000Z',
      updated_by: 'ben',
    });
  });

  it('auto-detected when the override sets no setup', () => {
    expect(setupSource({ ...base, repoChecks: { checks: [{ name: 'x', cmd: 'x' }] } })).toEqual({
      type: 'auto',
      repo: REPO,
      override_without_setup: true,
    });
  });

  it('the workflow gate’s own setup, else auto-detected', () => {
    expect(setupSource({ ...base, repoChecks: null, workflowSetup: 'pnpm i' })).toEqual({
      type: 'workflow',
      at: base.at,
    });
    expect(setupSource({ ...base, repoChecks: null })).toMatchObject({ type: 'auto' });
  });
});

describe('describeSource', () => {
  const cases: [SetupSource, string][] = [
    [
      { type: 'override', repo: REPO, updated_at: '2026-11-06T14:28:00.000Z', updated_by: 'ben' },
      `from the repo checks override for ${REPO}, saved 2026-11-06 14:28 UTC by ben`,
    ],
    [
      { type: 'override', repo: REPO, updated_at: null, updated_by: null },
      `from the repo checks override for ${REPO}`,
    ],
    [{ type: 'workflow', at: 'X' }, "from the workflow's checks at X"],
    [{ type: 'auto', repo: REPO, override_without_setup: false }, 'auto-detected from the lockfile'],
    [
      { type: 'auto', repo: REPO, override_without_setup: true },
      `auto-detected from the lockfile (the repo checks override for ${REPO} sets no setup)`,
    ],
  ];
  it.each(cases)('%j', (src, text) => expect(describeSource(src)).toBe(text));
});

describe('setupFailureMessage', () => {
  const input = {
    cmd: 'git fetch -q origin',
    source: { type: 'override', repo: REPO, updated_at: null, updated_by: null } as SetupSource,
    repo: REPO,
    how: 'exit code 128',
    check: 'npm test',
    baseRef: 'main',
  };

  it('fail on base: conductor’s config, with the fix', () => {
    const m = setupFailureMessage({ ...input, onBase: 'fail' });
    expect(m.config).toBe(true);
    expect(m.summary).toBe(
      `Setup failed before any check ran: \`git fetch -q origin\` (from the repo checks override for ${REPO}).`,
    );
    expect(m.text).toContain("conductor's check config, not your branch");
    expect(m.text).toContain(`Fix it with set_repo_checks for ${REPO}, or on the board's repo checks`);
    expect(m.text).toContain('so `npm test` did not run');
  });

  it('pass on base: the branch', () => {
    const m = setupFailureMessage({ ...input, onBase: 'pass' });
    expect(m.config).toBe(false);
    expect(m.text).toContain('It passes on `main`, so something on this branch breaks it');
  });

  it('unknown: could not tell', () => {
    const m = setupFailureMessage({ ...input, onBase: undefined, baseRef: undefined });
    expect(m.config).toBe(false);
    expect(m.text).toContain('could not tell whether it also fails on the base branch');
  });

  it('a workflow setup points at the workflow first', () => {
    const m = setupFailureMessage({
      ...input,
      source: { type: 'workflow', at: 'X' },
      onBase: 'fail',
    });
    expect(m.text).toContain('Fix it in the workflow (X)');
  });
});

describe('setupFailureSummary', () => {
  it('is the first line, clipped', () => {
    expect(setupFailureSummary('one\ntwo')).toBe('one');
    expect(setupFailureSummary('x'.repeat(400), 10)).toBe('xxxxxxxxx…');
  });
});
