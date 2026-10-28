import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AclError,
  assertOwnerOnly,
  currentUserSid,
  evaluateWinAcl,
  GET_ACL_SCRIPT,
  icaclsRestrictArgs,
  mkdirPrivate,
  parseGetAclJson,
  parseSddl,
  parseWhoamiCsv,
  readWinAcl,
  resolveSddlSid,
  SID_ADMINISTRATORS,
  SID_SYSTEM,
  writePrivateFile,
  type WinAcl,
} from './acl.js';

// MW-T04: private files and dirs (ADR-0024 §3, ADR-0010).

const WIN = process.platform === 'win32';
const USER = 'S-1-5-21-1004336348-1177238915-682003330-1001';
const EVERYONE = 'S-1-1-0';
const USERS = 'S-1-5-32-545';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'conductor-acl-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

function refusal(fn: () => void): AclError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AclError);
    return e as AclError;
  }
  throw new Error('expected a refusal');
}

// -----------------------------------------------------------------------------------------------
// Pure logic: runs on every OS.

describe('parseWhoamiCsv', () => {
  it('reads the SID with and without the header row, CRLF and a BOM', () => {
    expect(parseWhoamiCsv(`"User Name","SID"\r\n"desktop-1\\ben","${USER}"\r\n`)).toBe(USER);
    expect(parseWhoamiCsv(`\uFEFF"corp\\b.grady","${USER.toLowerCase()}"`)).toBe(USER);
  });

  it.each([
    ['empty', ''],
    ['header only', '"User Name","SID"\r\n'],
    ['not a SID', '"desktop\\ben","nope"'],
    ['not CSV', `desktop\\ben ${USER}`],
  ])('refuses %s', (_name, out) => {
    expect(() => parseWhoamiCsv(out)).toThrow(AclError);
  });
});

// A Get-Acl result with its SDDL and raw ACE count derived from the rules (what Windows emits for a
// DACL with only plain ACEs).
type BaseAcl = Omit<WinAcl, 'sddl' | 'aceCount'>;
function mk(base: BaseAcl): WinAcl {
  const aces = base.rules
    .map((r) => `(${r.type === 'Allow' ? 'A' : 'D'};${r.inherited ? 'ID' : ''};FA;;;${r.sid})`)
    .join('');
  return {
    ...base,
    sddl: `O:${base.owner}D:${base.protected ? 'PAI' : 'AI'}${aces}`,
    aceCount: base.rules.length,
  };
}
const TAIL = `,"sddl":"O:${USER}D:PAI","aceCount":0`;

describe('parseGetAclJson', () => {
  it('reads owner, protection, rules, SDDL and ACE count', () => {
    const acl = parseGetAclJson(
      JSON.stringify({
        owner: USER,
        protected: true,
        rules: [
          { sid: USER, type: 'Allow', inherited: false, rights: 'FullControl' },
          { sid: SID_SYSTEM, type: 'Allow', inherited: false, rights: 'FullControl' },
        ],
        sddl: `O:${USER}D:PAI(A;;FA;;;${USER})(A;;FA;;;SY)`,
        aceCount: 2,
      }) + '\r\n',
    );
    expect(acl.owner).toBe(USER);
    expect(acl.protected).toBe(true);
    expect(acl.rules).toHaveLength(2);
    expect(acl.aceCount).toBe(2);
  });

  it('accepts ConvertTo-Json flattening a single rule to an object, and null for none', () => {
    const one = parseGetAclJson(
      `{"owner":"${USER}","protected":true,"rules":{"sid":"${USER}","type":"Allow","inherited":false}${TAIL}}`,
    );
    expect(one.rules).toEqual([{ sid: USER, type: 'Allow', inherited: false }]);
    expect(
      parseGetAclJson(`{"owner":"${USER}","protected":true,"rules":null${TAIL}}`).rules,
    ).toEqual([]);
  });

  it.each([
    ['not JSON', 'Get-Acl : Access is denied.'],
    ['empty', ''],
    ['no owner', `{"protected":true,"rules":[]${TAIL}}`],
    ['owner as a name', `{"owner":"DESKTOP\\\\ben","protected":true,"rules":[]${TAIL}}`],
    ['protected missing', `{"owner":"${USER}","rules":[]${TAIL}}`],
    ['sddl missing', `{"owner":"${USER}","protected":true,"rules":[],"aceCount":0}`],
    ['aceCount missing', `{"owner":"${USER}","protected":true,"rules":[],"sddl":"O:${USER}D:P"}`],
    [
      'rule with a name',
      `{"owner":"${USER}","protected":true,"rules":[{"sid":"Everyone","type":"Allow","inherited":false}]${TAIL}}`,
    ],
    [
      'unknown rule type',
      `{"owner":"${USER}","protected":true,"rules":[{"sid":"${USER}","type":"Audit","inherited":false}]${TAIL}}`,
    ],
  ])('throws on %s (callers fail closed)', (_name, out) => {
    expect(() => parseGetAclJson(out)).toThrow();
  });
});

describe('parseSddl / resolveSddlSid', () => {
  it('reads owner, DACL flags and ACEs, skipping over conditional expressions', () => {
    const p = parseSddl(
      `O:${USER}G:DUD:PAI(A;OICI;FA;;;${USER})(XA;;FX;;;WD;(Member_of {SID(BA)} && (@User.x == "a;b)")))(A;ID;FA;;;SY)S:AI`,
    );
    expect(p.owner).toBe(USER);
    expect(p.daclFlags).toBe('PAI');
    expect(p.nullDacl).toBe(false);
    expect(p.aces).toEqual([
      { type: 'A', flags: 'OICI', sid: USER },
      { type: 'XA', flags: '', sid: 'WD' },
      { type: 'A', flags: 'ID', sid: 'SY' },
    ]);
  });

  it('finds the DACL after alias owners and groups that contain a D', () => {
    expect(parseSddl('O:DDG:DDD:P(A;;FA;;;DD)')).toMatchObject({
      owner: 'DD',
      daclFlags: 'P',
      aces: [{ type: 'A', sid: 'DD' }],
    });
    expect(parseSddl('O:BAD:NO_ACCESS_CONTROL')).toMatchObject({ owner: 'BA', nullDacl: true });
  });

  it.each([
    ['no DACL', `O:${USER}`],
    ['unterminated ACE', `O:${USER}D:P(A;;FA;;;${USER}`],
    ['too few fields', `O:${USER}D:P(A;;FA;${USER})`],
    ['empty trustee', `O:${USER}D:P(A;;FA;;;)`],
    ['junk after the DACL', `O:${USER}D:P(A;;FA;;;SY)junk`],
    ['unbalanced', `O:${USER})D:P`],
  ])('throws on %s', (_name, sddl) => {
    expect(() => parseSddl(sddl)).toThrow();
  });

  it('resolves SIDs, fixed aliases and domain-relative aliases; refuses unknown aliases', () => {
    expect(resolveSddlSid(USER.toLowerCase(), USER)).toBe(USER);
    expect(resolveSddlSid('SY', USER)).toBe(SID_SYSTEM);
    expect(resolveSddlSid('ba', USER)).toBe(SID_ADMINISTRATORS);
    expect(resolveSddlSid('WD', USER)).toBe(EVERYONE);
    expect(resolveSddlSid('LA', USER)).toBe('S-1-5-21-1004336348-1177238915-682003330-500');
    expect(() => resolveSddlSid('QQ', USER)).toThrow(/unknown trustee alias/);
  });
});

describe('evaluateWinAcl', () => {
  const ownerOnly = (): BaseAcl => ({
    owner: USER,
    protected: true,
    rules: [
      { sid: USER, type: 'Allow', inherited: false },
      { sid: SID_SYSTEM, type: 'Allow', inherited: false },
      { sid: SID_ADMINISTRATORS, type: 'Allow', inherited: false },
    ],
  });
  const opts = { path: 'C:\\Users\\ben\\.conductor\\machine.json', userSid: USER };
  // What Windows prints for icacls' owner-only DACL: aliases for SYSTEM and Administrators.
  const realSddl = `O:${USER}D:PAI(A;;FA;;;${USER})(A;;FA;;;SY)(A;;FA;;;BA)`;

  it('passes an owner-only ACL (SIDs compared case-insensitively, aliases resolved)', () => {
    expect(evaluateWinAcl(mk(ownerOnly()), opts)).toBeNull();
    expect(evaluateWinAcl({ ...mk(ownerOnly()), sddl: realSddl }, opts)).toBeNull();
    expect(evaluateWinAcl(mk({ ...ownerOnly(), owner: USER.toLowerCase() }), opts)).toBeNull();
    expect(evaluateWinAcl(mk({ ...ownerOnly(), rules: [] }), opts)).toBeNull();
  });

  it('refuses a file owned by another SID, naming it', () => {
    const r = evaluateWinAcl(mk({ ...ownerOnly(), owner: SID_ADMINISTRATORS }), opts);
    expect(r?.reason).toBe('foreign-owner');
    expect(r?.owner).toBe(SID_ADMINISTRATORS);
    expect(r?.message).toBe(
      `${opts.path} is owned by another user (${SID_ADMINISTRATORS}); refusing to use it`,
    );
    // Even when only the owner is being checked.
    expect(
      evaluateWinAcl(mk({ ...ownerOnly(), owner: SID_SYSTEM }), { ...opts, checkAccess: false })
        ?.reason,
    ).toBe('foreign-owner');
  });

  it('refuses an allow-ACE for any other SID, and says how to fix it', () => {
    for (const sid of [EVERYONE, USERS, 'S-1-5-11', 'S-1-5-21-1-2-3-1002']) {
      const acl = ownerOnly();
      acl.rules.push({ sid, type: 'Allow', inherited: false });
      const r = evaluateWinAcl(mk(acl), opts);
      expect(r?.reason).toBe('too-open');
      expect(r?.message).toContain(`is accessible to other users (${sid})`);
      expect(r?.message).toContain(`icacls "${opts.path}" /inheritance:r /grant:r *${USER}:F`);
    }
  });

  it('ignores deny-ACEs for other SIDs', () => {
    const acl = ownerOnly();
    acl.rules.push({ sid: EVERYONE, type: 'Deny', inherited: false });
    expect(evaluateWinAcl(mk(acl), opts)).toBeNull();
  });

  it('refuses inheritance, whether flagged on the ACL, on a rule or on an SDDL ACE', () => {
    expect(evaluateWinAcl(mk({ ...ownerOnly(), protected: false }), opts)?.reason).toBe(
      'inherited',
    );
    const acl = ownerOnly();
    acl.rules[0] = { sid: USER, type: 'Allow', inherited: true };
    const r = evaluateWinAcl(mk(acl), opts);
    expect(r?.reason).toBe('inherited');
    expect(r?.message).toContain('inherits permissions from its parent folder');
    const sddlOnly = {
      ...mk(ownerOnly()),
      sddl: realSddl.replace('(A;;FA;;;SY)', '(A;ID;FA;;;SY)'),
    };
    expect(evaluateWinAcl(sddlOnly, opts)?.reason).toBe('inherited');
  });

  it('checkAccess: false checks only the owner', () => {
    const acl = mk({
      owner: USER,
      protected: false,
      rules: [{ sid: EVERYONE, type: 'Allow', inherited: true }],
    });
    expect(evaluateWinAcl(acl, { ...opts, checkAccess: false })).toBeNull();
  });

  // Conditional / callback / object ACEs are dropped by GetAccessRules: the rules look owner-only.
  it.each([
    ['XA', `(XA;;FA;;;WD;(@User.Department == "Eng"))`],
    ['XD', `(XD;;FA;;;WD;(@User.x == 1))`],
    ['ZA', `(ZA;;FA;;;WD;;(@Resource.x == 1))`],
    ['OA', `(OA;;FA;bf967aba-0de6-11d0-a285-00aa003049e2;;WD)`],
    ['XU', `(XU;;FA;;;WD;(@User.x == 1))`],
  ])('refuses a %s ACE the rules do not show', (type, ace) => {
    const base = mk(ownerOnly());
    for (const aceCount of [3, 4]) {
      const r = evaluateWinAcl({ ...base, sddl: realSddl + ace, aceCount }, opts);
      expect(r?.reason).toBe('too-open');
      expect(r?.message).toContain(`can't be verified (${type}`);
    }
  });

  it('refuses a NULL DACL, from the SDDL or the raw count', () => {
    const base = mk({ ...ownerOnly(), rules: [] });
    expect(evaluateWinAcl({ ...base, sddl: `O:${USER}D:NO_ACCESS_CONTROL` }, opts)?.reason).toBe(
      'too-open',
    );
    expect(evaluateWinAcl({ ...base, aceCount: -1 }, opts)?.reason).toBe('too-open');
  });

  it('treats SDDL / raw count / rules disagreement as unreadable', () => {
    const base = mk(ownerOnly());
    const cases: WinAcl[] = [
      // The raw DACL has an ACE the rules don't.
      { ...base, aceCount: 4 },
      // The SDDL has an Everyone allow the rules don't (same counts).
      { ...base, sddl: realSddl.replace('(A;;FA;;;BA)', '(A;;FA;;;WD)') },
      // Allow vs deny disagree.
      { ...base, sddl: realSddl.replace('(A;;FA;;;BA)', '(D;;FA;;;BA)') },
      // Owner disagrees.
      { ...base, sddl: realSddl.replace(`O:${USER}`, 'O:BA') },
      // No owner in the SDDL.
      { ...base, sddl: realSddl.replace(`O:${USER}`, '') },
      // Protection flag disagrees.
      { ...base, sddl: realSddl.replace('D:PAI', 'D:AI') },
      // Unknown alias.
      { ...base, sddl: realSddl.replace('(A;;FA;;;BA)', '(A;;FA;;;QQ)') },
      // Malformed SDDL.
      { ...base, sddl: 'garbage' },
    ];
    for (const acl of cases) {
      const r = evaluateWinAcl(acl, opts);
      expect(r?.reason, acl.sddl).toBe('unreadable');
      expect(r?.message).toContain('refusing to use it');
    }
  });
});

describe('icaclsRestrictArgs / GET_ACL_SCRIPT', () => {
  it('grants only user, SYSTEM and Administrators, removing inheritance; dirs propagate', () => {
    expect(icaclsRestrictArgs('C:\\a b\\f', USER, 'file')).toEqual([
      'C:\\a b\\f',
      '/inheritance:r',
      '/grant:r',
      `*${USER}:F`,
      '*S-1-5-18:F',
      '*S-1-5-32-544:F',
      '/q',
    ]);
    expect(icaclsRestrictArgs('C:\\d', USER, 'dir').slice(3, 6)).toEqual([
      `*${USER}:(OI)(CI)F`,
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F',
    ]);
  });

  it('reads the path from the environment, never from the script text', () => {
    expect(GET_ACL_SCRIPT).toContain('-LiteralPath $env:CONDUCTOR_ACL_PATH');
    expect(GET_ACL_SCRIPT).toContain('SecurityIdentifier');
    expect(GET_ACL_SCRIPT).toContain('RawSecurityDescriptor');
    expect(GET_ACL_SCRIPT).toContain('GetSecurityDescriptorSddlForm');
  });
});

// -----------------------------------------------------------------------------------------------
// POSIX: today's credential.ts / config.ts behaviour and messages.

describe.skipIf(WIN)('POSIX', () => {
  it('writePrivateFile writes 0600 atomically, leaving no temp file', () => {
    const p = join(tmp, 'config.json');
    writeFileSync(p, 'old', { mode: 0o644 });
    writePrivateFile(p, 'secret\n');
    expect(readFileSync(p, 'utf8')).toBe('secret\n');
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readdirSync(tmp)).toEqual(['config.json']);
    expect(() => assertOwnerOnly(p, { kind: 'file' })).not.toThrow();
  });

  it('writePrivateFile leaves no temp file when the rename fails', () => {
    const p = join(tmp, 'adir');
    mkdirSync(join(p, 'child'), { recursive: true });
    expect(() => writePrivateFile(p, 'x')).toThrow();
    expect(readdirSync(tmp)).toEqual(['adir']);
  });

  it('mkdirPrivate creates parents and chmods 0700, also an existing 0755 dir', () => {
    const d = join(tmp, 'a', 'b');
    mkdirPrivate(d);
    expect(statSync(d).mode & 0o777).toBe(0o700);
    chmodSync(d, 0o755);
    mkdirPrivate(d);
    expect(statSync(d).mode & 0o777).toBe(0o700);
  });

  it('mkdirPrivate refuses a symlink without chmodding its target', () => {
    const target = join(tmp, 'target');
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    const link = join(tmp, 'link');
    symlinkSync(target, link);
    expect(() => mkdirPrivate(link)).toThrow(`${link} is a symlink; refusing to use it`);
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });

  it('refuses a group/other-readable file with the chmod hint', () => {
    const p = join(tmp, 'machine.json');
    writeFileSync(p, '{}', { mode: 0o644 });
    chmodSync(p, 0o644);
    const r = refusal(() => assertOwnerOnly(p, { kind: 'file' }));
    expect(r.reason).toBe('too-open');
    expect(r.message).toBe(`${p} is readable by other users; run: chmod 600 ${p}`);
    expect(() => assertOwnerOnly(p, { kind: 'file', checkAccess: false })).not.toThrow();
  });

  it('never mode-checks a dir (ADR-0010 checks only its owner)', () => {
    chmodSync(tmp, 0o755);
    expect(() => assertOwnerOnly(tmp, { kind: 'dir' })).not.toThrow();
  });

  it('refuses symlinks and the wrong kind with the credential.ts messages', () => {
    const f = join(tmp, 'f');
    writeFileSync(f, '', { mode: 0o600 });
    const link = join(tmp, 'link');
    symlinkSync(f, link);
    expect(() => assertOwnerOnly(link, { kind: 'file' })).toThrow(
      `${link} is a symlink; refusing to use it`,
    );
    expect(() => assertOwnerOnly(f, { kind: 'dir' })).toThrow(`${f} is not a directory`);
    expect(() => assertOwnerOnly(tmp, { kind: 'file' })).toThrow(`${tmp} is not a regular file`);
    expect(refusal(() => assertOwnerOnly(link, { kind: 'file' })).reason).toBe('wrong-type');
  });

  it('refuses a path owned by another uid', () => {
    const f = join(tmp, 'f');
    writeFileSync(f, '', { mode: 0o600 });
    const uid = statSync(f).uid;
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    for (const [p, kind] of [
      [f, 'file'],
      [tmp, 'dir'],
    ] as const) {
      const r = refusal(() => assertOwnerOnly(p, { kind }));
      expect(r.reason).toBe('foreign-owner');
      expect(r.message).toBe(`${p} is owned by another user; refusing to use it`);
    }
  });

  it('throws ENOENT for a missing path, as checkPrivateDir does', () => {
    expect(() => assertOwnerOnly(join(tmp, 'nope'), { kind: 'dir' })).toThrow(/ENOENT/);
  });

  it('currentUserSid is win32-only', () => {
    expect(() => currentUserSid()).toThrow(/win32/);
  });
});

// -----------------------------------------------------------------------------------------------
// win32: real icacls / Get-Acl.

describe.skipIf(!WIN)('win32', () => {
  const icacls = (...args: string[]): string =>
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), args, {
      encoding: 'utf8',
      windowsHide: true,
    });

  // %TEMP% is not owner-only, so make the test dir private first (it exists: nothing is created).
  beforeEach(() => mkdirPrivate(tmp));

  it('currentUserSid is a user SID', () => {
    expect(currentUserSid()).toMatch(/^S-1-5-21-\d+-\d+-\d+-\d+$/);
    expect(currentUserSid()).toBe(currentUserSid());
  });

  it('a file written by writePrivateFile passes and holds the data', () => {
    const p = join(tmp, 'machine.json');
    writePrivateFile(p, 'secret\n');
    expect(readFileSync(p, 'utf8')).toBe('secret\n');
    expect(readdirSync(tmp)).toEqual(['machine.json']);
    expect(() => assertOwnerOnly(p, { kind: 'file' })).not.toThrow();
    // Replacing it keeps it private.
    writePrivateFile(p, 'secret2\n');
    expect(readFileSync(p, 'utf8')).toBe('secret2\n');
    expect(() => assertOwnerOnly(p, { kind: 'file' })).not.toThrow();
  });

  it('refuses a plain (inheriting) file', () => {
    const p = join(tmp, 'plain.json');
    writeFileSync(p, '{}');
    // Owned by Administrators when the test runs elevated (the Actions runner), else by the user.
    expect(['inherited', 'foreign-owner']).toContain(
      refusal(() => assertOwnerOnly(p, { kind: 'file' })).reason,
    );
    icacls(p, '/setowner', `*${currentUserSid()}`);
    expect(refusal(() => assertOwnerOnly(p, { kind: 'file' })).reason).toBe('inherited');
  });

  it('refuses after Everyone is granted read, with a clear message', () => {
    const p = join(tmp, 'machine.json');
    writePrivateFile(p, 'secret');
    icacls(p, '/grant', `*${EVERYONE}:R`);
    const r = refusal(() => assertOwnerOnly(p, { kind: 'file' }));
    expect(r.reason).toBe('too-open');
    expect(r.message).toContain(`${p} is accessible to other users (${EVERYONE})`);
    expect(r.message).toContain('icacls');
  });

  it('refuses after inheritance is re-enabled', () => {
    const p = join(tmp, 'machine.json');
    writePrivateFile(p, 'secret');
    icacls(p, '/inheritance:e');
    expect(refusal(() => assertOwnerOnly(p, { kind: 'file' })).reason).toBe('inherited');
  });

  it('refuses a file owned by another SID (when the runner may set one)', (ctx) => {
    const p = join(tmp, 'machine.json');
    writePrivateFile(p, 'secret');
    try {
      icacls(p, '/setowner', `*${SID_SYSTEM}`);
    } catch {
      ctx.skip(); // not privileged; the fixture test in evaluateWinAcl covers the decision
    }
    const r = refusal(() => assertOwnerOnly(p, { kind: 'file' }));
    expect(r.reason).toBe('foreign-owner');
    expect(r.message).toContain(`(${SID_SYSTEM})`);
  });

  it('mkdirPrivate refuses an existing dir owned by another SID (when the runner may set one)', (ctx) => {
    const d = join(tmp, 'foreign');
    mkdirSync(d);
    try {
      icacls(d, '/setowner', `*${SID_SYSTEM}`);
    } catch {
      ctx.skip();
    }
    const r = refusal(() => mkdirPrivate(d));
    expect(r.reason).toBe('foreign-owner');
    expect(r.owner).toBe(SID_SYSTEM);
  });

  it('mkdirPrivate makes an owner-only dir whose new children inherit only those grants', () => {
    const d = join(tmp, 'private', 'push-1');
    mkdirPrivate(d);
    expect(() => assertOwnerOnly(d, { kind: 'dir' })).not.toThrow();
    // A child created inside inherits only user/SYSTEM/Administrators (and so is refused as
    // inheriting until it is restricted itself).
    const child = join(d, 'child');
    writeFileSync(child, 'x');
    const acl = readWinAcl(child);
    expect(acl.rules.length).toBeGreaterThan(0);
    for (const r of acl.rules) {
      expect(r.inherited).toBe(true);
      expect([currentUserSid(), SID_SYSTEM, SID_ADMINISTRATORS]).toContain(r.sid.toUpperCase());
    }
    expect(['inherited', 'foreign-owner']).toContain(
      refusal(() => assertOwnerOnly(child, { kind: 'file' })).reason,
    );
    // writePrivateFile inside it passes.
    const f = join(d, 'cred.json');
    writePrivateFile(f, 'x');
    expect(() => assertOwnerOnly(f, { kind: 'file' })).not.toThrow();
  });

  it('refuses a junction and a missing path fails closed', () => {
    const target = join(tmp, 'target');
    mkdirSync(target);
    const link = join(tmp, 'junction');
    symlinkSync(target, link, 'junction');
    expect(refusal(() => mkdirPrivate(link)).reason).toBe('wrong-type');
    expect(() => assertOwnerOnly(join(tmp, 'nope'), { kind: 'file' })).toThrow();
  });

  it('handles paths with spaces, quotes-free metacharacters and brackets', () => {
    const d = join(tmp, 'a b & [c] %x% $y');
    mkdirPrivate(d);
    expect(() => assertOwnerOnly(d, { kind: 'dir' })).not.toThrow();
    const f = join(d, "it's.json");
    writePrivateFile(f, 'x');
    expect(() => assertOwnerOnly(f, { kind: 'file' })).not.toThrow();
  });

  describe('no inherited-permission window', () => {
    let plain: string;
    beforeEach(() => {
      plain = mkdtempSync(join(tmpdir(), 'conductor-acl-plain-'));
    });
    afterEach(() => rmSync(plain, { recursive: true, force: true }));

    it('writePrivateFile refuses a folder that is not private, creating nothing', () => {
      const p = join(plain, 'machine.json');
      const r = refusal(() => writePrivateFile(p, 'secret'));
      // Inheriting; or owned by Administrators when the runner is elevated.
      expect(['inherited', 'foreign-owner']).toContain(r.reason);
      expect(r.message).toContain(`refusing to write ${p}: its folder is not private`);
      expect(readdirSync(plain)).toEqual([]);
    });

    it('mkdirPrivate refuses to create under a non-private ancestor, creating nothing', () => {
      const d = join(plain, 'a', 'b');
      const r = refusal(() => mkdirPrivate(d));
      expect(['inherited', 'foreign-owner']).toContain(r.reason);
      expect(r.message).toContain(`refusing to create ${d}: ${plain} is not private`);
      expect(existsSync(join(plain, 'a'))).toBe(false);
    });

    it('mkdirPrivate creates directly under %LOCALAPPDATA%, every new level owner-only', () => {
      const base = process.env.LOCALAPPDATA;
      expect(base).toBeTruthy();
      const top = join(base ?? '', `conductor-acl-test-${process.pid}-${Date.now()}`);
      try {
        const d = join(top, 'private', 'push-1');
        mkdirPrivate(d);
        for (const level of [top, join(top, 'private'), d]) {
          expect(() => assertOwnerOnly(level, { kind: 'dir' })).not.toThrow();
        }
        writePrivateFile(join(d, 'cred.json'), 'x');
      } finally {
        rmSync(top, { recursive: true, force: true });
      }
    });

    it('mkdirPrivate creates directly under the profile dir', () => {
      const top = join(homedir(), `.conductor-acl-test-${process.pid}-${Date.now()}`);
      try {
        mkdirPrivate(top);
        expect(() => assertOwnerOnly(top, { kind: 'dir' })).not.toThrow();
      } finally {
        rmSync(top, { recursive: true, force: true });
      }
    });

    it('a real owner-only ACL has matching SDDL, raw ACE count and rules', () => {
      const f = join(tmp, 'x.json');
      writePrivateFile(f, 'x');
      const acl = readWinAcl(f);
      expect(acl.aceCount).toBe(3);
      expect(acl.rules).toHaveLength(3);
      expect(parseSddl(acl.sddl).aces.map((a) => a.type)).toEqual(['A', 'A', 'A']);
    });
  });
});
