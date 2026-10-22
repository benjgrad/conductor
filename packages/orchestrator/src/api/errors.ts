import type { ApiError, ApiErrorCode } from '@conductor/shared';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';

// ApiError bodies (shared/src/api/rest.ts) for every 4xx/5xx (M1-T08).

export type ErrorDetail = { path: string; message: string };

export function apiError(code: ApiErrorCode, message: string, details?: ErrorDetail[]): ApiError {
  return { error: details ? { code, message, details } : { code, message } };
}

export function sendError(
  reply: FastifyReply,
  status: number,
  code: ApiErrorCode,
  message: string,
  details?: ErrorDetail[],
): FastifyReply {
  return reply.code(status).send(apiError(code, message, details));
}

export const pathString = (path: readonly PropertyKey[]): string =>
  path.map((p) => (typeof p === 'symbol' ? String(p) : p)).join('.');

/**
 * Parse a request body with a zod schema; on failure send 400 `bad_request` with the issues as
 * `details` and return undefined.
 */
export function parseBody<S extends z.ZodType>(
  schema: S,
  body: unknown,
  reply: FastifyReply,
): z.infer<S> | undefined {
  const res = schema.safeParse(body ?? {});
  if (res.success) return res.data;
  void sendError(
    reply,
    400,
    'bad_request',
    'invalid request body',
    res.error.issues.map((i) => ({ path: pathString(i.path), message: i.message })),
  );
  return undefined;
}
