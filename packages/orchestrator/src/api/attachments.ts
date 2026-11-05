import { createHash } from 'node:crypto';
import {
  API_PATHS,
  ATTACHMENT_CAPTION_HEADER,
  ATTACHMENT_CAPTION_MAX,
  ATTACHMENT_FILENAME_HEADER,
  ATTACHMENT_MAX_VIDEO_BYTES,
  ATTACHMENT_TICKET_MAX_BYTES,
  DAEMON_AUTH_HEADER,
  UuidSchema,
  attachmentMaxBytes,
  parseDaemonAuthHeader,
  attachmentCountMax,
  sanitizeAttachmentName,
  sniffMime,
  type ApiErrorCode,
  type AttachmentDto,
  type AttachmentMime,
  type AttachmentSource,
  type BoardSseEvent,
  type OkResponse,
} from '@conductor/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { AuthConfig } from '../auth/config.js';
import type { BoardBus, Queryable } from '../contracts.js';
import { withTransaction } from '../db/index.js';
import type { AttachmentRow } from '../db/types.js';
import { ATTACHMENT_META_COLUMNS as META } from '../engine/attachments.js';
import { authenticateMachine } from '../gateway/auth.js';
import type { Db } from '../main.js';
import { cardUpserted } from '../permissions/store.js';
import { sendError } from './errors.js';

export {
  UNLINKED_TTL_MS,
  sweepUnlinkedAttachments,
  attachmentRefs,
  attachmentsFallbackNote,
  loadTicketAttachments,
} from '../engine/attachments.js';

// 06 §Attachments, 10-contracts §Attachments. A human uploads a file's raw bytes (POST
// API_PATHS.attachments, `application/octet-stream`, the name in `x-conductor-filename`); the type
// is sniffed from the bytes, never taken from the client. The upload is unlinked until a ticket
// create / edit links it (`linkAttachments`), so a ticket is never claimed before its files exist;
// unlinked uploads older than UNLINKED_TTL_MS are swept. The bytes are served same-origin with
// `nosniff` and a sandbox CSP. The daemon of a machine working the ticket downloads them with its
// credential (API_PATHS.daemonAttachmentContent).

/** The upload route's body limit: the largest file plus nothing (Fastify answers 413 above it). */
export const UPLOAD_BODY_LIMIT = ATTACHMENT_MAX_VIDEO_BYTES;

export function toAttachmentDto(r: AttachmentRow): AttachmentDto {
  return {
    id: r.id,
    name: r.name,
    mime: r.mime as AttachmentDto['mime'],
    size_bytes: r.size_bytes,
    source: r.source,
    caption: r.caption,
    session_id: r.session_id,
    workflow_state: r.workflow_state,
    created_at: r.created_at.toISOString(),
    url: API_PATHS.attachmentContent(r.id),
  };
}

/** A failed link: the transaction is rolled back and this is the response. */
export class AttachmentLinkError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Link uploaded, unlinked attachments of the account to `ticketId`, inside the caller's
 * transaction. Throws AttachmentLinkError (400) when one is unknown or already linked, or the
 * ticket would exceed its human count limit or ATTACHMENT_TICKET_MAX_BYTES (`checkTicketLimits`).
 */
export async function linkAttachments(
  tx: Queryable,
  accountId: string,
  ticketId: string,
  ids: readonly string[],
): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const linked = await tx.query<{ id: string }>(
    'UPDATE attachment SET ticket_id = $1 ' +
      'WHERE id = ANY($2::uuid[]) AND account_id = $3 AND ticket_id IS NULL RETURNING id',
    [ticketId, unique, accountId],
  );
  if (linked.rows.length !== unique.length) {
    throw new AttachmentLinkError(400, 'bad_request', 'unknown or already linked attachment');
  }
  await checkTicketLimits(tx, ticketId, 'human');
}

/**
 * Throws AttachmentLinkError (400 `attachment_limit`) when the ticket holds more than
 * `attachmentCountMax(source)` attachments from `source` (each source has its own count, so an
 * agent can't use up the human's) or more than ATTACHMENT_TICKET_MAX_BYTES in all.
 */
export async function checkTicketLimits(
  tx: Queryable,
  ticketId: string,
  source: AttachmentSource,
): Promise<void> {
  const totals = await tx.query<{ n: number; bytes: string }>(
    'SELECT count(*) FILTER (WHERE source = $2)::int AS n, ' +
      'coalesce(sum(size_bytes), 0)::text AS bytes FROM attachment WHERE ticket_id = $1',
    [ticketId, source],
  );
  const { n, bytes } = totals.rows[0]!;
  const max = attachmentCountMax(source);
  if (n > max) {
    throw new AttachmentLinkError(
      400,
      'attachment_limit',
      source === 'agent'
        ? `the agents of a ticket attach at most ${max} files`
        : `a ticket has at most ${max} attachments`,
    );
  }
  if (Number(bytes) > ATTACHMENT_TICKET_MAX_BYTES) {
    throw new AttachmentLinkError(
      400,
      'attachment_limit',
      `a ticket's attachments total at most ${ATTACHMENT_TICKET_MAX_BYTES / 1024 / 1024} MB`,
    );
  }
}

/** Delete some of the ticket's attachments (inside the caller's transaction). */
export async function removeAttachments(
  tx: Queryable,
  ticketId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await tx.query('DELETE FROM attachment WHERE ticket_id = $1 AND id = ANY($2::uuid[])', [
    ticketId,
    [...new Set(ids)],
  ]);
}

type Refusal = { ok: false; status: number; code: ApiErrorCode; message: string };

/** The bytes' sniffed type, or the refusal (415 not a known type, 413 over its type's limit). */
export function checkBytes(data: Buffer): { ok: true; mime: AttachmentMime } | Refusal {
  const mime = sniffMime(data);
  if (mime === null) {
    return {
      ok: false,
      status: 415,
      code: 'attachment_type',
      message: 'only PNG, JPEG, GIF, WebP, MP4 and WebM files can be attached',
    };
  }
  const max = attachmentMaxBytes(mime);
  if (data.length > max) {
    return {
      ok: false,
      status: 413,
      code: 'attachment_too_large',
      message: `${mime} attachments are at most ${max / 1024 / 1024} MB`,
    };
  }
  return { ok: true, mime };
}

/** Store one upload (unlinked). `null` with the error to send when the bytes are refused. */
export async function storeUpload(
  db: Db,
  input: { accountId: string; userId: string | null; rawName: string; data: Buffer },
): Promise<{ ok: true; dto: AttachmentDto } | Refusal> {
  const checked = checkBytes(input.data);
  if (!checked.ok) return checked;
  const mime = checked.mime;
  const name = sanitizeAttachmentName(input.rawName, mime);
  const sha256 = createHash('sha256').update(input.data).digest();
  // TD-212: the bytes live in Postgres (covered by the pg_dump backup); move them to disk or
  // object storage if the total grows past a few GB.
  const row = await withTransaction(db, async (tx) => {
    const r = await tx.query<AttachmentRow>(
      'INSERT INTO attachment (account_id, source, name, mime, size_bytes, sha256, created_by) ' +
        "VALUES ($1, 'human', $2, $3, $4, $5, $6) RETURNING *",
      [input.accountId, name, mime, input.data.length, sha256, input.userId],
    );
    const a = r.rows[0]!;
    await tx.query(
      'INSERT INTO attachment_content (attachment_id, account_id, data) VALUES ($1, $2, $3)',
      [a.id, input.accountId, input.data],
    );
    return a;
  });
  return { ok: true, dto: toAttachmentDto(row) };
}

/** A live session of the agent attaching: what its attachment is filed under. */
interface AttachingSession {
  id: string;
  ticket_id: string;
  account_id: string;
  workflow_state: string;
  agent_name: string | null;
}

/**
 * Store a file an agent captured (06 §Attachments, agent attachments): linked to the session's
 * ticket at once, filed under the session and the state it is in, in one transaction with the
 * per-source limits and the card's `card.upserted` (the open panel refetches). Idempotent on
 * `(session_id, sha256)`: the same bytes again return the stored row (`created: false`).
 */
export async function storeAgentAttachment(
  db: Db,
  session: AttachingSession,
  input: { rawName: string; caption: string | null; data: Buffer },
): Promise<
  { ok: true; created: boolean; dto: AttachmentDto; events: BoardSseEvent[] } | Refusal
> {
  const checked = checkBytes(input.data);
  if (!checked.ok) return checked;
  const mime = checked.mime;
  const name = sanitizeAttachmentName(input.rawName, mime);
  const sha256 = createHash('sha256').update(input.data).digest();
  try {
    return await withTransaction(db, async (tx) => {
      // One upload per ticket at a time, so two can't both pass the count check.
      await tx.query('SELECT 1 FROM ticket WHERE id = $1 FOR UPDATE', [session.ticket_id]);
      // TD-212: the bytes live in Postgres, as a human's do.
      const ins = await tx.query<AttachmentRow>(
        'INSERT INTO attachment (account_id, ticket_id, session_id, workflow_state, source, ' +
          'name, mime, size_bytes, sha256, caption, created_by) ' +
          "VALUES ($1, $2, $3, $4, 'agent', $5, $6, $7, $8, $9, $10) " +
          "ON CONFLICT (session_id, sha256) WHERE source = 'agent' AND session_id IS NOT NULL " +
          'DO NOTHING RETURNING *',
        [
          session.account_id,
          session.ticket_id,
          session.id,
          session.workflow_state,
          name,
          mime,
          input.data.length,
          sha256,
          input.caption,
          session.agent_name ?? 'agent',
        ],
      );
      const row = ins.rows[0];
      if (!row) {
        const existing = await tx.query<AttachmentRow>(
          `SELECT ${META} FROM attachment a WHERE a.session_id = $1 AND a.sha256 = $2 ` +
            "AND a.source = 'agent'",
          [session.id, sha256],
        );
        return {
          ok: true as const,
          created: false,
          dto: toAttachmentDto(existing.rows[0]!),
          events: [],
        };
      }
      await tx.query(
        'INSERT INTO attachment_content (attachment_id, account_id, data) VALUES ($1, $2, $3)',
        [row.id, session.account_id, input.data],
      );
      await checkTicketLimits(tx, session.ticket_id, 'agent');
      // The card's updated_at moves, so a panel showing the ticket refetches it.
      await tx.query('UPDATE ticket SET updated_at = now() WHERE id = $1', [session.ticket_id]);
      const events = await cardUpserted(tx, session.id);
      return { ok: true as const, created: true, dto: toAttachmentDto(row), events };
    });
  } catch (err) {
    if (err instanceof AttachmentLinkError) {
      return { ok: false, status: err.status, code: err.code, message: err.message };
    }
    throw err;
  }
}

/** The caption from its header (URL-encoded, trimmed, at most ATTACHMENT_CAPTION_MAX); null if none. */
export function uploadCaption(header: string | string[] | undefined): string | null {
  const v = uploadName(header).trim();
  return v === '' ? null : v.slice(0, ATTACHMENT_CAPTION_MAX);
}

/** The upload's file name from its header (URL-encoded); '' when absent or malformed. */
export function uploadName(header: string | string[] | undefined): string {
  const v = Array.isArray(header) ? header[0] : header;
  if (v === undefined) return '';
  try {
    return decodeURIComponent(v);
  } catch {
    return '';
  }
}

/** The headers the bytes are served with: the sniffed type, never rendered as a document. */
export function contentHeaders(row: Pick<AttachmentRow, 'mime' | 'name' | 'size_bytes'>) {
  return {
    'content-type': row.mime,
    'content-length': String(row.size_bytes),
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'",
    'cache-control': 'private, max-age=31536000, immutable',
  };
}

export interface AttachmentRoutesOptions {
  db: Db;
  auth: AuthConfig;
  /** Where the agent attachment's `card.upserted` is published. */
  boardBus: BoardBus;
}

type IdParams = { Params: { id: string } };

export const registerAttachmentRoutes: FastifyPluginAsync<AttachmentRoutesOptions> = (
  app,
  { db, auth, boardBus },
) => {
  // Raw bytes on the upload route only (the security hook allows octet-stream there alone).
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: UPLOAD_BODY_LIMIT },
    (_req, body, done) => done(null, body),
  );
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err.statusCode === 413) {
      return sendError(reply, 413, 'attachment_too_large', 'the file is too large');
    }
    throw err;
  });

  const notFound = (reply: FastifyReply, id: string) =>
    sendError(reply, 404, 'not_found', `attachment ${id} not found`);

  /** Send the bytes of `id` when `where` (with $1 = id and `extra`) finds it. */
  const serve = async (
    reply: FastifyReply,
    id: string,
    where: string,
    extra: unknown[],
  ): Promise<FastifyReply> => {
    const r = await db.query<AttachmentRow & { data: Buffer }>(
      `SELECT ${META}, c.data FROM attachment a ` +
        `JOIN attachment_content c ON c.attachment_id = a.id WHERE a.id = $1 AND ${where}`,
      [id, ...extra],
    );
    const row = r.rows[0];
    if (!row) return notFound(reply, id);
    // TD-213: no Range support; Safari may not seek in a video.
    return reply.code(200).headers(contentHeaders(row)).send(row.data);
  };

  app.post(API_PATHS.attachments, { bodyLimit: UPLOAD_BODY_LIMIT }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return sendError(reply, 400, 'bad_request', 'send the file as the request body');
    }
    const actor = req.auth!.scope.actor;
    const res = await storeUpload(db, {
      accountId: req.auth!.scope.account_id,
      userId: actor.kind === 'user' ? actor.user_id : null,
      rawName: uploadName(req.headers[ATTACHMENT_FILENAME_HEADER]),
      data: req.body,
    });
    if (!res.ok) return sendError(reply, res.status, res.code, res.message);
    return reply.code(201).send(res.dto);
  });

  app.get<IdParams>(API_PATHS.attachmentContent(':id'), async (req, reply) => {
    const id = req.params.id;
    if (!UuidSchema.safeParse(id).success) return notFound(reply, id);
    return serve(reply, id, 'a.account_id = $2', [req.auth!.scope.account_id]);
  });

  /** Only an unlinked upload: a linked one is removed with PATCH `remove_attachment_ids`. */
  app.delete<IdParams>(API_PATHS.attachment(':id'), async (req, reply) => {
    const id = req.params.id;
    if (!UuidSchema.safeParse(id).success) return notFound(reply, id);
    const r = await db.query<{ ticket_id: string | null }>(
      'SELECT ticket_id FROM attachment WHERE id = $1 AND account_id = $2',
      [id, req.auth!.scope.account_id],
    );
    const row = r.rows[0];
    if (!row) return notFound(reply, id);
    if (row.ticket_id !== null) {
      return sendError(
        reply,
        409,
        'conflict',
        'the attachment is on a ticket; remove it by editing the ticket',
      );
    }
    await db.query('DELETE FROM attachment WHERE id = $1 AND ticket_id IS NULL', [id]);
    const ok: OkResponse = { ok: true };
    return ok;
  });

  /**
   * 06 §Attachments: an agent attaches what it captured. Password mode: the machine credential,
   * and the session must be live and on that machine (else 404). Local mode (loopback only,
   * ADR-0017 §Modes): any live session.
   */
  app.post<IdParams>(
    API_PATHS.daemonSessionAttachments(':id'),
    { bodyLimit: UPLOAD_BODY_LIMIT },
    async (req, reply) => {
      const id = req.params.id;
      let machineId: string | null = null;
      if (auth.mode === 'password') {
        const credential = parseDaemonAuthHeader(req.headers[DAEMON_AUTH_HEADER]);
        const machine = credential === null ? null : await authenticateMachine(db, credential);
        if (machine === null)
          return sendError(reply, 401, 'unauthorized', 'machine credential required');
        machineId = machine.machineId;
      }
      const noSession = () => sendError(reply, 404, 'not_found', `session ${id} not found`);
      if (!UuidSchema.safeParse(id).success) return noSession();
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return sendError(reply, 400, 'bad_request', 'send the file as the request body');
      }
      const s = await db.query<AttachingSession>(
        'SELECT s.id, s.ticket_id, s.account_id, s.workflow_state, ag.name AS agent_name ' +
          'FROM session s JOIN ticket t ON t.id = s.ticket_id ' +
          'LEFT JOIN agent ag ON ag.id = t.agent_id WHERE s.id = $1 ' +
          "AND s.status NOT IN ('done', 'failed', 'lost') " +
          'AND ($2::text IS NULL OR s.machine_id = $2)',
        [id, machineId],
      );
      const session = s.rows[0];
      if (!session) return noSession();
      const res = await storeAgentAttachment(db, session, {
        rawName: uploadName(req.headers[ATTACHMENT_FILENAME_HEADER]),
        caption: uploadCaption(req.headers[ATTACHMENT_CAPTION_HEADER]),
        data: req.body,
      });
      if (!res.ok) return sendError(reply, res.status, res.code, res.message);
      for (const ev of res.events) boardBus.publish(ev);
      return reply.code(res.created ? 201 : 200).send(res.dto);
    },
  );

  /**
   * The daemon's download. Password mode: the machine credential, and the machine must hold a
   * live session of the attachment's ticket (else 404, so ids aren't confirmed). Local mode
   * (loopback only, ADR-0017 §Modes): any live session of the ticket.
   */
  app.get<IdParams>(API_PATHS.daemonAttachmentContent(':id'), async (req, reply) => {
    const id = req.params.id;
    let machineId: string | null = null;
    if (auth.mode === 'password') {
      const credential = parseDaemonAuthHeader(req.headers[DAEMON_AUTH_HEADER]);
      const machine = credential === null ? null : await authenticateMachine(db, credential);
      if (machine === null)
        return sendError(reply, 401, 'unauthorized', 'machine credential required');
      machineId = machine.machineId;
    }
    if (!UuidSchema.safeParse(id).success) return notFound(reply, id);
    return serve(
      reply,
      id,
      'EXISTS (SELECT 1 FROM session s WHERE s.ticket_id = a.ticket_id ' +
        "AND s.status NOT IN ('done', 'failed', 'lost') " +
        'AND ($2::text IS NULL OR s.machine_id = $2))',
      [machineId],
    );
  });
  return Promise.resolve();
};
