import {
  DAEMON_FEATURE_MESSAGE_ATTACHMENTS,
  DAEMON_FEATURE_TICKET_ATTACHMENTS,
  type AttachmentRef,
  type JsonObject,
} from '@conductor/shared';
import type { Queryable } from '../contracts.js';
import type { AttachmentRow } from '../db/types.js';

// 06 §Attachments: what a `start_session` carries of the ticket's attachments. A daemon with
// DAEMON_FEATURE_TICKET_ATTACHMENTS gets `attachments` (it downloads them and lists their paths in
// the prompt); an older one gets a note appended to the prompt instead.

/** The metadata columns (never `attachment_content.data`). */
export const ATTACHMENT_META_COLUMNS =
  'a.id, a.account_id, a.ticket_id, a.session_id, a.workflow_state, a.source, a.name, ' +
  'a.mime, a.size_bytes, a.sha256, a.caption, a.created_by, a.created_at';

/** The ticket's attachments, oldest first (metadata only). */
export async function loadTicketAttachments(
  q: Queryable,
  ticketId: string,
): Promise<AttachmentRow[]> {
  const r = await q.query<AttachmentRow>(
    `SELECT ${ATTACHMENT_META_COLUMNS} FROM attachment a WHERE a.ticket_id = $1 ORDER BY a.created_at, a.id`,
    [ticketId],
  );
  return r.rows;
}

/**
 * `start_session.attachments` for the ticket (06 §Attachments): the human's only. What an agent
 * attached is evidence for the human, not instructions; the prompt says "the human attached".
 */
export async function attachmentRefs(q: Queryable, ticketId: string): Promise<AttachmentRef[]> {
  const all = await loadTicketAttachments(q, ticketId);
  return all.filter((a) => a.source === 'human').map(toRef);
}

function toRef(a: AttachmentRow): AttachmentRef {
  return {
    id: a.id,
    name: a.name,
    mime: a.mime,
    size: a.size_bytes,
    sha256: a.sha256.toString('hex'),
  };
}

/** Does the machine of `target` (`machine:<id>`) advertise `feature`? */
async function targetHasFeature(q: Queryable, target: string, feature: string): Promise<boolean> {
  const machineId = target.startsWith('machine:') ? target.slice('machine:'.length) : null;
  if (machineId === null) return false;
  const m = await q.query<{ features: string[] }>('SELECT features FROM machine WHERE id = $1', [
    machineId,
  ]);
  return m.rows[0]?.features.includes(feature) === true;
}

/**
 * For a machine without DAEMON_FEATURE_TICKET_ATTACHMENTS: the paragraph appended to the prompt
 * so the agent knows the files exist.
 */
export function attachmentsFallbackNote(refs: readonly AttachmentRef[]): string {
  const names = refs.map((r) => r.name).join(', ');
  return (
    `\n\nThis ticket has ${refs.length} attachment${refs.length === 1 ? '' : 's'} (${names}) ` +
    "that this machine's conductor daemon can't download. If you need them, call ask_user to " +
    'have them described.'
  );
}

/**
 * The `start_session` payload for `target` (`machine:<id>`) with the ticket's attachments: as
 * `attachments` when the machine advertises DAEMON_FEATURE_TICKET_ATTACHMENTS, else as a note on
 * the prompt. Unchanged when the ticket has none.
 */
export async function withStartAttachments(
  q: Queryable,
  payload: JsonObject,
  ticketId: string,
  target: string,
): Promise<JsonObject> {
  const refs = await attachmentRefs(q, ticketId);
  if (refs.length === 0) return payload;
  if (await targetHasFeature(q, target, DAEMON_FEATURE_TICKET_ATTACHMENTS)) {
    return { ...payload, attachments: refs };
  }
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  return { ...payload, prompt: prompt + attachmentsFallbackNote(refs) };
}

/**
 * 06 §Attachments (chat): for a machine without DAEMON_FEATURE_MESSAGE_ATTACHMENTS, the paragraph
 * appended to a message's text so the agent knows the files exist.
 */
export function messageAttachmentsFallbackNote(refs: readonly AttachmentRef[]): string {
  const names = refs.map((r) => r.name).join(', ');
  return (
    `\n\nThe human attached ${refs.length} file${refs.length === 1 ? '' : 's'} (${names}) to ` +
    "this message that this machine's conductor daemon can't download. If you need them, call " +
    'ask_user to have them described.'
  );
}

/**
 * 06 §Attachments (chat): the `send_message` / `send_input` payload for `target` with the files
 * sent with it (`ids`, the human's, linked to `ticketId`): as `attachments` when the machine
 * advertises DAEMON_FEATURE_MESSAGE_ATTACHMENTS, else as a note on the text.
 */
export async function withMessageAttachments(
  q: Queryable,
  payload: JsonObject,
  ticketId: string,
  ids: readonly string[],
  target: string,
): Promise<JsonObject> {
  if (ids.length === 0) return payload;
  const r = await q.query<AttachmentRow>(
    `SELECT ${ATTACHMENT_META_COLUMNS} FROM attachment a WHERE a.ticket_id = $1 ` +
      "AND a.source = 'human' AND a.id = ANY($2::uuid[]) ORDER BY a.created_at, a.id",
    [ticketId, [...ids]],
  );
  const refs = r.rows.map(toRef);
  if (refs.length === 0) return payload;
  if (await targetHasFeature(q, target, DAEMON_FEATURE_MESSAGE_ATTACHMENTS)) {
    return { ...payload, attachments: refs };
  }
  const text = typeof payload.text === 'string' ? payload.text : '';
  return { ...payload, text: text + messageAttachmentsFallbackNote(refs) };
}

/** Unlinked uploads older than this are deleted by `sweepUnlinkedAttachments`. */
export const UNLINKED_TTL_MS = 24 * 60 * 60 * 1000;
/** Delete unlinked uploads older than UNLINKED_TTL_MS. Returns how many. */
export async function sweepUnlinkedAttachments(q: Queryable, now: Date): Promise<number> {
  const r = await q.query(
    'DELETE FROM attachment WHERE ticket_id IS NULL AND session_id IS NULL AND created_at < $1',
    [new Date(now.getTime() - UNLINKED_TTL_MS)],
  );
  return r.rowCount ?? 0;
}
