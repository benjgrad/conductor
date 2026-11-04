// Windows only (MR-T16b): make the run's temp dir owner-only before the daemon puts its root in it.
// The daemon refuses to create its root under a folder that isn't private (platform/acl.rs
// `mkdir_private`), and only the per-user bases (the home dir, %LOCALAPPDATA%) are exempt: a real
// root lives under the home, but the stack's lives in %TEMP%\conductor-e2e-*, which inherits its
// parent's permissions. So the stack does what the daemon's refusal says to (`icacls … /inheritance:r
// /grant:r` for the user, SYSTEM and Administrators), with object + container inherit so everything
// the stack creates under it starts owner-only too (the daemon's owner_only_aces for a dir).
import { execFileSync } from 'node:child_process';

const SID_SYSTEM = 'S-1-5-18';
const SID_ADMINISTRATORS = 'S-1-5-32-544';

/** The SID in `whoami /user /fo csv /nh` output (`"host\user","S-1-5-…"`). Pure. */
export function parseWhoamiSid(out: string): string {
  const m = /"(S-1-[0-9-]+)"/.exec(out);
  if (!m) throw new Error(`cannot read the user's SID from whoami: ${out.trim()}`);
  return m[1]!;
}

/** The icacls argv that makes the directory `dir` owner-only, inheritably. Pure. */
export function ownerOnlyDirArgs(dir: string, userSid: string): string[] {
  return [
    dir,
    '/inheritance:r',
    '/grant:r',
    `*${userSid}:(OI)(CI)F`,
    `*${SID_SYSTEM}:(OI)(CI)F`,
    `*${SID_ADMINISTRATORS}:(OI)(CI)F`,
  ];
}

/** Make `dir` owner-only (Windows; spawns whoami and icacls, the boundary this needs). */
export function makeDirPrivate(dir: string): void {
  const sid = parseWhoamiSid(
    execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }),
  );
  execFileSync('icacls', ownerOnlyDirArgs(dir, sid), { stdio: 'pipe', windowsHide: true });
}
