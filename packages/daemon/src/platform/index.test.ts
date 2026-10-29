import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as platform from './index.js';

describe('platform seam', () => {
  it('exports the MW-T03 modules', () => {
    expect(typeof platform.spawnCli).toBe('function');
    expect(typeof platform.execFileCliSync).toBe('function');
    expect(typeof platform.killTree).toBe('function');
    expect(typeof platform.workflowShell).toBe('function');
    expect(typeof platform.readProcInfo).toBe('function');
  });

  // U-107 / spike N8: does lstat report a junction as a symbolic link? The edit guard and the
  // "never follow a symlink" checks rely on it. The value is printed for the record.
  it.runIf(process.platform === 'win32')('U-107: lstat on a junction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-junction-'));
    try {
      const target = join(dir, 'target');
      const link = join(dir, 'link');
      mkdirSync(target);
      symlinkSync(target, link, 'junction');
      const st = lstatSync(link);
      console.log(
        `U-107: lstatSync(junction).isSymbolicLink() = ${st.isSymbolicLink()}, ` +
          `isDirectory() = ${st.isDirectory()}, readlinkSync = ${readlinkSync(link)}`,
      );
      expect(typeof st.isSymbolicLink()).toBe('boolean');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
