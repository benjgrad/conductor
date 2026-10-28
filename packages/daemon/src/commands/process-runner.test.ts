import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { OUTPUT_TAIL_BYTES } from '@conductor/shared';
import { createCommandRunner } from './index.js';
import { ProcessCommandRunner } from './process-runner.js';
import type { CommandOutputChunk, RunCommandOptions } from './runner.js';
import { Semaphore } from './semaphore.js';
import { TailBuffer } from './tail.js';
import { removeTreeOrLeave } from '../test-support/remove-tree.js';

const onWin32 = process.platform === 'win32';
/** A path as written inside a POSIX shell script (Git Bash on win32 takes C:/…). */
const sh = (p: string) => p.replace(/\\/g, '/');
/** Shell that prints the OS pid of the last background job (MSYS `$!` is not a Windows pid). */
const LAST_BG_PID = onWin32 ? 'cat /proc/$!/winpid' : 'echo $!';

const wt = mkdtempSync(join(tmpdir(), 'conductor-cmd-'));
afterAll(() => removeTreeOrLeave(wt));

const opts = (cmd: string, over: Partial<RunCommandOptions> = {}): RunCommandOptions => ({
  commandId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  cmd,
  cwd: wt,
  timeoutMs: null,
  env: {},
  ...over,
});

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (pred: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('createCommandRunner', () => {
  it('returns the real runner with the given semaphore size', () => {
    const r = createCommandRunner({ maxConcurrent: 3 });
    expect(r).toBeInstanceOf(ProcessCommandRunner);
    expect(r.maxConcurrent).toBe(3);
  });
});

describe('ProcessCommandRunner', () => {
  it('exit 0: runs in cwd with merged env and streams output', async () => {
    const r = new ProcessCommandRunner({ maxConcurrent: 2 });
    const chunks: CommandOutputChunk[] = [];
    const res = await r.run(
      opts('(pwd -W 2>/dev/null || pwd); echo "port=$PORT"; echo oops >&2', {
        env: { PORT: '41000' },
        onOutput: (c) => chunks.push(c),
      }),
    );
    expect(res).toMatchObject({ exitCode: 0, signal: null, timedOut: false });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(res.outputTail).toContain('port=41000');
    expect(res.outputTail).toContain('oops');
    // macOS tmpdir may resolve through /private.
    expect(res.outputTail).toContain(sh(wt).replace(/^\/private/, ''));
    const out = chunks
      .filter((c) => c.stream === 'stdout')
      .map((c) => c.text)
      .join('');
    const err = chunks
      .filter((c) => c.stream === 'stderr')
      .map((c) => c.text)
      .join('');
    expect(out).toContain('port=41000');
    expect(err).toBe('oops\n');
    expect(r.runningCount).toBe(0);
  });

  it('non-zero exit is a result, not a rejection', async () => {
    const r = new ProcessCommandRunner({ maxConcurrent: 2 });
    const res = await r.run(opts('echo FAIL; exit 3'));
    expect(res).toMatchObject({ exitCode: 3, signal: null, timedOut: false, outputTail: 'FAIL\n' });
  });

  it('timeout: kills the whole process group and reports timedOut', async () => {
    const r = new ProcessCommandRunner({ maxConcurrent: 2, killGraceMs: 200 });
    const pidFile = join(wt, 'grandchild.pid');
    const started = Date.now();
    // A grandchild that would outlive a plain child kill.
    const res = await r.run(
      opts(`sleep 30 & ${LAST_BG_PID} > "${sh(pidFile)}"; echo started; wait`, {
        timeoutMs: 300,
      }),
    );
    // win32: the 200 ms grace can end before taskkill returns, so the escalation is reported.
    expect(res).toMatchObject({
      exitCode: null,
      signal: onWin32 ? (expect.stringMatching(/^SIG(TERM|KILL)$/) as unknown) : 'SIGTERM',
      timedOut: true,
    });
    expect(res.outputTail).toBe('started\n');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(existsSync(pidFile)).toBe(true);
    const gpid = Number(readFileSync(pidFile, 'utf8').trim());
    // TD-189: a Git Bash background job escapes taskkill /T on win32 (Job Objects would fix it);
    // the result still settles (drain timeout) and the slot is released.
    if (!onWin32) await waitFor(() => !pidAlive(gpid));
    expect(r.runningCount).toBe(0);
  });

  // win32 has no grace step: taskkill /T /F is final at once (TD-189).
  it.skipIf(onWin32)('timeout escalates to SIGKILL when SIGTERM is ignored', async () => {
    const r = new ProcessCommandRunner({ maxConcurrent: 1, killGraceMs: 200 });
    const res = await r.run(
      opts(`trap '' TERM; echo ready; while :; do sleep 0.05; done`, { timeoutMs: 200 }),
    );
    expect(res).toMatchObject({ exitCode: null, signal: 'SIGKILL', timedOut: true });
  });

  it('abort (WS kill) terminates a running command', async () => {
    const r = new ProcessCommandRunner({ maxConcurrent: 1, killGraceMs: 200 });
    const ac = new AbortController();
    const chunks: string[] = [];
    const p = r.run(
      opts('echo go; sleep 30', { signal: ac.signal, onOutput: (c) => chunks.push(c.text) }),
    );
    await waitFor(() => chunks.join('').includes('go'));
    ac.abort();
    expect(await p).toMatchObject({ exitCode: null, signal: 'SIGTERM', timedOut: false });
    expect(r.runningCount).toBe(0);
  });

  it('semaphore: 3 concurrent requests with limit 2 queue the third', async () => {
    const r = new ProcessCommandRunner({ maxConcurrent: 2 });
    const gate = join(wt, 'gate');
    const cmd = (name: string): string =>
      `echo ${name}; while [ ! -f "${sh(gate)}" ]; do sleep 0.02; done`;
    const waits: Record<string, boolean[]> = { a: [], b: [], c: [] };
    const out: Record<string, string> = { a: '', b: '', c: '' };
    const run = (n: 'a' | 'b' | 'c') =>
      r.run(
        opts(cmd(n), {
          onWaitingForSlot: (w) => waits[n]!.push(w),
          onOutput: (c) => (out[n] += c.text),
        }),
      );
    const a = run('a');
    const b = run('b');
    const c = run('c');
    expect(r.runningCount).toBe(2);
    expect(r.waitingCount).toBe(1);
    expect(waits).toEqual({ a: [], b: [], c: [true] });
    await waitFor(() => out.a !== '' && out.b !== '');
    await new Promise((res) => setTimeout(res, 100));
    expect(out.c).toBe(''); // still queued: not spawned
    writeFileSync(gate, '');
    const results = await Promise.all([a, b, c]);
    rmSync(gate);
    expect(results.map((x) => x.exitCode)).toEqual([0, 0, 0]);
    expect(waits.c).toEqual([true, false]);
    expect(out.c).toBe('c\n');
    expect(r.runningCount).toBe(0);
    expect(r.waitingCount).toBe(0);
  });

  it('aborting a queued command resolves SIGTERM without spawning or taking a slot', async () => {
    const r = new ProcessCommandRunner({ maxConcurrent: 1 });
    const gate = join(wt, 'gate2');
    const a = r.run(opts(`while [ ! -f "${sh(gate)}" ]; do sleep 0.02; done`));
    const ac = new AbortController();
    const waits: boolean[] = [];
    const out: string[] = [];
    const b = r.run(
      opts('echo should-not-run', {
        signal: ac.signal,
        onWaitingForSlot: (w) => waits.push(w),
        onOutput: (c) => out.push(c.text),
      }),
    );
    ac.abort();
    expect(await b).toMatchObject({ exitCode: null, signal: 'SIGTERM', durationMs: 0 });
    expect(waits).toEqual([true]);
    expect(r.waitingCount).toBe(0);
    writeFileSync(gate, '');
    expect(await a).toMatchObject({ exitCode: 0 });
    rmSync(gate);
    expect(out).toEqual([]);
    expect(r.runningCount).toBe(0);
  });

  it('keeps only the last tailBytes of combined output', async () => {
    const r = new ProcessCommandRunner({ maxConcurrent: 1 });
    const res = await r.run(
      opts('i=0; while [ $i -lt 100 ]; do echo line$i; i=$((i+1)); done', { tailBytes: 20 }),
    );
    expect(Buffer.byteLength(res.outputTail)).toBeLessThanOrEqual(20);
    expect(res.outputTail.endsWith('line99\n')).toBe(true);
  });

  it('defaults the tail to OUTPUT_TAIL_BYTES', async () => {
    const r = new ProcessCommandRunner({ maxConcurrent: 1 });
    const res = await r.run(opts(`head -c ${OUTPUT_TAIL_BYTES * 2} /dev/zero | tr '\\0' x`));
    expect(res.outputTail.length).toBe(OUTPUT_TAIL_BYTES);
  });

  it('rejects when the process cannot be spawned, and frees the slot', async () => {
    const r = new ProcessCommandRunner({ maxConcurrent: 1 });
    await expect(r.run(opts('true', { cwd: join(wt, 'missing') }))).rejects.toThrow();
    expect(r.runningCount).toBe(0);
    expect(await r.run(opts('true'))).toMatchObject({ exitCode: 0 });
  });
});

describe('Semaphore', () => {
  it('is FIFO and hands a released slot to the oldest waiter', async () => {
    const s = new Semaphore(1);
    expect(s.tryAcquire()).toBe(true);
    const order: string[] = [];
    const x = s.acquire().then(() => order.push('x'));
    const y = s.acquire().then(() => order.push('y'));
    s.release();
    await x;
    s.release();
    await y;
    expect(order).toEqual(['x', 'y']);
    s.release();
    expect(s.inUse).toBe(0);
  });

  it('rejects a non-positive size', () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
  });
});

describe('TailBuffer', () => {
  it('drops a multi-byte character cut at the front', () => {
    const t = new TailBuffer(4);
    t.push(Buffer.from('aé€')); // 1 + 2 + 3 bytes; the last 4 = é's 2nd byte + €
    expect(t.toString()).toBe('€');
  });

  it('keeps everything under the limit across chunks', () => {
    const t = new TailBuffer(5);
    t.push(Buffer.from('ab'));
    t.push(Buffer.from('cd'));
    t.push(Buffer.from('efg'));
    expect(t.toString()).toBe('cdefg');
  });
});
