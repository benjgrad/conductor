import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { killTree, taskkillArgs } from './kill-tree.js';
import { spawnCli } from './spawn.js';

const isWin = process.platform === 'win32';

/** Is `pid` a live process? A Linux zombie (exited, not yet reaped by init) counts as dead. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
    } catch {
      return false;
    }
  }
  return true;
}

async function waitFor(cond: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

const spawned: number[] = [];
afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
});

/**
 * A node child (own process group on POSIX) that starts a grandchild and prints
 * `<grandchild pid>` once it is running. `ignoreTerm` makes both ignore SIGTERM.
 */
async function childWithGrandchild(
  ignoreTerm = false,
): Promise<{ child: ChildProcess; childPid: number; grandPid: number }> {
  const trap = ignoreTerm ? "process.on('SIGTERM',()=>{});" : '';
  // The grandchild says when its trap is installed; only then does the child print its pid.
  const grand = `${trap}console.log('ready');setInterval(()=>{},1000);`;
  const src = `${trap}const {spawn}=require('node:child_process');
const g=spawn(process.execPath,['-e',${JSON.stringify(grand)}],{stdio:['ignore','pipe','ignore']});
g.stdout.once('data',()=>console.log(g.pid));setInterval(()=>{},1000);`;
  const child = spawnCli(process.execPath, ['-e', src], {
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const childPid = child.pid;
  if (childPid === undefined) throw new Error('child did not spawn');
  spawned.push(childPid);
  const rl = createInterface({ input: child.stdout! });
  const line = await new Promise<string>((resolve) => rl.once('line', resolve));
  rl.close();
  const grandPid = Number(line.trim());
  spawned.push(grandPid);
  return { child, childPid, grandPid };
}

describe('killTree', () => {
  it('taskkillArgs: tree, force, by pid', () => {
    expect(taskkillArgs(42)).toEqual(['/T', '/F', '/PID', '42']);
  });

  it('rejects a bad pid and ignores a never-spawned child', async () => {
    expect(() => killTree(0)).toThrow(RangeError);
    expect(() => killTree(-5)).toThrow(RangeError);
    const never = { pid: undefined } as unknown as ChildProcess;
    await expect(killTree(never).settled).resolves.toBeUndefined();
  });

  it('kills a node child and its grandchild (both pids gone)', async () => {
    const { child, childPid, grandPid } = await childWithGrandchild();
    expect(alive(childPid)).toBe(true);
    expect(alive(grandPid)).toBe(true);
    await killTree(child, { graceMs: 5_000 }).settled.catch(() => undefined);
    expect(await waitFor(() => !alive(childPid))).toBe(true);
    expect(await waitFor(() => !alive(grandPid))).toBe(true);
  });

  it('accepts a bare pid as well', async () => {
    const { childPid, grandPid } = await childWithGrandchild();
    await killTree(childPid, { signal: 'SIGKILL' }).settled;
    expect(await waitFor(() => !alive(childPid))).toBe(true);
    expect(await waitFor(() => !alive(grandPid))).toBe(true);
  });

  it.skipIf(isWin)('POSIX: escalates to SIGKILL after the grace period', async () => {
    const { child, childPid, grandPid } = await childWithGrandchild(true);
    const h = killTree(child, { graceMs: 300 });
    await new Promise((r) => setTimeout(r, 150));
    expect(alive(childPid)).toBe(true); // SIGTERM ignored
    await h.settled;
    expect(await waitFor(() => !alive(childPid))).toBe(true);
    expect(await waitFor(() => !alive(grandPid))).toBe(true);
  });

  it.skipIf(isWin)('POSIX: cancel() stops the escalation', async () => {
    const { child, childPid, grandPid } = await childWithGrandchild(true);
    const h = killTree(child, { graceMs: 200 });
    h.cancel();
    await h.settled;
    await new Promise((r) => setTimeout(r, 400));
    expect(alive(childPid)).toBe(true);
    expect(alive(grandPid)).toBe(true);
  });

  it.runIf(isWin)('win32: an exited child is skipped (its pid may be reused)', async () => {
    const child = spawnCli(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    await new Promise((r) => child.once('exit', r));
    await expect(killTree(child).settled).resolves.toBeUndefined();
  });
});
