import { execFileSync } from 'node:child_process';
import { cpus, freemem, loadavg, type CpuInfo } from 'node:os';

// ADR-0024 §8: machine resources that each OS reports differently.
//
// Memory: macOS `os.freemem()` counts only completely unused pages, so darwin reads `vm_stat`.
// CPU: `os.loadavg()` is always [0, 0, 0] on win32, so busy cores come from `os.cpus()` time
// deltas between two calls there (the first call uses the totals since boot).

/**
 * Available memory on macOS from `vm_stat`: free + inactive + speculative + purgeable pages,
 * i.e. what the kernel can hand out without swapping. `os.freemem()` on darwin counts only
 * completely unused pages (often < 200 MB on a busy Mac), which made every start look like
 * memory pressure. Returns null if the output can't be parsed.
 */
export function parseVmStatAvailableBytes(out: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(out)?.[1];
  if (!pageSize) return null;
  const pages = (label: string) =>
    Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(out)?.[1] ?? NaN);
  const parts = ['free', 'inactive', 'speculative', 'purgeable'].map(pages);
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((a, b) => a + b, 0) * Number(pageSize);
}

/** Memory the OS can hand out without swapping, in bytes. */
export function availableMemBytes(): number {
  if (process.platform === 'darwin') {
    try {
      const avail = parseVmStatAvailableBytes(
        execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 2000 }),
      );
      if (avail !== null) return avail;
    } catch {
      // fall through to freemem()
    }
  }
  return freemem();
}

/** Busy and total CPU time summed over all cores. */
function cpuTimes(info: readonly CpuInfo[]): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const { times } of info) {
    const t = times.user + times.nice + times.sys + times.irq + times.idle;
    total += t;
    busy += t - times.idle;
  }
  return { busy, total };
}

/**
 * Busy cores between two `os.cpus()` snapshots: the busy share of the elapsed CPU time times the
 * core count. Pure. With no elapsed time, 0.
 */
export function busyCoresBetween(prev: readonly CpuInfo[], now: readonly CpuInfo[]): number {
  const a = cpuTimes(prev);
  const b = cpuTimes(now);
  const total = b.total - a.total;
  if (total <= 0) return 0;
  return ((b.busy - a.busy) / total) * now.length;
}

let lastCpus: CpuInfo[] | null = null;

/** Busy cores now: POSIX the 1-minute load average; win32 the busy share since the last call. */
export function busyCores(): number {
  if (process.platform !== 'win32') return loadavg()[0] ?? 0;
  const now = cpus();
  const prev =
    lastCpus ?? now.map((c) => ({ ...c, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }));
  lastCpus = now;
  return busyCoresBetween(prev, now);
}
