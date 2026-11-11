import {
  API_PATHS,
  DAEMON_AUTH_HEADER,
  RunGateRequestSchema,
  RunGateResultSchema,
  UuidSchema,
  WorkflowDefinitionSchema,
  agentTransitionOptions,
  parseDaemonAuthHeader,
  selfCheckSpecOf,
  type RunGateSpec,
  type TicketKind,
} from '@conductor/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthConfig } from '../auth/config.js';
import { readRepoChecks } from '../engine/rows.js';
import { authenticateMachine } from '../gateway/auth.js';
import type { Db } from '../main.js';
import { sendError } from './errors.js';

// R4: the daemon's side of an agent's `run_gate` (05 §Self-checks, 10-contracts §run_gate).
// - POST API_PATHS.daemonSessionGate: the checks the gate of `transition` runs, out of the
//   session's current agent state, with the repo override applied (`selfCheckSpecOf`, as the
//   engine's gate step), and a `self_check_run` row recording the call.
// - POST API_PATHS.daemonSessionGateResult: the outcome, once per run.
// Auth as the page publish (api/pages.ts): the machine credential in password mode, and the
// session must be live and on that machine. Nothing here touches the engine.

export interface RunGateRoutesOptions {
  db: Db;
  auth: AuthConfig;
}

type IdParams = { Params: { id: string } };

interface GateSession {
  id: string;
  account_id: string;
  ticket_id: string;
  workflow_id: string;
  workflow_version: number;
  workflow_state: string | null;
  status: string;
  repo: string;
  kind: TicketKind | null;
}

/** null after sending the error: the machine of the request (or none, in local mode). */
async function machineOf(
  db: Db,
  auth: AuthConfig,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ machineId: string | null } | null> {
  if (auth.mode !== 'password') return { machineId: null };
  const credential = parseDaemonAuthHeader(req.headers[DAEMON_AUTH_HEADER]);
  const machine = credential === null ? null : await authenticateMachine(db, credential);
  if (machine === null) {
    await sendError(reply, 401, 'unauthorized', 'machine credential required');
    return null;
  }
  return { machineId: machine.machineId };
}

export const registerRunGateRoutes: FastifyPluginAsync<RunGateRoutesOptions> = (
  app,
  { db, auth },
) => {
  /** The live session `id` on that machine (any, in local mode), or null. */
  const liveSession = async (id: string, machineId: string | null) => {
    if (!UuidSchema.safeParse(id).success) return null;
    const r = await db.query<GateSession>(
      'SELECT s.id, s.account_id, s.ticket_id, s.workflow_id, s.workflow_version, ' +
        's.workflow_state, s.status, t.repo, t.kind FROM session s JOIN ticket t ON t.id = s.ticket_id ' +
        "WHERE s.id = $1 AND s.status NOT IN ('done', 'failed', 'lost') " +
        'AND ($2::text IS NULL OR s.machine_id = $2)',
      [id, machineId],
    );
    return r.rows[0] ?? null;
  };

  app.post<IdParams>(API_PATHS.daemonSessionGate(':id'), async (req, reply) => {
    const m = await machineOf(db, auth, req, reply);
    if (m === null) return reply;
    const id = req.params.id;
    const body = RunGateRequestSchema.safeParse(req.body);
    if (!body.success) {
      return sendError(reply, 400, 'bad_request', 'expected {transition, sha}');
    }
    const session = await liveSession(id, m.machineId);
    if (session === null) return sendError(reply, 404, 'not_found', `session ${id} not found`);
    const d = await db.query<{ definition: unknown }>(
      'SELECT definition FROM workflow_definition WHERE id = $1 AND version = $2',
      [session.workflow_id, session.workflow_version],
    );
    const def = WorkflowDefinitionSchema.safeParse(d.rows[0]?.definition);
    const state = session.workflow_state;
    if (
      !def.success ||
      state === null ||
      session.status !== 'running' ||
      def.data.states[state]?.type !== 'agent'
    ) {
      return sendError(
        reply,
        409,
        'wrong_state',
        'the session is not working in an agent state (a gate or a human may have it)',
      );
    }
    const transition = body.data.transition;
    const options = agentTransitionOptions(def.data, state, session.kind);
    if (!options.some((o) => o.name === transition)) {
      return sendError(
        reply,
        400,
        'bad_request',
        `"${transition}" is not a transition you can take here; allowed: ` +
          options.map((o) => o.name).join(', '),
      );
    }
    const override = await readRepoChecks(db, session.account_id, session.repo);
    const spec = selfCheckSpecOf(def.data, state, transition, override);
    if (spec === null) {
      const checked = options.filter((o) => o.checks === true).map((o) => o.name);
      return sendError(
        reply,
        400,
        'bad_request',
        `"${transition}" runs no checks, so there is nothing to run` +
          (checked.length > 0 ? `; transitions with checks: ${checked.join(', ')}` : ''),
      );
    }
    const row = await db.query<{ id: string }>(
      'INSERT INTO self_check_run (account_id, ticket_id, session_id, workflow_state, transition, sha) ' +
        'VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [session.account_id, session.ticket_id, session.id, state, transition, body.data.sha],
    );
    const res: RunGateSpec = {
      run_id: row.rows[0]!.id,
      transition,
      title: spec.title,
      setup: spec.setup,
      checks: [...spec.checks],
    };
    return reply.code(201).send(res);
  });

  app.post<IdParams>(API_PATHS.daemonSessionGateResult(':id'), async (req, reply) => {
    const m = await machineOf(db, auth, req, reply);
    if (m === null) return reply;
    const id = req.params.id;
    const body = RunGateResultSchema.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'bad_request', 'expected a RunGateResult');
    if (!UuidSchema.safeParse(id).success) {
      return sendError(reply, 404, 'not_found', `session ${id} not found`);
    }
    // The session may have ended meanwhile (a kill): the outcome is still worth keeping, so only
    // the machine is checked, not that the session is live.
    const { run_id: runId, passed, duration_ms: durationMs, ...rest } = body.data;
    const r = await db.query(
      'UPDATE self_check_run r SET finished_at = now(), passed = $3, duration_ms = $4, results = $5 ' +
        'FROM session s WHERE r.id = $2 AND r.session_id = $1 AND s.id = r.session_id ' +
        'AND r.finished_at IS NULL AND ($6::text IS NULL OR s.machine_id = $6)',
      [id, runId, passed, durationMs, JSON.stringify(rest), m.machineId],
    );
    if ((r.rowCount ?? 0) === 0) {
      const known = await db.query(
        'SELECT 1 FROM self_check_run r JOIN session s ON s.id = r.session_id ' +
          'WHERE r.id = $2 AND r.session_id = $1 AND ($3::text IS NULL OR s.machine_id = $3)',
        [id, runId, m.machineId],
      );
      // Already reported: idempotent.
      if (known.rows.length > 0) return { ok: true };
      return sendError(reply, 404, 'not_found', `run ${runId} not found`);
    }
    return { ok: true };
  });
  return Promise.resolve();
};
