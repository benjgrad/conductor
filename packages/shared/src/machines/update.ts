import { z } from 'zod';
import { IsoDateTimeSchema } from '../domain.js';

// Daemon auto-update contracts (M2-T18b; ADR-0021, 10-contracts §Daemon auto-update). The WS
// frames that use these (`update_available`, `heartbeat.draining`, `alert update_failed`) are in
// protocol/ws.ts; this module must not import it.

/** The daemon exits with this after switching `current` to a new version: "restart me". */
export const EXIT_RESTART_FOR_UPDATE = 75;
/** Draining for an update gives up after 6 h (`update.max_drain_ms`); the daemon resumes work. */
export const UPDATE_MAX_DRAIN_MS = 6 * 60 * 60 * 1000;
/** A trial start fails if it reaches the server and gets no `registered` within this. */
export const UPDATE_TRIAL_REGISTER_MS = 120_000;
/** After this many abandoned drains for one version, the daemon stops trying that version. */
export const UPDATE_MAX_DRAIN_ATTEMPTS = 3;
/** After an abandoned drain, the daemon doesn't drain for that version again for 1 h. */
export const UPDATE_DRAIN_COOLDOWN_MS = 60 * 60 * 1000;
/** The launcher rolls back after this many failed trial starts of a new version. */
export const UPDATE_MAX_TRIAL_ATTEMPTS = 2;

/** Cap on a daemon tarball (`update_available.size`, `latest.json.size`). */
export const DAEMON_TARBALL_MAX_BYTES = 100 * 1024 * 1024;
/**
 * A served daemon tarball name. ADR-0021 §1, widened for ADR-0026's per-target names
 * (`conductor-daemon-<version>-<target>.tgz`, Rust targets contain `_`). No `/` or `\`.
 */
export const DAEMON_TARBALL_RE = /^conductor-daemon-[0-9A-Za-z._+-]{1,128}\.tgz$/;
/** A target suffix in a tarball name: a lower-case Rust triple (`x86_64-unknown-linux-gnu`). */
export const DAEMON_TARGET_RE = /^[0-9a-z_]+(-[0-9a-z_]+){1,3}$/;
/** A daemon version (`<package version>[+<short sha>]`), as distribution.ts serves it. */
export const DAEMON_VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/;
/** The body of `GET API_PATHS.daemonDownload(LATEST_DAEMON_FILE)`. */
export const LATEST_DAEMON_FILE = 'latest.json';

export const DaemonVersionSchema = z.string().regex(DAEMON_VERSION_RE);
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * `file` names exactly `version`: `conductor-daemon-<version>.tgz`, or
 * `conductor-daemon-<version>-<target>.tgz` with a DAEMON_TARGET_RE target. TD-196: the Rust types
 * don't carry this check; the Rust updater (MR-T14) has to make it itself.
 */
export function daemonTarballMatches(file: string, version: string): boolean {
  if (!DAEMON_TARBALL_RE.test(file) || !DAEMON_VERSION_RE.test(version)) return false;
  const prefix = `conductor-daemon-${version}`;
  if (file === `${prefix}.tgz`) return true;
  if (!file.startsWith(`${prefix}-`) || !file.endsWith('.tgz')) return false;
  return DAEMON_TARGET_RE.test(file.slice(prefix.length + 1, -'.tgz'.length));
}

/** `{version, file, sha256, size}` of one served build (update_available, latest.json). */
export const daemonBuildShape = {
  version: DaemonVersionSchema,
  file: z.string().regex(DAEMON_TARBALL_RE),
  sha256: Sha256HexSchema,
  size: z.number().int().positive().max(DAEMON_TARBALL_MAX_BYTES),
};

/** The refine every daemon build reference carries: `file` embeds `version`. */
export const daemonBuildRefinement = {
  check: (b: { file: string; version: string }) => daemonTarballMatches(b.file, b.version),
  params: { message: 'file does not name this version', path: ['file'] },
};

/**
 * ADR-0021 §1: `GET /downloads/latest.json` (`no-store`), fetched by a daemon closed with 4005.
 * Per-target builds (ADR-0026): the daemon adds `?os=<register.os>&arch=<register.arch>`; with
 * no query the server returns its only build (M2-T18d / MR-T15).
 */
export const LatestDaemonSchema = z
  .object(daemonBuildShape)
  .refine(daemonBuildRefinement.check, daemonBuildRefinement.params);
export type LatestDaemon = z.infer<typeof LatestDaemonSchema>;

/** Where an update failed (ADR-0021 §3). */
export const UpdateFailedStageSchema = z.enum([
  'download',
  'verify',
  'unpack',
  'drain_timeout',
  'trial',
]);
export type UpdateFailedStage = z.infer<typeof UpdateFailedStageSchema>;
/** Cap on `alert update_failed.error`. */
export const UPDATE_FAILED_ERROR_MAX = 500;

/** An open `update_failed` alert on a machine, for the Machines page (M2-T18e). */
export const MachineUpdateAlertDtoSchema = z.object({
  kind: z.literal('update_failed'),
  version: DaemonVersionSchema,
  stage: UpdateFailedStageSchema,
  error: z.string().max(UPDATE_FAILED_ERROR_MAX),
  at: IsoDateTimeSchema,
});
export type MachineUpdateAlertDto = z.infer<typeof MachineUpdateAlertDtoSchema>;
