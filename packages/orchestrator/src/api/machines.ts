import {
  API_PATHS,
  EnrollRequestSchema,
  RenameMachineRequestSchema,
  type EnrollmentTokenCreated,
  type MachineAlertDto,
  type MachineCapabilityDto,
  type MachineDetail,
  type MachineRepoDto,
  type MachineRow,
  type OkResponse,
} from '@conductor/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { rateLimitRouteConfig } from '../auth/throttle.js';
import type { Queryable } from '../contracts.js';
import type {
  MachineAlertRow,
  MachineCapabilityRow,
  MachineRepoRow,
  MachineRow as MachineDbRow,
} from '../db/types.js';
import { isOutdated } from '../distribution.js';
import { createEnrollmentToken, enrollMachine } from '../gateway/enroll.js';
import { revokeMachine, type MachineSockets } from '../gateway/revoke.js';
import type { Db } from '../main.js';
import { parseBody, sendError } from './errors.js';

// M2-T17: the machines REST routes (10-contracts §Accounts and web auth; ADR-0013 §Enrollment,
// ADR-0017 §Daemon distribution). Every route but the enroll is the signed-in account's; another
// account's machine id is 404. Registered as a plugin so the enroll route's per-IP limit applies
// (`rateLimitRouteConfig`, after `registerRateLimit`).

export interface MachineRoutesOptions {
  db: Db;
  /** Closes a revoked machine's daemon sockets (the gateway). */
  sockets: MachineSockets;
  /** The origin the install command downloads from (no trailing slash). */
  installUrl: (req: FastifyRequest) => string;
  /** The daemon version this orchestrator serves; null = none built (`outdated` is false). */
  servedVersion: string | null;
}

type IdParams = { Params: { id: string } };

/** Statuses that hold a machine slot (the fleet view's `running_sessions`, as in M1). */
const SLOT_STATUSES = ['assigned', 'running', 'needs_input', 'waiting_external'];
/** Statuses a revoke hands to a human (`revokeMachine`'s `live_session_ids`). */
const ENDED_STATUSES = ['done', 'failed', 'lost'];

/** base64url, so it needs no quoting in the shell command. */
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

const OK: OkResponse = { ok: true };

/** The line shown once on Add a machine; install.sh moves the token off argv (TD-117). */
export function installCommand(installUrl: string, token: string): string {
  if (!TOKEN_RE.test(token)) throw new Error('enrollment token is not base64url');
  return `curl -fsSL ${installUrl}${API_PATHS.installScript} | sh -s -- --token ${token}`;
}

type MachineListRow = MachineDbRow & { running_sessions: number; repo_count: number };

const MACHINE_SELECT =
  'SELECT m.*, ' +
  '(SELECT count(*)::int FROM session s WHERE s.machine_id = m.id ' +
  'AND s.status = ANY($2::session_status[])) AS running_sessions, ' +
  '(SELECT count(*)::int FROM machine_repo r WHERE r.machine_id = m.id) AS repo_count ' +
  'FROM machine m WHERE m.account_id = $1';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toMachineRow(m: MachineListRow, servedVersion: string | null): MachineRow {
  return {
    id: m.id,
    hostname: m.hostname,
    status: m.status,
    tags: m.tags,
    last_heartbeat_at: iso(m.last_heartbeat_at),
    max_sessions: m.max_sessions,
    running_sessions: m.running_sessions,
    cpu_free: m.cpu_free,
    mem_free_mb: m.mem_free_mb,
    name: m.name ?? m.hostname,
    daemon_version: m.daemon_version,
    claude_version: m.claude_code_version,
    // Computed at read time, never stored (DECISIONS_LOG 2026-10-27).
    outdated: isOutdated(m.daemon_version, servedVersion),
    repo_count: m.repo_count,
    revoked_at: iso(m.revoked_at),
  };
}

async function listMachineRows(
  db: Queryable,
  accountId: string,
  servedVersion: string | null,
): Promise<MachineRow[]> {
  const res = await db.query<MachineListRow>(`${MACHINE_SELECT} ORDER BY m.created_at, m.id`, [
    accountId,
    SLOT_STATUSES,
  ]);
  return res.rows.map((m) => toMachineRow(m, servedVersion));
}

async function loadMachine(
  db: Queryable,
  accountId: string,
  id: string,
): Promise<MachineListRow | null> {
  const res = await db.query<MachineListRow>(`${MACHINE_SELECT} AND m.id = $3`, [
    accountId,
    SLOT_STATUSES,
    id,
  ]);
  return res.rows[0] ?? null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function toCapabilityDto(c: MachineCapabilityRow): MachineCapabilityDto {
  const detail = c.detail as Record<string, unknown>;
  return {
    name: c.name,
    version: c.version,
    authed: c.kind === 'cli' && typeof detail.authed === 'boolean' ? detail.authed : null,
    repo: c.kind === 'skill' || c.kind === 'agent' ? str(detail.repo) : null,
  };
}

function toAlertDto(a: MachineAlertRow): MachineAlertDto {
  const detail = a.detail as Record<string, unknown>;
  const files = Array.isArray(detail.files)
    ? detail.files.filter((f): f is string => typeof f === 'string')
    : [];
  return {
    id: a.id,
    kind: a.kind,
    repo: str(detail.repo),
    session_id: a.session_id,
    files,
    created_at: a.created_at.toISOString(),
  };
}

async function loadMachineDetail(
  db: Queryable,
  m: MachineListRow,
  servedVersion: string | null,
): Promise<MachineDetail> {
  const repos = await db.query<MachineRepoRow>(
    'SELECT * FROM machine_repo WHERE machine_id = $1 ORDER BY path',
    [m.id],
  );
  const caps = await db.query<MachineCapabilityRow>(
    'SELECT * FROM machine_capability WHERE machine_id = $1 ORDER BY kind, name, key',
    [m.id],
  );
  const alerts = await db.query<MachineAlertRow>(
    'SELECT * FROM machine_alert WHERE machine_id = $1 AND cleared_at IS NULL ' +
      'ORDER BY created_at, id',
    [m.id],
  );
  const live = await db.query<{ session_id: string; ticket_id: string; title: string }>(
    'SELECT s.id AS session_id, s.ticket_id, t.title FROM session s ' +
      'JOIN ticket t ON t.id = s.ticket_id ' +
      'WHERE s.machine_id = $1 AND NOT (s.status = ANY($2::session_status[])) ' +
      'ORDER BY s.created_at, s.id',
    [m.id, ENDED_STATUSES],
  );
  const capabilities: MachineDetail['capabilities'] = {
    cli: [],
    mcp: [],
    skill: [],
    agent: [],
    claude: [],
  };
  for (const c of caps.rows) capabilities[c.kind].push(toCapabilityDto(c));
  return {
    ...toMachineRow(m, servedVersion),
    os: m.os,
    arch: m.arch,
    repos: repos.rows.map((r): MachineRepoDto => ({
      remote: r.remote,
      path: r.path,
      mode: r.mode,
      default_branch: r.default_branch,
    })),
    capabilities,
    alerts: alerts.rows.map(toAlertDto),
    live_sessions: live.rows,
  };
}

export const registerMachineRoutes: FastifyPluginAsync<MachineRoutesOptions> = (app, opts) => {
  const { db, sockets, installUrl, servedVersion } = opts;
  const notFound = (id: string) => `machine ${id} not found`;

  // Public: the token authenticates (the auth hook and the security guard let it through).
  app.post(
    API_PATHS.machinesEnroll,
    { config: rateLimitRouteConfig('enroll') },
    async (req, reply) => {
      const body = parseBody(EnrollRequestSchema, req.body, reply);
      if (!body) return reply;
      const enrolled = await enrollMachine(db, body);
      if (enrolled === null) {
        return sendError(
          reply,
          401,
          'unauthorized',
          'enrollment token is unknown, used or expired',
        );
      }
      return reply.code(201).send(enrolled);
    },
  );

  app.post(API_PATHS.machineEnrollmentTokens, async (req, reply) => {
    const issued = await createEnrollmentToken(db, req.auth!.scope);
    const out: EnrollmentTokenCreated = {
      token: issued.token,
      command: installCommand(installUrl(req), issued.token),
      expires_at: issued.expires_at.toISOString(),
    };
    return reply.code(201).send(out);
  });

  app.get(API_PATHS.machines, (req) =>
    listMachineRows(db, req.auth!.scope.account_id, servedVersion),
  );

  app.get<IdParams>(API_PATHS.machine(':id'), async (req, reply) => {
    const m = await loadMachine(db, req.auth!.scope.account_id, req.params.id);
    if (!m) return sendError(reply, 404, 'not_found', notFound(req.params.id));
    return loadMachineDetail(db, m, servedVersion);
  });

  app.patch<IdParams>(API_PATHS.machine(':id'), async (req, reply) => {
    const body = parseBody(RenameMachineRequestSchema, req.body, reply);
    if (!body) return reply;
    const accountId = req.auth!.scope.account_id;
    const res = await db.query(
      'UPDATE machine SET name = $3, updated_at = now() WHERE id = $1 AND account_id = $2',
      [req.params.id, accountId, body.name],
    );
    const m = res.rowCount === 0 ? null : await loadMachine(db, accountId, req.params.id);
    if (!m) return sendError(reply, 404, 'not_found', notFound(req.params.id));
    return toMachineRow(m, servedVersion);
  });

  app.post<IdParams>(API_PATHS.machineRevoke(':id'), async (req, reply) => {
    const res = await revokeMachine({ db, sockets }, req.auth!.scope, req.params.id);
    if (!res) return sendError(reply, 404, 'not_found', notFound(req.params.id));
    // M2-T20 hands live_session_ids to a human (machine.lost {reason: 'revoked'}).
    return OK;
  });

  return Promise.resolve();
};
