import { z } from 'zod';
import {
  IsoDateTimeSchema,
  MachineAlertKindSchema,
  MachineRepoModeSchema,
  UuidSchema,
} from '../domain.js';
import {
  DaemonVersionSchema,
  UPDATE_ERROR_MAX_CHARS,
  UpdateStageSchema,
} from '../machines/update.js';
import { MachineDtoSchema } from './rest.js';

// Machines REST DTOs (M2-T01, ADR-0013 §Enrollment, ADR-0017 §Daemon distribution). The daemon
// WS protocol (inventory, capabilities on the wire) is M2-T02's; these are the web's views.

/** Enrollment tokens are single use and valid for 30 minutes. */
export const ENROLLMENT_TOKEN_TTL_MS = 30 * 60_000;

/**
 * POST /api/machines/enroll (public, token-authenticated, rate-limited) → 201 EnrollResponse.
 * 401 `unauthorized` for an unknown, used or expired token; 429 per IP.
 */
export const EnrollRequestSchema = z.object({
  token: z.string().min(1).max(512),
  hostname: z.string().min(1).max(255),
  os: z.string().min(1).max(64),
  arch: z.string().min(1).max(64),
  daemon_version: z.string().min(1).max(100),
});
export type EnrollRequest = z.infer<typeof EnrollRequestSchema>;

/** The machine id (server-generated) and its credential, returned once; only a hash is stored. */
export const EnrollResponseSchema = z.object({
  machine_id: z.string().min(1),
  credential: z.string().min(1),
});
export type EnrollResponse = z.infer<typeof EnrollResponseSchema>;

/**
 * POST /api/machines/enrollment-tokens `{}` → 201. `command` is the full install line, shown once:
 * `curl -fsSL <public url>/install.sh | sh -s -- --token <token>`. `command_windows` is the same
 * for PowerShell (MW-T11): `$env:CONDUCTOR_ENROLL_TOKEN='<token>'; irm <public url>/install.ps1 | iex`;
 * optional, so a client hides the Windows form when an older server leaves it out.
 */
export const EnrollmentTokenCreatedSchema = z.object({
  token: z.string().min(1),
  command: z.string().min(1),
  command_windows: z.string().min(1).optional(),
  expires_at: IsoDateTimeSchema,
});
export type EnrollmentTokenCreated = z.infer<typeof EnrollmentTokenCreatedSchema>;

/** An open machine alert (e.g. the `.git` of a checkout-mode repo changed during a session). */
export const MachineAlertDtoSchema = z.object({
  id: UuidSchema,
  kind: MachineAlertKindSchema,
  repo: z.string().nullable(),
  session_id: UuidSchema.nullable(),
  files: z.array(z.string()),
  created_at: IsoDateTimeSchema,
});
export type MachineAlertDto = z.infer<typeof MachineAlertDtoSchema>;

/** ADR-0021 §3: an update to `version` failed at `stage` (the `alert update_failed` payload). */
export const MachineUpdateAlertSchema = z.object({
  kind: z.literal('update_failed'),
  version: DaemonVersionSchema,
  stage: UpdateStageSchema,
  error: z.string().max(UPDATE_ERROR_MAX_CHARS),
  at: IsoDateTimeSchema,
});
export type MachineUpdateAlert = z.infer<typeof MachineUpdateAlertSchema>;

/**
 * A `MachineRow.alerts` entry. The list (M2-T18d) carries `update_failed` ones; the git_tamper
 * DTO is admitted so a MachineDetail (which narrows `alerts` to it) is still a valid MachineRow.
 */
export const MachineRowAlertSchema = z.union([MachineUpdateAlertSchema, MachineAlertDtoSchema]);
export type MachineRowAlert = z.infer<typeof MachineRowAlertSchema>;

/**
 * GET /api/machines → MachineRow[] (the caller's account only). A superset of the M1 MachineDto,
 * so M1 clients still parse it. "Last seen" is `last_heartbeat_at`; `outdated`: the daemon is older
 * than the version the server distributes.
 */
export const MachineRowSchema = MachineDtoSchema.extend({
  name: z.string(),
  daemon_version: z.string().nullable(),
  claude_version: z.string().nullable(),
  outdated: z.boolean(),
  repo_count: z.number().int().nonnegative(),
  revoked_at: IsoDateTimeSchema.nullable(),
  /** ADR-0021: the machine's open `update_failed` alerts (M2-T18d). Absent ≡ none, never null. */
  alerts: z.array(MachineRowAlertSchema).optional(),
});
export type MachineRow = z.infer<typeof MachineRowSchema>;
export const MachineListResponseSchema = z.array(MachineRowSchema);

/** One repo of a machine's inventory. `remote: null` = not routable (no canonical origin). */
export const MachineRepoDtoSchema = z.object({
  remote: z.string().nullable(),
  path: z.string(),
  mode: MachineRepoModeSchema,
  default_branch: z.string().nullable(),
});
export type MachineRepoDto = z.infer<typeof MachineRepoDtoSchema>;

/**
 * One capability for display (never account names or secrets): `version` for cli / claude,
 * `authed` for cli, `repo` for repo-scoped skills and agents; null where it doesn't apply.
 */
export const MachineCapabilityDtoSchema = z.object({
  name: z.string(),
  version: z.string().nullable(),
  authed: z.boolean().nullable(),
  repo: z.string().nullable(),
});
export type MachineCapabilityDto = z.infer<typeof MachineCapabilityDtoSchema>;

/**
 * GET /api/machines/:id → MachineDetail (404 for another account's id). `live_sessions`: what a
 * revoke would hand to a human (the Machines page names them in its confirmation).
 */
export const MachineDetailSchema = MachineRowSchema.extend({
  os: z.string().nullable(),
  arch: z.string().nullable(),
  repos: z.array(MachineRepoDtoSchema),
  capabilities: z.object({
    cli: z.array(MachineCapabilityDtoSchema),
    mcp: z.array(MachineCapabilityDtoSchema),
    skill: z.array(MachineCapabilityDtoSchema),
    agent: z.array(MachineCapabilityDtoSchema),
    claude: z.array(MachineCapabilityDtoSchema),
  }),
  alerts: z.array(MachineAlertDtoSchema),
  live_sessions: z.array(
    z.object({ session_id: UuidSchema, ticket_id: UuidSchema, title: z.string() }),
  ),
});
export type MachineDetail = z.infer<typeof MachineDetailSchema>;

/** PATCH /api/machines/:id → 200 MachineRow. */
export const RenameMachineRequestSchema = z.object({ name: z.string().trim().min(1).max(64) });
export type RenameMachineRequest = z.infer<typeof RenameMachineRequestSchema>;
