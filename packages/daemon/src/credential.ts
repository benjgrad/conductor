import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';
import { API_PATHS } from '@conductor/shared';
import { z } from 'zod';

// The machine credential (M2-T04; ADR-0013 §Enrollment, ADR-0017 §Daemon distribution):
// `<root>/machine.json` = {url, machine_id, credential}, file 0600 in a 0700 directory, both
// lstat- and owner-checked like ADR-0010's private repos. No file = local mode (M1 behaviour).
// Error messages name paths, never the credential.

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

function foreign(st: Stats): boolean {
  return process.getuid !== undefined && st.uid !== process.getuid();
}

/** Refuse a root that is a symlink, not a directory, or owned by another user. */
export function checkPrivateDir(dir: string): void {
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) throw new Error(`${dir} is a symlink; refusing to use it`);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (foreign(st)) throw new Error(`${dir} is owned by another user; refusing to use it`);
}

/** Refuse an existing credential file that is a symlink, not a file, or owned by another user. */
function checkFile(path: string, st: Stats): void {
  if (st.isSymbolicLink()) throw new Error(`${path} is a symlink; refusing to use it`);
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  if (foreign(st)) throw new Error(`${path} is owned by another user; refusing to use it`);
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
  const st = lstatOrNull(path);
  if (st === null) return;
  checkFile(path, st);
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
  const st = lstatOrNull(path);
  if (st === null) return null;
  checkPrivateDir(rootDir);
  checkFile(path, st);
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`${path} is readable by other users; run: chmod 600 ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON; enroll again with --force`);
  }
  const parsed = MachineCredentialSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))];
    throw new Error(`${path} is invalid (${fields.join(', ')}); enroll again with --force`);
  }
  return parsed.data;
}

/** Write the credential atomically (temp file 0600 + rename) into a 0700 root. */
export function writeCredential(
  rootDir: string,
  cred: MachineCredential,
  opts: { force: boolean },
): string {
  const data = MachineCredentialSchema.parse(cred);
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  checkWritable(rootDir, opts);
  chmodSync(rootDir, 0o700);
  const path = credentialPath(rootDir);
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return path;
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
