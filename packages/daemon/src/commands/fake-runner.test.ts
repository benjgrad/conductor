import { describe, expect, it } from 'vitest';
import { FakeCommandRunner } from './fake-runner.js';
import type { RunCommandOptions } from './runner.js';

const opts = (cmd: string, over: Partial<RunCommandOptions> = {}): RunCommandOptions => ({
  commandId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  cmd,
  cwd: '/tmp/wt',
  timeoutMs: null,
  env: {},
  ...over,
});

describe('FakeCommandRunner', () => {
  it('scripts exit codes, output and timeouts', async () => {
    const r = new FakeCommandRunner(2, true)
      .script('npm test', { exitCode: 1, output: 'FAIL' })
      .script('slow', { timedOut: true });
    const chunks: string[] = [];
    const t = await r.run(opts('npm test', { onOutput: (c) => chunks.push(c.text) }));
    expect(t).toMatchObject({ exitCode: 1, timedOut: false, outputTail: 'FAIL' });
    expect(chunks).toEqual(['FAIL']);
    expect(await r.run(opts('slow'))).toMatchObject({ exitCode: null, timedOut: true });
    expect(await r.run(opts('npm run build'))).toMatchObject({ exitCode: 0 });
  });

  it('queues the third of three commands with limit 2 and reports build_slot', async () => {
    const r = new FakeCommandRunner(2);
    const waits: boolean[] = [];
    const a = r.run(opts('a'));
    const b = r.run(opts('b'));
    const c = r.run(opts('c', { onWaitingForSlot: (w) => waits.push(w) }));
    expect(r.runningCount).toBe(2);
    expect(waits).toEqual([true]);
    r.release('a');
    await a;
    expect(waits).toEqual([true, false]);
    expect(r.runningCount).toBe(2);
    r.releaseAll();
    await Promise.all([b, c]);
    expect(r.runningCount).toBe(0);
  });

  it('resolves with SIGTERM on abort', async () => {
    const r = new FakeCommandRunner(1);
    const ac = new AbortController();
    const p = r.run(opts('x', { signal: ac.signal }));
    ac.abort();
    expect(await p).toMatchObject({ exitCode: null, signal: 'SIGTERM', timedOut: false });
  });

  it('aborting a queued run keeps the next waiter queued until a slot frees', async () => {
    const r = new FakeCommandRunner(1);
    const ac = new AbortController();
    const a = r.run(opts('a'));
    const b = r.run(opts('b', { signal: ac.signal }));
    const cWaits: boolean[] = [];
    let cDone = false;
    const c = r.run(opts('c', { onWaitingForSlot: (w) => cWaits.push(w) })).then((res) => {
      cDone = true;
      return res;
    });
    ac.abort();
    expect(await b).toMatchObject({ exitCode: null, signal: 'SIGTERM' });
    expect(r.runningCount).toBe(1);
    expect(cWaits).toEqual([true]);
    r.release('a');
    await a;
    expect(r.runningCount).toBe(1);
    expect(cWaits).toEqual([true, false]);
    expect(cDone).toBe(false);
    expect(r.release('c')).toBe(true);
    expect(await c).toMatchObject({ exitCode: 0, signal: null });
    expect(r.runningCount).toBe(0);
  });
});
