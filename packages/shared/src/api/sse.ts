import { z } from 'zod';
import {
  BoardColumnSchema,
  CardBadgeSchema,
  InputRequestKindSchema,
  IsoDateTimeSchema,
  OutputStreamSchema,
  SessionStatusSchema,
  UuidSchema,
} from '../domain.js';

// Server-sent events (03 §SSE). Implemented by M1-T08, consumed by M1-T09.
//
// Wire format, board stream (GET /api/stream/board):
//   id: <event.id>\nevent: <type>\ndata: <JSON of the whole BoardSseEvent>\n\n
// `id` is the `event` table id, so Last-Event-ID replay reads `event WHERE id > $1`.
//
// Output stream (GET /api/stream/sessions/:id/output):
//   event: output\ndata: <JSON OutputChunk>\n\n   (no id: output is not replayable beyond the ring)

const base = { id: z.number().int().positive(), ts: IsoDateTimeSchema, session_id: UuidSchema };

/**
 * Board-level events. NOTE `input.answered` (SSE, for the UI) is distinct from the engine
 * event `input.provided` (EngineEvent) on purpose (10-contracts).
 */
export const BoardSseEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('card.moved'),
    ...base,
    ticket_id: UuidSchema,
    /** null = the card is new on the board. */
    from: BoardColumnSchema.nullable(),
    to: BoardColumnSchema,
  }),
  z.object({
    type: z.literal('session.status'),
    ...base,
    from: SessionStatusSchema,
    to: SessionStatusSchema,
    workflow_state: z.string().nullable(),
  }),
  z.object({
    type: z.literal('input.requested'),
    ...base,
    input_request_id: UuidSchema,
    kind: InputRequestKindSchema,
    question: z.string(),
    created_at: IsoDateTimeSchema,
  }),
  z.object({
    type: z.literal('input.answered'),
    ...base,
    input_request_id: UuidSchema,
    answered_by: z.string().nullable(),
  }),
  /** A badge toggled on a card (e.g. waiting_for_build_slot). */
  z.object({
    type: z.literal('card.badge'),
    ...base,
    badge: CardBadgeSchema,
    on: z.boolean(),
  }),
]);
export type BoardSseEvent = z.infer<typeof BoardSseEventSchema>;
export type BoardSseEventType = BoardSseEvent['type'];
export const BOARD_SSE_EVENT_TYPES = BoardSseEventSchema.options.map((o) => o.shape.type.value);

/** One chunk of terminal output, as kept in the orchestrator ring buffer and streamed. */
export const OutputChunkSchema = z.object({
  session_id: UuidSchema,
  /** Monotonic per session within the orchestrator process (resets on restart). */
  seq: z.number().int().nonnegative(),
  stream: OutputStreamSchema,
  text: z.string(),
  ts: IsoDateTimeSchema,
});
export type OutputChunk = z.infer<typeof OutputChunkSchema>;

/** Encode one SSE frame. */
export function encodeSseFrame(event: string, data: unknown, id?: number): string {
  const idLine = id === undefined ? '' : `id: ${id}\n`;
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
