import { describe, expect, it } from 'vitest';
import { cliVersionFrom } from './version.js';

describe('cliVersionFrom', () => {
  it.each([
    ['gh version 2.40.0 (2023-12-07)\nhttps://github.com/cli/cli/releases/tag/v2.40.0\n', '2.40.0'],
    ['azure-cli                         2.60.0 *\n\ncore 2.60.0\n', '2.60.0'],
    ['git version 2.45.0\n', '2.45.0'],
    ['(Version="1.5.1", GitCommit="", GoVersion="go1.22")', '1.5.1'],
    ['2.1.308 (Claude Code)', '2.1.308'],
    ['tool 3.0.0-rc.1', '3.0.0-rc.1'],
  ])('%j → %s', (out, v) => expect(cliVersionFrom(out)).toBe(v));

  it('garbage → null', () => {
    for (const out of ['', 'gh version unknown', 'v2.40', 'nothing here']) {
      expect(cliVersionFrom(out)).toBeNull();
    }
  });
});
