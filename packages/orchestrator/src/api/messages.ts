import { ATTACHMENTS_ONLY_TEXT, type ChunkVia, type EngineEvent } from '@conductor/shared';
import type {
  ApplyEventOptions,
  ApplyEventResult,
  BoardBus,
  EngineService,
  OutputBus,
} from '../contracts.js';
import { withTransaction } from '../db/index.js';
import type { Db } from '../main.js';
import { chatEchoText, linkChatAttachments, unlinkChatAttachments } from './attachments.js';

/** What the message paths need; `db` and `boardBus` only when the human attached files. */
export interface MessageDeps {
  engine: EngineService;
  outputBus: OutputBus;
  db?: Db;
  boardBus?: BoardBus;
  /** How the message arrived, marked on its `user` chunk (OutputChunk.via); absent: the board. */
  via?: ChunkVia;
}

/** 06 §Attachments (chat): the uploads a message or answer carries, from the human's account. */
export interface ChatAttachments {
  accountId: string;
  ids: readonly string[];
}

/**
 * 06 §Attachments (chat): link the uploads to the session's ticket and apply `event` (with their
 * ids) in one transaction; a refused apply unlinks them again, so the human can resend. Throws
 * AttachmentLinkError (unknown, already linked, over the ticket's limits). Without uploads, a
 * plain apply. Returns the result and the linked files' names (for the chat bubble).
 */
async function applyWithAttachments(
  deps: MessageDeps,
  sessionId: string,
  event: Extract<EngineEvent, { type: 'operator.message' | 'input.provided' }>,
  attach: ChatAttachments | undefined,
  opts: ApplyEventOptions,
): Promise<{ result: ApplyEventResult; names: string[] }> {
  if (!attach || attach.ids.length === 0) {
    return { result: await deps.engine.applyEvent(sessionId, event, opts), names: [] };
  }
  const { db, boardBus } = deps;
  if (!db || !boardBus) throw new Error('chat attachments need db and boardBus');
  const out = await withTransaction(db, async (tx) => {
    const s = await tx.query<{ ticket_id: string; workflow_state: string | null }>(
      'SELECT s.ticket_id, s.workflow_state FROM session s JOIN ticket t ON t.id = s.ticket_id ' +
        'WHERE s.id = $1 AND t.account_id = $2 FOR UPDATE OF s',
      [sessionId, attach.accountId],
    );
    const session = s.rows[0];
    // Unknown here: let the apply answer as it does without files (404).
    if (!session) {
      return { result: await deps.engine.applyEvent(sessionId, event, { ...opts, tx }), names: [] };
    }
    const rows = await linkChatAttachments(tx, {
      accountId: attach.accountId,
      ticketId: session.ticket_id,
      sessionId,
      workflowState: session.workflow_state,
      ids: attach.ids,
    });
    const ids = rows.map((r) => r.id);
    const result = await deps.engine.applyEvent(
      sessionId,
      { ...event, attachment_ids: ids },
      { ...opts, tx },
    );
    if (result.status !== 'applied') await unlinkChatAttachments(tx, ids);
    return { result, names: result.status === 'applied' ? rows.map((r) => r.name) : [] };
  });
  // The wrapper didn't own the transaction: its board events are ours to publish.
  if (out.result.status === 'applied') {
    for (const ev of out.result.boardEvents) boardBus.publish(ev);
  }
  return out;
}

/**
 * ADR-0007: a message to the running agent, for POST /api/sessions/:id/messages and MCP's
 * message_agent (ADR-0031). `operator.message` → one send_message command; once the apply has
 * committed, the text is appended to the output ring as a `user` chunk (Claude does not echo
 * user messages, so this is how the board shows what the human said). 06 §Attachments (chat):
 * with `attach`, the files go with it (`applyWithAttachments`) and the chunk names them.
 */
export async function sendOperatorMessage(
  deps: MessageDeps,
  sessionId: string,
  text: string,
  attach?: ChatAttachments,
): Promise<ApplyEventResult> {
  const sent = text === '' ? ATTACHMENTS_ONLY_TEXT : text;
  const { result, names } = await applyWithAttachments(
    deps,
    sessionId,
    { type: 'operator.message', text: sent },
    attach,
    {},
  );
  if (result.status === 'applied') {
    deps.outputBus.append(sessionId, 'user', chatEchoText(text, names), undefined, deps.via);
  }
  return result;
}

/**
 * A human's answer to an open input request (POST /api/sessions/:id/input, MCP answer_input and
 * message_agent `as_answer`): `input.provided`, then, once the apply has committed, the answer as
 * a `user` chunk, as for a live message. Neither path to the agent (send_input or a resume with the
 * answer as its prompt) echoes it, so without this the answer never shows in the Messages thread.
 * 06 §Attachments (chat): with `attach`, as `sendOperatorMessage`.
 */
export async function provideAnswer(
  deps: MessageDeps,
  sessionId: string,
  event: Extract<EngineEvent, { type: 'input.provided' }>,
  opts: ApplyEventOptions = {},
  attach?: ChatAttachments,
): Promise<ApplyEventResult> {
  const withFiles = attach !== undefined && attach.ids.length > 0;
  const answer = event.answer === '' && withFiles ? ATTACHMENTS_ONLY_TEXT : event.answer;
  const { result, names } = await applyWithAttachments(
    deps,
    sessionId,
    { ...event, answer },
    attach,
    opts,
  );
  if (result.status === 'applied') {
    const echo = chatEchoText(event.answer, names);
    if (echo.trim() !== '') deps.outputBus.append(sessionId, 'user', echo, undefined, deps.via);
  }
  return result;
}

/**
 * ADR-0041: a human overrules the answer conductor gave on their behalf (POST
 * /api/sessions/:id/overrule): `human.overrule`, then, once applied, the text as a `user` chunk,
 * as for a live message.
 */
export async function overruleDefault(
  deps: { engine: EngineService; outputBus: OutputBus },
  sessionId: string,
  event: Extract<EngineEvent, { type: 'human.overrule' }>,
): Promise<ApplyEventResult> {
  const result = await deps.engine.applyEvent(sessionId, event, { actor: event.actor });
  if (result.status === 'applied') deps.outputBus.append(sessionId, 'user', event.text);
  return result;
}
