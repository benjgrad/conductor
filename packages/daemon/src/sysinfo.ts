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
    memFreeMb: Math.floor(freemem() / (1024 * 1024)),
    diskFreeMb,
  };
};
