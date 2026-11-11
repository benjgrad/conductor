import { z } from 'zod';
import { clip, type PushNotification } from '../push/payload.js';

// R14: a failed deploy of main (deploy/gradyserver/ci-deploy.sh, runbook §12) is reported to the
// board as a ticket and a push, through `conductor-admin deploy-failed` (JSON on stdin). This file
// is the pure half: the report's shape, the ticket's title and body, the idempotency keys and the
// notification. record-failure.ts writes them.

/** Lines of the deploy log a report keeps (the newest). */
export const DEPLOY_LOG_TAIL_LINES = 50;
/** And at most this many characters of them. */
export const DEPLOY_LOG_TAIL_CHARS = 8000;
const STEP_MAX = 80;

const Sha = z.string().regex(/^[0-9a-f]{40}$/, 'a full 40-hex commit sha');

export const DEPLOY_OUTCOMES = ['rolled_back', 'rollback_failed', 'did_not_run'] as const;
export type DeployOutcome = (typeof DEPLOY_OUTCOMES)[number];

/** The newest `DEPLOY_LOG_TAIL_LINES` lines, then the newest `DEPLOY_LOG_TAIL_CHARS` characters. */
export function clipLogTail(log: string): string {
  const lines = log.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const tail = lines.slice(-DEPLOY_LOG_TAIL_LINES).join('\n');
  return tail.length <= DEPLOY_LOG_TAIL_CHARS ? tail : tail.slice(-DEPLOY_LOG_TAIL_CHARS);
}

export const DeployFailureReportSchema = z.object({
  sha: Sha,
  subject: z.string().default(''),
  step: z.string().trim().min(1),
  outcome: z.enum(DEPLOY_OUTCOMES),
  /** The sha production runs now (the rollback target, or what was live); null if unknown. */
  running: Sha.nullable().default(null),
  run_url: z.string().default(''),
  /** host/org/repo the ticket is opened on. */
  repo: z.string().min(1),
  log_tail: z.string().default('').transform(clipLogTail),
  attempted_at: z.iso.datetime({ offset: true }),
});
export type DeployFailureReport = z.output<typeof DeployFailureReportSchema>;

const short = (sha: string) => sha.slice(0, 7);

/** The ticket's `external_ref`, and the root of every idempotency key of one sha's failures. */
export function deployRef(sha: string): string {
  return `deploy:${sha}`;
}

/** The outbox idempotency key of attempt `n`'s push: one per failed attempt, never two. */
export function deployPushKey(sha: string, attempt: number): string {
  return `${deployRef(sha)}:${attempt}`;
}

export function deployTicketTitle(r: DeployFailureReport): string {
  return `Deploy of ${short(r.sha)} failed: ${clip(r.step, STEP_MAX)}`;
}

/** What production is doing now, in one sentence. */
export function outcomeSentence(r: DeployFailureReport): string {
  switch (r.outcome) {
    case 'rolled_back':
      return r.running
        ? `Production rolled back to ${short(r.running)} and passes its smoke test; nothing new shipped.`
        : 'Production rolled back; nothing new shipped.';
    case 'rollback_failed':
      return 'The rollback failed too: conductor may be down.';
    case 'did_not_run':
      return r.running
        ? `Stopped before touching production; it is still on ${short(r.running)}.`
        : 'Stopped before touching production.';
  }
}

/** A fence that the log can't close early. */
function fenced(text: string): string {
  let fence = '```';
  while (text.includes(fence)) fence += '`';
  return `${fence}text\n${text || '(no log captured)'}\n${fence}`;
}

function facts(r: DeployFailureReport): string[] {
  return [
    `- Commit: \`${r.sha}\`${r.subject ? ` (${r.subject})` : ''}`,
    `- Failed step: ${r.step}`,
    `- Outcome: ${outcomeSentence(r)}`,
    `- Run: ${r.run_url || 'by hand'}`,
    `- At: ${r.attempted_at}`,
  ];
}

export function deployTicketBody(r: DeployFailureReport): string {
  return [
    '## Goal',
    `Find why the deploy of \`${short(r.sha)}\` to gradyserver failed at "${r.step}" and fix it on main. Merging the fix deploys it.`,
    '',
    '## Context',
    'Opened by deploy/gradyserver/ci-deploy.sh (runbook docs/setup/deploy-gradyserver.md §12). A repeated failure of this sha appends an attempt below.',
    '',
    ...facts(r),
    '',
    `Last ${DEPLOY_LOG_TAIL_LINES} lines of the deploy log:`,
    '',
    fenced(r.log_tail),
    '',
    '## Out of scope',
    '- Re-deploying by hand or automatic remediation.',
    '',
    '## Verification',
    '- The next deploy of main succeeds.',
  ].join('\n');
}

/** Appended to the ticket's body when the same sha fails again. */
export function deployAttemptSection(r: DeployFailureReport, attempt: number): string {
  return [
    '',
    `## Attempt ${attempt} (${r.attempted_at})`,
    '',
    ...facts(r),
    '',
    fenced(r.log_tail),
  ].join('\n');
}

/** How many attempts a ticket's body already records (the first is the body itself). */
export function attemptsInBody(body: string): number {
  return 1 + (body.match(/^## Attempt \d+ /gm)?.length ?? 0);
}

export function deployFailureNotification(
  ticketId: string,
  r: DeployFailureReport,
): PushNotification {
  return {
    title: clip(deployTicketTitle(r), 120),
    body: outcomeSentence(r),
    url: `/#/?ticket=${ticketId}`,
    // One sha's notifications replace each other in the browser.
    tag: deployRef(r.sha),
  };
}
