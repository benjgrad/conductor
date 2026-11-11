-- Budget spend: what finished sessions spend and how long they run, per workflow (R9, 09 §Budgets).
--
-- Read-only. One SELECT returns one JSON report: per workflow id/version, the count and the
-- p50 / p90 / p95 / max of `session.spend_usd` and of `session.wall_seconds` (in minutes) over the
-- sessions that ended `done` in the window, and how many would have tripped the version's
-- current `budget`. Use it to pick `budget.usd` / `budget.minutes` so normal tickets don't trip.
--
-- `wall_seconds` excludes parked time (human and event states, a gate's paused phases) and, from
-- R9 on, queued time; rows written before R9 over-count a session that was requeued (TD-042).
-- Sessions with `spend_usd = 0` (spend never reported) are counted apart, not in the spend stats.
--
-- Run it on gradyserver against the live database:
--   docker exec -i conductor-postgres-1 psql -U conductor -d conductor -v ON_ERROR_STOP=1 -At \
--     < scripts/analysis/budget-spend.sql
-- or locally: psql "$(scripts/db.sh url)" -At -f scripts/analysis/budget-spend.sql
--
-- Parameter (a custom setting, so it works from psql and node-pg alike):
--   budget_spend.days   window length in days (default 30)
-- e.g. PGOPTIONS='-c budget_spend.days=60' psql ... -f scripts/analysis/budget-spend.sql

BEGIN READ ONLY;

WITH
params AS (
  SELECT now() - make_interval(
    days => COALESCE(NULLIF(current_setting('budget_spend.days', true), '')::int, 30)
  ) AS since
),
done AS (
  SELECT s.workflow_id, s.workflow_version, s.spend_usd::float8 AS usd,
         s.wall_seconds::float8 / 60 AS minutes,
         (d.definition -> 'budget' ->> 'usd')::float8 AS budget_usd,
         (d.definition -> 'budget' ->> 'minutes')::float8 AS budget_minutes
    FROM session s
    JOIN workflow_definition d ON d.id = s.workflow_id AND d.version = s.workflow_version
   WHERE s.status = 'done' AND s.updated_at >= (SELECT since FROM params)
),
per AS (
  SELECT workflow_id, workflow_version,
         count(*) AS sessions,
         count(*) FILTER (WHERE usd = 0) AS no_spend_reported,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY usd) FILTER (WHERE usd > 0) AS usd_p50,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY usd) FILTER (WHERE usd > 0) AS usd_p90,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY usd) FILTER (WHERE usd > 0) AS usd_p95,
         max(usd) AS usd_max,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes) AS minutes_p50,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY minutes) AS minutes_p90,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY minutes) AS minutes_p95,
         max(minutes) AS minutes_max,
         max(budget_usd) AS budget_usd,
         max(budget_minutes) AS budget_minutes,
         count(*) FILTER (WHERE usd >= budget_usd) AS over_usd,
         count(*) FILTER (WHERE minutes >= budget_minutes) AS over_minutes
    FROM done
   GROUP BY workflow_id, workflow_version
)
SELECT json_build_object(
  'since', (SELECT since FROM params),
  'workflows', COALESCE(json_agg(per ORDER BY workflow_id, workflow_version), '[]'::json)
)
FROM per;

COMMIT;
