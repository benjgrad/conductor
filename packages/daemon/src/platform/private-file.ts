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
import { AclError, assertOwnerOnly, mkdirPrivate, writePrivateFile } from './acl.js';

// TD-118 (M2-T18): private files without a check-then-use window, for the machine credential.
// POSIX: the file is opened with O_NOFOLLOW and checked with fstat on that same fd; a strict dir is
// 0700-style and ours; a write chmods the dir through an O_NOFOLLOW fd (never by path, so never
// through a symlink), and fsyncs the file and then the dir. win32: acl.ts's owner-only DACL checks
// and writes (ADR-0024 §3); NTFS has no O_NOFOLLOW, and lstat already refuses junctions there.

const isWin32 = (): boolean => process.platform === 'win32';

/** O_NOFOLLOW / O_DIRECTORY are POSIX-only; 0 where Node doesn't define them. */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;

/** Test hook: the fsync calls (file, then dir) are observable. */
export interface DurableIo {
  fsync(fd: number): void;
}
const DEFAULT_IO: DurableIo = { fsync: fsyncSync };

function ownedByUs(st: Stats): boolean {
  return process.getuid === undefined || st.uid === process.getuid();
}

/**
 * Refuse `dir` unless it is a real directory owned by this user that nobody else can access:
 * POSIX `mode & 0o077` is 0 too (acl.ts checks only a dir's type and owner there), win32 the DACL.
 */
export function assertPrivateDir(dir: string): void {
  assertOwnerOnly(dir, { kind: 'dir' });
  if (isWin32()) return;
  if ((lstatSync(dir).mode & 0o077) !== 0) {
    throw new AclError('too-open', `${dir} is accessible to other users; run: chmod 700 ${dir}`);
  }
}

/** Read a file only this user can read: type, owner and mode are checked on the open fd (POSIX). */
export function readPrivateFile(path: string): string {
  if (isWin32()) {
    assertOwnerOnly(path, { kind: 'file' });
    return readFileSync(path, 'utf8');
  }
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
    if (!st.isFile()) throw new AclError('wrong-type', `${path} is not a regular file`);
    if (!ownedByUs(st)) {
      throw new AclError('foreign-owner', `${path} is owned by another user; refusing to use it`);
    }
    if ((st.mode & 0o077) !== 0) {
      throw new AclError('too-open', `${path} is readable by other users; run: chmod 600 ${path}`);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Write `<dir>/<name>` atomically and durably, readable only by this user, creating `dir` private.
 * `beforeWrite` runs once `dir` is private and before anything is written (e.g. "no file yet").
 * Returns the file's path.
 */
export function writePrivateFileDurable(
  dir: string,
  name: string,
  data: string,
  opts: { beforeWrite?: () => void; io?: DurableIo } = {},
): string {
  const path = join(dir, name);
  if (isWin32()) {
    mkdirPrivate(dir);
    opts.beforeWrite?.();
    writePrivateFile(path, data);
    return path;
  }
  const io = opts.io ?? DEFAULT_IO;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirFd = openPrivateDirPosix(dir);
  try {
    fchmodSync(dirFd, 0o700);
    opts.beforeWrite?.();
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    const fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        fchmodSync(fd, 0o600); // umask-proof
        writeSync(fd, data);
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
    let link = code === 'ELOOP';
    if (code === 'ENOTDIR') {
      try {
        link = lstatSync(dir).isSymbolicLink();
      } catch {
        link = false;
      }
    }
    if (link) throw new Error(`${dir} is a symlink; refusing to use it`, { cause: e });
    if (code === 'ENOTDIR') throw new Error(`${dir} is not a directory`, { cause: e });
    throw e;
  }
  const st = fstatSync(fd);
  if (!st.isDirectory() || !ownedByUs(st)) {
    closeSync(fd);
    throw new AclError('foreign-owner', `${dir} is owned by another user; refusing to use it`);
  }
  return fd;
}
