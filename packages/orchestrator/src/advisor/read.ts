import {
  frictionReport,
  sampleNote,
  insightFindings,
  processMetrics,
  rankFindings,
  type AdvisorGroupBy,
} from '@conductor/shared';
import type { Queryable } from '../contracts.js';
import {
  analystSetting,
  analystUsage,
  getInsight,
  insightCoverage,
  insightsEnabled,
  loadInsights,
} from './insights.js';
import { clampWindow, loadAdvisorRows } from './queries.js';

// ADR-0033, UXR-84: the advisor's reads, shared by the MCP tools (get_process_metrics,
// list_findings, get_process_report, get_insight) and the board's /api/insights routes, so both
// return the same thing for the same account and window.

/** list_findings: findings per page (each ≤ ~700 bytes, well under the 8 KB cap). */
export const FINDINGS_PAGE = 8;

export interface AdvisorReadArgs {
  window_days?: number | undefined;
  repo?: string | undefined;
  workflow_id?: string | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const loadRows = (db: Queryable, accountId: string, a: AdvisorReadArgs) =>
  loadAdvisorRows(db, {
    accountId,
    windowDays: clampWindow(a.window_days),
    repo: a.repo,
    workflowId: a.workflow_id,
  });

const insightFilter = (accountId: string, a: AdvisorReadArgs, since: string) => ({
  accountId,
  since: new Date(since),
  repo: a.repo,
  workflowId: a.workflow_id,
});

export async function readProcessMetrics(
  db: Queryable,
  accountId: string,
  a: AdvisorReadArgs & { group_by?: AdvisorGroupBy | undefined },
) {
  const rows = await loadRows(db, accountId, a);
  return {
    window_days: clampWindow(a.window_days),
    since: rows.since,
    ...(rows.truncated.length > 0 ? { rows_truncated: rows.truncated } : {}),
    ...processMetrics(rows, a.group_by ?? 'state'),
  };
}

export async function readFindings(
  db: Queryable,
  accountId: string,
  a: AdvisorReadArgs & { cursor?: number | undefined },
) {
  const rows = await loadRows(db, accountId, a);
  const insights = await loadInsights(db, insightFilter(accountId, a, rows.since));
  const all = rankFindings(rows, insightFindings(insights));
  const start = Math.min(a.cursor ?? 0, all.length);
  const end = start + FINDINGS_PAGE;
  return {
    window_days: clampWindow(a.window_days),
    since: rows.since,
    ...(rows.truncated.length > 0 ? { rows_truncated: rows.truncated } : {}),
    findings: all.slice(start, end),
    next_cursor: end < all.length ? end : null,
    total: all.length,
  };
}

export async function readProcessReport(db: Queryable, accountId: string, a: AdvisorReadArgs) {
  const rows = await loadRows(db, accountId, a);
  const f = insightFilter(accountId, a, rows.since);
  const [insights, coverage, enabled, usage, setting] = await Promise.all([
    loadInsights(db, f),
    insightCoverage(db, f),
    insightsEnabled(db, accountId),
    analystUsage(db, f),
    analystSetting(db, accountId),
  ]);
  return {
    window_days: clampWindow(a.window_days),
    since: rows.since,
    insights_enabled: enabled,
    ...(enabled
      ? {}
      : {
          note:
            'No machine runs analyst jobs yet (it needs the Rust daemon): only the ' +
            'deterministic metrics are available.',
        }),
    ...coverage,
    ...sampleNote({ ...coverage, ...setting, open: usage.open }),
    // R13: what the analysts cost, and whether the account samples.
    analyst: { ...setting, ...usage },
    totals: processMetrics(rows, 'state').totals,
    ...frictionReport(insights),
  };
}

/** One session's insight, labelled model-written; null for a bad id or none in the account. */
export async function readInsight(db: Queryable, accountId: string, sessionId: string) {
  if (!UUID_RE.test(sessionId)) return null;
  const found = await getInsight(db, accountId, sessionId);
  if (found === null) return null;
  return {
    session_id: found.session_id,
    ticket_id: found.ticket_id,
    created_at: found.created_at.toISOString(),
    model: found.model,
    model_written: true as const,
    ...found.insight,
  };
}
