// UX-15 FR-5: what a push notification carries. Nothing beyond the ticket title, the agent name
// and the question clipped to 120 characters: no repo, branch, machine, answer, or secret. The
// push service only sees ciphertext, but the notification shows on a lock screen.

export const PUSH_QUESTION_MAX = 120;

/** The JSON the service worker (UX-16) receives. `tag` collapses duplicates of one request. */
export interface PushNotification {
  title: string;
  body: string;
  /** The board, opened on the ticket. */
  url: string;
  tag: string;
}

/** `text` cut to `max` code points (not UTF-16 units), with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  const points = [...text.replace(/\s+/g, ' ').trim()];
  return points.length <= max ? points.join('') : `${points.slice(0, max - 1).join('')}…`;
}

/**
 * "needs input": the ticket title, then `<agent>: <question>`. The agent name is the workflow
 * state that asked (the request's `return_to`, e.g. `planning`, else the session's state): the
 * schema has no other agent name.
 */
export function needsInputPayload(p: {
  ticketId: string;
  ticketTitle: string;
  agent: string | null;
  question: string;
  inputRequestId: string;
}): PushNotification {
  const question = clip(p.question, PUSH_QUESTION_MAX);
  return {
    title: clip(p.ticketTitle, PUSH_QUESTION_MAX),
    body: p.agent ? `${p.agent}: ${question}` : question,
    url: `/#/?ticket=${p.ticketId}`,
    tag: p.inputRequestId,
  };
}

/** The `tag` (and outbox idempotency key) of a permission prompt's notification (UXR-32). */
export function permissionTag(requestId: string): string {
  return `permission:${requestId}`;
}

/**
 * UXR-32: an agent is held on a tool permission (ADR-0023). The ticket title, then
 * `<agent>: wants to run <tool>: <summary>` clipped to 120. The summary is what the board card
 * shows (`permissionSummary`: a command, a path, a URL); nothing else of the tool input.
 */
export function permissionPayload(p: {
  ticketId: string;
  ticketTitle: string;
  agent: string | null;
  tool: string;
  summary: string;
  requestId: string;
}): PushNotification {
  const what = `wants to run ${p.tool}: ${p.summary}`;
  return {
    title: clip(p.ticketTitle, PUSH_QUESTION_MAX),
    body: clip(p.agent ? `${p.agent}: ${what}` : what, PUSH_QUESTION_MAX),
    url: `/#/?ticket=${p.ticketId}`,
    tag: permissionTag(p.requestId),
  };
}

/**
 * A transition with `notify: true` was taken: the ticket title, then
 * `<transition title>: <from column> → <to column>`. The same text is the in-tab notification
 * (`transition.notified`). No reason text: an agent's or human's reason may carry anything.
 */
export function transitionPayload(p: {
  ticketId: string;
  ticketTitle: string;
  transitionTitle: string;
  fromTitle: string;
  toTitle: string;
  /** The `state.entered` event id: the notification's `tag`. */
  eventId: number;
}): PushNotification {
  return {
    title: clip(p.ticketTitle, PUSH_QUESTION_MAX),
    body: clip(`${p.transitionTitle}: ${p.fromTitle} → ${p.toTitle}`, PUSH_QUESTION_MAX),
    url: `/#/?ticket=${p.ticketId}`,
    tag: transitionTag(p.eventId),
  };
}

/**
 * ADR-0037 P1 (T6): a watch's `notify: escalate` (e.g. a question unanswered for 2h). One per
 * stay: the tag (and idempotency key) is `watch_escalate:<session>:<state>:<visit>`.
 */
export function watchEscalatePayload(p: {
  ticketId: string;
  ticketTitle: string;
  stateTitle: string;
  reason: string;
  tag: string;
}): PushNotification {
  return {
    title: clip(p.ticketTitle, PUSH_QUESTION_MAX),
    body: clip(`Still waiting in ${p.stateTitle}: ${p.reason}`, PUSH_QUESTION_MAX),
    url: `/#/?ticket=${p.ticketId}`,
    tag: p.tag,
  };
}

/** The `tag` of a watch escalation: once per session, state and visit (stay). */
export function watchEscalateTag(sessionId: string, state: string, visit: number): string {
  return `watch_escalate:${sessionId}:${state}:${visit}`;
}

/**
 * ADR-0041: conductor answered a question on a human's behalf. Always pushed, once per request:
 * the tag (and idempotency key) is `default_taken:<input_request_id>`.
 */
export function defaultTakenPayload(p: {
  ticketId: string;
  ticketTitle: string;
  after: string;
  answer: string;
  tag: string;
}): PushNotification {
  return {
    title: clip(p.ticketTitle, PUSH_QUESTION_MAX),
    body: clip(
      `Conductor answered for you (no reply in ${p.after}): ${p.answer}`,
      PUSH_QUESTION_MAX,
    ),
    url: `/#/?ticket=${p.ticketId}`,
    tag: p.tag,
  };
}

/** The `tag` of a default answer's notification: once per input request. */
export function defaultTakenTag(inputRequestId: string): string {
  return `default_taken:${inputRequestId}`;
}

/** The `tag` (and outbox idempotency key) of a transition notification. */
export function transitionTag(eventId: number): string {
  return `transition:${eventId}`;
}

/** POST /api/push/test. */
export function testPayload(): PushNotification {
  return { title: 'Conductor', body: 'Notifications are on', url: '/#/', tag: 'conductor-test' };
}
