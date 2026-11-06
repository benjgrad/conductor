import { repoChecksKey } from '@conductor/shared';
import type { EngineService, Queryable } from '../contracts.js';

// What a change to a repo's checks does to the tickets waiting on them (05 §Requirements to enter a
// column, "Setup failures"). Called after the change is committed, by every path that changes
// them: REST PUT/DELETE /api/repo-checks, MCP set_repo_checks / clear_repo_checks, and applying a
// `repo_checks` change proposal (REST and MCP apply_change).
//   (a) An agent's proposal that was applied answers the question it was proposed with, so the
//       agent finishes again and its gate re-runs with the new checks.
//   (b) Every session of the account waiting on a `check_config` request for that repo gets
//       `gate.retry`: its gate runs again with the new checks. A retry that fails again lands back
//       on the human with the same message (uncounted), so this is bounded by people.

export interface AfterRepoChecksDeps {
  db: Queryable;
  engine: EngineService;
}

/** The actor of the automatic retries and answers. */
const BY = 'conductor';

/** The answer an agent gets when its proposed checks were applied. */
export function appliedAnswer(title: string, by: string | null): string {
  return (
    `${by ?? 'A human'} applied your proposed repo checks ("${title}"). ` +
    'Finish this step again: the checks will re-run with them.'
  );
}

export async function afterRepoChecksChanged(
  deps: AfterRepoChecksDeps,
  accountId: string,
  repo: string,
  applied: { proposalId: string; by: string | null } | null = null,
): Promise<{ answered: number; retried: number }> {
  let answered = 0;
  if (applied !== null) {
    const p = await deps.db.query<{ title: string; session_id: string; request_id: string }>(
      'SELECT p.title, r.session_id, r.id AS request_id FROM change_proposal p ' +
        'JOIN input_request r ON r.id = p.input_request_id ' +
        'WHERE p.id = $1 AND p.account_id = $2 AND r.answer IS NULL',
      [applied.proposalId, accountId],
    );
    for (const row of p.rows) {
      const res = await deps.engine.applyEvent(
        row.session_id,
        {
          type: 'input.provided',
          input_request_id: row.request_id,
          answer: appliedAnswer(row.title, applied.by),
        },
        { actor: applied.by ?? BY },
      );
      if (res.status === 'applied') answered++;
    }
  }
  const waiting = await deps.db.query<{ session_id: string; repo: string }>(
    'SELECT r.session_id, t.repo FROM input_request r ' +
      'JOIN session s ON s.id = r.session_id JOIN ticket t ON t.id = s.ticket_id ' +
      "WHERE r.kind = 'check_config' AND r.answer IS NULL AND s.status = 'needs_input' " +
      'AND t.account_id = $1',
    [accountId],
  );
  const key = repoChecksKey(repo);
  let retried = 0;
  for (const row of waiting.rows) {
    if (repoChecksKey(row.repo) !== key) continue;
    const res = await deps.engine.applyEvent(
      row.session_id,
      { type: 'gate.retry', actor: BY },
      { actor: BY },
    );
    if (res.status === 'applied') retried++;
  }
  return { answered, retried };
}

/** afterRepoChecksChanged, never throwing: the change itself already succeeded. */
export async function afterRepoChecksChangedSafe(
  deps: AfterRepoChecksDeps | null,
  accountId: string,
  repo: string,
  applied: { proposalId: string; by: string | null } | null = null,
): Promise<void> {
  if (deps === null) return;
  try {
    await afterRepoChecksChanged(deps, accountId, repo, applied);
  } catch (err) {
    process.stderr.write(
      `[conductor] retrying the checks after a repo-checks change failed: ${String(err)}\n`,
    );
  }
}
