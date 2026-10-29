import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeTreeOrLeave } from '../test-support/remove-tree.js';
import {
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_FILES,
  readScreenshots,
  screenshotDir,
  screenshotEnv,
  screenshotsSection,
} from './screenshots.js';

// M2-T35b: the agent-written screenshot directory, read as untrusted input.

const onWin32 = process.platform === 'win32';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('img'),
]);
const SID = '0f0e0d0c-0b0a-4908-8706-050403020100';

let tmp: string;
let dir: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-shots-')));
  dir = join(tmp, 'shots');
  mkdirSync(dir);
});
afterEach(() => removeTreeOrLeave(tmp));
const save = (name: string, bytes: Buffer = PNG) => writeFileSync(join(dir, name), bytes);

describe('screenshotDir / screenshotEnv', () => {
  it('is <root>/artifacts/<session>/screenshots, created on demand; a non-UUID id gets none', () => {
    expect(screenshotDir(tmp, SID)).toBe(join(tmp, 'artifacts', SID, 'screenshots'));
    expect(screenshotDir(tmp, '../../etc')).toBeNull();
    const env = screenshotEnv(tmp, SID);
    expect(env).toEqual({ CONDUCTOR_SCREENSHOT_DIR: join(tmp, 'artifacts', SID, 'screenshots') });
    expect(readScreenshots(env.CONDUCTOR_SCREENSHOT_DIR!)).toEqual({
      views: [],
      files: [],
      skipped: [],
    });
    expect(screenshotEnv(tmp, 'nope')).toEqual({});
  });
});

describe('readScreenshots', () => {
  it('keeps complete pairs in view order; lonely files and bad names are skipped with a reason', () => {
    save('before-nav.png');
    save('after-nav.png');
    save('before-board.png');
    save('after-board.png');
    save('after-lonely.png');
    save('Before-Other.png'); // not Before-Nav.png: a case-insensitive FS (NTFS) would overwrite before-nav.png
    save('notes.txt');
    const r = readScreenshots(dir);
    expect(r.views).toEqual(['board', 'nav']);
    expect(r.files.map((f) => f.name)).toEqual([
      'before-board.png',
      'after-board.png',
      'before-nav.png',
      'after-nav.png',
    ]);
    expect(r.files[0]!.bytes.equals(PNG)).toBe(true);
    expect(r.skipped).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Before-Other.png: not named'),
        expect.stringContaining('notes.txt: not named'),
        'after-lonely.png: no matching before file',
      ]),
    );
  });

  it('refuses non-PNG bytes and files over the size cap', () => {
    save('before-a.png', Buffer.from('GIF89a'));
    save('after-a.png');
    save('before-b.png', Buffer.concat([PNG, Buffer.alloc(MAX_SCREENSHOT_BYTES)]));
    save('after-b.png');
    const r = readScreenshots(dir);
    expect(r.views).toEqual([]);
    expect(r.skipped).toEqual(
      expect.arrayContaining(['before-a.png: not a PNG', 'before-b.png: over 5 MB']),
    );
  });

  it.skipIf(onWin32)(
    'never follows a symlink: a linked file or a linked directory is refused',
    () => {
      const secret = join(tmp, 'secret.png');
      writeFileSync(secret, PNG);
      symlinkSync(secret, join(dir, 'before-x.png'));
      save('after-x.png');
      expect(readScreenshots(dir).views).toEqual([]);
      expect(readScreenshots(dir).skipped).toContain('before-x.png: not a regular file');

      const linkedDir = join(tmp, 'linked');
      symlinkSync(dir, linkedDir);
      expect(readScreenshots(linkedDir)).toMatchObject({ views: [], files: [] });
    },
  );

  it(`reads at most ${MAX_SCREENSHOT_FILES} files`, () => {
    for (let k = 0; k < 12; k++) {
      save(`before-v${k}.png`);
      save(`after-v${k}.png`);
    }
    const r = readScreenshots(dir);
    expect(r.files.length).toBeLessThanOrEqual(MAX_SCREENSHOT_FILES);
    expect(r.skipped.some((s) => s.includes(`more than ${MAX_SCREENSHOT_FILES} files`))).toBe(true);
  });

  it('a missing directory is an empty set', () => {
    expect(readScreenshots(join(tmp, 'none'))).toEqual({ views: [], files: [], skipped: [] });
  });
});

describe('screenshotsSection', () => {
  it('is a Before / After table per view, then the marker with the pair count', () => {
    const s = screenshotsSection(['nav'], (n) => `https://x/${n}`);
    expect(s).toBe(
      [
        '## Screenshots',
        '',
        '| View | Before | After |',
        '| --- | --- | --- |',
        '| nav | ![before nav](https://x/before-nav.png) | ![after nav](https://x/after-nav.png) |',
        '',
        '<!-- conductor:screenshots pairs=1 -->',
      ].join('\n'),
    );
  });
});
