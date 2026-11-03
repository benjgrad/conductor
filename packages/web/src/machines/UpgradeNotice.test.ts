import { describe, expect, it } from 'vitest';
import { upgradeShells } from './UpgradeNotice.js';

// Stopgap until ADR-0021 auto-update (MR-T14); removed with UpgradeNotice in MR-T18a.
describe('upgradeShells', () => {
  it.each([
    ['darwin', { posix: true, windows: false }],
    ['linux', { posix: true, windows: false }],
    ['win32', { posix: false, windows: true }],
    ['Windows_NT', { posix: false, windows: true }],
    [null, { posix: true, windows: true }],
    [undefined, { posix: true, windows: true }],
  ])('%s → %o', (os, shells) => {
    expect(upgradeShells(os)).toEqual(shells);
  });
});
