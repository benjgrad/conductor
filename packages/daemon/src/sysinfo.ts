import { statfsSync } from 'node:fs';
import { cpus } from 'node:os';
import { availableMemBytes, busyCores } from './platform/sysres.js';

export { parseVmStatAvailableBytes } from './platform/sysres.js';

// Live machine resources for `heartbeat` and `request_work` (03). Injectable so tests can fake
// memory pressure.

export interface LiveResources {
  /** Idle cores: from the 1-minute load average (win32: CPU time since the last call). */
  cpuFree: number;
  memFreeMb: number;
  diskFreeMb: number;
}

export type SysInfo = (rootDir: string) => LiveResources;

export const liveResources: SysInfo = (rootDir) => {
  const cores = cpus().length;
  const load = busyCores();
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
