import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';
import { API_PATHS } from '@conductor/shared';
import { z } from 'zod';
import { assertOwnerOnly, mkdirPrivate, writePrivateFile } from './platform/index.js';

// The machine credential (M2-T04; ADR-0013 §Enrollment, ADR-0017 §Daemon distribution):
// `<root>/machine.json` = {url, machine_id, credential}, file 0600 in a 0700 directory, both
// lstat- and owner-checked like ADR-0010's private repos. On win32 the same checks are an owner-only
// DACL (ADR-0024 §3, platform/acl.ts). No file = local mode (M1 behaviour).
// Error messages name paths, never the credential.
// TD-118 (M2-T18), POSIX: the file is opened with O_NOFOLLOW and checked with fstat on that fd (no
// lstat-then-read window); a loaded root must be 0700 and ours; a write fsyncs the file and the
// root, and the root is chmodded through an O_NOFOLLOW fd, never by path.

export const CREDENTIAL_FILE = 'machine.json';

/** Hosts that may be reached over plain http/ws (dev and tests); everything else needs TLS. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** True for an https/wss URL, or an http/ws URL to a LOOPBACK_HOSTS host. */
export function isSecureOrLoopback(url: URL): boolean {
  if (url.protocol === 'https:' || url.protocol === 'wss:') return true;
  return (url.protocol === 'http:' || url.protocol === 'ws:') && LOOPBACK_HOSTS.has(url.hostname);
}

const MachineCredentialSchema = z.object({
  url: z
    .string()
    .refine(
      (u) =>
        URL.canParse(u) && /^https?:$/.test(new URL(u).protocol) && isSecureOrLoopback(new URL(u)),
      'not an https URL (plain http only to a loopback host)',
    ),
  machine_id: z.string().min(1),
  credential: z.string().min(1),
});
export type MachineCredential = z.infer<typeof MachineCredentialSchema>;

export function credentialPath(rootDir: string): string {
  return join(rootDir, CREDENTIAL_FILE);
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

const isWin32 = (): boolean => process.platform === 'win32';

/** O_NOFOLLOW / O_DIRECTORY are POSIX-only; 0 where Node doesn't define them. */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;

/** Test hook: the fsync calls (file, then root) are observable. */
export interface CredentialIo {
  fsync(fd: number): void;
}
const DEFAULT_IO: CredentialIo = { fsync: fsyncSync };

function ownedByUs(st: Stats): boolean {
  return process.getuid === undefined || st.uid === process.getuid();
}

/**
 * Refuse a root that is a symlink, not a directory, or owned by another user (win32: also any DACL
 * that isn't owner-only). POSIX with `checkMode` (loading): also anything but 0700-style privacy.
 */
export function checkPrivateDir(dir: string, opts: { checkMode?: boolean } = {}): void {
  assertOwnerOnly(dir, { kind: 'dir' });
  if (isWin32() || opts.checkMode !== true) return;
  if ((lstatSync(dir).mode & 0o077) !== 0) {
    throw new Error(`${dir} is accessible to other users; run: chmod 700 ${dir}`);
  }
}

/** POSIX: read `path` through an O_NOFOLLOW fd, checking that same fd (type, owner, mode). */
function readPrivateFilePosix(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`${path} is a symlink; refusing to use it`, { cause: e });
    }
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} is not a regular file`);
    if (!ownedByUs(st)) throw new Error(`${path} is owned by another user; refusing to use it`);
    if ((st.mode & 0o077) !== 0) {
      throw new Error(`${path} is readable by other users; run: chmod 600 ${path}`);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Check that a credential could be written under `rootDir`: the root (if it exists) is private and
 * there is no credential yet, unless `force` (a symlinked or foreign file is refused even then).
 * Used by `enroll` before it spends the one-time token.
 */
export function checkWritable(rootDir: string, opts: { force: boolean }): void {
  if (lstatOrNull(rootDir) === null) return;
  checkPrivateDir(rootDir);
  const path = credentialPath(rootDir);
  if (lstatOrNull(path) === null) return;
  // Type and owner only: the file is about to be replaced, so its mode doesn't matter.
  assertOwnerOnly(path, { kind: 'file', checkAccess: false });
  if (!opts.force) {
    throw new Error(
      `${path} already exists (this machine is enrolled); pass --force to replace it`,
    );
  }
}

/** The stored credential, or null (local mode) when `<root>/machine.json` does not exist. */
export function loadCredential(rootDir: string): MachineCredential | null {
  const path = credentialPath(rootDir);
  if (lstatOrNull(rootDir) === null) return null;
  if (lstatOrNull(path) === null) return null;
  checkPrivateDir(rootDir, { checkMode: true });
  // Type, owner, and nobody else can read it (POSIX `mode & 0o077` on the open fd, win32 the DACL).
  let text: string;
  if (isWin32()) {
    assertOwnerOnly(path, { kind: 'file' });
    text = readFileSync(path, 'utf8');
  } else {
    text = readPrivateFilePosix(path);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} is not valid JSON; enroll again with --force`, { cause: e });
  }
  const parsed = MachineCredentialSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))];
    throw new Error(`${path} is invalid (${fields.join(', ')}); enroll again with --force`);
  }
  return parsed.data;
}

/**
 * Write the credential atomically (private temp file + rename) into a private root. POSIX: the
 * root is made 0700 through an O_NOFOLLOW fd, and the file and the root are fsynced.
 */
export function writeCredential(
  rootDir: string,
  cred: MachineCredential,
  opts: { force: boolean },
  io: CredentialIo = DEFAULT_IO,
): string {
  const data = MachineCredentialSchema.parse(cred);
  const path = credentialPath(rootDir);
  const body = `${JSON.stringify(data, null, 2)}\n`;
  if (isWin32()) {
    mkdirPrivate(rootDir);
    checkWritable(rootDir, opts);
    writePrivateFile(path, body);
    return path;
  }
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const dirFd = openPrivateDirPosix(rootDir);
  try {
    fchmodSync(dirFd, 0o700);
    checkWritable(rootDir, opts);
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    const fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        fchmodSync(fd, 0o600); // umask-proof
        writeSync(fd, body);
        io.fsync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    // The rename itself survives a power cut only once the directory is synced.
    io.fsync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  return path;
}

/** POSIX: an fd on `dir` that is a real directory (not a symlink) owned by us. */
function openPrivateDirPosix(dir: string): number {
  let fd: number;
  try {
    fd = openSync(dir, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (e) {
    // O_DIRECTORY | O_NOFOLLOW on a symlink: ELOOP (macOS) or ENOTDIR (Linux).
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || (code === 'ENOTDIR' && lstatOrNull(dir)?.isSymbolicLink() === true))
      throw new Error(`${dir} is a symlink; refusing to use it`, { cause: e });
    if (code === 'ENOTDIR') throw new Error(`${dir} is not a directory`, { cause: e });
    throw e;
  }
  const st = fstatSync(fd);
  if (!st.isDirectory() || !ownedByUs(st)) {
    closeSync(fd);
    throw new Error(`${dir} is owned by another user; refusing to use it`);
  }
  return fd;
}

/** The daemon WS URL for a stored orchestrator URL: https → wss, http → ws, path daemonWs. */
export function daemonWsUrl(storedUrl: string): string {
  const u = new URL(storedUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = API_PATHS.daemonWs;
  u.search = '';
  u.hash = '';
  return u.toString();
}
