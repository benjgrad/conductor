-- Stale questions: did Ben's answer equal the agent's recommendation? (M2, needs_input watch policy)
--
-- Read-only. One JSON array on stdout: every agent_question input_request answered in the last
-- 90 days and closed by a move out of needs_input, with the move that opened it and the move
-- that closed it. Classify it with scripts/analysis/stale-questions.js.
--
-- Production (gradyserver, the `cdc` alias of docs/setup/deploy-gradyserver.md):
--   ssh -p 1024 bengrady4@gradyserver.com "docker compose -p conductor \
--     -f ~/deploy/conductor/current/deploy/gradyserver/compose.yml \
--     --env-file ~/deploy/conductor/.env --env-file ~/deploy/conductor/current.env \
--     exec -T postgres psql -U conductor -d conductor -qAt -v ON_ERROR_STOP=1 -f -" \
--     < scripts/analysis/stale-questions.sql > /tmp/stale-questions.json
-- Local:
--   psql "$DATABASE_URL" -qAt -v ON_ERROR_STOP=1 -f scripts/analysis/stale-questions.sql > /tmp/stale-questions.json
--
-- The window is 90 days; set `-v days=60` to change it.
-- Keep the export out of git: it holds question and answer text.
\if :{?days}
\else
\set days 90
\endif
BEGIN READ ONLY;
SELECT COALESCE(json_agg(row_to_json(q) ORDER BY q.created_at), '[]'::json)
FROM (
  SELECT
    i.id,
    i.session_id,
    s.ticket_id,
    t.kind::text AS ticket_kind,
    t.repo,
    t.account_id,
    i.question,
    i.options,
    i.answer,
    i.answered_by,
    i.return_to,
    i.created_at,
    i.answered_at,
    extract(epoch FROM i.answered_at - i.created_at) / 60 AS wait_minutes,
    op.payload->>'transition' AS origin_transition,
    op.payload->>'from' AS origin_from,
    op.payload->>'to' AS origin_to,
    cl.payload->>'transition' AS closing_transition,
    cl.payload->>'from' AS closing_from,
    cl.payload->>'to' AS closing_to,
    cl.payload->>'actor' AS closing_actor
  FROM input_request i
  JOIN session s ON s.id = i.session_id
  JOIN ticket t ON t.id = s.ticket_id
  -- The move that opened it: the session's newest state.entered up to its creation (the engine
  -- writes both in one transaction; the margin covers the two clocks), as advisor/queries.ts.
  LEFT JOIN LATERAL (
    SELECT e.payload FROM event e
    WHERE e.session_id = i.session_id AND e.type = 'state.entered'
      AND e.ts <= i.created_at + interval '5 seconds'
    ORDER BY e.id DESC LIMIT 1
  ) op ON true
  -- The move that closed it: the session's first state.entered from the answer on.
  LEFT JOIN LATERAL (
    SELECT e.payload FROM event e
    WHERE e.session_id = i.session_id AND e.type = 'state.entered'
      AND e.ts >= i.answered_at - interval '5 seconds'
    ORDER BY e.id ASC LIMIT 1
  ) cl ON true
  WHERE i.kind = 'agent_question'
    AND i.answer IS NOT NULL
    AND i.answered_at >= now() - make_interval(days => :days)
    -- PR hand-offs (question: true on the PR transitions) are not questions.
    AND COALESCE(op.payload->>'transition', '') NOT IN ('pr_ready_for_review', 'personal_pr_ready_for_review')
    AND cl.payload->>'from' = 'needs_input'
) q;
ROLLBACK;
