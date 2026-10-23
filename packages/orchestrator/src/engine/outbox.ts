// U-039 (M1-T07): a start_session prompt can carry the `attach: output` command tail (up to
// 16 KB of raw build/test output). It is needed in `outbox.payload` only until the daemon has
// the command, so when a start_session row becomes terminal (`acked`, or `failed`: it is never
// sent again, and a requeue re-renders its prompt from the session, not from the old row) its
// `payload.prompt` is set to JSON null. Every other payload field is kept.
//
// ADR-0007: a send_message row's `payload.text` (a human's message, up to 20 000 chars) is
// scrubbed the same way. The message is kept once, in its `operator.message` event row (the
// audit record); the outbox copy is only transport.

/**
 * SQL expression for `SET payload = …` in the guarded UPDATE that makes an outbox row terminal
 * (the gateway's command_ack, the dispatcher's stale / ack-timeout failures): the payload with
 * `prompt` nulled for a start_session row, `text` nulled for a send_message row, unchanged for
 * every other kind.
 */
export const SCRUBBED_PAYLOAD_SQL =
  "CASE WHEN kind = 'start_session' THEN jsonb_set(payload, '{prompt}', 'null'::jsonb) " +
  "WHEN kind = 'send_message' THEN jsonb_set(payload, '{text}', 'null'::jsonb) " +
  'ELSE payload END';
