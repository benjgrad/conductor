import { execFileSync } from 'node:child_process';
import { statfsSync } from 'node:fs';
import { cpus, freemem, loadavg } from 'node:os';

// Live machine resources for `heartbeat` and `request_work` (03). Injectable so tests can fake
// memory pressure.

export interface LiveResources {
  /** Idle cores, estimated from the 1-minute load average. */
  cpuFree: number;
  memFreeMb: number;
  diskFreeMb: number;
}

export type SysInfo = (rootDir: string) => LiveResources;

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

function availableMemBytes(): number {
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

export const liveResources: SysInfo = (rootDir) => {
  const cores = cpus().length;
  const load = loadavg()[0] ?? 0;
  let diskFreeMb = 0;
  try {
    const s = statfsSync(rootDir);
    diskFreeMb = Math.floor((s.bavail * s.bsize) / (1024 * 1024));
  } catch {
    // root dir not created yet
  }
  return {
    cpuFree: Math.max(0, Math.round((cores - load) * 100) / 100),
    memFreeMb: Math.floor(availableMemBytes() / (1024 * 1024)),
    diskFreeMb,
  };
};
