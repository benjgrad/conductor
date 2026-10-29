import type { Queryable } from '../contracts.js';
import { needsInputPayload } from './payload.js';

// UX-15 FR-4: in the transaction that creates an input_request, one `push_needs_input` outbox row
// per user of the account with a subscription. target `user:<id>`, idempotency_key = the input
// request id (outbox_push_idem_idx: enqueueing the same request twice adds nothing). The
// notification is rendered here, from the same transaction's data, so the push dispatcher needs
// no joins. No fencing token: a push isn't fenced.

/** The outbox payload of a push_needs_input row. `delivered`: subscription ids already sent. */
export interface PushOutboxPayload {
  ticket_id: string;
  input_request_id: string;
  notification: ReturnType<typeof needsInputPayload> | null;
  delivered: string[];
}

/** Returns how many rows it wrote (0 when nobody in the account subscribed). */
export async function enqueueNeedsInputPush(
  tx: Queryable,
  p: {
    accountId: string;
    sessionId: string;
    ticketId: string;
    ticketTitle: string;
    agent: string | null;
    inputRequestId: string;
    question: string;
    now: Date;
  },
): Promise<number> {
  const payload: PushOutboxPayload = {
    ticket_id: p.ticketId,
    input_request_id: p.inputRequestId,
    notification: needsInputPayload({
      ticketId: p.ticketId,
      ticketTitle: p.ticketTitle,
      agent: p.agent,
      question: p.question,
      inputRequestId: p.inputRequestId,
    }),
    delivered: [],
  };
  const r = await tx.query(
    `INSERT INTO outbox (command_id, account_id, target, kind, session_id, payload,
       idempotency_key, next_attempt_at, created_at)
     SELECT gen_random_uuid(), $1, 'user:' || u.user_id, 'push_needs_input', $2, $3::jsonb, $4, $5, $5
       FROM (SELECT DISTINCT user_id FROM push_subscription WHERE account_id = $1) u
     ON CONFLICT (target, idempotency_key) WHERE target LIKE 'user:%' DO NOTHING`,
    [p.accountId, p.sessionId, JSON.stringify(payload), p.inputRequestId, p.now],
  );
  return r.rowCount ?? 0;
}
