import { API_PATHS, RunScheduleRequestSchema } from '@conductor/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { AuthConfig } from '../auth/config.js';
import type { BoardBus } from '../contracts.js';
import type { Db } from '../main.js';
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  runScheduleNow,
  updateSchedule,
  type ScheduleDeps,
} from '../schedules/store.js';
import { parseBody, sendError } from './errors.js';

// ADR-0032: /api/schedules, recurring tickets. Thin routes over schedules/store.ts (the MCP
// tools call the same functions), always scoped to the caller's account.

export interface ScheduleRoutesOptions {
  db: Db;
  boardBus: BoardBus;
  auth: AuthConfig;
  now: () => Date;
}

type IdParams = { Params: { id: string } };

export const registerScheduleRoutes: FastifyPluginAsync<ScheduleRoutesOptions> = (
  app,
  { db, boardBus, auth, now },
) => {
  const deps: ScheduleDeps = { db, boardBus, auth, now };

  app.get(API_PATHS.schedules, async (req) => listSchedules(db, req.auth!.scope.account_id, now()));

  app.post(API_PATHS.schedules, async (req, reply) => {
    const res = await createSchedule(deps, req.auth!.scope, req.body ?? {}, req.auth!.user.email);
    if (!res.ok) return sendError(reply, res.status, res.code, res.message, res.details);
    return reply.code(201).send(res.dto);
  });

  app.get<IdParams>(API_PATHS.schedule(':id'), async (req, reply) => {
    const dto = await getSchedule(db, req.auth!.scope.account_id, req.params.id, now());
    if (dto === null) return sendError(reply, 404, 'not_found', `no schedule ${req.params.id}`);
    return dto;
  });

  app.patch<IdParams>(API_PATHS.schedule(':id'), async (req, reply) => {
    const res = await updateSchedule(deps, req.auth!.scope, req.params.id, req.body ?? {});
    if (!res.ok) return sendError(reply, res.status, res.code, res.message, res.details);
    return res.dto;
  });

  // A JSON body like every unsafe request (the security hook 415s anything else).
  app.delete<IdParams>(API_PATHS.schedule(':id'), async (req, reply) => {
    if (!(await deleteSchedule(db, req.auth!.scope.account_id, req.params.id))) {
      return sendError(reply, 404, 'not_found', `no schedule ${req.params.id}`);
    }
    return { ok: true };
  });

  app.post<IdParams>(API_PATHS.scheduleRun(':id'), async (req, reply) => {
    const body = parseBody(RunScheduleRequestSchema, req.body, reply);
    if (!body) return reply;
    const res = await runScheduleNow(deps, req.auth!.scope, req.params.id, body);
    if (!res.ok) return sendError(reply, res.status, res.code, res.message, res.details);
    return reply.code(201).send({ ticket_id: res.ticket_id, schedule: res.dto });
  });
  return Promise.resolve();
};
