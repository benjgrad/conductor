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
  /** ADR-0010: a conductor entry action (open_pr) on the session's machine. */
  'run_action',
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

/**
 * A kanban column id (06, ADR-0010): `queued` (the implicit first column) or a state name of the
 * `conductor` workflow. Derived from the session, never stored.
 */
export const BoardColumnSchema = z.string().min(1);
export type BoardColumn = z.infer<typeof BoardColumnSchema>;

/**
 * Card badges: flags on a card that are not columns (ADR-0010: status is a badge now).
 * `checking`: in an entry step (or ADR-0009 review), still in its source column. `failed` /
 * `lost` / `cancelled`: the session or ticket ended that way; the card is in the Done column.
 */
export const CardBadgeSchema = z.enum([
  'waiting_for_build_slot',
  'checking',
  'failed',
  'lost',
  'cancelled',
]);
export type CardBadge = z.infer<typeof CardBadgeSchema>;

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export const UuidSchema = z.uuid();

/** Arbitrary JSON object (state results, context, connector args). */
export const JsonObjectSchema = z.record(z.string(), z.json());
export type JsonObject = z.infer<typeof JsonObjectSchema>;

/**
 * ADR-0010 open_pr: the only PR URL shape conductor records or shows. Checked by the daemon before
 * it reports, by the engine before it stores, and by `BoardCardSchema` (anything else → null).
 */
export const GITHUB_PR_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

export function isGithubPrUrl(v: unknown): v is string {
  return typeof v === 'string' && GITHUB_PR_URL_RE.test(v);
}

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

// ---------------------------------------------------------------- accounts (M2, ADR-0012, ADR-0017)

/**
 * The `local` account (ADR-0017 §Auth: schema sketch): every pre-M2 row is backfilled into it, and
 * `local` mode runs as it. The bootstrap admin claims it (U-056).
 */
export const LOCAL_ACCOUNT_ID = '00000000-0000-0000-0000-000000000001';

/**
 * An `account.id`: any 8-4-4-4-12 hex GUID. Not UuidSchema, because LOCAL_ACCOUNT_ID's version
 * nibble is 0, which RFC 9562 `z.uuid()` refuses. Accounts created later get random v4 ids.
 */
export const AccountIdSchema = z.guid();

/** `CONDUCTOR_AUTH` (ADR-0017 §Modes): `local` = M1 (loopback, no sign-in); `password` = hosted. */
export const AuthModeSchema = z.enum(['local', 'password']);
export type AuthMode = z.infer<typeof AuthModeSchema>;

/** Who is acting inside an account: a signed-in user, an enrolled machine, or conductor itself. */
export const AccountActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), user_id: z.string().min(1) }),
  z.object({ kind: z.literal('machine'), machine_id: z.string().min(1) }),
  z.object({ kind: z.literal('system') }),
]);
export type AccountActor = z.infer<typeof AccountActorSchema>;

/**
 * ADR-0012 §Tenancy: passed to every repository function, engine call and stream subscription.
 * Every query filters on `account_id`; another account's id is `not_found`.
 */
export const AccountScopeSchema = z.object({
  account_id: AccountIdSchema,
  actor: AccountActorSchema,
});
export type AccountScope = z.infer<typeof AccountScopeSchema>;

/** The scope of `local` mode (and of pre-M2 code paths): the `local` account. */
export function localScope(actor: AccountActor): AccountScope {
  return { account_id: LOCAL_ACCOUNT_ID, actor };
}

/**
 * How a machine's sessions use a repo (ADR-0013, U-060): worktrees of a daemon `reference` clone
 * (default) or of the user's own `checkout` (opt-in per repo, with the `.git` tamper check).
 */
export const MachineRepoModeSchema = z.enum(['reference', 'checkout']);
export type MachineRepoMode = z.infer<typeof MachineRepoModeSchema>;

/** Machine alert kinds (ADR-0013): `git_tamper` = a checkout's `.git` config or hooks changed. */
export const MachineAlertKindSchema = z.enum(['git_tamper']);
export type MachineAlertKind = z.infer<typeof MachineAlertKindSchema>;
