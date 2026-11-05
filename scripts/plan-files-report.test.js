// @ts-check
import { describe, expect, it } from 'vitest';
import { classify, covers, plannedFiles, sessionsSql, summarize } from './plan-files-report.js';

describe('plannedFiles (JS copy of plannedFilesOf)', () => {
  it('absent, malformed and present', () => {
    expect(plannedFiles({ plan: 'p' })).toBeNull();
    expect(plannedFiles({ files: 'a' })).toBeNull();
    expect(plannedFiles({ files: ['ok', '../x'] })).toBeNull();
    expect(plannedFiles({ files: [] })).toEqual([]);
    expect(plannedFiles({ files: ['a', ' a ', 'b/**'] })).toEqual(['a', 'b/**']);
  });
});

describe('covers', () => {
  it('equal, glob and directory', () => {
    expect(covers('docs/x.md', 'docs/x.md')).toBe(true);
    expect(covers('packages/web/src/a/b.ts', 'packages/web/src/**')).toBe(true);
    expect(covers('scripts/a.js', 'scripts/*.js')).toBe(true);
    expect(covers('docs/design/x.md', 'docs/design')).toBe(true);
    expect(covers('docs/other.md', 'docs/design')).toBe(false);
  });
});

describe('classify', () => {
  it('no files: not present, nothing measured', () => {
    expect(classify({ plan: 'p' }, ['a'])).toEqual({
      present: false,
      empty: false,
      inside: null,
      outside: [],
    });
  });
  it('files and no PR yet', () => {
    expect(classify({ files: ['a'] }, null)).toMatchObject({ present: true, inside: null });
  });
  it('inside and outside the list', () => {
    expect(classify({ files: ['src/**'] }, ['src/a.ts'])).toMatchObject({ inside: true });
    expect(classify({ files: ['src/**'] }, ['src/a.ts', 'docs/b.md'])).toMatchObject({
      inside: false,
      outside: ['docs/b.md'],
    });
    expect(classify({ files: [] }, ['a'])).toMatchObject({ empty: true, inside: false });
  });
});

describe('summarize', () => {
  const row = (/** @type {Partial<import('./plan-files-report.js').Row>} */ r) => ({
    ticket: 't',
    title: 'T',
    pr: null,
    hasFilesHeading: false,
    present: true,
    empty: false,
    inside: true,
    outside: [],
    ...r,
  });
  it('counts against the T7 thresholds', () => {
    const rows = [
      ...Array.from({ length: 18 }, () => row({})),
      row({ present: false, inside: null }),
      row({ inside: false, outside: ['x.ts'], pr: 'https://github.com/o/r/pull/1' }),
    ];
    const md = summarize(rows);
    expect(md).toContain('| `files` present | 19 / 20 (T7 needs ≥ 18/20: pass) |');
    expect(md).toContain('| diff inside the list | 18 / 20 (T7 needs ≥ 15/20: pass) |');
    expect(md).toContain('| `files` absent or malformed | 1 |');
    expect(md).toContain('- T (https://github.com/o/r/pull/1): `x.ts`');
  });
  it('fails below the thresholds and notes a short sample', () => {
    const md = summarize([row({ present: false, inside: null })]);
    expect(md).toContain('0 / 1 (T7 needs ≥ 18/20: fail)');
    expect(md).toContain('Only 1 plans so far');
  });
});

describe('sessionsSql', () => {
  it('quotes its inputs', () => {
    const sql = sessionsSql('planning', "o'r", '2026-11-06', 20);
    expect(sql).toContain("t.repo = 'o''r'");
    expect(sql).toContain('LIMIT 20');
  });
});
