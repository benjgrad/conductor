import { describe, expect, it } from 'vitest';
import { DAEMON_FIXTURES, INVENTORY_REPO_FIXTURE, M2_WS_FIXTURES } from '../protocol/fixtures.js';
import { parseDaemonMessage, parseOrchestratorMessage } from '../protocol/ws.js';
import {
  AbsolutePathSchema,
  InventoryRepoSchema,
  WorkingCopySchema,
  isAbsolutePath,
} from './inventory.js';

// MW-T02 / ADR-0024 §8: Windows drive paths join POSIX absolute paths.
const WIN = 'C:\\Users\\b\\repo';

describe('AbsolutePathSchema (MW-T02)', () => {
  it.each([
    // POSIX, unchanged from M2
    ['/a', 'posix'],
    ['/home/b/code/app', 'posix'],
    ['/a/b/', 'posix trailing slash'],
    ['/a\\..\\b', 'posix: backslash is a filename character'],
    ['/a/b:c', 'posix: colon is a filename character'],
    ['/a/...', 'posix: three dots is a name'],
    // Windows drive-absolute
    [WIN, 'backslashes'],
    ['C:/Users/b/repo', 'forward slashes'],
    ['c:\\x', 'lower-case drive'],
    ['Z:\\', 'drive root'],
    ['D:\\code/mixed\\seps', 'mixed separators'],
    ['C:\\Program Files\\app', 'space'],
    ['C:\\a\\...', 'three dots is a name'],
  ])('accepts %s (%s)', (p) => {
    expect(isAbsolutePath(p)).toBe(true);
    expect(AbsolutePathSchema.safeParse(p).success).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['/', 'too short'],
    ['code/app', 'relative'],
    ['./app', 'dot-relative'],
    ['~/code/app', 'tilde'],
    ['/a/../b', 'posix ..'],
    ['/a/./b', 'posix .'],
    ['/a/..', 'posix trailing ..'],
    ['/a\0b', 'posix NUL'],
    ['\\\\host\\share\\repo', 'UNC'],
    ['\\\\?\\C:\\repo', 'win32 file namespace'],
    ['\\\\.\\C:\\repo', 'win32 device namespace'],
    ['\\\\?\\UNC\\host\\share', 'long UNC'],
    ['\\repo', 'root-relative (current drive)'],
    ['C:', 'bare drive'],
    ['C:foo', 'drive-relative'],
    ['C:repo\\x', 'drive-relative with separator later'],
    ['1:\\x', 'not a drive letter'],
    ['CC:\\x', 'two-letter drive'],
    ['C:\\a\\..\\b', 'win ..'],
    ['C:\\a\\.\\b', 'win .'],
    ['C:/a/../b', 'win .. with forward slashes'],
    ['C:\\a/..\\b', 'win .. with mixed separators'],
    ['C:\\a\\..', 'win trailing ..'],
    ['C:\\repo\0x', 'win NUL'],
    ['C:\\repo:stream', 'NTFS alternate data stream'],
    ['C:\\a\\D:\\b', 'second drive'],
  ])('refuses %j (%s)', (p) => {
    expect(isAbsolutePath(p)).toBe(false);
    expect(AbsolutePathSchema.safeParse(p).success).toBe(false);
  });
});

describe('Windows paths round-trip through the WS schemas (MW-T02)', () => {
  const wire = (v: unknown) => JSON.stringify(v);

  it('inventory', () => {
    const repo = { ...INVENTORY_REPO_FIXTURE, path: WIN, mode: 'checkout' as const };
    expect(InventoryRepoSchema.parse(repo)).toEqual(repo);
    const msg = {
      ...DAEMON_FIXTURES.inventory,
      payload: { ...DAEMON_FIXTURES.inventory.payload, repos: [repo] },
    };
    expect(parseDaemonMessage(wire(msg))).toEqual(msg);
  });

  it('start_session.working_copy', () => {
    const f = M2_WS_FIXTURES.start_session_working_copy;
    const working_copy = { repo_path: WIN, mode: 'reference' as const };
    expect(WorkingCopySchema.parse(working_copy)).toEqual(working_copy);
    const msg = { ...f, payload: { ...f.payload, working_copy } };
    expect(parseOrchestratorMessage(wire(msg))).toEqual(msg);
  });

  it('a git_tamper alert', () => {
    const f = M2_WS_FIXTURES.alert_with_session;
    const msg = { ...f, payload: { ...f.payload, repo: WIN } };
    expect(parseDaemonMessage(wire(msg))).toEqual(msg);
  });

  it('a UNC path is refused in each of them', () => {
    const unc = '\\\\host\\share\\repo';
    const inv = {
      ...DAEMON_FIXTURES.inventory,
      payload: {
        ...DAEMON_FIXTURES.inventory.payload,
        repos: [{ ...INVENTORY_REPO_FIXTURE, path: unc }],
      },
    };
    expect(() => parseDaemonMessage(wire(inv))).toThrow();
    const f = M2_WS_FIXTURES.start_session_working_copy;
    expect(() =>
      parseOrchestratorMessage(
        wire({
          ...f,
          payload: { ...f.payload, working_copy: { repo_path: unc, mode: 'checkout' } },
        }),
      ),
    ).toThrow();
    const a = M2_WS_FIXTURES.alert_with_session;
    expect(() =>
      parseDaemonMessage(wire({ ...a, payload: { ...a.payload, repo: unc } })),
    ).toThrow();
  });
});
