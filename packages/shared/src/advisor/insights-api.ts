import { z } from 'zod';
import {
  FrictionCategorySchema,
  FrictionSchema,
  InsightOutcomeSchema,
  SESSION_INSIGHT_SCHEMA_VERSION,
  type StoredInsight,
} from './insight.js';
import { AdvisorGroupBySchema, FindingSchema, ProcessMetricsSchema } from './metrics.js';
import { ChangeStatusSchema } from './proposal.js';

// ADR-0033, UXR-84: the analysts' friction report (shared by the MCP tool `get_process_report`,
// the REST route and the web mock) and the DTOs of the read-only /api/insights routes. The
// routes return what the MCP tools return; findings also carry the proposal that fixes them.

/** get_process_report: friction groups shown, and insight ids per group. */
export const REPORT_FRICTIONS_MAX = 10;
export const REPORT_IDS_MAX = 3;
const REPORT_SUGGESTION_CLIP = 200;

const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1) + '…');

/**
 * ADR-0033 P2: the analysts' frictions grouped by category and state, most sessions first, each
 * with up to REPORT_IDS_MAX session ids (for get_insight), their tickets, and its most frequent
 * suggestion.
 */
export function frictionReport(insights: readonly StoredInsight[]) {
  type G = {
    category: string;
    state: string | null;
    sessions: Set<string>;
    tickets: string[];
    severity: number;
    suggestions: Map<string, number>;
  };
  const groups = new Map<string, G>();
  const outcomes: Record<string, number> = {};
  let wasted = 0;
  for (const s of insights) {
    outcomes[s.insight.outcome] = (outcomes[s.insight.outcome] ?? 0) + 1;
    wasted += s.insight.wasted_minutes ?? 0;
    for (const f of s.insight.frictions) {
      const key = `${f.category}:${f.state ?? ''}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          category: f.category,
          state: f.state,
          sessions: new Set(),
          tickets: [],
          severity: 0,
          suggestions: new Map(),
        };
        groups.set(key, g);
      }
      g.sessions.add(s.session_id);
      if (g.tickets.length < REPORT_IDS_MAX && !g.tickets.includes(s.ticket_id)) {
        g.tickets.push(s.ticket_id);
      }
      g.severity = Math.max(g.severity, f.severity);
      g.suggestions.set(f.suggestion, (g.suggestions.get(f.suggestion) ?? 0) + 1);
    }
  }
  const all = [...groups.values()].sort(
    (a, b) =>
      b.sessions.size - a.sessions.size ||
      b.severity - a.severity ||
      `${a.category}:${a.state ?? ''}`.localeCompare(`${b.category}:${b.state ?? ''}`),
  );
  return {
    analysed: insights.length,
    outcomes,
    wasted_minutes_reported: wasted,
    frictions: all.slice(0, REPORT_FRICTIONS_MAX).map((g) => ({
      category: g.category,
      state: g.state,
      sessions: g.sessions.size,
      max_severity: g.severity,
      top_suggestion: clip(
        [...g.suggestions.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0],
        REPORT_SUGGESTION_CLIP,
      ),
      session_ids: [...g.sessions].slice(0, REPORT_IDS_MAX),
      ticket_ids: g.tickets,
    })),
    more_frictions: Math.max(0, all.length - REPORT_FRICTIONS_MAX),
  };
}

/** Below this share of finished sessions analysed, the report says how thin its sample is. */
export const REPORT_THIN_SAMPLE = 0.25;

/**
 * The frictions' sample: how many of the window's finished sessions were analysed, and a note
 * when that matters: R13 `sample` mode (a daily cap picks the sessions), a share under
 * REPORT_THIN_SAMPLE, or (every session analysed by default) jobs still queued.
 */
export function sampleNote(c: {
  finished_sessions: number;
  analysed_sessions: number;
  mode?: 'all' | 'sample';
  daily_cap?: number | null;
  open?: number;
}): {
  sample_share: number;
  sample_note?: string;
} {
  const share = c.finished_sessions === 0 ? 0 : c.analysed_sessions / c.finished_sessions;
  const rounded = Math.round(share * 100) / 100;
  const of = `${c.analysed_sessions} of ${c.finished_sessions} finished sessions`;
  if (c.mode === 'sample' && c.daily_cap != null) {
    return {
      sample_share: rounded,
      sample_note:
        `This account samples: at most ${c.daily_cap} sessions a day are analysed, so ` +
        `frictions come from ${of} (${Math.round(share * 100)} %).`,
    };
  }
  if (c.finished_sessions > 0 && share < REPORT_THIN_SAMPLE) {
    return {
      sample_share: rounded,
      sample_note:
        `Frictions come from ${of} ` +
        `(${Math.round(share * 100)} %); wasted minutes are summed over those ` +
        `${c.analysed_sessions} only.`,
    };
  }
  if (c.mode === 'all' && share < 1 && (c.open ?? 0) > 0) {
    return {
      sample_share: rounded,
      sample_note: `${c.open} more ${c.open === 1 ? 'session is' : 'sessions are'} being analysed.`,
    };
  }
  return { sample_share: rounded };
}

// ---------------------------------------------------------------- REST DTOs (UXR-84)

/** The query of every /api/insights list route (unknown params are a 400). */
export const InsightsQuerySchema = z.strictObject({
  window_days: z.coerce.number().finite().optional(),
  group_by: AdvisorGroupBySchema.optional(),
  repo: z.string().trim().min(1).max(200).optional(),
  workflow_id: z.string().min(1).max(100).optional(),
  cursor: z.coerce.number().int().min(0).optional(),
});
export type InsightsQuery = z.infer<typeof InsightsQuerySchema>;

const TruncatedSchema = z.array(z.enum(['moves', 'checks', 'inputs', 'permissions']));

/** GET /api/insights/metrics. */
export const ProcessMetricsResponseSchema = ProcessMetricsSchema.extend({
  window_days: z.number().int().positive(),
  since: z.string(),
  rows_truncated: TruncatedSchema.optional(),
});
export type ProcessMetricsResponse = z.infer<typeof ProcessMetricsResponseSchema>;

/** A finding, and the account's change proposal citing it (an open one first), if any. */
export const FindingWithProposalSchema = FindingSchema.extend({
  proposal: z.object({ id: z.string(), status: ChangeStatusSchema, title: z.string() }).nullable(),
});
export type FindingWithProposal = z.infer<typeof FindingWithProposalSchema>;

/** GET /api/insights/findings. */
export const FindingsResponseSchema = z.object({
  window_days: z.number().int().positive(),
  since: z.string(),
  rows_truncated: TruncatedSchema.optional(),
  findings: z.array(FindingWithProposalSchema),
  next_cursor: z.number().int().nullable(),
  total: z.number().int().nonnegative(),
});
export type FindingsResponse = z.infer<typeof FindingsResponseSchema>;

export const ReportFrictionSchema = z.object({
  /** A FrictionCategory; a newer server's category still parses. */
  category: z.string(),
  state: z.string().nullable(),
  sessions: z.number().int().nonnegative(),
  max_severity: z.number().int(),
  top_suggestion: z.string(),
  session_ids: z.array(z.string()),
  ticket_ids: z.array(z.string()).default([]),
});
export type ReportFriction = z.infer<typeof ReportFrictionSchema>;

/** R13: the report's `analyst`: every session or a sample, and the window's jobs and cost. */
export const AnalystReportSchema = z.object({
  mode: z.enum(['all', 'sample']),
  /** Jobs per 24 h in `sample` mode; null in `all`. */
  daily_cap: z.number().int().positive().nullable(),
  jobs: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  /** USD the daemon reported, summed over `priced_jobs`. */
  cost_usd: z.number().nonnegative(),
  priced_jobs: z.number().int().nonnegative(),
});
export type AnalystReport = z.infer<typeof AnalystReportSchema>;

/** GET /api/insights/report. */
export const ProcessReportResponseSchema = z.object({
  window_days: z.number().int().positive(),
  since: z.string(),
  insights_enabled: z.boolean(),
  note: z.string().optional(),
  finished_sessions: z.number().int().nonnegative(),
  analysed_sessions: z.number().int().nonnegative(),
  /** analysed / finished (0..1). Absent from older servers. */
  sample_share: z.number().min(0).max(1).optional(),
  /** Set when the sample is thin, sampled or still filling (`sampleNote`). */
  sample_note: z.string().optional(),
  /** R13: the analyst setting and the window's jobs and cost. Absent from older servers. */
  analyst: AnalystReportSchema.optional(),
  totals: ProcessMetricsSchema.shape.totals,
  analysed: z.number().int().nonnegative(),
  outcomes: z.record(z.string(), z.number()),
  wasted_minutes_reported: z.number().nonnegative(),
  frictions: z.array(ReportFrictionSchema),
  more_frictions: z.number().int().nonnegative(),
});
export type ProcessReportResponse = z.infer<typeof ProcessReportResponseSchema>;

/** GET /api/insights/sessions/:id: one session's analyst insight (model-written). */
export const SessionInsightResponseSchema = z.object({
  session_id: z.string(),
  ticket_id: z.string(),
  created_at: z.string(),
  model: z.string(),
  model_written: z.literal(true),
  schema_version: z.literal(SESSION_INSIGHT_SCHEMA_VERSION),
  summary: z.string(),
  outcome: InsightOutcomeSchema,
  frictions: z.array(FrictionSchema),
  wasted_minutes: z.number().int().nonnegative().nullable(),
});
export type SessionInsightResponse = z.infer<typeof SessionInsightResponseSchema>;

/** The friction categories, for labels. */
export const FRICTION_CATEGORIES = FrictionCategorySchema.options;
