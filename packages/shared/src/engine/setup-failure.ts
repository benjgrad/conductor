import type { RepoChecks } from '../workflow/repo-checks.js';
import type { RepoChecksMeta } from './types.js';

// A failed check setup (ADR-0010's fresh checkout, ADR-0030's repo checks): whose problem it is
// and what to do (05 §Requirements to enter a column, "Setup failures"). The daemon runs the same
// setup once on the base branch's tip and reports `setup_on_base`; this module turns that into the
// one message the agent, the board and get_ticket all show. Pure, so apply stays pure.

/** `context` key of a gate whose setup failed on conductor's check config (`gate.retry`). */
export const CHECK_CONFIG_KEY = '__check_config';

/**
 * The card button (BoardCard.human_transitions) and take_transition name of `gate.retry`: shown
 * while a `check_config` request is open. Not a workflow transition (`$` names never are).
 */
export const RETRY_CHECKS = '$retry_checks';

/** Where the setup that failed came from. */
export type SetupSource =
  | {
      type: 'override';
      repo: string;
      updated_at: string | null;
      updated_by: string | null;
    }
  | { type: 'workflow'; at: string }
  /** `override_without_setup`: a repo override exists but sets no setup (so it was auto-detected). */
  | { type: 'auto'; repo: string; override_without_setup: boolean };


/**
 * The source of the failed setup: the repo override when it sets a setup, else the workflow
 * gate's own `setup` (a command, or '' for none), else auto-detected from the lockfile.
 */
export function setupSource(p: {
  /** The override pinned on the gate step (null = none). */
  repoChecks: RepoChecks | null | undefined;
  meta: RepoChecksMeta | null | undefined;
  /** The definition's setup for this gate (null = auto-detect). */
  workflowSetup: string | null;
  /** Where the workflow gate is, e.g. `entry of "Review"`. */
  at: string;
  repo: string;
}): SetupSource {
  const o = p.repoChecks;
  if (o !== null && o !== undefined) {
    if (o.setup !== undefined) {
      return {
        type: 'override',
        repo: p.repo,
        updated_at: p.meta?.updated_at ?? null,
        updated_by: p.meta?.updated_by ?? null,
      };
    }
    return { type: 'auto', repo: p.repo, override_without_setup: true };
  }
  if (p.workflowSetup !== null) return { type: 'workflow', at: p.at };
  return { type: 'auto', repo: p.repo, override_without_setup: false };
}

/** The source in words, e.g. "from the repo checks override for github.com/a/b, saved … by ben". */
export function describeSource(src: SetupSource): string {
  switch (src.type) {
    case 'override': {
      const saved = [
        src.updated_at !== null ? `saved ${src.updated_at.slice(0, 16).replace('T', ' ')} UTC` : '',
        src.updated_by !== null ? `by ${src.updated_by}` : '',
      ]
        .filter((x) => x !== '')
        .join(' ');
      return `from the repo checks override for ${src.repo}${saved !== '' ? `, ${saved}` : ''}`;
    }
    case 'workflow':
      return `from the workflow's checks at ${src.at}`;
    case 'auto':
      return src.override_without_setup
        ? `auto-detected from the lockfile (the repo checks override for ${src.repo} sets no setup)`
        : 'auto-detected from the lockfile';
  }
}

/** Where the fix is made, for the plain sentence. */
function fixWhere(src: SetupSource, repo: string): string {
  return src.type === 'workflow'
    ? `Fix it in the workflow (${src.at}), or give ${repo} its own checks with set_repo_checks or on the board's repo checks`
    : `Fix it with set_repo_checks for ${repo}, or on the board's repo checks`;
}

export interface SetupFailureInput {
  /** The setup command that ran (cmd_exit `setup_cmd`); null = not reported (an older daemon). */
  cmd: string | null;
  source: SetupSource;
  repo: string;
  /** How it failed, e.g. "exit code 128". */
  how: string;
  /** The check that therefore did not run. */
  check: string;
  /** How the setup did on the base branch's tip (cmd_exit `setup_on_base`; absent = not probed). */
  onBase: 'pass' | 'fail' | 'unknown' | undefined;
  /** The base branch the probe used (absent: "the base branch"). */
  baseRef?: string | undefined;
}

/** The FR-3 paragraph: how the agent proposes a check-config fix (it never applies one). */
export const PROPOSE_CHECKS_HINT =
  "If the failure is conductor's check config rather than your branch, don't retry the gate: call `ask_user` with your question and `proposed_checks: {title, rationale, checks}` (the repo's full corrected checks: `{setup?, checks: [{name, cmd, timeout?}]}`). Ben confirms it with one click and the checks re-run; you never change the checks yourself.";

/**
 * The message: `summary` is its first line (the status line uses it); `text` is the whole
 * message without the output tail (callers add the tail where it belongs).
 */
export function setupFailureMessage(i: SetupFailureInput): {
  summary: string;
  text: string;
  /** True when the probe showed it is conductor's config (fails on the base branch too). */
  config: boolean;
} {
  const cmd = i.cmd ?? (i.source.type === 'auto' ? 'the auto-detected setup' : 'the setup');
  const shown = i.cmd !== null ? `\`${cmd}\`` : cmd;
  const summary = `Setup failed before any check ran: ${shown} (${describeSource(i.source)}).`;
  const base = i.baseRef !== undefined && i.baseRef !== '' ? `\`${i.baseRef}\`` : 'the base branch';
  const lines = [summary, `It failed (${i.how}) in a fresh checkout, so \`${i.check}\` did not run.`];
  switch (i.onBase) {
    case 'fail':
      lines.push(
        `It fails on ${base} too, so this is conductor's check config, not your branch. ${fixWhere(i.source, i.repo)}; the ticket then retries the checks (or press Retry checks).`,
      );
      break;
    case 'pass':
      lines.push(
        `It passes on ${base}, so something on this branch breaks it (for example a lockfile change): fix the branch. If the setup itself needs to change for this branch, propose new repo checks instead.`,
      );
      break;
    default:
      lines.push(
        `Conductor could not tell whether it also fails on ${base}. If it is the branch, fix the branch; if it is conductor's check config, ${fixWhere(i.source, i.repo).replace(/^Fix/, 'fix')}.`,
      );
  }
  return { summary, text: lines.join('\n'), config: i.onBase === 'fail' };
}

/** The first line of a check_config question (its summary), clipped for a status line. */
export function setupFailureSummary(question: string, max = 300): string {
  const first = (question.split('\n')[0] ?? '').trim();
  return first.length <= max ? first : first.slice(0, max - 1) + '…';
}
