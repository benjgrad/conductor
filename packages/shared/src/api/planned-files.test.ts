import { describe, expect, it } from 'vitest';
import { PlannedFileSchema, PlannedFilesSchema, plannedFilesOf } from './planned-files.js';

describe('planned files (ADR-0037 P4)', () => {
  it('a planning result without files parses and reads as null', () => {
    expect(plannedFilesOf({ plan: '# Plan', summary: 'S.' })).toBeNull();
  });

  it('a planning result with files reads them back', () => {
    const files = ['packages/shared/src/**', 'docs/x.md'];
    expect(plannedFilesOf({ plan: '# Plan', summary: 'S.', files })).toEqual(files);
  });

  it('an empty list is allowed and distinct from absent', () => {
    expect(plannedFilesOf({ plan: 'p', files: [] })).toEqual([]);
  });

  it('trims and de-duplicates in order', () => {
    expect(plannedFilesOf({ files: ['b.ts', ' a.ts ', 'b.ts'] })).toEqual(['b.ts', 'a.ts']);
  });

  it.each(['', '   ', '/etc/passwd', './x', '../x', 'a/../b', 'C:\\x', 'C:/x', 'a\\b', 'a\nb'])(
    'rejects %j',
    (bad) => {
      expect(PlannedFileSchema.safeParse(bad).success).toBe(false);
    },
  );

  it('rejects a glob longer than 200 characters', () => {
    expect(PlannedFileSchema.safeParse('a'.repeat(201)).success).toBe(false);
    expect(PlannedFileSchema.safeParse('a'.repeat(200)).success).toBe(true);
  });

  it('one bad entry makes the whole list read as null', () => {
    expect(PlannedFilesSchema.safeParse(['ok.ts', '../x']).success).toBe(false);
    expect(plannedFilesOf({ files: ['ok.ts', '../x'] })).toBeNull();
  });

  it('a non-array files, or a non-object result, reads as null', () => {
    expect(plannedFilesOf({ files: 'a.ts' })).toBeNull();
    expect(plannedFilesOf(null)).toBeNull();
    expect(plannedFilesOf(['a.ts'])).toBeNull();
    expect(plannedFilesOf('x')).toBeNull();
  });
});
