import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

// MW-T04 (ADR-0024 §3, ADR-0010): private files and dirs on every OS.
//
// POSIX wraps today's logic from `credential.ts` / `config.ts` / `actions/open-pr.ts` unchanged:
// files 0600, dirs 0700, lstat (no symlinks), owner uid, and `mode & 0o077` on files.
//
// win32 has no useful mode bits and `process.getuid` is undefined, so an owner check written the
// POSIX way silently passes (windows-spike.md N6/N7). Instead:
// - write: `icacls <p> /setowner *<user>` then
//   `icacls <p> /inheritance:r /grant:r *<user>:F *S-1-5-18:F *S-1-5-32-544:F`
//   (dirs grant `(OI)(CI)F` so children start owner-only too);
// - verify: PowerShell `Get-Acl`, as SIDs, refusing a foreign owner, inheritance, or any allow-ACE
//   for a SID outside {user, SYSTEM, Administrators}. An ACL that can't be read is refused. The
//   SDDL is read too: any ACE that isn't a plain allow/deny (conditional, callback and object ACEs
//   are invisible to GetAccessRules) is refused, and the SDDL, the raw DACL's ACE count and the
//   parsed rules must agree, else the ACL counts as unreadable.
// - no inherited-permission window: a new file or dir starts with its parent's inherited ACL until
//   icacls tightens it, and a handle opened in that window keeps its access. So a private file is
//   only written into a dir that already passes the check, and mkdirPrivate only creates under an
//   owner-only ancestor or directly under the user's profile dir or %LOCALAPPDATA%. Those two are
//   per-user by default; we assume nobody widened them (if someone did, the whole profile is
//   exposed anyway). Each new level is restricted before the next is created. POSIX has no window:
//   open/mkdir create the file/dir 0600/0700 themselves.
// Every tool runs by absolute System32 path through execFile (argv array, no shell). The path is
// passed to PowerShell in the environment, never spliced into the script.

/** SYSTEM. */
export const SID_SYSTEM = 'S-1-5-18';
/** BUILTIN\Administrators. */
export const SID_ADMINISTRATORS = 'S-1-5-32-544';

export type AclKind = 'file' | 'dir';

export type AclRefusal =
  | 'wrong-type' // a symlink, or not the requested kind
  | 'foreign-owner'
  | 'too-open' // POSIX group/other mode bits, or a win32 allow-ACE for another SID
  | 'inherited' // win32: the DACL inherits from the parent
  | 'unreadable'; // win32: the ACL (or the current user's SID) could not be read

/** A refused private path. `reason` lets call sites keep their own wording if they need to. */
export class AclError extends Error {
  constructor(
    readonly reason: AclRefusal,
    message: string,
    /** win32 'foreign-owner': the owner SID found. */
    readonly owner?: string,
  ) {
    super(message);
    this.name = 'AclError';
  }
}

export interface AssertOwnerOnlyOptions {
  kind: AclKind;
  /**
   * Also check who else can access it (POSIX file mode, win32 DACL + inheritance). Default true.
   * False checks only the type and the owner: `credential.ts` `checkWritable` vetting a file it is
   * about to replace. POSIX never mode-checks a dir (ADR-0010 checks only its owner); win32 checks
   * a dir's DACL (ADR-0024 §3).
   */
  checkAccess?: boolean;
}

const isWin32 = (): boolean => process.platform === 'win32';

// ---------------------------------------------------------------------------------------------
// Public API

/**
 * The current user's SID (`whoami /user /fo csv`), cached for the process. win32 only: throws
 * elsewhere, and throws if whoami fails or prints something that is not a SID.
 */
export function currentUserSid(): string {
  if (cachedSid !== undefined) return cachedSid;
  if (!isWin32()) throw new Error('currentUserSid is only available on win32');
  let out: string;
  try {
    out = run(system32('whoami.exe'), ['/user', '/fo', 'csv']);
  } catch (e) {
    throw new AclError('unreadable', `cannot determine the current user's SID: ${errText(e)}`);
  }
  cachedSid = parseWhoamiCsv(out);
  return cachedSid;
}
let cachedSid: string | undefined;

/**
 * Write `data` to `path` atomically, readable only by this user: a temp file next to it, made
 * private before it holds any data, then renamed over `path`. The parent must exist.
 */
export function writePrivateFile(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  if (!isWin32()) {
    // As config.ts writeFileConfig: create 0600 exclusively, chmod (umask-proof), rename.
    writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
    try {
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    return;
  }
  // The temp file inherits its folder's ACL until it is restricted, so the folder must already be
  // private. Then: create it empty, restrict it, check it, and only then put the secret in it.
  const dir = dirname(resolve(path));
  try {
    assertWin32(dir, { kind: 'dir' });
  } catch (e) {
    if (!(e instanceof AclError)) throw e;
    throw new AclError(
      e.reason,
      `refusing to write ${path}: its folder is not private (${e.message})`,
      e.owner,
    );
  }
  writeFileSync(tmp, '', { flag: 'wx' });
  try {
    restrictWin32(tmp, 'file');
    assertWin32(tmp, { kind: 'file' });
    writeFileSync(tmp, data, { flag: 'r+' });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Create `path` (and any missing parents) and make it private: refuse it if it is a symlink, not a
 * directory, or owned by someone else, then chmod 0700 (POSIX) or apply the owner-only DACL and
 * verify it (win32).
 */
export function mkdirPrivate(path: string): void {
  if (!isWin32()) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    // Type and owner first: chmod follows symlinks, and a foreign dir must not be touched.
    assertOwnerOnly(path, { kind: 'dir', checkAccess: false });
    chmodSync(path, 0o700);
    return;
  }
  // The levels to create, outermost first, and the nearest existing ancestor.
  const missing: string[] = [];
  let ancestor = resolve(path);
  while (lstatOrNull(ancestor) === null) {
    missing.unshift(ancestor);
    const up = dirname(ancestor);
    if (up === ancestor) break;
    ancestor = up;
  }
  if (missing.length > 0 && !isPerUserBase(ancestor)) {
    try {
      assertWin32(ancestor, { kind: 'dir' });
    } catch (e) {
      if (!(e instanceof AclError)) throw e;
      throw new AclError(
        e.reason,
        `refusing to create ${path}: ${ancestor} is not private (${e.message})`,
        e.owner,
      );
    }
  }
  for (const dir of missing) {
    try {
      mkdirSync(dir);
    } catch (e) {
      // Created concurrently: the owner check below decides whether it is ours.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    makeDirPrivateWin32(dir);
  }
  if (missing.length === 0) makeDirPrivateWin32(resolve(path));
}

/**
 * Type and owner first, as on POSIX. An elevated admin's new dirs are owned by Administrators (the
 * token's default owner), so that owner is accepted here only: Administrators already holds full
 * control in the final DACL, restrictWin32 makes the user the owner, and the final check requires
 * exactly that.
 */
function makeDirPrivateWin32(dir: string): void {
  assertType(dir, lstatSync(dir), 'dir');
  const pre = evaluateWinAcl(readWinAcl(dir), {
    path: dir,
    userSid: currentUserSid(),
    checkAccess: false,
  });
  if (pre && !(pre.reason === 'foreign-owner' && pre.owner === SID_ADMINISTRATORS)) throw pre;
  restrictWin32(dir, 'dir');
  assertWin32(dir, { kind: 'dir' });
}

/** The user's profile dir or %LOCALAPPDATA% (per-user by default; see the header). */
function isPerUserBase(dir: string): boolean {
  const canon = (p: string): string | null => {
    try {
      return realpathSync.native(p).toLowerCase();
    } catch {
      return null;
    }
  };
  const target = canon(dir);
  if (target === null) return false;
  return [homedir(), process.env.LOCALAPPDATA]
    .filter((p): p is string => p !== undefined && p !== '')
    .some((p) => canon(p) === target);
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
 * Refuse `path` unless it is a real file/dir (lstat: no symlink, no junction) owned by this user
 * and, with `checkAccess` (default), private to it. Throws AclError. A missing path throws the
 * underlying ENOENT, as `credential.ts` does today.
 */
export function assertOwnerOnly(path: string, opts: AssertOwnerOnlyOptions): void {
  if (isWin32()) {
    assertWin32(path, opts);
    return;
  }
  assertPosix(path, opts);
}

// ---------------------------------------------------------------------------------------------
// POSIX (copied from credential.ts; messages unchanged)

function assertPosix(path: string, opts: AssertOwnerOnlyOptions): void {
  const st = lstatSync(path);
  assertType(path, st, opts.kind);
  if (process.getuid !== undefined && st.uid !== process.getuid()) {
    throw new AclError('foreign-owner', `${path} is owned by another user; refusing to use it`);
  }
  if (opts.kind === 'file' && (opts.checkAccess ?? true) && (st.mode & 0o077) !== 0) {
    throw new AclError('too-open', `${path} is readable by other users; run: chmod 600 ${path}`);
  }
}

function assertType(
  path: string,
  st: { isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean },
  kind: AclKind,
): void {
  if (st.isSymbolicLink()) {
    throw new AclError('wrong-type', `${path} is a symlink; refusing to use it`);
  }
  if (kind === 'dir' && !st.isDirectory()) {
    throw new AclError('wrong-type', `${path} is not a directory`);
  }
  if (kind === 'file' && !st.isFile()) {
    throw new AclError('wrong-type', `${path} is not a regular file`);
  }
}

// ---------------------------------------------------------------------------------------------
// win32

function assertWin32(path: string, opts: AssertOwnerOnlyOptions): void {
  // Node's lstat reports junctions as symlinks too.
  assertType(path, lstatSync(path), opts.kind);
  const userSid = currentUserSid();
  const refusal = evaluateWinAcl(readWinAcl(path), {
    path,
    userSid,
    checkAccess: opts.checkAccess ?? true,
  });
  if (refusal) throw refusal;
}

/** win32: the owner and DACL of `path` as SIDs (Get-Acl). Throws AclError 'unreadable'. */
export function readWinAcl(path: string): WinAcl {
  try {
    return parseGetAclJson(
      run(system32('WindowsPowerShell', 'v1.0', 'powershell.exe'), POWERSHELL_ARGS, {
        CONDUCTOR_ACL_PATH: path,
      }),
    );
  } catch (e) {
    throw new AclError(
      'unreadable',
      `cannot read the permissions of ${path} (${errText(e)}); refusing to use it`,
    );
  }
}

function restrictWin32(path: string, kind: AclKind): void {
  const sid = currentUserSid();
  const icacls = system32('icacls.exe');
  try {
    // The owner first, while inherited ACEs still give us WRITE_OWNER: an elevated admin's new
    // files can default to being owned by Administrators.
    run(icacls, [path, '/setowner', `*${sid}`, '/q']);
    run(icacls, icaclsRestrictArgs(path, sid, kind));
  } catch (e) {
    throw new AclError('unreadable', `cannot restrict the permissions of ${path}: ${errText(e)}`);
  }
}

/** The icacls argv that makes `path` owner-only (user, SYSTEM, Administrators; no inheritance). */
export function icaclsRestrictArgs(path: string, userSid: string, kind: AclKind): string[] {
  const inherit = kind === 'dir' ? '(OI)(CI)' : '';
  return [
    path,
    '/inheritance:r',
    '/grant:r',
    `*${userSid}:${inherit}F`,
    `*${SID_SYSTEM}:${inherit}F`,
    `*${SID_ADMINISTRATORS}:${inherit}F`,
    '/q',
  ];
}

/** The fix printed in refusal messages. */
function icaclsFixHint(path: string, userSid: string): string {
  return `icacls "${path}" /inheritance:r /grant:r *${userSid}:F *${SID_SYSTEM}:F *${SID_ADMINISTRATORS}:F`;
}

/**
 * Emits `{owner, protected, rules: [{sid, type, inherited, rights}], sddl, aceCount}` for
 * $env:CONDUCTOR_ACL_PATH, every identity as a SID (GetOwner/GetAccessRules with SecurityIdentifier
 * never needs a lookup). `sddl` (owner + DACL) and `aceCount` (the raw DACL's ACE count, -1 for a
 * NULL DACL) cross-check `rules`, which silently omits ACE types .NET can't express as rules.
 */
export const GET_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$sidType = [System.Security.Principal.SecurityIdentifier]',
  '$acl = Get-Acl -LiteralPath $env:CONDUCTOR_ACL_PATH',
  '$rules = @($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object {',
  '  [pscustomobject]@{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString();',
  '    inherited = [bool]$_.IsInherited; rights = $_.FileSystemRights.ToString() } })',
  "$sddl = $acl.GetSecurityDescriptorSddlForm('Owner, Access')",
  '$raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($sddl)',
  '$aceCount = if ($null -eq $raw.DiscretionaryAcl) { -1 } else { $raw.DiscretionaryAcl.Count }',
  '[pscustomobject]@{ owner = $acl.GetOwner($sidType).Value;',
  '  protected = [bool]$acl.AreAccessRulesProtected; rules = $rules; sddl = $sddl;',
  '  aceCount = [int]$aceCount } |',
  '  ConvertTo-Json -Compress -Depth 4',
].join('\n');

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command', GET_ACL_SCRIPT];

// ---------------------------------------------------------------------------------------------
// Pure parsing and decisions (unit-tested on every OS)

const SID_RE = /^S-1-\d+(-\d+)+$/i;
const SidSchema = z.string().regex(SID_RE, 'not a SID');

const RuleSchema = z.object({
  sid: SidSchema,
  type: z.enum(['Allow', 'Deny']),
  inherited: z.boolean(),
  rights: z.string().optional(),
});

const WinAclSchema = z.object({
  owner: SidSchema,
  protected: z.boolean(),
  // ConvertTo-Json flattens a one-element array to an object and an empty one may come out null.
  rules: z.preprocess(
    (r: unknown): unknown[] =>
      r === null || r === undefined ? [] : Array.isArray(r) ? (r as unknown[]) : [r],
    z.array(RuleSchema),
  ),
  sddl: z.string().min(1),
  aceCount: z.number().int().min(-1),
});

export type WinAcl = z.infer<typeof WinAclSchema>;
export type WinAce = z.infer<typeof RuleSchema>;

/** Parse the GET_ACL_SCRIPT output. Throws on anything unexpected (callers fail closed). */
export function parseGetAclJson(stdout: string): WinAcl {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  } catch {
    throw new Error('Get-Acl output is not JSON');
  }
  const parsed = WinAclSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))];
    throw new Error(`Get-Acl output is malformed (${fields.join(', ')})`);
  }
  return parsed.data;
}

/** The SID from `whoami /user /fo csv` (with or without its header row). */
export function parseWhoamiCsv(stdout: string): string {
  const lines = stdout
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const last = lines.at(-1);
  // `"DOMAIN\user","S-1-5-21-…"`; a user name can't contain `"`.
  const m = last === undefined ? null : /^"[^"]*","([^"]*)"$/.exec(last);
  const sid = m?.[1];
  if (sid === undefined || !SID_RE.test(sid)) {
    throw new AclError('unreadable', "cannot determine the current user's SID from whoami output");
  }
  return sid.toUpperCase();
}

const sameSid = (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase();

/** One DACL ACE from an SDDL string: its type (`A`, `D`, `XA`, ...), flags and raw trustee. */
export interface SddlAce {
  type: string;
  flags: string;
  sid: string;
}

export interface ParsedSddl {
  owner: string | null;
  /** DACL flags, e.g. `PAI`; contains `NO_ACCESS_CONTROL` for a NULL DACL. */
  daclFlags: string;
  nullDacl: boolean;
  aces: SddlAce[];
}

/**
 * Parse the owner and DACL of an SDDL string. An ACE body is split on its first five `;` only, so a
 * conditional expression (7th field, with its own parentheses) is skipped, not parsed. Throws on
 * anything malformed (callers fail closed).
 */
export function parseSddl(sddl: string): ParsedSddl {
  const s = sddl.trim();
  const owner = /^O:([^:()]+?)(?=[GDS]:|$)/.exec(s)?.[1] ?? null;
  // The first top-level `D:` (outside any ACE).
  let depth = 0;
  let d = -1;
  let quoted = false;
  for (let i = 0; i < s.length && d < 0; i++) {
    const c = s[i];
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && c === 'D' && s[i + 1] === ':') d = i;
    if (depth < 0) throw new Error('SDDL has unbalanced parentheses');
  }
  if (d < 0) throw new Error('SDDL has no DACL');
  let i = d + 2;
  let daclFlags = '';
  while (i < s.length && s[i] !== '(' && !(s[i + 1] === ':' && /^[OGDS]$/.test(s[i] ?? ''))) {
    daclFlags += s[i];
    i++;
  }
  const aces: SddlAce[] = [];
  while (i < s.length && s[i] === '(') {
    // Balanced parentheses, ignoring any inside a conditional expression's "string literals".
    let level = 0;
    let quoted = false;
    let j = i;
    for (; j < s.length; j++) {
      if (s[j] === '"') quoted = !quoted;
      else if (quoted) continue;
      else if (s[j] === '(') level++;
      else if (s[j] === ')' && --level === 0) break;
    }
    if (j >= s.length) throw new Error('SDDL has an unterminated ACE');
    let rest = s.slice(i + 1, j);
    const fields: string[] = [];
    for (let f = 0; f < 5; f++) {
      const k = rest.indexOf(';');
      if (k < 0) throw new Error('SDDL ACE has too few fields');
      fields.push(rest.slice(0, k));
      rest = rest.slice(k + 1);
    }
    const k = rest.indexOf(';');
    const sid = k < 0 ? rest : rest.slice(0, k);
    const type = fields[0] ?? '';
    if (type === '' || sid === '') throw new Error('SDDL ACE has an empty type or trustee');
    aces.push({ type: type.toUpperCase(), flags: (fields[1] ?? '').toUpperCase(), sid });
    i = j + 1;
  }
  const tail = s.slice(i);
  if (tail !== '' && !tail.startsWith('S:')) {
    throw new Error('SDDL has unexpected data after the DACL');
  }
  return { owner, daclFlags, nullDacl: daclFlags.includes('NO_ACCESS_CONTROL'), aces };
}

/** Fixed SDDL SID aliases (MS-DTYP 2.4.2.4). */
const SDDL_ALIASES: Readonly<Record<string, string>> = {
  AA: 'S-1-5-32-579',
  AC: 'S-1-15-2-1',
  AN: 'S-1-5-7',
  AO: 'S-1-5-32-548',
  AU: 'S-1-5-11',
  BA: 'S-1-5-32-544',
  BG: 'S-1-5-32-546',
  BO: 'S-1-5-32-551',
  BU: 'S-1-5-32-545',
  CD: 'S-1-5-32-574',
  CG: 'S-1-3-1',
  CO: 'S-1-3-0',
  CY: 'S-1-5-32-569',
  ED: 'S-1-5-9',
  ER: 'S-1-5-32-573',
  HA: 'S-1-5-32-578',
  IS: 'S-1-5-32-568',
  IU: 'S-1-5-4',
  LS: 'S-1-5-19',
  LU: 'S-1-5-32-559',
  MU: 'S-1-5-32-558',
  NO: 'S-1-5-32-556',
  NS: 'S-1-5-20',
  NU: 'S-1-5-2',
  OW: 'S-1-3-4',
  PO: 'S-1-5-32-550',
  PS: 'S-1-5-10',
  PU: 'S-1-5-32-547',
  RA: 'S-1-5-32-575',
  RC: 'S-1-5-12',
  RD: 'S-1-5-32-555',
  RE: 'S-1-5-32-552',
  RM: 'S-1-5-32-580',
  RU: 'S-1-5-32-554',
  SO: 'S-1-5-32-549',
  SS: 'S-1-18-2',
  SU: 'S-1-5-6',
  SY: 'S-1-5-18',
  WD: 'S-1-1-0',
  WR: 'S-1-5-33',
};

/** Domain-relative SDDL aliases: the RID, appended to the domain part of the user's SID. */
const SDDL_DOMAIN_RIDS: Readonly<Record<string, number>> = {
  RO: 498,
  LA: 500,
  LG: 501,
  DA: 512,
  DU: 513,
  DG: 514,
  DC: 515,
  DD: 516,
  CA: 517,
  SA: 518,
  EA: 519,
  PA: 520,
  CN: 522,
  AP: 525,
  KA: 526,
  EK: 527,
  RS: 553,
};

/**
 * An SDDL trustee as an upper-case SID. Throws on an alias it doesn't know. A domain-relative
 * alias resolved against the wrong domain only makes the cross-check disagree (fail closed).
 */
export function resolveSddlSid(trustee: string, userSid: string): string {
  if (SID_RE.test(trustee)) return trustee.toUpperCase();
  const key = trustee.toUpperCase();
  const fixed = SDDL_ALIASES[key];
  if (fixed !== undefined) return fixed;
  const rid = SDDL_DOMAIN_RIDS[key];
  if (rid !== undefined) return `${userSid.toUpperCase().replace(/-\d+$/, '')}-${rid}`;
  throw new Error(`SDDL names an unknown trustee alias ${trustee}`);
}

/**
 * Decide whether a win32 ACL is owner-only for `userSid`. Returns the refusal, or null if it
 * passes. Deny ACEs never widen access, so only allow-ACEs are checked. Any ACE that is not a
 * plain allow/deny (conditional XA/XD, callback, object OA/OD, ZA, ...) is refused, as is a NULL
 * DACL, and any disagreement between the SDDL, the raw ACE count and the parsed rules.
 */
export function evaluateWinAcl(
  acl: WinAcl,
  opts: { path: string; userSid: string; checkAccess?: boolean },
): AclError | null {
  const { path, userSid } = opts;
  const unreadable = (why: string): AclError =>
    new AclError(
      'unreadable',
      `cannot verify the permissions of ${path} (${why}); refusing to use it`,
    );
  let sddl: ParsedSddl;
  let sddlOwner: string | null;
  try {
    sddl = parseSddl(acl.sddl);
    sddlOwner = sddl.owner === null ? null : resolveSddlSid(sddl.owner, userSid);
  } catch (e) {
    return unreadable((e as Error).message);
  }
  if (sddlOwner === null || !sameSid(sddlOwner, acl.owner)) {
    return unreadable('the SDDL owner disagrees with Get-Acl');
  }
  if (!sameSid(acl.owner, userSid)) {
    return new AclError(
      'foreign-owner',
      `${path} is owned by another user (${acl.owner}); refusing to use it`,
      acl.owner.toUpperCase(),
    );
  }
  if (opts.checkAccess === false) return null;
  if (sddl.nullDacl || acl.aceCount < 0) {
    return new AclError(
      'too-open',
      `${path} has no access control list (everyone has full access); run: ${icaclsFixHint(path, userSid)}`,
    );
  }
  const odd = [
    ...new Set(sddl.aces.filter((a) => a.type !== 'A' && a.type !== 'D').map((a) => a.type)),
  ];
  if (odd.length > 0) {
    return new AclError(
      'too-open',
      `${path} has access rules that can't be verified (${odd.join(', ')}: conditional, callback or object ACEs); run: ${icaclsFixHint(path, userSid)}`,
    );
  }
  if (acl.aceCount !== acl.rules.length || acl.aceCount !== sddl.aces.length) {
    return unreadable(
      `${acl.aceCount} ACEs in the DACL, ${sddl.aces.length} in the SDDL, ${acl.rules.length} rules`,
    );
  }
  let sddlKeys: string[];
  try {
    sddlKeys = sddl.aces.map((a) => `${a.type}:${resolveSddlSid(a.sid, userSid)}`);
  } catch (e) {
    return unreadable((e as Error).message);
  }
  const ruleKeys = acl.rules.map((r) => `${r.type === 'Allow' ? 'A' : 'D'}:${r.sid.toUpperCase()}`);
  const sameSet = (a: string[], b: string[]): boolean =>
    a.every((k) => b.includes(k)) && b.every((k) => a.includes(k));
  if (!sameSet(sddlKeys, ruleKeys)) return unreadable('the SDDL disagrees with Get-Acl');
  if (sddl.daclFlags.includes('P') !== acl.protected) {
    return unreadable('the SDDL protection flag disagrees with Get-Acl');
  }
  if (
    !acl.protected ||
    acl.rules.some((r) => r.inherited) ||
    sddl.aces.some((a) => a.flags.includes('ID'))
  ) {
    return new AclError(
      'inherited',
      `${path} inherits permissions from its parent folder; run: ${icaclsFixHint(path, userSid)}`,
    );
  }
  const allowed = [userSid, SID_SYSTEM, SID_ADMINISTRATORS];
  const others = [
    ...new Set(
      acl.rules
        .filter((r) => r.type === 'Allow' && !allowed.some((s) => sameSid(s, r.sid)))
        .map((r) => r.sid.toUpperCase()),
    ),
  ];
  if (others.length > 0) {
    return new AclError(
      'too-open',
      `${path} is accessible to other users (${others.join(', ')}); run: ${icaclsFixHint(path, userSid)}`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// helpers

function system32(...parts: string[]): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...parts);
}

function run(file: string, args: string[], extraEnv?: Record<string, string>): string {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  // A PSModulePath inherited from PowerShell 7 (pwsh) points Windows PowerShell 5.1 at modules it
  // can't load, so Get-Acl fails ("found in the module ... but the module could not be loaded").
  // Without it, powershell.exe uses its own defaults.
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'psmodulepath') delete env[k];
  return execFileSync(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    env,
  });
}

function errText(e: unknown): string {
  const err = e as { stderr?: unknown; message?: unknown };
  const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
  if (stderr !== '') return stderr.split(/\r?\n/)[0] ?? stderr;
  return typeof err.message === 'string' ? err.message : String(e);
}

/** Test hook: forget the cached SID. */
export function resetAclCacheForTests(): void {
  cachedSid = undefined;
}
