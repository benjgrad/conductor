import { repoChecksKey } from '@conductor/shared';
import { z } from 'zod';

// R11: what a GitHub delivery is about, and which live sessions it should wake. Pure. A delivery
// never decides anything (FR-2): the sessions it matches have their next condition check
// (`state_deadline`, conditions phase) or watch check (`watch_deadline`) brought forward to now,
// and the normal evaluation runs on the next sweep tick.

/** The events a webhook may be subscribed to; anything else is acknowledged and ignored. */
export const WEBHOOK_EVENTS = [
  'check_run',
  'check_suite',
  'pull_request',
  'pull_request_review',
] as const;

/** What a delivery points at. */
export interface WebhookTarget {
  /** `repoChecksKey` form: `github.com/<owner>/<repo>`, lower-cased. */
  repo: string;
  /** Normalised (`normPrUrl`) PR URLs the delivery is about. */
  prUrls: string[];
  /** Head branch names (case kept: git branches are case-sensitive). */
  branches: string[];
  /** A PR was merged: the default branch moved, so every watch on the repo checks again. */
  repoMerged: boolean;
}

/** A PR URL for comparison: lower-cased, without a trailing slash. */
export function normPrUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

const Repo = z.object({ full_name: z.string().regex(/^[^/\s]+\/[^/\s]+$/) });
const PrRef = z.object({ number: z.number().int().positive() });
const PullRequest = z.object({
  html_url: z.string().min(1),
  head: z.object({ ref: z.string().min(1) }),
  merged: z.boolean().nullable().optional(),
});

const CheckSuitePayload = z.object({
  action: z.string(),
  repository: Repo,
  check_suite: z.object({
    head_branch: z.string().nullable().optional(),
    pull_requests: z.array(PrRef).optional(),
  }),
});
const CheckRunPayload = z.object({
  action: z.string(),
  repository: Repo,
  check_run: z.object({
    check_suite: z.object({ head_branch: z.string().nullable().optional() }).optional(),
    pull_requests: z.array(PrRef).optional(),
  }),
});
const PullRequestPayload = z.object({
  action: z.string(),
  repository: Repo,
  pull_request: PullRequest,
});

/** `pull_request` actions that can change what a condition or watch sees. */
const PR_ACTIONS: ReadonlySet<string> = new Set([
  'closed',
  'reopened',
  'synchronize',
  'ready_for_review',
  'converted_to_draft',
  'edited',
]);
const REVIEW_ACTIONS: ReadonlySet<string> = new Set(['submitted', 'dismissed', 'edited']);

const repoKey = (fullName: string) => repoChecksKey(`github.com/${fullName}`);
const prUrlOf = (fullName: string, n: number) =>
  normPrUrl(`https://github.com/${fullName}/pull/${n}`);
const branchesOf = (b: string | null | undefined) => (b ? [b] : []);

/**
 * The target of a delivery (`X-GitHub-Event` + parsed body), or null when it can change nothing
 * (another event, an action that doesn't settle anything, a malformed payload).
 */
export function webhookTarget(event: string, payload: unknown): WebhookTarget | null {
  switch (event) {
    case 'check_suite': {
      const p = CheckSuitePayload.safeParse(payload);
      if (!p.success || p.data.action !== 'completed') return null;
      const { repository: r, check_suite: cs } = p.data;
      return {
        repo: repoKey(r.full_name),
        prUrls: (cs.pull_requests ?? []).map((pr) => prUrlOf(r.full_name, pr.number)),
        branches: branchesOf(cs.head_branch),
        repoMerged: false,
      };
    }
    case 'check_run': {
      const p = CheckRunPayload.safeParse(payload);
      if (!p.success || p.data.action !== 'completed') return null;
      const { repository: r, check_run: cr } = p.data;
      return {
        repo: repoKey(r.full_name),
        prUrls: (cr.pull_requests ?? []).map((pr) => prUrlOf(r.full_name, pr.number)),
        branches: branchesOf(cr.check_suite?.head_branch),
        repoMerged: false,
      };
    }
    case 'pull_request':
    case 'pull_request_review': {
      const p = PullRequestPayload.safeParse(payload);
      if (!p.success) return null;
      const actions = event === 'pull_request' ? PR_ACTIONS : REVIEW_ACTIONS;
      if (!actions.has(p.data.action)) return null;
      const { repository: r, pull_request: pr } = p.data;
      return {
        repo: repoKey(r.full_name),
        prUrls: [normPrUrl(pr.html_url)],
        branches: [pr.head.ref],
        repoMerged: event === 'pull_request' && p.data.action === 'closed' && pr.merged === true,
      };
    }
    default:
      return null;
  }
}

/** A live session that has a check to bring forward (`candidatesOf` in nudge.ts). */
export interface NudgeCandidate {
  id: string;
  /** `ticket.repo` as stored. */
  repo: string;
  /** `context.__pr.pr_url`, or null. */
  pr_url: string | null;
  branch: string | null;
  /** In a move step's conditions phase with a `state_deadline` still ahead. */
  conditions_pending: boolean;
  /** A watched state with a `watch_deadline` still ahead. */
  watching: boolean;
}

/** Which candidates a target wakes: their conditions check, or their watch check. */
export function sessionsToNudge(
  target: WebhookTarget,
  candidates: readonly NudgeCandidate[],
): { conditions: string[]; watches: string[] } {
  const urls = new Set(target.prUrls);
  const branches = new Set(target.branches);
  const conditions: string[] = [];
  const watches: string[] = [];
  for (const c of candidates) {
    if (repoChecksKey(c.repo) !== target.repo) continue;
    const matches =
      (c.pr_url !== null && urls.has(normPrUrl(c.pr_url))) ||
      (c.branch !== null && branches.has(c.branch));
    if (matches && c.conditions_pending) conditions.push(c.id);
    if (c.watching && (matches || target.repoMerged)) watches.push(c.id);
  }
  return { conditions, watches };
}
