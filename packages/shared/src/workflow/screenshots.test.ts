import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_PATHS,
  SCREENSHOTS_MARKER_RE,
  globToRegExp,
  matchingPaths,
  screenshotPairs,
  screenshotsMarker,
} from './screenshots.js';

// M2-T35a: the pure helpers behind the `pr_screenshots` condition.

describe('globToRegExp', () => {
  it.each([
    ['**/*.tsx', 'App.tsx', true],
    ['**/*.tsx', 'packages/web/src/App.tsx', true],
    ['**/*.tsx', 'packages/web/src/App.ts', false],
    ['*.tsx', 'App.tsx', true],
    ['*.tsx', 'src/App.tsx', false],
    ['packages/web/**', 'packages/web/src/a/b.css', true],
    ['packages/web/**', 'packages/webx/a.css', false],
    ['src/**/test/*.ts', 'src/test/a.ts', true],
    ['src/**/test/*.ts', 'src/x/y/test/a.ts', true],
    ['**/*.{tsx,css}', 'a/b.css', true],
    ['**/*.{tsx,css}', 'a/b.scss', false],
    ['a?c.md', 'abc.md', true],
    ['a?c.md', 'a/c.md', false],
    ['docs/(x).md', 'docs/(x).md', true],
    ['**/*.css', '.github/x.css', true],
    ['a{b', 'a{b', true],
  ])('%s vs %s → %s', (glob, path, want) => {
    expect(globToRegExp(glob).test(path)).toBe(want);
  });
});

describe('matchingPaths', () => {
  it('keeps the paths any glob matches, in order; the defaults cover UI files', () => {
    const files = ['README.md', 'packages/web/src/App.tsx', 'src/x.ts', 'web/styles.css'];
    expect(matchingPaths(files, DEFAULT_UI_PATHS)).toEqual([
      'packages/web/src/App.tsx',
      'web/styles.css',
    ]);
    expect(matchingPaths(files, ['**/*.go'])).toEqual([]);
  });
});

describe('screenshotPairs', () => {
  it('pairs before-/after- files by view; strays and bad names do not count', () => {
    expect(
      screenshotPairs([
        'before-nav.png',
        'after-nav.png',
        'before-board.png',
        'after-settings.png',
        'after-Nav.png',
        'before-nav.jpg',
        'notes.txt',
      ]),
    ).toEqual(['nav']);
  });
});

describe('the PR body marker', () => {
  it('round-trips its pair count', () => {
    const body = `## Screenshots\n\n…\n\n${screenshotsMarker(3)}\n`;
    expect(SCREENSHOTS_MARKER_RE.exec(body)?.[1]).toBe('3');
    expect(SCREENSHOTS_MARKER_RE.exec('no table')).toBeNull();
  });
});
