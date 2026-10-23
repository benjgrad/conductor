import { z } from 'zod';

// Domain enums shared by the engine, the WS protocol, the REST/SSE API and the DB row types.
// Source of truth: docs/design/02-data-model.md (column enums) and 10-contracts.md.

/** `session.status` (02). `waiting_for_build_slot` is a card badge, NOT a status (10-contracts). */
export const SessionStatusSchema = z.enum([
  'queued',
  'assigned',
  'running',
  'needs_input',
  'waiting_external',
  'done',
  'failed',
  'lost',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/** `ticket.status` (02). */
export const TicketStatusSchema = z.enum([
  'ready',
  'claimed',
  'in_progress',
  'done',
  'failed',
  'cancelled',
]);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

/** `machine.status` (02). */
export const MachineStatusSchema = z.enum(['online', 'draining', 'offline']);
export type MachineStatus = z.infer<typeof MachineStatusSchema>;

/** `input_request.kind` (02, 06). */
export const InputRequestKindSchema = z.enum([
  'agent_question',
  'budget_exceeded',
  'retries_exhausted',
  'timeout',
  'approval',
]);
export type InputRequestKind = z.infer<typeof InputRequestKindSchema>;

/** `outbox.kind` (02). Each has exactly one Effect (engine/types.ts); see 10-contracts. */
export const OutboxKindSchema = z.enum([
  'start_session',
  'send_input',
  'send_message',
  'run_cmd',
  'kill',
  'connector_call',
]);
export type OutboxKind = z.infer<typeof OutboxKindSchema>;

/** `outbox.status` (02). */
export const OutboxStatusSchema = z.enum(['pending', 'sent', 'acked', 'failed']);
export type OutboxStatus = z.infer<typeof OutboxStatusSchema>;

/**
 * Terminal output streams. The first five are ADR-0005 `DriverEvent.output.stream`;
 * `stdout` is a command state's output (stderr is shared). `user` is a message a human sent to
 * the running agent (POST /api/sessions/:id/messages, ADR-0007); the orchestrator appends it,
 * because Claude does not echo user messages on its output stream.
 */
export const OutputStreamSchema = z.enum([
  'assistant',
  'tool_use',
  'tool_result',
  'stderr',
  'debug',
  'stdout',
  'user',
]);
export type OutputStream = z.infer<typeof OutputStreamSchema>;

/** Kanban columns (06). Queries over `session.status`, never stored. */
export const BoardColumnSchema = z.enum([
  'queued',
  'running',
  'needs_input',
  'waiting_external',
  'done',
  'failed',
]);
export type BoardColumn = z.infer<typeof BoardColumnSchema>;

/** Card badges: transient flags on a card that are not statuses. */
export const CardBadgeSchema = z.enum(['waiting_for_build_slot']);
export type CardBadge = z.infer<typeof CardBadgeSchema>;

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export const UuidSchema = z.uuid();

/** Arbitrary JSON object (state results, context, connector args). */
export const JsonObjectSchema = z.record(z.string(), z.json());
export type JsonObject = z.infer<typeof JsonObjectSchema>;

/** Tail of command output kept for `attach: output` and `cmd_exit.output_tail` (10-contracts). */
export const OUTPUT_TAIL_BYTES = 16 * 1024;

/** Per-session terminal output ring buffer in the orchestrator (U-005, 10-contracts). */
export const OUTPUT_RING_BYTES = 256 * 1024;

/**
 * The per-session git branch, set by the claim (T11) when it INSERTs the session row and sent to
 * the daemon in WS `start_session.branch` (04, 10-contracts). `<session-short>` is the first 8
 * characters of the session uuid.
 */
export function sessionBranch(ticketId: string, sessionId: string): string {
  return `conductor/${ticketId}/${sessionId.slice(0, 8)}`;
}
