import { z } from 'zod';
import {
  IsoDateTimeSchema,
  MachineAlertKindSchema,
  MachineRepoModeSchema,
  UuidSchema,
} from '../domain.js';
import { RepoRuleListSchema } from '../machines/repo-rules.js';
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
  /**
   * Repo rules (ADR-0013 §Routing, amendment 2026-10-30): the repo patterns this machine may take
   * (null = any), and those only it may take. Absent from older servers ≡ null / [].
   */
  repo_allow: z.array(z.string()).nullable().default(null),
  repo_exclusive: z.array(z.string()).default([]),
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

/** Cap on `MachineDetail.cannot_take`. */
export const MACHINE_CANNOT_TAKE_MAX = 50;

/**
 * M2-T16a (ADR-0013 §Routing): a queued ticket this machine is excluded from, and why: the repo
 * (`missing_repo`, absent when it has it), the capability keys it lacks, its own `repo_allow`
 * (`excluded_by_rule`) and the names of the other machines whose `repo_exclusive` claims the repo
 * (`exclusive_to`).
 */
export const MachineCannotTakeSchema = z.object({
  ticket_id: UuidSchema,
  title: z.string(),
  missing_repo: z.string().optional(),
  missing_capabilities: z.array(z.string()),
  excluded_by_rule: z.literal(true).optional(),
  exclusive_to: z.array(z.string()).optional(),
});
export type MachineCannotTake = z.infer<typeof MachineCannotTakeSchema>;

/**
 * GET /api/machines/:id → MachineDetail (404 for another account's id). `live_sessions`: what a
 * revoke would hand to a human (the Machines page names them in its confirmation). `cannot_take`:
 * the account's queued tickets this machine can't take (highest priority first, at most
 * MACHINE_CANNOT_TAKE_MAX; absent from older servers ≡ []).
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
  cannot_take: z.array(MachineCannotTakeSchema).max(MACHINE_CANNOT_TAKE_MAX).default([]),
});
export type MachineDetail = z.infer<typeof MachineDetailSchema>;

/**
 * PATCH /api/machines/:id → 200 MachineRow. Every field optional, at least one: `name`, and the repo
 * rules (`RepoPatternSchema` each, at most REPO_RULE_MAX; `repo_allow: null` = any repo). 400 for
 * a bad pattern; 409 `conflict` when a `repo_exclusive` pattern equals (case-insensitively) one on
 * another unrevoked machine of the account.
 */
export const UpdateMachineRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    repo_allow: RepoRuleListSchema.nullable().optional(),
    repo_exclusive: RepoRuleListSchema.optional(),
  })
  .refine(
    (r) => r.name !== undefined || r.repo_allow !== undefined || r.repo_exclusive !== undefined,
    'expected name, repo_allow or repo_exclusive',
  );
export type UpdateMachineRequest = z.input<typeof UpdateMachineRequestSchema>;

/** The rename-only form (M2-T17); an UpdateMachineRequest. */
export const RenameMachineRequestSchema = z.object({ name: z.string().trim().min(1).max(64) });
export type RenameMachineRequest = z.infer<typeof RenameMachineRequestSchema>;
