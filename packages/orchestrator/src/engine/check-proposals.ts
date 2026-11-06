import { repoChecksKey, type ProposedChecks } from '@conductor/shared';
import type { Queryable } from '../contracts.js';
import { createProposal } from '../advisor/proposals.js';

// An agent's proposed repo checks (ask_user `proposed_checks`, 05 §Requirements to enter a column,
// "Setup failures"). The agent may only propose: the change is stored as a `repo_checks` change
// proposal for the ticket's repo, linked to the ticket and the question it came with, and nothing
// changes until a human applies it (apply_change / the board). Applying it answers that question
// (check-config.ts), so the agent finishes again and the gate re-runs with the new checks.

/** `created_by` of an agent's proposal. */
export const agentProposer = (ticketId: string): string => `agent:${ticketId.slice(0, 8)}`;

/**
 * Store the proposal in the wrapper's transaction. A refusal (invalid checks, too many open, no
 * change) is appended to the open question instead, so the human sees why there is nothing to
 * apply. Returns the question as it now reads.
 */
export async function storeProposedChecks(
  tx: Queryable,
  p: {
    accountId: string;
    ticketId: string;
    repo: string;
    inputRequestId: string;
    question: string;
    proposed: ProposedChecks;
  },
): Promise<string> {
  const evidence = p.question.replace(/\s+/g, ' ').trim();
  const res = await createProposal(
    tx,
    { accountId: p.accountId, by: agentProposer(p.ticketId), mayEditWorkflows: false },
    {
      title: p.proposed.title,
      rationale: p.proposed.rationale,
      evidence: [{ text: evidence.length <= 300 ? evidence : evidence.slice(0, 299) + '…' }],
      expected_effect: {
        metric: 'check_failure_rate',
        scope: { repo: repoChecksKey(p.repo) },
        direction: 'down',
        text: "The ticket's checks can run again.",
      },
      rollback: `set_repo_checks back to the previous checks for ${repoChecksKey(p.repo)}.`,
      change: { kind: 'repo_checks', repo: p.repo, checks: p.proposed.checks },
    },
    { ticketId: p.ticketId, inputRequestId: p.inputRequestId },
  );
  if (res.ok) return p.question;
  const question = `${p.question}\n\n(Conductor could not store the proposed checks: ${res.message})`;
  await tx.query('UPDATE input_request SET question = $2 WHERE id = $1', [
    p.inputRequestId,
    question,
  ]);
  return question;
}
