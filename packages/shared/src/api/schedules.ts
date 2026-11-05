import { z } from 'zod';
import {
  DEFAULT_TICKET_PRIORITY,
  IsoDateTimeSchema,
  TicketPrioritySchema,
  TicketStatusSchema,
  UuidSchema,
} from '../domain.js';
import { DEFAULT_SCHEDULE_TIMEZONE } from '../schedule/cron.js';
import { ROUTINE_WORKFLOW_ID } from '../workflow/routine.js';
import { TicketKindSchema } from '../workflow/schema.js';

// ADR-0032: recurring tickets. The REST routes (/api/schedules) and the MCP tools
// (list/save/delete/run_schedule_now) share these shapes; 10-contracts §Schedules.

/** How many upcoming runs a ScheduleDto previews. */
export const SCHEDULE_PREVIEW_RUNS = 3;

export const SCHEDULE_NAME_MAX = 100;
export const SCHEDULE_TITLE_MAX = 200;
export const SCHEDULE_BODY_MAX = 20_000;
export const SCHEDULE_MACHINES_MAX = 10;

/** Why the last due run made no ticket. */
export const ScheduleSkipReasonSchema = z.enum(['previous_run_open', 'invalid_schedule']);
export type ScheduleSkipReason = z.infer<typeof ScheduleSkipReasonSchema>;

/** Warnings on a save: the template can't run anywhere yet (it is saved anyway). */
export const ScheduleWarningSchema = z.enum([
  'no_machine_has_repo',
  'machine_lacks_repo',
  'pinned_machine_revoked',
]);
export type ScheduleWarning = z.infer<typeof ScheduleWarningSchema>;

export const ScheduleDtoSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  cron: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  title: z.string(),
  body: z.string(),
  repo: z.string(),
  workflow_id: z.string(),
  kind: TicketKindSchema,
  priority: z.number().int(),
  required_tags: z.array(z.string()),
  /** Machine ids each run is pinned to (`ticket.repo_allow_machines`); null = any machine. */
  machine_ids: z.array(z.string()).nullable(),
  /** null while disabled. */
  next_run_at: IsoDateTimeSchema.nullable(),
  /** The next SCHEDULE_PREVIEW_RUNS run times ([] while disabled). */
  next_runs: z.array(IsoDateTimeSchema),
  last_run_at: IsoDateTimeSchema.nullable(),
  /** The ticket of the last run, as it is now; null = never ran (or the ticket is gone). */
  last_ticket: z.object({ id: UuidSchema, status: TicketStatusSchema }).nullable(),
  last_skipped_at: IsoDateTimeSchema.nullable(),
  last_skip_reason: ScheduleSkipReasonSchema.nullable(),
  /** Present when something keeps the runs from being claimed; absent ≡ none. */
  warnings: z.array(ScheduleWarningSchema).optional(),
  created_by: z.string().nullable(),
  created_at: IsoDateTimeSchema,
  /** PATCH's `expected_updated_at`. */
  updated_at: IsoDateTimeSchema,
});
export type ScheduleDto = z.infer<typeof ScheduleDtoSchema>;

export const ScheduleListResponseSchema = z.object({ schedules: z.array(ScheduleDtoSchema) });
export type ScheduleListResponse = z.infer<typeof ScheduleListResponseSchema>;

const nameField = z.string().trim().min(1).max(SCHEDULE_NAME_MAX);
const machinesField = z
  .array(z.string().trim().min(1).max(200))
  .max(SCHEDULE_MACHINES_MAX)
  .nullable()
  .describe('Machine ids or names; null / [] = any machine');

/** POST /api/schedules → 201 ScheduleDto. */
export const CreateScheduleRequestSchema = z.object({
  name: nameField,
  cron: z.string().trim().min(1).max(100),
  timezone: z.string().trim().min(1).max(100).default(DEFAULT_SCHEDULE_TIMEZONE),
  enabled: z.boolean().default(true),
  title: z.string().trim().min(1).max(SCHEDULE_TITLE_MAX),
  body: z.string().max(SCHEDULE_BODY_MAX).default(''),
  repo: z.string().trim().min(1).max(200),
  workflow_id: z.string().min(1).max(100).default(ROUTINE_WORKFLOW_ID),
  kind: TicketKindSchema,
  priority: TicketPrioritySchema.default(DEFAULT_TICKET_PRIORITY),
  required_tags: z.array(z.string().min(1).max(100)).max(20).default([]),
  machines: machinesField.default(null),
});
export type CreateScheduleRequest = z.input<typeof CreateScheduleRequestSchema>;

/** PATCH /api/schedules/:id → ScheduleDto. Every field optional; `expected_updated_at` guards. */
export const UpdateScheduleRequestSchema = z.object({
  expected_updated_at: IsoDateTimeSchema.optional(),
  name: nameField.optional(),
  cron: z.string().trim().min(1).max(100).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  title: z.string().trim().min(1).max(SCHEDULE_TITLE_MAX).optional(),
  body: z.string().max(SCHEDULE_BODY_MAX).optional(),
  repo: z.string().trim().min(1).max(200).optional(),
  workflow_id: z.string().min(1).max(100).optional(),
  kind: TicketKindSchema.optional(),
  priority: TicketPrioritySchema.optional(),
  required_tags: z.array(z.string().min(1).max(100)).max(20).optional(),
  machines: machinesField.optional(),
});
export type UpdateScheduleRequest = z.input<typeof UpdateScheduleRequestSchema>;

/** POST /api/schedules/:id/run `{force?}` → 201 RunScheduleResponse. */
export const RunScheduleRequestSchema = z.object({ force: z.boolean().default(false) });

export const RunScheduleResponseSchema = z.object({
  ticket_id: UuidSchema,
  schedule: ScheduleDtoSchema,
});
export type RunScheduleResponse = z.infer<typeof RunScheduleResponseSchema>;
