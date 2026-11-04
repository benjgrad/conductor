// harness/acl.ts (MR-T16b): the pure halves of making the Windows temp dir owner-only. No stack.
import { describe, expect, it } from 'vitest';
import { ownerOnlyDirArgs, parseWhoamiSid } from './harness/acl.js';

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
});
