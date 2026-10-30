// M2-T18: the per-user service manager `conductor-daemon service` drives. win32 has none yet (the
// MW milestone decides between a Scheduled Task and a service); `service` refuses there.

export type ServiceManager = 'launchd' | 'systemd';

/** launchd on macOS, systemd --user on Linux, null elsewhere (win32 included). */
export function serviceManager(
  platform: NodeJS.Platform = process.platform,
): ServiceManager | null {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd';
  return null;
}
