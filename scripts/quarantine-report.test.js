// @ts-check
import { describe, expect, it } from 'vitest';
import { buildReport, jobState, junitCases, noRunner, vitestCases } from './quarantine-report.js';

/** @param {Partial<import('./test-flaky.js').FlakyRow>} r */
const row = (r) => ({
  test: 'x',
  file: 'packages/web/src/A.test.tsx',
  firstSeen: '2026-10-01',
  rounds: '1',
  owner: 'WF-T1',
  fixBy: '2026-12-01',
  ...r,
});
const TS = row({ test: '`A.test.tsx`' });
const RS = row({
  test: '`daemon::tests::kill_real`',
  file: 'crates/conductor-daemon/src/daemon/tests/kill_real.rs',
  owner: 'WF-T7',
});

const vitest = (/** @type {string} */ status) => ({
  testResults: [
    {
      name: '/w/repo/packages/web/src/A.test.tsx',
      status,
      assertionResults: [
        { fullName: 'a ok', status: 'passed' },
        { fullName: 'a flaky', status },
      ],
    },
  ],
});
const JUNIT = `<?xml version="1.0"?><testsuites><testsuite name="conductor-daemon">
<testcase name="daemon::tests::kill_real::one" classname="conductor-daemon"/>
<testcase name="daemon::tests::kill_real::two" classname="conductor-daemon"><failure message="x">boom</failure></testcase>
<testcase name="daemon::tests::other::three" classname="conductor-daemon"><failure/></testcase>
</testsuite></testsuites>`;

const report = (/** @type {Partial<Parameters<typeof buildReport>[0]>} */ over) =>
  buildReport({
    rows: [TS, RS],
    vitestJson: vitest('passed'),
    junitXml: JUNIT,
    jobs: { ts: 'success', rust: 'success' },
    today: '2026-11-04',
    ...over,
  });

describe('quarantine report', () => {
  it('parses vitest JSON and nextest JUnit', () => {
    expect(vitestCases(vitest('failed')).get('/w/repo/packages/web/src/A.test.tsx')).toEqual([
      { name: 'a ok', failed: false },
      { name: 'a flaky', failed: true },
    ]);
    expect(vitestCases(null).size).toBe(0);
    expect(junitCases(JUNIT).map((c) => [c.name, c.failed])).toEqual([
      ['daemon::tests::kill_real::one', false],
      ['daemon::tests::kill_real::two', true],
      ['daemon::tests::other::three', true],
    ]);
  });

  it('one line per row: passed, still failing (only its own cases)', () => {
    const { markdown, warnings } = report({});
    expect(markdown).toContain('| `A.test.tsx` | WF-T1 | 2026-12-01 | passed (2) |');
    expect(markdown).toContain('**still failing** (1/2): daemon::tests::kill_real::two');
    expect(markdown).not.toContain('other::three');
    expect(warnings).toEqual([
      'still failing: `daemon::tests::kill_real` (crates/conductor-daemon/src/daemon/tests/kill_real.rs)',
    ]);
  });

  it('a failing TS file is still failing', () => {
    expect(report({ vitestJson: vitest('failed') }).markdown).toContain(
      '**still failing** (1/2): a flaky',
    );
  });

  it('no results: not run, or infrastructure when the job never got a runner', () => {
    const { markdown, warnings } = report({
      vitestJson: null,
      junitXml: null,
      jobs: { ts: 'skipped', rust: 'infrastructure' },
    });
    expect(markdown).toContain('not run (job: skipped)');
    expect(markdown).toContain('infrastructure: job cancelled before a runner was assigned');
    expect(warnings).toEqual([]);
  });

  it('flags an overdue row', () => {
    const { markdown, warnings } = report({ rows: [row({ fixBy: '2026-11-01' })] });
    expect(markdown).toContain('**2026-11-01 (overdue)**');
    expect(warnings).toEqual(['overdue: x was to be fixed or deleted by 2026-11-01 (WF-T1)']);
  });
});

describe('a job cancelled before a runner was assigned', () => {
  it('noRunner: no runner name and no steps', () => {
    expect(noRunner({ runner_name: null, steps: [] })).toBe(true);
    expect(noRunner({ runner_name: '', steps: null })).toBe(true);
    expect(noRunner({ runner_name: 'GitHub Actions 3', steps: [{}] })).toBe(false);
    expect(noRunner({ runner_name: null, steps: [{}] })).toBe(false);
  });

  const jobs = () => [
    { name: 'ts', runner_name: 'GitHub Actions 1', steps: [{}] },
    { name: 'rust (macos-latest)', runner_name: null, steps: [] },
  ];
  it.each([
    ['cancelled', false, /^rust\b/, 'infrastructure'],
    ['cancelled', false, /^ts\b/, 'cancelled'],
    ['success', true, /^rust\b/, 'success'],
    ['skipped', false, /^rust\b/, 'skipped'],
  ])('%s, results %s, %s → %s', (result, has, name, want) => {
    expect(jobState(result, has, jobs, name)).toBe(want);
  });
  it('keeps the workflow result when GitHub cannot be asked', () => {
    expect(
      jobState(
        'cancelled',
        false,
        () => {
          throw new Error('no gh');
        },
        /^rust\b/,
      ),
    ).toBe('cancelled');
    expect(jobState('cancelled', false, null, /^rust\b/)).toBe('cancelled');
  });
});
