// @ts-check
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RUST_MARKER,
  asksForQuarantine,
  forPackage,
  nextestFilter,
  overdue,
  parseFlaky,
  quarantinedRust,
  quarantinedTs,
  readFlaky,
} from './test-flaky.js';

const md = (/** @type {string[]} */ rows) =>
  [
    'intro | not a row |',
    '<!-- flaky:start -->',
    '',
    '| Test   | File | First seen | Rounds caused | Owner ticket | Fix by |',
    '| ------ | ---- | ---------- | ------------- | ------------ | ------ |',
    ...rows,
    '',
    '<!-- flaky:end -->',
    '| after | the end |',
  ].join('\n');

const WEB =
  '| `A.test.tsx:3` (x) | `packages/web/src/A.test.tsx` | 2026-10-01 | 2 | WF-T1 | 2026-11-01 |';
const RUST =
  '| `daemon::tests::kill_real` (MR-T12) | `crates/c/src/daemon/tests/kill_real.rs` | 2026-10-02 | ≥1 | WF-T2 | 2026-12-01 |';

describe('parseFlaky', () => {
  it('reads padded rows between the markers, unquoting backticked cells', () => {
    expect(parseFlaky(md([WEB, RUST]))).toEqual([
      {
        test: '`A.test.tsx:3` (x)',
        file: 'packages/web/src/A.test.tsx',
        firstSeen: '2026-10-01',
        rounds: '2',
        owner: 'WF-T1',
        fixBy: '2026-11-01',
      },
      {
        test: '`daemon::tests::kill_real` (MR-T12)',
        file: 'crates/c/src/daemon/tests/kill_real.rs',
        firstSeen: '2026-10-02',
        rounds: '≥1',
        owner: 'WF-T2',
        fixBy: '2026-12-01',
      },
    ]);
  });

  it('is empty without the markers, or with only the header', () => {
    expect(parseFlaky('| a | b |\n| - | - |\n| c | d |')).toEqual([]);
    expect(parseFlaky(md([]))).toEqual([]);
  });

  it('splits TS from Rust, per package and as a nextest filter', () => {
    const rows = parseFlaky(md([WEB, RUST]));
    expect(quarantinedTs(rows)).toEqual(['packages/web/src/A.test.tsx']);
    expect(forPackage(rows, 'web')).toEqual(['src/A.test.tsx']);
    expect(forPackage(rows, 'daemon')).toEqual([]);
    expect(quarantinedRust(rows).map((r) => r.owner)).toEqual(['WF-T2']);
    expect(nextestFilter(rows)).toBe('test(/daemon::tests::kill_real::/)');
    expect(nextestFilter(parseFlaky(md([WEB])))).toBe('');
  });

  it('flags rows past their fix-by date', () => {
    const rows = parseFlaky(md([WEB, RUST]));
    expect(overdue(rows, '2026-11-01')).toEqual([]);
    expect(overdue(rows, '2026-11-02').map((r) => r.owner)).toEqual(['WF-T1']);
  });
});

describe('asksForQuarantine', () => {
  it.each([
    [['node', 'vitest', '--project', 'quarantine'], {}, true],
    [['node', 'vitest', 'run', '--project=quarantine'], {}, true],
    [['node', 'vitest', 'run'], { CONDUCTOR_TEST_QUARANTINE: '1' }, true],
    [['node', 'vitest', 'run'], {}, false],
    [['node', 'vitest', '--project', 'web'], {}, false],
  ])('%j %j → %s', (argv, env, want) => {
    expect(asksForQuarantine(argv, env)).toBe(want);
  });
});

// The real list against the repo: cheap file reads, so the gate keeps FLAKY.md honest.
describe('docs/tracking/FLAKY.md', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const rows = readFlaky(root);

  it('lists at least one test, each with an existing file and a YYYY-MM-DD fix-by date', () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(existsSync(join(root, r.file)), r.file).toBe(true);
      expect(r.fixBy, r.test).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(r.fixBy)), r.fixBy).toBe(false);
      expect(
        r.file.endsWith('.rs') || /^packages\/[^/]+\/.+\.test\.tsx?$/.test(r.file),
        r.file,
      ).toBe(true);
    }
  });

  it('every test fn in a listed Rust file carries the ignore marker', () => {
    for (const r of quarantinedRust(rows)) {
      const src = readFileSync(join(root, r.file), 'utf8');
      const tests = src.match(/^\s*#\[(?:tokio::)?test\b/gm)?.length ?? 0;
      expect(tests, r.file).toBeGreaterThan(0);
      expect(src.split(RUST_MARKER).length - 1, r.file).toBe(tests);
    }
  });

  it('no unlisted Rust file carries the ignore marker', () => {
    const listed = new Set(quarantinedRust(rows).map((r) => r.file));
    const marked = readdirSync(join(root, 'crates'), { recursive: true, encoding: 'utf8' })
      .map((f) => `crates/${f.split('\\').join('/')}`)
      .filter((f) => f.endsWith('.rs') && !f.includes('/target/'))
      .filter((f) => readFileSync(join(root, f), 'utf8').includes(RUST_MARKER));
    expect(marked.filter((f) => !listed.has(f))).toEqual([]);
  });
});
