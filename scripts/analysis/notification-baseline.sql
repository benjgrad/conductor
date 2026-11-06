-- Notification baseline: pushes per ticket and per cause (M3, the "before" number for ADR-0037 T4).
--
-- Read-only. One SELECT returns one JSON report. It answers two questions:
--   legacy  what today's notifier pushes over the window. This is the before number. Today's
--           notifier (orchestrator/src/push/enqueue.ts) pushes once per input_request
--           (enqueueNeedsInputPush), once per permission prompt the agent waits on
--           (enqueuePermissionPush), and once per `notify: true` transition (enqueueTransitionPush).
--           The input and permission rows are rebuilt from input_request / permission_request, so
--           the count holds even for days when push was off or nobody had subscribed. Transition
--           pushes can't be rebuilt that way, so they come from the outbox.
--           Permission pushes were written only from the UXR-32 deploy on (PR #156, merged
--           2026-11-05 12:17 UTC, live on gradyserver from about 12:30 UTC). Before that, no build
--           enqueued them, even while push was on for questions; `coverage` counts them apart.
--   outbox  what was actually enqueued (outbox push_* rows). A push is one idempotency key; one
--           row is written per subscribed user, so `deliveries` counts the rows. `coverage`
--           compares the two over the period the outbox has push rows for.
--   v6_estimate  the same candidate pushes replayed under the ADR-0037 P6 policy of the v6 draft
--           as amended by T4 (`notify: {default: once, engine_moves: never, coalesce: 15m}`, the
--           hand-offs and `ready_for_testing` `once`, the questions `every`; `v6_modes` below).
--           The rules applied are listed under `assumptions` in the report.
--
-- Run it on gradyserver against the live database:
--   docker exec -i conductor-postgres-1 psql -U conductor -d conductor -v ON_ERROR_STOP=1 -At \
--     < scripts/analysis/notification-baseline.sql
-- or locally: psql "$(scripts/db.sh url)" -At -f scripts/analysis/notification-baseline.sql
--
-- Parameters are custom settings, so they work from psql and from node-pg alike:
--   notification_baseline.days              window length in days (default 60)
--   notification_baseline.since / .until    explicit bounds (timestamptz; until defaults to now())
--   notification_baseline.coalesce_minutes  the coalesce window, and the re-entry window (15)
-- e.g. to re-run over the weeks after T4 shipped:
--   PGOPTIONS='-c notification_baseline.since=2026-12-01' psql ... -f scripts/analysis/notification-baseline.sql
--
-- Classification (FR-1), one `cause` per push:
--   handoff            an agent_question opened by a `*ready_for_review` hand-off. This is the
--                      advisor's no-definition rule (advisor/gates.ts inputClass).
--   question           any other agent_question: ask_user, plan_needs_approval, scope_changed, …
--   timeout | retries_exhausted | budget_exceeded | approval | machine_lost
--                      the engine stopped and asked (input_request.kind)
--   permission         a permission prompt (UXR-32)
--   transition | transition_engine
--                      a `notify: true` transition push, by actor
-- and two flags:
--   same_state         the ticket's previous push was for the same waiting state (a rework lap
--                      back into it, e.g. request_changes → hand-off back into In review)
--   reentry            same_state, and less than coalesce_minutes after the previous push
--
-- The opening move of an input_request is the session's newest `state.entered` at most 5 s after
-- it was created (the advisor's join, advisor/queries.ts). A gate label `X → Y (move: t)` is
-- read as the state `Y`.

BEGIN READ ONLY;

WITH
params AS (
  SELECT
    u.until,
    COALESCE(
      NULLIF(current_setting('notification_baseline.since', true), '')::timestamptz,
      u.until - make_interval(
        days => COALESCE(NULLIF(current_setting('notification_baseline.days', true), '')::int, 60)
      )
    ) AS since,
    COALESCE(
      NULLIF(current_setting('notification_baseline.coalesce_minutes', true), '')::int, 15
    ) AS coalesce_min
  FROM (
    SELECT COALESCE(
      NULLIF(current_setting('notification_baseline.until', true), '')::timestamptz, now()
    ) AS until
  ) u
),

-- legacy: one push per input_request.
inputs AS (
  SELECT
    i.id::text AS key,
    'needs_input'::text AS kind,
    s.ticket_id,
    i.session_id,
    i.created_at AS at,
    CASE
      WHEN i.kind = 'agent_question' AND se.payload->>'transition' LIKE '%ready_for_review'
        THEN 'handoff'
      WHEN i.kind = 'agent_question' THEN 'question'
      ELSE i.kind::text
    END AS cause,
    COALESCE(
      regexp_replace(se.payload->>'to', '^.+ → (.+) \((entry|review|move: .+)\)$', '\1'),
      'needs_input'
    ) AS wait_state,
    i.answered_at,
    -- The opening move, for the v6 replay.
    se.payload->>'transition' AS move_transition,
    se.payload->>'cause' AS move_cause,
    se.payload->>'actor' AS move_actor
  FROM params pr
  CROSS JOIN input_request i
  JOIN session s ON s.id = i.session_id
  LEFT JOIN LATERAL (
    SELECT e.payload FROM event e
     WHERE e.session_id = i.session_id AND e.type = 'state.entered'
       AND e.ts <= i.created_at + interval '5 seconds'
     ORDER BY e.id DESC LIMIT 1
  ) se ON true
  WHERE i.created_at >= pr.since AND i.created_at < pr.until
),

-- legacy: one push per permission prompt stored while the agent ran (a request refused because
-- no agent was running is denied at once and pushes nothing).
perms AS (
  SELECT
    'permission:' || p.id AS key,
    'permission'::text AS kind,
    s.ticket_id,
    p.session_id,
    p.created_at AS at,
    'permission'::text AS cause,
    COALESCE(
      regexp_replace(cur.payload->>'to', '^.+ → (.+) \((entry|review|move: .+)\)$', '\1'),
      s.workflow_state,
      'unknown'
    ) AS wait_state,
    NULL::timestamptz AS answered_at,
    NULL::text AS move_transition,
    NULL::text AS move_cause,
    NULL::text AS move_actor
  FROM params pr
  CROSS JOIN permission_request p
  JOIN session s ON s.id = p.session_id
  LEFT JOIN LATERAL (
    SELECT e.payload FROM event e
     WHERE e.session_id = p.session_id AND e.type = 'state.entered' AND e.ts <= p.created_at
     ORDER BY e.id DESC LIMIT 1
  ) cur ON true
  WHERE p.created_at >= pr.since AND p.created_at < pr.until
    AND NOT (p.status = 'denied' AND p.message IS NOT DISTINCT FROM 'the session is not running an agent')
),

-- legacy: `notify: true` transitions, from the outbox (no other record of the flag).
transitions AS (
  SELECT DISTINCT ON (o.idempotency_key)
    o.idempotency_key AS key,
    'transition'::text AS kind,
    s.ticket_id,
    o.session_id,
    o.created_at AS at,
    -- An engine move: an ADR-0037 cause other than a transition, a start or an answer; on a row
    -- before P7 (no cause), actor engine or system.
    CASE WHEN COALESCE(e.payload->>'cause' NOT IN ('transition', 'start', 'answer_routed'),
                       e.payload->>'actor' IN ('engine', 'system')) THEN 'transition_engine'
         ELSE 'transition' END AS cause,
    COALESCE(
      regexp_replace(e.payload->>'to', '^.+ → (.+) \((entry|review|move: .+)\)$', '\1'),
      'unknown'
    ) AS wait_state,
    NULL::timestamptz AS answered_at,
    e.payload->>'transition' AS move_transition,
    e.payload->>'cause' AS move_cause,
    e.payload->>'actor' AS move_actor
  FROM params pr
  CROSS JOIN outbox o
  JOIN session s ON s.id = o.session_id
  LEFT JOIN event e ON e.id = (o.payload->>'event_id')::bigint
  WHERE o.kind = 'push_transition' AND o.created_at >= pr.since AND o.created_at < pr.until
  ORDER BY o.idempotency_key, o.created_at
),

candidates AS (
  SELECT * FROM inputs UNION ALL SELECT * FROM perms UNION ALL SELECT * FROM transitions
),

-- FR-1 flags, over the ticket's pushes in order.
flagged AS (
  SELECT
    c.*,
    (lag(c.wait_state) OVER t IS NOT DISTINCT FROM c.wait_state
       AND lag(c.at) OVER t IS NOT NULL) AS same_state,
    (lag(c.wait_state) OVER t IS NOT DISTINCT FROM c.wait_state
       AND c.at - lag(c.at) OVER t < make_interval(mins => pr.coalesce_min)) AS reentry
  FROM candidates c CROSS JOIN params pr
  WINDOW t AS (PARTITION BY c.ticket_id ORDER BY c.at, c.key)
),

-- The v6 draft's notify modes (docs/design/workflows/conductor.v6.draft.json); any other name
-- inherits the default `once`, except a legacy `notify: true` transition push (`every`).
v6_modes(transition, mode) AS (
  VALUES ('personal_pr_ready_for_review', 'once'), ('pr_ready_for_review', 'once'),
         ('ready_for_testing', 'once'),
         ('ask_user', 'every'), ('plan_needs_approval', 'every'), ('scope_changed', 'every'),
         ('needs_product_context', 'every'), ('impossible', 'every'),
         ('needs_approval_to_message', 'every')
),
-- Each non-permission candidate's move: named (cause `transition`, or before ADR-0037 P7 an
-- agent's or a human's), or an engine move, which `engine_moves: never` keeps silent. A question
-- whose opening move recorded no transition (rows before ADR-0011) is read as an `ask_user`.
v6_candidates AS (
  SELECT f.*,
    COALESCE(f.move_transition, CASE WHEN f.cause = 'question' THEN 'ask_user' END) AS via,
    (f.kind = 'transition' OR f.cause IN ('handoff', 'question'))
      AND COALESCE(f.move_transition, CASE WHEN f.cause = 'question' THEN 'ask_user' END)
            IS NOT NULL
      AND COALESCE(f.move_cause = 'transition', f.move_actor IS DISTINCT FROM 'engine'
                                                AND f.move_actor IS DISTINCT FROM 'system')
      AS named
  FROM flagged f
  WHERE f.kind <> 'permission'
),
v6_named AS (
  SELECT c.*,
    COALESCE(m.mode, CASE WHEN c.kind = 'transition' THEN 'every' ELSE 'once' END) AS mode,
    row_number() OVER (PARTITION BY c.ticket_id, c.via ORDER BY c.at, c.key) AS take
  FROM v6_candidates c
  LEFT JOIN v6_modes m ON m.transition = c.via
  WHERE c.named
),
v6_moves AS (
  SELECT n.*,
    floor(extract(epoch FROM n.at) / (pr.coalesce_min * 60)) AS bucket
  FROM v6_named n
  CROSS JOIN params pr
  WHERE n.mode = 'every' OR (n.mode = 'once' AND n.take = 1)
),
-- The notifier's bucketed key `notify:<ticket>:<state>:<floor(now / coalesce)>` keeps the first.
v6 AS (
  SELECT * FROM (
    SELECT DISTINCT ON (ticket_id, wait_state, bucket) key, ticket_id, cause, at
      FROM v6_moves ORDER BY ticket_id, wait_state, bucket, at, key
  ) kept
  UNION ALL
  SELECT key, ticket_id, cause, at FROM flagged WHERE kind = 'permission'
),

-- What the outbox actually holds.
outbox_pushes AS (
  SELECT
    o.idempotency_key AS key,
    CASE WHEN o.kind = 'push_transition' THEN 'transition'
         WHEN o.payload ? 'permission_request_id' THEN 'permission'
         ELSE 'needs_input' END AS kind,
    min(o.created_at) AS at,
    count(*) AS deliveries,
    count(*) FILTER (WHERE o.status = 'failed') AS failed
  FROM params pr
  CROSS JOIN outbox o
  WHERE o.kind IN ('push_needs_input', 'push_transition')
    AND o.created_at >= pr.since AND o.created_at < pr.until
  GROUP BY o.idempotency_key, 2
),
outbox_span AS (SELECT min(at) AS first_at FROM outbox_pushes),

per_ticket AS (
  SELECT ticket_id, count(*) AS n FROM flagged GROUP BY ticket_id
),
v6_per_ticket AS (
  SELECT ticket_id, count(*) AS n FROM v6 GROUP BY ticket_id
),
ticket_causes AS (
  SELECT ticket_id, cause, count(*) AS n FROM flagged GROUP BY ticket_id, cause
),
noisiest AS (
  SELECT
    pt.ticket_id, t.title, pt.n,
    COALESCE(v.n, 0) AS v6,
    (SELECT string_agg(tc.cause || ' ×' || tc.n, ', ' ORDER BY tc.n DESC, tc.cause)
       FROM ticket_causes tc WHERE tc.ticket_id = pt.ticket_id)
      || '; back into the same state ' || (SELECT count(*) FROM flagged f
                                           WHERE f.ticket_id = pt.ticket_id AND f.same_state)
      || ', of them within the coalesce window ' || (SELECT count(*) FROM flagged f
                                           WHERE f.ticket_id = pt.ticket_id AND f.reentry)
      AS why
  FROM per_ticket pt
  JOIN ticket t ON t.id = pt.ticket_id
  LEFT JOIN v6_per_ticket v ON v.ticket_id = pt.ticket_id
  ORDER BY pt.n DESC, pt.ticket_id
  LIMIT 10
),

report AS (
  SELECT jsonb_build_object(
    'window', (SELECT jsonb_build_object('since', since, 'until', until,
                                         'coalesce_minutes', coalesce_min,
                                         -- The history may be shorter than the window.
                                         'first_move_at', (SELECT min(ts) FROM event
                                                            WHERE type = 'state.entered'))
                 FROM params),
    'legacy', jsonb_build_object(
      'pushes', (SELECT count(*) FROM flagged),
      'tickets', (SELECT count(*) FROM per_ticket),
      'by_kind', (SELECT COALESCE(jsonb_object_agg(kind, n), '{}') FROM
                    (SELECT kind, count(*) AS n FROM flagged GROUP BY kind) k),
      'by_cause', (SELECT COALESCE(jsonb_object_agg(cause, jsonb_build_object(
                      'pushes', n, 'same_state', same, 'reentry', reentry)), '{}') FROM
                    (SELECT cause, count(*) AS n, count(*) FILTER (WHERE same_state) AS same,
                            count(*) FILTER (WHERE reentry) AS reentry
                       FROM flagged GROUP BY cause) c),
      'by_day', (SELECT COALESCE(jsonb_object_agg(day, n ORDER BY day), '{}') FROM
                   (SELECT to_char(date_trunc('day', at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                           count(*) AS n FROM flagged GROUP BY 1) d),
      'per_ticket', (SELECT jsonb_build_object(
                       'median', percentile_cont(0.5) WITHIN GROUP (ORDER BY n),
                       'p90', percentile_cont(0.9) WITHIN GROUP (ORDER BY n),
                       'max', max(n)) FROM per_ticket),
      'handoff_share', (SELECT round(count(*) FILTER (WHERE cause = 'handoff')::numeric
                                     / NULLIF(count(*), 0), 3) FROM flagged),
      'same_state_share', (SELECT round(count(*) FILTER (WHERE same_state)::numeric
                                        / NULLIF(count(*), 0), 3) FROM flagged),
      'reentry_share', (SELECT round(count(*) FILTER (WHERE reentry)::numeric
                                     / NULLIF(count(*), 0), 3) FROM flagged),
      'noisiest', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                     'ticket_id', ticket_id, 'title', title, 'pushes', n, 'v6_estimate', v6,
                     'why', why) ORDER BY n DESC, ticket_id), '[]') FROM noisiest)
    ),
    'outbox', jsonb_build_object(
      'pushes', (SELECT count(*) FROM outbox_pushes),
      'deliveries', (SELECT COALESCE(sum(deliveries), 0) FROM outbox_pushes),
      'failed_deliveries', (SELECT COALESCE(sum(failed), 0) FROM outbox_pushes),
      'by_kind', (SELECT COALESCE(jsonb_object_agg(kind, n), '{}') FROM
                    (SELECT kind, count(*) AS n FROM outbox_pushes GROUP BY kind) k),
      'first_push_at', (SELECT first_at FROM outbox_span)
    ),
    -- Over the span the outbox has push rows for: the rebuilt legacy pushes, and how many of them
    -- the outbox holds. A gap means push was off, or nobody in the account had subscribed.
    'coverage', jsonb_build_object(
      'legacy_pushes_since_first_outbox_push',
        (SELECT count(*) FROM flagged, outbox_span WHERE flagged.at >= outbox_span.first_at),
      'of_them_in_outbox',
        (SELECT count(*) FROM flagged JOIN outbox_pushes o ON o.key = flagged.key),
      -- The same pair for permission prompts alone: they were enqueued only from the UXR-32
      -- deploy on (see the header), so a gap here before that date is not a missed push.
      'permissions_since_first_outbox_push',
        (SELECT count(*) FROM flagged, outbox_span
          WHERE flagged.kind = 'permission' AND flagged.at >= outbox_span.first_at),
      'permissions_in_outbox',
        (SELECT count(*) FROM flagged JOIN outbox_pushes o ON o.key = flagged.key
          WHERE flagged.kind = 'permission')
    ),
    'v6_estimate', jsonb_build_object(
      'pushes', (SELECT count(*) FROM v6),
      'reduction', (SELECT round(1 - (SELECT count(*) FROM v6)::numeric
                                 / NULLIF((SELECT count(*) FROM flagged), 0), 3)),
      'by_cause', (SELECT COALESCE(jsonb_object_agg(cause, n), '{}') FROM
                     (SELECT cause, count(*) AS n FROM v6 GROUP BY cause) c),
      'dropped', jsonb_build_object(
        'engine_moves', (SELECT count(*) FROM v6_candidates WHERE NOT named),
        'once_repeats', (SELECT count(*) FROM v6_named WHERE mode = 'once' AND take > 1),
        'coalesced', (SELECT count(*) FROM v6_moves) - (SELECT count(*) FROM v6 WHERE cause <> 'permission')
      ),
      'by_via', (SELECT COALESCE(jsonb_object_agg(via, n), '{}') FROM
                   (SELECT m.via, count(*) AS n FROM v6 JOIN v6_moves m ON m.key = v6.key
                     GROUP BY m.via) v),
      'per_ticket', (SELECT jsonb_build_object(
                       'median', percentile_cont(0.5) WITHIN GROUP (ORDER BY n),
                       'p90', percentile_cont(0.9) WITHIN GROUP (ORDER BY n),
                       'max', max(n)) FROM v6_per_ticket),
      -- For comparison with the M3 baseline: the estimate without hand-off pushes, and without
      -- any return to the state the ticket last waited in.
      'what_if', jsonb_build_object(
        'without_handoffs', (SELECT count(*) FROM v6 WHERE cause <> 'handoff'),
        'without_same_state_returns',
          (SELECT count(*) FROM v6 JOIN flagged f ON f.key = v6.key WHERE NOT f.same_state)
      ),
      'assumptions', jsonb_build_array(
        'Modes as in the v6 draft (ADR-0037 P6, amended by T4): the hand-offs and ready_for_testing once, the six question transitions every, any other name the default once.',
        'once: only the first take of a transition name on the ticket pushes (across sessions and re-opens); every: each take.',
        'engine_moves never: a request or transition push whose move was not a named transition (cause other than transition; before ADR-0037 P7, actor engine or system) is dropped. Engine stops (timeout, retries_exhausted, budget, approval, machine_lost) never push.',
        'A question whose opening move recorded no transition (rows before ADR-0011) counts as an ask_user.',
        'A legacy notify: true transition push counts as every unless the draft names its transition.',
        'Coalesce: one push per (ticket, waiting state, coalesce-minute bucket since the epoch), as the notifier''s bucketed idempotency key (ADR-0037 Q5).',
        'Permission prompts are outside the policy: always notified, never coalesced.',
        'Hand-offs are recognised by name (*ready_for_review), not from the pinned definition.',
        'Legacy pushes assume someone in the account had subscribed; counts are push events, not per-user deliveries.'
      )
    )
  ) AS report
)
SELECT jsonb_pretty(report) AS report FROM report;

ROLLBACK;
