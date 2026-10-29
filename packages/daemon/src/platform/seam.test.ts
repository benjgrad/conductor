import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ADR-0024 §1: every OS branch in the daemon lives in platform/, next to its other-OS twin, and
// is exercised by the Windows CI job as well as on POSIX. So a daemon change can't add POSIX-only
// (or Windows-only) behaviour outside platform/ without this test failing on every OS.

const SRC = fileURLToPath(new URL('..', import.meta.url));

/**
 * Files allowed to mention process.platform outside platform/, and why. Keep this list short:
 * a new entry needs the same reason class.
 */
const ALLOWED: Record<string, string> = {
  // The hook script is text run by its own `node` process on the target OS; its win32 branch is
  // covered by edit-guard.test.ts under cmd.exe and Git Bash.
  'claude/edit-guard.ts': 'script text for a separate process',
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory())
      return e.name === 'platform' || e.name === 'test-support' ? [] : sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

describe('platform seam (ADR-0024 §1)', () => {
  it('no daemon source outside platform/ branches on process.platform', () => {
    const offenders = sources(SRC)
      .map((f) => relative(SRC, f).split('\\').join('/'))
      .filter((rel) => !(rel in ALLOWED))
      .filter((rel) => /\bprocess\.platform\b/.test(readFileSync(join(SRC, rel), 'utf8')));
    expect(offenders, 'move the OS branch into src/platform/ (with its win32 twin)').toEqual([]);
  });
});
