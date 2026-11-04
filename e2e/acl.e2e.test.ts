// harness/acl.ts (MR-T16b): the pure halves of making the Windows temp dir owner-only. No stack.
import { describe, expect, it } from 'vitest';
import { ownerOnlyDirArgs, parseWhoamiSid, system32 } from './harness/acl.js';

describe('owner-only temp dir (Windows)', () => {
  it('reads the SID from whoami /user /fo csv /nh', () => {
    expect(parseWhoamiSid('"fv-az123\\runneradmin","S-1-5-21-3077485881-3661871218-500"\r\n')).toBe(
      'S-1-5-21-3077485881-3661871218-500',
    );
    expect(() => parseWhoamiSid('ERROR: access denied')).toThrow(/SID/);
  });

  it('removes inheritance and grants only the user, SYSTEM and Administrators, inheritably', () => {
    expect(ownerOnlyDirArgs('C:\\T\\conductor-e2e-x', 'S-1-5-21-1')).toEqual([
      'C:\\T\\conductor-e2e-x',
      '/inheritance:r',
      '/grant:r',
      '*S-1-5-21-1:(OI)(CI)F',
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F',
    ]);
  });

  it('runs Windows tools from System32, never a same-named one on PATH (Git Bash whoami)', () => {
    expect(system32('whoami.exe', { SystemRoot: 'C:\\Windows' })).toBe(
      'C:\\Windows\\System32\\whoami.exe',
    );
    expect(system32('icacls.exe', { windir: 'D:\\Win' })).toBe('D:\\Win\\System32\\icacls.exe');
    expect(system32('taskkill.exe', {})).toBe('C:\\Windows\\System32\\taskkill.exe');
  });
});
