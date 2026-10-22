import { z } from 'zod';
import {
  BoardColumnSchema,
  CardBadgeSchema,
  InputRequestKindSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  SessionStatusSchema,
  UuidSchema,
} from '../domain.js';
import { BoardCardSchema } from './rest.js';

export { OutputChunkSchema, type OutputChunk } from './output.js';

// Server-sent events (03 §SSE). Implemented by M1-T08, consumed by M1-T09.
//
// Wire format, board stream (GET /api/stream/board):
//   id: <event.id>\nevent: <type>\ndata: <JSON of the whole BoardSseEvent>\n\n
//
// Every BoardSseEvent is backed by exactly ONE `event` table row (10-contracts §Board events):
//   row.type = the SSE `type`, row.session_id = the SSE `session_id`,
//   row.payload = the SSE event minus {type, id, ts, session_id}, row.id = `id`, row.ts = `ts`.
// So Last-Event-ID replay is `SELECT … FROM event WHERE id > $1 AND type = ANY($board_types)
// ORDER BY id`, decoded with `boardSseEventFromRow`. Writers build rows with `boardSseEventToRow`.
//
// Output stream (GET /api/stream/sessions/:id/output):
//   event: output\ndata: <JSON OutputChunk>\n\n   (no id: output is not replayable beyond the ring)

const base = { id: z.number().int().positive(), ts: IsoDateTimeSchema };
const sessionBase = { ...base, session_id: UuidSchema };

/**
 * Board-level events. The client keeps one card per `ticket_id`. NOTE `input.answered` (SSE, for
 * the UI) is distinct from the engine event `input.provided` (EngineEvent) on purpose
 * (10-contracts).
 */
export const BoardSseEventSchema = z.discriminatedUnion('type', [
  /**
   * The full current card; the client replaces (or adds) the card keyed by `ticket_id`. Emitted
   * by T08 on ticket create (session_id null), and by T04's EngineService after every applied
   * event that changed a card field (claim/assignment, state entered, status, spend, input).
   */
  z.object({
    type: z.literal('card.upserted'),
    ...base,
    session_id: UuidSchema.nullable(),
    ticket_id: UuidSchema,
    card: BoardCardSchema,
  }),
  /** The card changed column (`columnFor(status)` changed). New cards arrive as card.upserted. */
  z.object({
    type: z.literal('card.moved'),
    ...sessionBase,
    ticket_id: UuidSchema,
    from: BoardColumnSchema,
    to: BoardColumnSchema,
  }),
  z.object({
    type: z.literal('session.status'),
    ...sessionBase,
    from: SessionStatusSchema,
    to: SessionStatusSchema,
    workflow_state: z.string().nullable(),
  }),
  z.object({
    type: z.literal('input.requested'),
    ...sessionBase,
    input_request_id: UuidSchema,
    kind: InputRequestKindSchema,
    question: z.string(),
    created_at: IsoDateTimeSchema,
  }),
  z.object({
    type: z.literal('input.answered'),
    ...sessionBase,
    input_request_id: UuidSchema,
    answered_by: z.string().nullable(),
  }),
  /** A badge toggled on a card (e.g. waiting_for_build_slot). Written by the gateway (T11). */
  z.object({
    type: z.literal('card.badge'),
    ...sessionBase,
    badge: CardBadgeSchema,
    on: z.boolean(),
  }),
]);
export type BoardSseEvent = z.infer<typeof BoardSseEventSchema>;
export type BoardSseEventType = BoardSseEvent['type'];
export const BOARD_SSE_EVENT_TYPES = BoardSseEventSchema.options.map((o) => o.shape.type.value);

const BOARD_TYPE_SET = new Set<string>(BOARD_SSE_EVENT_TYPES);

/** The event-row columns a board event maps to/from (structurally matches db `EventRow`). */
export interface BoardEventRowLike {
  /** bigserial; node-postgres returns it as a string. */
  id: string | number;
  session_id: string | null;
  type: string;
  payload: unknown;
  ts: Date | string;
}

/** What a writer INSERTs into `event` for a board event (id and ts come from the DB). */
export interface BoardEventRowInsert {
  type: BoardSseEventType;
  session_id: string | null;
  payload: z.infer<typeof JsonObjectSchema>;
}

/** Distributes over the union: drops the row-owned keys from each variant. */
type WithoutRowKeys<E> = E extends BoardSseEvent ? Omit<E, 'id' | 'ts'> : never;
export type BoardSseEventDraft = WithoutRowKeys<BoardSseEvent>;

/**
 * Build the `event` row for a board event before INSERT. Pair with `RETURNING id, ts` and
 * `boardSseEventFromRow` to get the publishable event.
 */
export function boardSseEventToRow(draft: BoardSseEventDraft): BoardEventRowInsert {
  const { type, session_id, ...payload } = draft;
  return { type, session_id, payload: JsonObjectSchema.parse(payload) };
}

/**
 * Decode one `event` row into the SSE event it backs. Returns null for rows that are not board
 * events (engine events, `state.entered`, …). Throws (ZodError) on a board-typed row whose
 * payload does not match: that is a writer bug, not data to skip.
 */
export function boardSseEventFromRow(row: BoardEventRowLike): BoardSseEvent | null {
  if (!BOARD_TYPE_SET.has(row.type)) return null;
  const ts = row.ts instanceof Date ? row.ts.toISOString() : row.ts;
  const payload = typeof row.payload === 'object' && row.payload !== null ? row.payload : {};
  return BoardSseEventSchema.parse({
    ...payload,
    type: row.type,
    id: Number(row.id),
    ts,
    session_id: row.session_id,
  });
}

/** Encode one SSE frame. */
export function encodeSseFrame(event: string, data: unknown, id?: number): string {
  const idLine = id === undefined ? '' : `id: ${id}\n`;
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
