import { realpathSync } from 'node:fs';

// ADR-0024: comparing paths on each OS. Call sites import this instead of testing
// `process.platform`.

/**
 * Do `a` and `b` name the same existing file or directory? POSIX: equal realpaths (as before).
 * win32: `realpathSync.native` on both (it expands 8.3 short names such as `RUNNER~1`, which git
 * never prints, and resolves junctions), compared case-insensitively. False when either is
 * missing.
 */
export function samePath(a: string, b: string): boolean {
  try {
    if (process.platform !== 'win32') return realpathSync(a) === realpathSync(b);
    return realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();
  } catch {
    return false;
  }
}
