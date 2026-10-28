import { z } from 'zod';

// Daemon auto-update (M2-T18b; ADR-0021, 10-contracts §Daemon auto-update). The wire shapes that
// carry these (`update_available`, `heartbeat.draining`, `alert update_failed`) are in ws.ts.

/** §1: the only tarball name a daemon fetches; it must also equal `daemonTarballName(version)`. */
export const DAEMON_TARBALL_RE = /^conductor-daemon-[0-9A-Za-z.+-]+\.tgz$/;

/** §2: a download larger than this is refused before it is written out. */
export const DAEMON_TARBALL_MAX_BYTES = 100 * 1024 * 1024;

/** A served daemon version (`0.3.0+4c5d6e7`): no `/`, never starting with `.`. */
export const DaemonVersionSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/);

/** A SHA-256 digest: 64 lowercase hex characters. */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** §1: the tarball file name for a version. */
export function daemonTarballName(version: string): string {
  return `conductor-daemon-${version}.tgz`;
}

/**
 * §1: the build to fetch. The `GET /downloads/latest.json` body (no-store) and the
 * `update_available` payload. `file` must be exactly `daemonTarballName(version)`.
 */
export const LatestDaemonSchema = z
  .object({
    version: DaemonVersionSchema,
    file: z.string().regex(DAEMON_TARBALL_RE),
    sha256: Sha256HexSchema,
    size: z.number().int().positive().max(DAEMON_TARBALL_MAX_BYTES),
  })
  .refine((d) => d.file === daemonTarballName(d.version), {
    message: 'file must be conductor-daemon-<version>.tgz',
    path: ['file'],
  });
export type LatestDaemon = z.infer<typeof LatestDaemonSchema>;

/** §3: where an update failed (`alert update_failed.stage`). */
export const UpdateStageSchema = z.enum(['download', 'verify', 'unpack', 'drain_timeout', 'trial']);
export type UpdateStage = z.infer<typeof UpdateStageSchema>;

/** §3: cap on `alert update_failed.error` (UTF-16 code units). */
export const UPDATE_ERROR_MAX_CHARS = 500;

/** §2: exit code after switching `current` (`EX_TEMPFAIL`); both service units restart on it. */
export const EXIT_RESTART_FOR_UPDATE = 75;

/** §2: a drain gives up after 6 h; the daemon resumes work and alerts `drain_timeout`. */
export const UPDATE_MAX_DRAIN_MS = 6 * 60 * 60_000;

/** §3: a new version that reaches the server without `registered` within this exits 75. */
export const UPDATE_TRIAL_REGISTER_MS = 120_000;

/** §2: abandoned drains per version before the daemon stops trying it. */
export const UPDATE_MAX_DRAIN_ATTEMPTS = 3;

/** §2: after an abandoned drain, no drain for the same version for 1 h. */
export const UPDATE_DRAIN_COOLDOWN_MS = 60 * 60_000;

/** §3: starts of a new version before the launcher rolls back (`attempts > 2`). */
export const UPDATE_MAX_TRIAL_ATTEMPTS = 2;
