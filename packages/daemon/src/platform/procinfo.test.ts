import { describe, expect, it } from 'vitest';
import {
  cimScript,
  parseCimDate,
  parseCimProcessJson,
  parsePsLine,
  parseWindowsCommandLine,
  readProcInfo,
} from './procinfo.js';
import { spawnCli } from './spawn.js';

const isWin = process.platform === 'win32';
const T = Date.UTC(2026, 9, 27, 10, 11, 12);

describe('parsePsLine (POSIX, as orphan.ts)', () => {
  it('parses lstart (UTC) and the command', () => {
    expect(parsePsLine('Tue Oct 27 10:11:12 2026 /usr/bin/claude --resume x')).toEqual({
      startedAt: T,
      command: '/usr/bin/claude --resume x',
      argv: ['/usr/bin/claude', '--resume', 'x'],
    });
    expect(parsePsLine('Wed Oct  7 01:02:03 2026 node')?.startedAt).toBe(
      Date.UTC(2026, 9, 7, 1, 2, 3),
    );
    expect(parsePsLine('Tue 27 Oct 10:11:12 2026')).toEqual({
      startedAt: T,
      command: '',
      argv: [],
    });
  });

  it('returns null for anything else', () => {
    expect(parsePsLine('')).toBeNull();
    expect(parsePsLine('yesterday')).toBeNull();
    expect(parsePsLine('Tue Foo 27 10:11:12 2026')).toBeNull();
  });
});

describe('parseWindowsCommandLine (CommandLineToArgvW)', () => {
  const cases: [string, string[]][] = [
    // argv[0]: quoted runs to the next quote with no escapes; unquoted to whitespace.
    [
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\b\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" --session-id 3c1f --print',
      [
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\Users\\b\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
        '--session-id',
        '3c1f',
        '--print',
      ],
    ],
    ['C:\\bin\\claude.exe --resume abc', ['C:\\bin\\claude.exe', '--resume', 'abc']],
    ['"C:\\a\\"b c', ['C:\\a\\', 'b', 'c']],
    ['"C:\\x y\\a.exe"rest b', ['C:\\x y\\a.exe', 'rest', 'b']],
    // Microsoft's documented examples (arguments after argv[0]).
    ['p "abc" d e', ['p', 'abc', 'd', 'e']],
    ['p a\\\\\\b d"e f"g h', ['p', 'a\\\\\\b', 'de fg', 'h']],
    ['p a\\\\\\"b c d', ['p', 'a\\"b', 'c', 'd']],
    ['p a\\\\\\\\"b c" d e', ['p', 'a\\\\b c', 'd', 'e']],
    // Quote runs: `""` inside quotes is a literal quote and ends quoting; `"""` outside too.
    ['p "a""b"', ['p', 'a"b']],
    ['p "a""b c"', ['p', 'a"b', 'c']],
    ['p """a b"""', ['p', '"a', 'b"']],
    ['p "" x', ['p', '', 'x']],
    ['p a"" b', ['p', 'a', 'b']],
    ['p\t a\t\tb  ', ['p', 'a', 'b']],
    ['p "trailing\\\\"', ['p', 'trailing\\']],
    ['p "unterminated arg', ['p', 'unterminated arg']],
    ['p', ['p']],
    ['', ['']],
  ];
  it.each(cases)('%j', (line, argv) => {
    expect(parseWindowsCommandLine(line)).toEqual(argv);
  });
});

describe('parseCimDate', () => {
  const ms = Date.UTC(2026, 9, 27, 17, 11, 12, 345);
  it('accepts every shape PowerShell may print', () => {
    expect(parseCimDate('2026-10-27T17:11:12.3456789Z')).toBe(ms);
    expect(parseCimDate('2026-10-27T10:11:12.3456789-07:00')).toBe(ms);
    expect(parseCimDate('2026-10-27T17:11:12.345+00:00')).toBe(ms);
    expect(parseCimDate(`/Date(${ms})/`)).toBe(ms);
    expect(parseCimDate(`/Date(${ms}-0700)/`)).toBe(ms);
    expect(parseCimDate({ value: `/Date(${ms})/`, DateTime: 'Tuesday, …' })).toBe(ms);
    expect(parseCimDate('20261027101112.345678-420')).toBe(ms);
    expect(parseCimDate('20261027171112.345999+000')).toBe(ms);
    expect(parseCimDate(ms + 0.9)).toBe(ms);
  });

  it('null for zone-less or garbage values', () => {
    expect(parseCimDate('2026-10-27T17:11:12')).toBeNull(); // would depend on the daemon's TZ
    expect(parseCimDate('yesterday')).toBeNull();
    expect(parseCimDate(null)).toBeNull();
    expect(parseCimDate(undefined)).toBeNull();
    expect(parseCimDate(Number.NaN)).toBeNull();
  });
});

describe('parseCimProcessJson', () => {
  const cmd =
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\conductor\\cli.js" --session-id "a b"';
  const fixture = JSON.stringify({
    ProcessId: 4242,
    ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
    CommandLine: cmd,
    CreationDate: '2026-10-27T17:11:12.3456789Z',
  });

  it('reads start time, command, argv and image path', () => {
    expect(parseCimProcessJson(`${fixture}\r\n`)).toEqual({
      startedAt: Date.UTC(2026, 9, 27, 17, 11, 12, 345),
      command: cmd,
      argv: [
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\Program Files\\conductor\\cli.js',
        '--session-id',
        'a b',
      ],
      executablePath: 'C:\\Program Files\\nodejs\\node.exe',
    });
    expect(parseCimProcessJson(`[${fixture}]`)?.argv[0]).toBe(
      'C:\\Program Files\\nodejs\\node.exe',
    );
  });

  it('null when gone, unreadable (CommandLine null) or malformed', () => {
    expect(parseCimProcessJson('')).toBeNull();
    expect(parseCimProcessJson('  \r\n')).toBeNull();
    expect(
      parseCimProcessJson(
        JSON.stringify({ ProcessId: 4, CommandLine: null, CreationDate: '2026-10-27T17:11:12Z' }),
      ),
    ).toBeNull();
    expect(
      parseCimProcessJson(JSON.stringify({ CommandLine: 'x', CreationDate: 'nope' })),
    ).toBeNull();
    expect(parseCimProcessJson('{not json')).toBeNull();
    expect(parseCimProcessJson('42')).toBeNull();
  });

  it('cimScript embeds an integer pid only', () => {
    expect(cimScript(4242)).toContain("-Filter 'ProcessId=4242'");
    expect(cimScript(4242)).toContain('ConvertTo-Json');
    expect(() => cimScript(1.5)).toThrow(RangeError);
    expect(() => cimScript(-1)).toThrow(RangeError);
  });
});

describe('readProcInfo (real processes)', () => {
  it('returns the start time and argv of a spawned child, then null once it is dead', async () => {
    const before = Date.now();
    const child = spawnCli(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)', 'conductor-procinfo-marker', 'second'],
      { stdio: 'ignore' },
    );
    await new Promise((r) => child.once('spawn', r));
    const pid = child.pid!;
    try {
      const info = readProcInfo(pid);
      expect(info).not.toBeNull();
      // POSIX lstart has 1 s precision (truncated); CIM has sub-ms.
      expect(info!.startedAt).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 - 2_000);
      expect(info!.startedAt).toBeLessThanOrEqual(Date.now() + 2_000);
      expect(info!.argv.slice(-2)).toEqual(['conductor-procinfo-marker', 'second']);
      expect(info!.command).toContain('conductor-procinfo-marker');
      if (isWin) expect(info!.executablePath?.toLowerCase()).toMatch(/node\.exe$/);
      // Stable across reads (the orphan check compares it for equality).
      expect(readProcInfo(pid)?.startedAt).toBe(info!.startedAt);
    } finally {
      child.kill('SIGKILL');
    }
    await new Promise((r) => child.once('exit', r));
    expect(readProcInfo(pid)).toBeNull();
  });

  it('null for a pid that does not exist or is invalid', () => {
    expect(readProcInfo(2 ** 22 + 12345)).toBeNull();
    expect(readProcInfo(0)).toBeNull();
    expect(readProcInfo(-1)).toBeNull();
  });
});
