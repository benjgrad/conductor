import {
  holdersOf,
  sessionPlannedFiles,
  STEP_CONTEXT_KEY,
  stepOfContext,
  type Concurrency,
  type EngineEvent,
  type HolderCandidate,
  type SessionSnapshot,
} from '@conductor/shared';
import type { Queryable } from '../contracts.js';

// ADR-0037 P4 (T7): the wrapper side of `requires.concurrency`. apply keeps a held move step's
// `state_deadline` armed ("check me"); the EngineService wrapper answers that timer, in its own
// transaction, with `concurrency.checked {holders}` computed here. A per-repo advisory lock
// serialises the checks, so two held tickets are never released by racing transactions. Release
// is quick because any same-repo session leaving a state brings the held ones' deadline to now
// (`nudgeSameRepoHolds`); the sweep then fires within a second.

/** The advisory-lock key for one account's repo (`pg_advisory_xact_lock(hashtext(…))`). */
export function holdLockKey(accountId: string, repo: string): string {
  return `concurrency:${accountId}:${repo}`;
}

/**
 * The held move's holders: the account's other live sessions on the ticket's repo that are in
 * flight on the same key ahead of it (`holdersOf`), oldest first.
 */
export async function readHolders(
  tx: Queryable,
  p: {
    accountId: string;
    repo: string;
    self: SessionSnapshot;
    conc: Concurrency;
  },
): Promise<{ session_id: string; ticket_id: string }[]> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [holdLockKey(p.accountId, p.repo)]);
  const rows = await tx.query<{
    id: string;
    ticket_id: string;
    kind: string | null;
    workflow_state: string | null;
    context: Record<string, Record<string, unknown>>;
    return_to: string | null;
  }>(
    `SELECT s.id, s.ticket_id, t.kind, s.workflow_state, s.context, s.return_to
       FROM session s JOIN ticket t ON t.id = s.ticket_id
      WHERE t.account_id = $1 AND t.repo = $2 AND s.id <> $3
        AND s.status NOT IN ('done', 'failed', 'lost')`,
    [p.accountId, p.repo, p.self.id],
  );
  const candidates: HolderCandidate[] = rows.rows.map((r) => ({
    session_id: r.id,
    ticket_id: r.ticket_id,
    kind: r.kind,
    workflow_state: r.workflow_state,
    step: stepOfContext(r.context),
    files: sessionPlannedFiles(r.context, r.return_to),
  }));
  const holders = holdersOf(
    {
      session_id: p.self.id,
      kind: p.self.ticket.kind ?? null,
      files: sessionPlannedFiles(p.self.context, p.self.return_to),
      started_at: p.self.step?.started_at ?? null,
    },
    p.conc,
    candidates,
  );
  return holders.slice(0, 50).map((h) => ({ session_id: h.session_id, ticket_id: h.ticket_id }));
}

/**
 * The event apply sees for a held step's timer: `concurrency.checked` with the holders (same
 * `state` and `deadline`, so apply's staleness check is the timer's). Any other event: unchanged.
 */
export async function withHolders(
  tx: Queryable,
  event: EngineEvent,
  p: { accountId: string; repo: string; before: SessionSnapshot; conc: Concurrency | undefined },
): Promise<EngineEvent> {
  if (event.type !== 'timer.fired' || p.before.step?.phase !== 'held' || p.conc === undefined) {
    return event;
  }
  const holders = await readHolders(tx, {
    accountId: p.accountId,
    repo: p.repo,
    self: p.before,
    conc: p.conc,
  });
  return { type: 'concurrency.checked', state: event.state, deadline: event.deadline, holders };
}

/**
 * Did this applied event move a session out of a state (or end it), so a held ticket on the same
 * repo may now go? Leaving a real state (not a gate step's label) or becoming terminal.
 */
export function releasesHolds(before: SessionSnapshot, after: SessionSnapshot): boolean {
  const terminal = (s: string) => s === 'done' || s === 'failed' || s === 'lost';
  if (!terminal(before.status) && terminal(after.status)) return true;
  return before.step === null && before.workflow_state !== after.workflow_state;
}

/**
 * Re-check every held move of the account on `repo` (but this session) at the next sweep tick:
 * their `state_deadline` comes forward to now. Returns how many were nudged.
 */
export async function nudgeSameRepoHolds(
  tx: Queryable,
  p: { accountId: string; repo: string; exceptSessionId: string; now: Date },
): Promise<number> {
  const r = await tx.query(
    `UPDATE session s SET state_deadline = $4
       FROM ticket t
      WHERE s.ticket_id = t.id AND t.account_id = $1 AND t.repo = $2 AND s.id <> $3
        AND s.status = 'waiting_external'
        AND s.context -> $5 ->> 'phase' = 'held'
        AND s.state_deadline IS NOT NULL AND s.state_deadline > $4`,
    [p.accountId, p.repo, p.exceptSessionId, p.now, STEP_CONTEXT_KEY],
  );
  return r.rowCount ?? 0;
}
