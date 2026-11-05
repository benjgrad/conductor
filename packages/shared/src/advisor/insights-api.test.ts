import { describe, expect, it } from 'vitest';
import { API_PATHS, apiPathTemplates } from '../api/rest.js';
import type { StoredInsight } from './insight.js';
import {
  FindingsResponseSchema,
  InsightsQuerySchema,
  ProcessReportResponseSchema,
  REPORT_IDS_MAX,
  SessionInsightResponseSchema,
  frictionReport,
  sampleNote,
} from './insights-api.js';

const roundTrip = <T>(schema: { parse: (v: unknown) => T }, v: unknown) =>
  schema.parse(JSON.parse(JSON.stringify(v)));

const stored = (i: number, category = 'flaky_check', state: string | null = 'qa'): StoredInsight =>
  ({
    session_id: `s${i}`,
    ticket_id: `t${i % 2}`,
    insight: {
      schema_version: 1,
      summary: `Session ${i}`,
      outcome: 'completed',
      frictions: [{ category, state, evidence: 'e', severity: 2, suggestion: 'fix it' }],
      wasted_minutes: 3,
    },
  }) as StoredInsight;

describe('insights REST paths (UXR-84)', () => {
  it('lists the four routes', () => {
    const byKey = Object.fromEntries(apiPathTemplates().map((t) => [t.key, t.path]));
    expect(byKey).toMatchObject({
      insightsMetrics: '/api/insights/metrics',
      insightsFindings: '/api/insights/findings',
      insightsReport: '/api/insights/report',
      insightSession: '/api/insights/sessions/:id',
    });
    expect(API_PATHS.insightSession('abc')).toBe('/api/insights/sessions/abc');
  });
});

describe('InsightsQuerySchema', () => {
  it('coerces numbers and rejects unknown or bad params', () => {
    expect(InsightsQuerySchema.parse({ window_days: '7', group_by: 'repo', cursor: '8' })).toEqual({
      window_days: 7,
      group_by: 'repo',
      cursor: 8,
    });
    for (const bad of [{ group_by: 'x' }, { window_days: 'abc' }, { cursor: '-1' }, { x: '1' }]) {
      expect(InsightsQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('frictionReport', () => {
  it('groups by category and state, with distinct tickets beside the sessions', () => {
    const r = frictionReport([
      ...[0, 1, 2, 3].map((i) => stored(i)),
      stored(9, 'environment', null),
    ]);
    expect(r.frictions.map((f) => [f.category, f.state, f.sessions])).toEqual([
      ['flaky_check', 'qa', 4],
      ['environment', null, 1],
    ]);
    expect(r.frictions[0]!.session_ids).toHaveLength(REPORT_IDS_MAX);
    expect(r.frictions[0]!.ticket_ids).toEqual(['t0', 't1']);
    expect(r.wasted_minutes_reported).toBe(15);
  });
});

describe('DTOs', () => {
  it('a report and its frictions round-trip; old frictions without ticket_ids parse', () => {
    const report = {
      window_days: 30,
      since: '2026-10-01T00:00:00.000Z',
      insights_enabled: true,
      finished_sessions: 5,
      analysed_sessions: 4,
      totals: {
        tickets: 2,
        sessions: 2,
        moves: 6,
        check_runs: 1,
        questions: 0,
        handoffs: 0,
        stops: 0,
        permission_prompts: 0,
      },
      ...frictionReport([stored(1)]),
    };
    expect(roundTrip(ProcessReportResponseSchema, report)).toEqual(report);
    // An older server's totals (no handoffs / stops) still parse, as zeros.
    const oldTotals: Record<string, unknown> = { ...report.totals };
    delete oldTotals.handoffs;
    delete oldTotals.stops;
    expect(ProcessReportResponseSchema.parse({ ...report, totals: oldTotals }).totals).toEqual(
      report.totals,
    );
    const old: Record<string, unknown> = { ...report.frictions[0]! };
    delete old.ticket_ids;
    const parsed = ProcessReportResponseSchema.parse({ ...report, frictions: [old] });
    expect(parsed.frictions[0]!.ticket_ids).toEqual([]);
  });

  it('a findings page and a session insight round-trip', () => {
    const page = {
      window_days: 7,
      since: '2026-10-29T00:00:00.000Z',
      findings: [
        {
          id: 'failing_check:npm test',
          category: 'failing_check',
          severity: 3,
          title: 'Check fails often: npm test',
          evidence: '3 of 3 runs failed',
          example_ticket_ids: ['t1'],
          suggested_tool: 'set_repo_checks',
          suggestion: 'Replace it.',
          proposal: { id: 'p1', status: 'proposed', title: 'Fix' },
        },
      ],
      next_cursor: null,
      total: 1,
    };
    expect(roundTrip(FindingsResponseSchema, page)).toEqual(page);
    const insight = {
      session_id: 's1',
      ticket_id: 't1',
      created_at: '2026-11-01T00:00:00.000Z',
      model: 'haiku',
      model_written: true,
      ...stored(1).insight,
    };
    expect(roundTrip(SessionInsightResponseSchema, insight)).toEqual(insight);
  });
});

describe('sampleNote', () => {
  it('says how thin the sample is under a quarter of finished sessions', () => {
    expect(sampleNote({ finished_sessions: 127, analysed_sessions: 8 })).toEqual({
      sample_share: 0.06,
      sample_note:
        'Frictions come from 8 of 127 finished sessions (6 %); wasted minutes are summed over ' +
        'those 8 only.',
    });
    expect(sampleNote({ finished_sessions: 10, analysed_sessions: 5 })).toEqual({
      sample_share: 0.5,
    });
    expect(sampleNote({ finished_sessions: 0, analysed_sessions: 0 })).toEqual({
      sample_share: 0,
    });
  });
});
