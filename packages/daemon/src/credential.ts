import { lstatSync, readFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { API_PATHS } from '@conductor/shared';
import { z } from 'zod';
import { assertOwnerOnly, mkdirPrivate, writePrivateFile } from './platform/index.js';

// The machine credential (M2-T04; ADR-0013 §Enrollment, ADR-0017 §Daemon distribution):
// `<root>/machine.json` = {url, machine_id, credential}, file 0600 in a 0700 directory, both
// lstat- and owner-checked like ADR-0010's private repos. On win32 the same checks are an owner-only
// DACL (ADR-0024 §3, platform/acl.ts). No file = local mode (M1 behaviour).
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

/**
 * Refuse a root that is a symlink, not a directory, or owned by another user (win32: also any DACL
 * that isn't owner-only).
 */
export function checkPrivateDir(dir: string): void {
  assertOwnerOnly(dir, { kind: 'dir' });
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
  checkPrivateDir(rootDir);
  // Type, owner, and nobody else can read it (POSIX `mode & 0o077`, win32 the DACL).
  assertOwnerOnly(path, { kind: 'file' });
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

/** Write the credential atomically (private temp file + rename) into a private root. */
export function writeCredential(
  rootDir: string,
  cred: MachineCredential,
  opts: { force: boolean },
): string {
  const data = MachineCredentialSchema.parse(cred);
  mkdirPrivate(rootDir);
  checkWritable(rootDir, opts);
  const path = credentialPath(rootDir);
  writePrivateFile(path, `${JSON.stringify(data, null, 2)}\n`);
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
