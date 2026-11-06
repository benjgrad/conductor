import { z } from 'zod';
import { RepoChecksSchema } from '../workflow/repo-checks.js';
import { WorkflowDefinitionSchema } from '../workflow/schema.js';
import { stateKey } from './gates.js';
import {
  checkFailed,
  classOf,
  median,
  percentile,
  stateDurations,
  type AdvisorRows,
} from './metrics.js';

// ADR-0033 P3 (MA-T05): change proposals. The workflow advisor never writes directly: it stores a
// proposal (what would change, why, the evidence, the expected effect and the rollback), a human
// confirms it, and `apply_change` (or Apply on the board) runs the existing guarded save path.
// The review (list_change_proposals with an id, or the board) later compares the expected metric
// before and after. Pure: no I/O here.

/**
 * What a proposal may change. Machine settings come with MA-T06 (ADR-0022): until then no other
 * kind parses, so nothing over MCP can touch permissions or `bypassPermissions`.
 */
export const ChangeKindSchema = z.enum(['workflow', 'repo_checks']);
export type ChangeKind = z.infer<typeof ChangeKindSchema>;

/**
 * `proposed` → `applied` | `rejected` | `conflict` (what it was based on changed: propose again)
 * | `failed` (the save threw). Only `proposed` can be applied; nothing retries by itself.
 */
export const ChangeStatusSchema = z.enum(['proposed', 'applied', 'rejected', 'conflict', 'failed']);
export type ChangeStatus = z.infer<typeof ChangeStatusSchema>;
export const CHANGE_STATUSES = ChangeStatusSchema.options;

/** An account has at most this many `proposed` proposals at once. */
export const OPEN_PROPOSALS_MAX = 20;

export const WorkflowChangeSchema = z.strictObject({
  kind: z.literal('workflow'),
  workflow_id: z.string().min(1).max(100),
  /** The version the definition was edited from (get_workflow's `version`). */
  base_version: z.number().int().min(1),
  /** The whole new definition, as save_workflow takes it. */
  definition: z.record(z.string(), z.unknown()),
});

export const RepoChecksChangeSchema = z.strictObject({
  kind: z.literal('repo_checks'),
  repo: z.string().trim().min(1).max(200),
  /** The repo's new checks; null = clear them (the workflow's checks run again). */
  checks: RepoChecksSchema.nullable(),
});

export const ProposalChangeSchema = z.discriminatedUnion('kind', [
  WorkflowChangeSchema,
  RepoChecksChangeSchema,
]);
export type ProposalChange = z.infer<typeof ProposalChangeSchema>;

export const EffectMetricSchema = z.enum([
  'median_stay',
  'p90_stay',
  'reentries',
  'check_failure_rate',
  'questions',
  'permission_denials',
]);
export type EffectMetric = z.infer<typeof EffectMetricSchema>;

export const ExpectedEffectSchema = z.strictObject({
  metric: EffectMetricSchema,
  /** Narrow the metric: a state, a repo, a check command. */
  scope: z
    .strictObject({
      state: z.string().min(1).max(100).optional(),
      repo: z.string().min(1).max(200).optional(),
      check: z.string().min(1).max(2_000).optional(),
    })
    .default({}),
  direction: z.enum(['down', 'up']),
  text: z.string().trim().min(1).max(300),
});
export type ExpectedEffect = z.infer<typeof ExpectedEffectSchema>;

export const EvidenceItemSchema = z.strictObject({
  /** A list_findings id, when the evidence is a finding. */
  finding_id: z.string().min(1).max(200).optional(),
  text: z.string().trim().min(1).max(300),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const ProposalMetaSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  rationale: z.string().trim().min(1).max(1_000),
  evidence: z.array(EvidenceItemSchema).min(1).max(8),
  expected_effect: ExpectedEffectSchema,
  rollback: z.string().trim().min(1).max(500),
});
export type ProposalMeta = z.infer<typeof ProposalMetaSchema>;

/** propose_change's input (and the store's): the metadata and the change itself. */
export const ProposeChangeInputSchema = ProposalMetaSchema.extend({
  change: ProposalChangeSchema,
});
export type ProposeChangeInput = z.infer<typeof ProposeChangeInputSchema>;

// ---------------------------------------------------------------- review

/** The shortest after-window worth comparing; under it a review is `too_early`. */
export const REVIEW_MIN_DAYS = 1;
/** The longest window on each side of the change. */
export const REVIEW_MAX_DAYS = 30;
/** Fewer samples than this on either side: `direction_met` is null (can't tell). */
export const REVIEW_MIN_SAMPLES = 3;

export interface EffectValue {
  /** null: no data for the metric in the window. */
  value: number | null;
  /** How many stays, moves, runs, tickets or prompts it was computed from. */
  sample: number;
}

const sameText = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The expected effect's metric over one window's rows, narrowed to its scope. */
export function effectValue(rows: AdvisorRows, effect: Pick<ExpectedEffect, 'metric' | 'scope'>) {
  const { state, repo, check } = effect.scope;
  const inRepo = (r: { repo: string }) => repo === undefined || sameText(r.repo, repo);
  const out = (value: number | null, sample: number): EffectValue => ({
    value: value === null ? null : round2(value),
    sample,
  });
  switch (effect.metric) {
    case 'median_stay':
    case 'p90_stay': {
      const mins = stateDurations(rows.moves.filter(inRepo))
        .filter((s) => state === undefined || s.state === state)
        .map((s) => s.minutes);
      if (mins.length === 0) return out(null, 0);
      return out(
        effect.metric === 'median_stay' ? median(mins) : percentile(mins, 0.9),
        mins.length,
      );
    }
    case 'reentries': {
      // Re-entries per ticket that entered the state (or any state).
      const moves = rows.moves
        .filter(inRepo)
        .filter((m) => state === undefined || stateKey(m.to) === state);
      const tickets = new Set(moves.map((m) => m.ticket_id)).size;
      if (tickets === 0) return out(null, 0);
      return out(moves.filter((m) => m.visit >= 2).length / tickets, tickets);
    }
    case 'check_failure_rate': {
      const runs = rows.checks
        .filter(inRepo)
        .filter(
          (c) =>
            (state === undefined || c.state === state) &&
            (check === undefined || c.cmd === check || c.name === check),
        );
      if (runs.length === 0) return out(null, 0);
      return out(runs.filter(checkFailed).length / runs.length, runs.length);
    }
    case 'questions': {
      // Questions per ticket that entered the state (or any ticket in the window).
      const tickets = new Set(
        rows.moves
          .filter(inRepo)
          .filter((m) => state === undefined || stateKey(m.to) === state)
          .map((m) => m.ticket_id),
      ).size;
      if (tickets === 0) return out(null, 0);
      const asked = rows.inputs
        .filter(inRepo)
        .filter((i) => classOf(i) === 'question')
        .filter((i) => state === undefined || (i.state !== null && stateKey(i.state) === state));
      return out(asked.length / tickets, tickets);
    }
    case 'permission_denials': {
      const prompts = rows.permissions.filter(inRepo);
      if (prompts.length === 0) return out(null, 0);
      return out(
        prompts.filter((p) => p.status === 'denied' || p.status === 'expired').length,
        prompts.length,
      );
    }
  }
}

export const ProposalReviewSchema = z.object({
  metric: EffectMetricSchema,
  scope: ExpectedEffectSchema.shape.scope,
  direction: z.enum(['down', 'up']),
  /** Days on each side of `applied_at`. */
  window_days: z.number(),
  before: z.object({ value: z.number().nullable(), sample: z.number().int() }),
  after: z.object({ value: z.number().nullable(), sample: z.number().int() }),
  /** after − before; null when either side has no data. */
  delta: z.number().nullable(),
  /** Did it move the expected way? null: too few samples on a side to tell. */
  direction_met: z.boolean().nullable(),
  /** Less than REVIEW_MIN_DAYS since the change: nothing compared yet. */
  too_early: z.boolean(),
  reviewed_at: z.string(),
});
export type ProposalReview = z.infer<typeof ProposalReviewSchema>;

/** The expected effect's metric before and after the change, and whether it moved as expected. */
export function compareMetrics(
  before: AdvisorRows,
  after: AdvisorRows,
  effect: ExpectedEffect,
): Pick<
  ProposalReview,
  'metric' | 'scope' | 'direction' | 'before' | 'after' | 'delta' | 'direction_met'
> {
  const b = effectValue(before, effect);
  const a = effectValue(after, effect);
  const delta = a.value === null || b.value === null ? null : round2(a.value - b.value);
  const enough = a.sample >= REVIEW_MIN_SAMPLES && b.sample >= REVIEW_MIN_SAMPLES;
  return {
    metric: effect.metric,
    scope: effect.scope,
    direction: effect.direction,
    before: b,
    after: a,
    delta,
    direction_met:
      delta === null || !enough ? null : effect.direction === 'down' ? delta < 0 : delta > 0,
  };
}

/** The review window: days since `appliedAt`, clamped to REVIEW_MAX_DAYS; null = too early. */
export function reviewWindowDays(appliedAt: Date, now: Date): number | null {
  const days = (now.getTime() - appliedAt.getTime()) / 86_400_000;
  if (days < REVIEW_MIN_DAYS) return null;
  return Math.min(REVIEW_MAX_DAYS, Math.floor(days));
}

// ---------------------------------------------------------------- DTOs (REST and MCP)

export const StructuralChangeSchema = z.object({
  op: z.enum(['add', 'remove', 'change']),
  path: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});

export const ChangeProposalSummarySchema = z.object({
  id: z.string(),
  kind: ChangeKindSchema,
  status: ChangeStatusSchema,
  title: z.string(),
  /** The repo (repo_checks) or the workflow id. */
  target: z.string(),
  /** A workflow change needs an instance admin to apply, and changes every account. */
  requires_admin: z.boolean(),
  /** How many structural changes it makes. */
  changes: z.number().int().nonnegative(),
  /** The expected effect, in words. */
  expected_effect: z.string(),
  created_at: z.string(),
  applied_at: z.string().nullable(),
  /** An agent's proposal (ask_user `proposed_checks`): the ticket it was proposed on; else null. */
  ticket_id: z.string().nullable().optional(),
});
export type ChangeProposalSummary = z.infer<typeof ChangeProposalSummarySchema>;

export const ChangeProposalDetailSchema = ChangeProposalSummarySchema.extend({
  rationale: z.string(),
  evidence: z.array(EvidenceItemSchema),
  effect: ExpectedEffectSchema,
  rollback: z.string(),
  diff: z.object({
    changes: z.array(StructuralChangeSchema),
    more_changes: z.number().int().nonnegative(),
  }),
  /** Workflow: the version it was based on. */
  base_version: z.number().int().nullable(),
  created_by: z.string().nullable(),
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  /** Workflow: the version applying it saved. */
  applied_version: z.number().int().nullable(),
  /** Why it is `conflict` or `failed`. */
  error: z.string().nullable(),
  review: ProposalReviewSchema.nullable(),
  /** The warning to show before applying a workflow change. */
  warning: z.string().nullable(),
  /**
   * UXR-73: the whole change, for a readable diff (REST only; MCP results leave them out).
   * Workflow: the definition it was based on (null when that version no longer parses) and the
   * proposed one.
   */
  base_definition: WorkflowDefinitionSchema.nullable().optional(),
  proposed_definition: WorkflowDefinitionSchema.nullable().optional(),
  /** Repo checks: the repo's override before (null = the workflow's checks) and after. */
  checks_before: RepoChecksSchema.nullable().optional(),
  checks_after: RepoChecksSchema.nullable().optional(),
});
export type ChangeProposalDetail = z.infer<typeof ChangeProposalDetailSchema>;

export const ChangeProposalListResponseSchema = z.object({
  proposals: z.array(ChangeProposalSummarySchema),
  next_cursor: z.number().int().nullable(),
  total: z.number().int().nonnegative(),
});
export type ChangeProposalListResponse = z.infer<typeof ChangeProposalListResponseSchema>;

export const ListChangeProposalsQuerySchema = z.object({
  status: z.union([ChangeStatusSchema, z.literal('all')]).optional(),
  cursor: z.coerce.number().int().min(0).optional(),
  /** UXR-73: only this kind (the Repo checks page lists `repo_checks`). */
  kind: ChangeKindSchema.optional(),
  /** UXR-73: only this target: a repo (normalised like `repoChecksKey`) or a workflow id. */
  target: z.string().min(1).max(500).optional(),
  /** Only the proposals an agent made on this ticket. */
  ticket_id: z.string().uuid().optional(),
});

/** A workflow change's warning (workflows are shared by every account until M2-T12). */
export const WORKFLOW_CHANGE_WARNING =
  'Workflows are shared by every account on this instance: applying this changes the workflow ' +
  'for all of them, and only an instance admin can apply it.';
