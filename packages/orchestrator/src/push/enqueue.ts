import type { Queryable } from '../contracts.js';
import {
  needsInputPayload,
  permissionPayload,
  permissionTag,
  transitionTag,
  type PushNotification,
} from './payload.js';

// UX-15 FR-4: in the transaction that creates an input_request, one `push_needs_input` outbox row
// per user of the account with a subscription. target `user:<id>`, idempotency_key = the input
// request id (outbox_push_idem_idx: enqueueing the same request twice adds nothing). The
// notification is rendered here, from the same transaction's data, so the push dispatcher needs
// no joins. No fencing token: a push isn't fenced.
// A transition with `notify: true` enqueues `push_transition` rows the same way, keyed by its
// `state.entered` event id (`transition:<id>`). UXR-32: a pending permission request (the gateway,
// ADR-0023) enqueues `push_needs_input` rows keyed `permission:<request id>`.
// ADR-0037 P6: under a workflow `notify` policy the wrapper enqueues one row per positive decision
// instead (a request's question, else the transition), keyed `notify:<ticket>:<state>:<bucket>`
// when the policy has a `coalesce` window. Permission prompts are outside the policy.

/**
 * The outbox payload of a push row (`push_needs_input`, `push_transition`). `delivered`:
 * subscription ids already sent. `input_request_id` (a question) or `permission_request_id` (a
 * permission prompt, UXR-32) only on `push_needs_input`; `event_id` (the `state.entered` row) only
 * on `push_transition`.
 */
export interface PushOutboxPayload {
  ticket_id: string;
  input_request_id?: string;
  permission_request_id?: string;
  event_id?: number;
  notification: PushNotification | null;
  delivered: string[];
}

type PushKind = 'push_needs_input' | 'push_transition';

/** One row per subscribed user of the account (minus `excludeUserId`); returns how many. */
async function enqueuePush(
  tx: Queryable,
  p: {
    kind: PushKind;
    accountId: string;
    sessionId: string;
    payload: PushOutboxPayload;
    idempotencyKey: string;
    now: Date;
    excludeUserId?: string | null;
  },
): Promise<number> {
  const r = await tx.query(
    `INSERT INTO outbox (command_id, account_id, target, kind, session_id, payload,
       idempotency_key, next_attempt_at, created_at)
     SELECT gen_random_uuid(), $1, 'user:' || u.user_id, $7::outbox_kind, $2, $3::jsonb, $4, $5, $5
       FROM (SELECT DISTINCT user_id FROM push_subscription
              WHERE account_id = $1 AND ($6::text IS NULL OR user_id::text <> $6)) u
     ON CONFLICT (target, idempotency_key) WHERE target LIKE 'user:%' DO NOTHING`,
    [
      p.accountId,
      p.sessionId,
      JSON.stringify(p.payload),
      p.idempotencyKey,
      p.now,
      p.excludeUserId ?? null,
      p.kind,
    ],
  );
  return r.rowCount ?? 0;
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
    /** ADR-0037 P6 `coalesce`: the bucketed key (`notifyBucketKey`); default the request id. */
    idempotencyKey?: string | undefined;
  },
): Promise<number> {
  return enqueuePush(tx, {
    kind: 'push_needs_input',
    accountId: p.accountId,
    sessionId: p.sessionId,
    payload: {
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
    },
    idempotencyKey: p.idempotencyKey ?? p.inputRequestId,
    now: p.now,
  });
}

/**
 * UXR-32: a permission request the agent waits on. Same kind and fan-out as a question; keyed
 * `permission:<request id>`, so a request seen twice enqueues once. Returns how many rows.
 */
export async function enqueuePermissionPush(
  tx: Queryable,
  p: {
    accountId: string;
    sessionId: string;
    ticketId: string;
    ticketTitle: string;
    agent: string | null;
    permissionRequestId: string;
    tool: string;
    summary: string;
    now: Date;
  },
): Promise<number> {
  return enqueuePush(tx, {
    kind: 'push_needs_input',
    accountId: p.accountId,
    sessionId: p.sessionId,
    payload: {
      ticket_id: p.ticketId,
      permission_request_id: p.permissionRequestId,
      notification: permissionPayload({
        ticketId: p.ticketId,
        ticketTitle: p.ticketTitle,
        agent: p.agent,
        tool: p.tool,
        summary: p.summary,
        requestId: p.permissionRequestId,
      }),
      delivered: [],
    },
    idempotencyKey: permissionTag(p.permissionRequestId),
    now: p.now,
  });
}

/**
 * A transition with `notify: true` (`state_entered.notify`): one `push_transition` row per
 * subscribed user of the account, except `excludeUserId` (the human who took it: their own move
 * never notifies them). Returns how many rows it wrote.
 */
export async function enqueueTransitionPush(
  tx: Queryable,
  p: {
    accountId: string;
    sessionId: string;
    ticketId: string;
    eventId: number;
    notification: PushNotification;
    now: Date;
    excludeUserId?: string | null;
    /** ADR-0037 P6 `coalesce`: the bucketed key (`notifyBucketKey`); default `transition:<id>`. */
    idempotencyKey?: string | undefined;
  },
): Promise<number> {
  return enqueuePush(tx, {
    kind: 'push_transition',
    accountId: p.accountId,
    sessionId: p.sessionId,
    payload: {
      ticket_id: p.ticketId,
      event_id: p.eventId,
      notification: p.notification,
      delivered: [],
    },
    idempotencyKey: p.idempotencyKey ?? transitionTag(p.eventId),
    now: p.now,
    excludeUserId: p.excludeUserId ?? null,
  });
}

/**
 * ADR-0037 P1 (T6): a watch's escalation (`watch.escalated`). Same kind and fan-out as a
 * transition notification; keyed by its per-stay tag, so it is sent once per stay.
 */
export async function enqueueWatchEscalatePush(
  tx: Queryable,
  p: {
    accountId: string;
    sessionId: string;
    ticketId: string;
    notification: PushNotification;
    idempotencyKey: string;
    now: Date;
  },
): Promise<number> {
  return enqueuePush(tx, {
    kind: 'push_transition',
    accountId: p.accountId,
    sessionId: p.sessionId,
    payload: { ticket_id: p.ticketId, notification: p.notification, delivered: [] },
    idempotencyKey: p.idempotencyKey,
    now: p.now,
  });
}

/**
 * ADR-0041: a default answer conductor took (`question.default_taken`). Same kind and fan-out as
 * a transition notification; keyed by its per-request tag, so it is sent once.
 */
export async function enqueueDefaultTakenPush(
  tx: Queryable,
  p: {
    accountId: string;
    sessionId: string;
    ticketId: string;
    notification: PushNotification;
    idempotencyKey: string;
    now: Date;
  },
): Promise<number> {
  return enqueuePush(tx, {
    kind: 'push_transition',
    accountId: p.accountId,
    sessionId: p.sessionId,
    payload: { ticket_id: p.ticketId, notification: p.notification, delivered: [] },
    idempotencyKey: p.idempotencyKey,
    now: p.now,
  });
}
