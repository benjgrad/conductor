import { describe, expect, it } from 'vitest';
import { checkOurs, parseLstart, readProcInfo } from './orphan.js';

// BUG-1b FR-2: the matching rules, without processes (daemon.test.ts probes real stand-ins).

const ID = '3c1f7a52-2b9e-4d61-8f04-6e5d4c3b2a19';
const T = Date.UTC(2026, 9, 27, 10, 11, 12);

describe('parseLstart', () => {
  it('parses ps lstart (UTC) to ms epoch', () => {
    expect(parseLstart('Tue Oct 27 10:11:12 2026')).toBe(T);
    expect(parseLstart('Wed Oct  7 01:02:03 2026')).toBe(Date.UTC(2026, 9, 7, 1, 2, 3));
    expect(parseLstart('Tue 27 Oct 10:11:12 2026')).toBe(T);
  });

  it('returns null for anything else', () => {
    expect(parseLstart('')).toBeNull();
    expect(parseLstart('yesterday')).toBeNull();
    expect(parseLstart('Tue Foo 27 10:11:12 2026')).toBeNull();
  });

  it('readProcInfo reads this process (read-only) and null for no such pid', () => {
    const me = readProcInfo(process.pid);
    expect(me).not.toBeNull();
    expect(Math.abs(me!.startedAt - (Date.now() - process.uptime() * 1000))).toBeLessThan(5_000);
    expect(me!.command).toContain('node');
    expect(readProcInfo(2 ** 22 + 12345)).toBeNull();
  });
});

describe('checkOurs', () => {
  const stored = { startedAt: T, claudeSessionId: ID };
  const at = (command: string, startedAt = T) => ({ startedAt, command });
  const ok = { ok: true };
  const no = (reason: string) => ({ ok: false, reason });

  it.each([
    ['our claude --session-id', at(`claude -p --verbose --session-id ${ID} --model x`), ok],
    ['our claude --resume, absolute path', at(`/opt/x/claude -p --resume ${ID}`), ok],
    ['an npm (node shebang) claude', at(`node /opt/x/claude --resume ${ID}`), ok],
    [
      '(a) same argv, another start time',
      at(`claude --resume ${ID}`, T + 1000),
      no('start time differs (pid reused)'),
    ],
    ['(b) grep mentioning the id', at(`grep -r ${ID} .`), no('not the claude binary')],
    [
      '(b) id not adjacent to the flag',
      at(`claude --foo ${ID}`),
      no('argv lacks --session-id/--resume <id>'),
    ],
    [
      '(b) id as a prefix',
      at(`claude --session-id ${ID}x`),
      no('argv lacks --session-id/--resume <id>'),
    ],
    [
      '(e) another binary',
      at(`/usr/bin/notclaude --session-id ${ID}`),
      no('not the claude binary'),
    ],
    [
      '(e) claude deeper in argv',
      at(`sh -c x /tmp/claude --resume ${ID}`),
      no('not the claude binary'),
    ],
    ['no process info', null, no('cannot read process info')],
  ])('%s', (_name, info, want) => {
    expect(checkOurs(info, stored, 'claude')).toEqual(want);
  });

  it('matches the configured binary by exact path, even with spaces', () => {
    const bin = '/Users/x/My Tools/claude-wrapper';
    expect(checkOurs(at(`${bin} --resume ${ID}`), stored, bin)).toEqual(ok);
    expect(checkOurs(at(`/elsewhere/claude-wrapper --resume ${ID}`), stored, bin)).toEqual(ok);
  });

  it('(d) an empty or non-UUID stored id is never ours', () => {
    for (const claudeSessionId of ['', 'not-a-uuid', undefined]) {
      expect(
        checkOurs(
          at(`claude --resume ${claudeSessionId ?? ''}`),
          { startedAt: T, claudeSessionId },
          'claude',
        ),
      ).toEqual(no('invalid stored claude session id'));
    }
  });

  it('FR-4: no recorded start time is never ours', () => {
    expect(checkOurs(at(`claude --resume ${ID}`), { claudeSessionId: ID }, 'claude')).toEqual(
      no('no recorded start time'),
    );
  });
});
