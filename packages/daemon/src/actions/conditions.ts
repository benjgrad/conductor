import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import {
  GITHUB_PR_URL_RE,
  matchingPaths,
  type Condition,
  type ConditionResult,
  type EvaluateConditionsResult,
} from '@conductor/shared';
import { killTree, spawnCli } from '../platform/index.js';
import { CmdConditionRunner, type CmdExec } from './condition-cmd.js';
import type { FreshCheckout, FreshCheckoutInput } from './checkout.js';
import { cleanEnv, tail } from './open-pr.js';

// ADR-0011 `run_action {action: 'evaluate_conditions'}`: external facts about conductor's PR,
// evaluated on this machine with its own `gh` login (ADR-0016: no third-party secrets on the
// server). Read-only, so no idempotency rules: the engine re-polls until every condition is met,
// one fails, or `condition_timeout` passes.
//
// One `gh pr view <pr_url> --json statusCheckRollup,reviewDecision,reviews,state,mergedAt,author` per
// call, whatever the number of gh conditions. Hardened like open_pr (ADR-0010 implementation
// notes): it runs in the daemon root (outside every repository, so no agent-writable repo config
// is read), with no inherited GIT_* / GH_REPO / GH_HOST and GIT_CONFIG_NOSYSTEM=1; a 60 s timeout;
// stdout and stderr each capped at 16 KB (a `--jq` projection keeps the output small, so a cap hit
// means something is wrong and the conditions stay pending).
//
// Mapping (ADR-0016 §The connector registry):
//   - pr_checks_green: every check SUCCESS / NEUTRAL / SKIPPED → met; any failure → failed (the
//     detail names each failing check with its https link); else pending. No checks reported yet
//     is pending (CI may not have started); the engine's `no_checks_after` decides when that
//     means "no CI" (U-072).
//   - pr_approvals {min} (security review 2026-10-26: on a public repo anyone can approve). Only
//     ELIGIBLE reviewers count: `authorAssociation` OWNER / MEMBER / COLLABORATOR, never the PR's
//     own author. Their latest APPROVED / CHANGES_REQUESTED / DISMISSED review each (COMMENTED
//     doesn't change a verdict).
//     Per eligible reviewer, in review order (security reviews 2026-10-26; GitHub keeps a
//     "changes requested" block across pushes, and reviewDecision only shows it when branch
//     protection requires reviews):
//       CHANGES_REQUESTED (on any commit) → blocked;
//       APPROVED on the current head (`commit.oid` = `headRefOid`) → approved (clears a block);
//       APPROVED on an older commit → stale: no approval, and a block stays;
//       DISMISSED → no verdict (clears a block).
//     Then, in this order:
//       any blocked reviewer, or `reviewDecision` CHANGES_REQUESTED → failed;
//       the PR closed without merging → failed;
//       `reviewDecision` REVIEW_REQUIRED → pending whatever the count (branch protection still
//       wants reviews);
//       eligible approvals ≥ min → met, else pending.
//   - pr_merged: merged → met; else pending.
//   - pr_screenshots {ui_paths, min_pairs} (M2-T35a): the PR changes no file matching `ui_paths`
//     → met; else the body's `screenshotsMarker` (written by open_pr with the Before / After table,
//     M2-T35b) must count ≥ min_pairs (default 1) → met; fewer → failed, the detail naming the UI
//     files and where the agent saves the screenshots (back to Implementing, counted). gh lists at
//     most 100 files; when `changedFiles` says more, the list is treated as touching the UI. The
//     files and body are only asked for when a pr_screenshots condition is evaluated.
//   - Head pinning: with `headSha` (the commit conductor checked and pushed), a PR whose
//     `headRefOid` differs fails every PR condition ("someone pushed to the branch").
//   - A closed, unmerged PR fails every gh condition (it can't become true without a human).
//   - pr_mergeable (ADR-0037 P2): GitHub's `mergeable`: MERGEABLE → met, CONFLICTING → failed,
//     UNKNOWN → pending (GitHub is still computing); merged → met. gh is asked for
//     `mergeable,mergeStateStatus` only when a pr_mergeable condition, or a pr_checks_green with
//     `no_checks.policy: require_mergeable` (P3: the result then carries `mergeable` for the
//     engine's no-CI policy), is evaluated.
//   - cmd (ADR-0037 P2): condition-cmd.ts, in a fresh checkout on this machine.
//   - azure_pipeline_succeeded / jira_fields_set, and age_below (the engine's) → unsupported.
//   - short_circuit (ADR-0037 P1): in declared order, stop at the first result that is not met;
//     the rest are `skipped`. gh then runs only when a gh condition is reached.
// A missing gh, or gh failing to authenticate, is not an error: every gh condition is `pending`
// with the detail "gh not available: …", so the engine keeps polling until the timeout.

export const GH_CONDITION_TIMEOUT_MS = 60_000;
/** Cap on gh's stdout (and, separately, stderr). */
export const GH_OUTPUT_CAP_BYTES = 16 * 1024;

const GH_TYPES: ReadonlySet<Condition['type']> = new Set([
  'pr_checks_green',
  'pr_approvals',
  'pr_merged',
  'pr_screenshots',
  'pr_mergeable',
]);

const GH_FIELDS = 'statusCheckRollup,reviewDecision,reviews,state,mergedAt,author,headRefOid';
/** Keeps only the fields the mapping reads (same names, so unprojected output parses too). */
const GH_JQ =
  '{state, mergedAt, reviewDecision, headRefOid, author: {login: .author.login},' +
  ' statusCheckRollup: [(.statusCheckRollup // [])[] | {__typename, name, context, status, conclusion, state, detailsUrl, targetUrl}],' +
  ' reviews: [(.reviews // [])[] | {author: {login: .author.login}, authorAssociation, state, commit: {oid: .commit.oid}}]';
/** pr_screenshots adds the changed paths and the body's pair count (never the body itself). */
const GH_SCREENSHOT_FIELDS = ',files,changedFiles,body';
const GH_SCREENSHOT_JQ =
  ', files: [(.files // [])[] | .path], changedFiles,' +
  ' screenshotPairs: ((((.body // "") | capture("<!-- conductor:screenshots pairs=(?<n>[0-9]{1,3}) -->") | .n | tonumber)) // null)';
/** ADR-0037: pr_mergeable and the require_mergeable no-CI policy add GitHub's mergeability. */
const GH_MERGEABLE_FIELDS = ',mergeable,mergeStateStatus';
const GH_MERGEABLE_JQ = ', mergeable, mergeStateStatus';

/** Does this condition need GitHub's `mergeable`? */
export function needsMergeable(c: Condition): boolean {
  return (
    c.type === 'pr_mergeable' ||
    (c.type === 'pr_checks_green' && c.no_checks?.policy === 'require_mergeable')
  );
}

/** The `gh pr view` args for `conditions`. */
export function ghViewArgs(prUrl: string, conditions: readonly Condition[]): string[] {
  const shots = conditions.some((c) => c.type === 'pr_screenshots');
  const merge = conditions.some(needsMergeable);
  return [
    'pr',
    'view',
    prUrl,
    '--json',
    GH_FIELDS + (shots ? GH_SCREENSHOT_FIELDS : '') + (merge ? GH_MERGEABLE_FIELDS : ''),
    '--jq',
    GH_JQ + (shots ? GH_SCREENSHOT_JQ : '') + (merge ? GH_MERGEABLE_JQ : '') + '}',
  ];
}

export interface EvaluateConditionsInput {
  /** The move step's conditions, in declaration order (results match by position). */
  conditions: readonly Condition[];
  /** `context.__pr.pr_url` (null: no PR opened yet). */
  prUrl: string | null;
  /** The commit conductor checked and pushed; set → the PR head must equal it. */
  headSha?: string | undefined;
  /** The daemon root: gh's cwd, outside every repository. */
  root: string;
  /** How to run gh (default `gh` from PATH). Tests: `{cmd: '/bin/sh', args: [fakeScript]}`. */
  gh?: { cmd: string; args: readonly string[] };
  /** Default process.env; cleaned like open_pr's. */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Default GH_CONDITION_TIMEOUT_MS. */
  timeoutMs?: number;
  /** ADR-0037 P1: stop at the first condition not met; the rest are `skipped`. */
  shortCircuit?: boolean;
  /** ADR-0037 P2 `cmd`: the session's worktree and branch (this daemon's records); null: not here. */
  worktree?: { path: string; branch: string } | null;
  /** `cmd` with `needs: setup`: the setup ('' none, null / undefined auto-detect). */
  setup?: string | null | undefined;
  /** `cmd`: how to run a command (the daemon's command runner). Absent: `cmd` stays pending. */
  exec?: CmdExec;
  /** Tests: the fresh checkout and the worktree head. */
  checkout?: (i: FreshCheckoutInput) => Promise<FreshCheckout>;
  resolveHead?: (worktree: string) => Promise<string | null>;
  /** Tests: the PATH searched for a package manager. */
  path?: string;
}

interface GhRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout went over GH_OUTPUT_CAP_BYTES (the rest was dropped and gh was killed). */
  truncated: boolean;
  timedOut: boolean;
  spawnError: NodeJS.ErrnoException | null;
}

function runCapped(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<GhRun> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    let settled = false;
    const child = spawnCli(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(signal ? { signal } : {}),
    }) as ChildProcessByStdio<null, Readable, Readable>;
    // gh's own children could hold the pipes open after the kill: settle now, don't wait for 'close'.
    const stop = () => {
      killTree(child, { signal: 'SIGKILL' }); // win32: gh's own children too (taskkill /T)
      child.stdout.destroy();
      child.stderr.destroy();
      done(null);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => {
      if (truncated) return;
      const room = GH_OUTPUT_CAP_BYTES - outBytes;
      if (b.length > room) {
        out.push(b.subarray(0, room));
        outBytes = GH_OUTPUT_CAP_BYTES;
        truncated = true;
        stop();
        return;
      }
      out.push(b);
      outBytes += b.length;
    });
    child.stderr.on('data', (b: Buffer) => {
      const room = GH_OUTPUT_CAP_BYTES - errBytes;
      if (room <= 0) return;
      const keep = b.length > room ? b.subarray(0, room) : b;
      err.push(keep);
      errBytes += keep.length;
    });
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        truncated,
        timedOut,
        spawnError,
      });
    };
    child.on('error', (e: NodeJS.ErrnoException) => {
      spawnError = e;
      // A spawn failure never emits 'close' on some platforms; an abort does, after 'error'.
      if (child.pid === undefined) done(null);
    });
    child.on('close', (code) => done(code));
  });
}

const result = (
  type: Condition['type'],
  status: ConditionResult['status'],
  value: string | null,
  detail: string | null,
): ConditionResult => ({ type, status, value, detail });

function unsupported(c: Condition): ConditionResult {
  return result(c.type, 'unsupported', null, `${c.type} can't be evaluated on this machine yet`);
}

export const SKIPPED_DETAIL = 'not checked: an earlier condition is not met';

const ghMissing = (e: NodeJS.ErrnoException) =>
  e.code === 'ENOENT'
    ? 'gh not available: gh (the GitHub CLI) is not on PATH: install it and run `gh auth login` on this machine'
    : `gh not available: ${e.message}`;

const AUTH_RE = /auth|login|token|credential|401|403/i;

/** The PR view, or why there is none (every gh condition is then `pending` with it). */
type ViewOutcome = { pr: PrView } | { pending: string };

async function fetchView(i: EvaluateConditionsInput): Promise<ViewOutcome> {
  if (i.prUrl === null) return { pending: 'no pull request yet' };
  if (!GITHUB_PR_URL_RE.test(i.prUrl)) {
    return { pending: `not a GitHub pull request URL: ${i.prUrl}` };
  }
  const gh = i.gh ?? { cmd: 'gh', args: [] };
  const r = await runCapped(
    gh.cmd,
    [...gh.args, ...ghViewArgs(i.prUrl, i.conditions)],
    i.root,
    cleanEnv(i.env ?? process.env),
    i.timeoutMs ?? GH_CONDITION_TIMEOUT_MS,
    i.signal,
  );
  if (r.spawnError && r.spawnError.name !== 'AbortError')
    return { pending: ghMissing(r.spawnError) };
  if (r.timedOut) {
    const s = (i.timeoutMs ?? GH_CONDITION_TIMEOUT_MS) / 1000;
    return { pending: `gh pr view timed out after ${s} s` };
  }
  if (r.truncated) {
    return {
      pending: `gh pr view printed more than ${GH_OUTPUT_CAP_BYTES / 1024} KB; output truncated: ${tail(r.stdout, 200)}`,
    };
  }
  if (r.code !== 0) {
    const msg = tail(r.stderr || r.stdout) || `exit ${String(r.code)}`;
    return {
      pending: AUTH_RE.test(msg) ? `gh not available: ${msg}` : `gh pr view failed: ${msg}`,
    };
  }
  try {
    return { pr: parsePrView(JSON.parse(r.stdout)) };
  } catch {
    return { pending: `gh pr view printed unexpected output: ${tail(r.stdout, 200)}` };
  }
}

export async function evaluateConditions(
  i: EvaluateConditionsInput,
): Promise<EvaluateConditionsResult> {
  // One gh call per evaluation, made when the first gh condition needs it (with short_circuit a
  // failing earlier condition means gh never runs).
  let view: Promise<ViewOutcome> | null = null;
  const getView = () => (view ??= fetchView(i));
  if (!i.shortCircuit && i.conditions.some((c) => GH_TYPES.has(c.type))) void getView();
  let cmds: CmdConditionRunner | null = null;
  const results: ConditionResult[] = [];
  let stopped = false;
  try {
    for (const c of i.conditions) {
      if (stopped) {
        results.push(result(c.type, 'skipped', null, SKIPPED_DETAIL));
        continue;
      }
      let r: ConditionResult;
      if (GH_TYPES.has(c.type)) {
        const v = await getView();
        r =
          'pr' in v ? mapCondition(c, v.pr, i.headSha) : result(c.type, 'pending', null, v.pending);
      } else if (c.type === 'cmd') {
        if (i.exec === undefined) {
          r = result(
            c.type,
            'pending',
            null,
            'this daemon has no command runner for cmd conditions',
          );
        } else {
          cmds ??= new CmdConditionRunner({
            root: i.root,
            worktree: i.worktree ?? null,
            setup: i.setup,
            exec: i.exec,
            ...(i.env ? { env: i.env } : {}),
            ...(i.signal ? { signal: i.signal } : {}),
            ...(i.checkout ? { checkout: i.checkout } : {}),
            ...(i.resolveHead ? { resolveHead: i.resolveHead } : {}),
            ...(i.path !== undefined ? { path: i.path } : {}),
          });
          // The commit conductor pushed, else the PR head gh reported (when gh already ran).
          let sha: string | null = i.headSha ?? null;
          // (`view` is assigned through getView, which TS's narrowing doesn't see.)
          const fetched = view as Promise<ViewOutcome> | null;
          if (sha === null && fetched !== null) {
            const v = await fetched;
            sha = 'pr' in v ? v.pr.headRefOid : null;
          }
          r = await cmds.run(c, sha);
        }
      } else {
        r = unsupported(c);
      }
      results.push(r);
      if (i.shortCircuit && r.status !== 'met') stopped = true;
    }
  } finally {
    cmds?.close();
  }
  return { results };
}

// ---- mapping (pure) ---------------------------------------------------------------------------

export interface PrCheck {
  name: string;
  /** CheckRun: QUEUED / IN_PROGRESS / COMPLETED / …; null for a StatusContext. */
  status: string | null;
  /** CheckRun conclusion, or a StatusContext's state (SUCCESS / FAILURE / ERROR / PENDING …). */
  conclusion: string | null;
  /** CheckRun `detailsUrl` / StatusContext `targetUrl` when https; null otherwise. */
  url: string | null;
}

export interface PrView {
  state: string;
  merged: boolean;
  reviewDecision: string | null;
  checks: PrCheck[];
  /** The PR author's login (null: unknown). */
  author: string | null;
  /** The PR's current head commit (null: unknown). */
  headRefOid: string | null;
  reviews: { author: string; association: string | null; state: string; commit: string | null }[];
  /** The changed paths gh listed (null: not asked for); `changedFiles` may say there are more. */
  files: string[] | null;
  changedFiles: number | null;
  /** The pair count in the body's screenshots marker (null: none). */
  screenshotPairs: number | null;
  /** ADR-0037: GitHub's MERGEABLE / CONFLICTING / UNKNOWN (null: not asked for). */
  mergeable: string | null;
  mergeStateStatus: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
/** A check's link, only when it is a plain https URL (it reaches the agent as evidence). */
const httpsUrl = (v: unknown): string | null => {
  const s = str(v);
  return s !== null && /^https:\/\/[^\s]{1,500}$/.test(s) ? s : null;
};
const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** gh's JSON (projected or not) → PrView. Throws on a non-object. */
export function parsePrView(raw: unknown): PrView {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a PR');
  const o = raw as Record<string, unknown>;
  const rollup = Array.isArray(o.statusCheckRollup) ? o.statusCheckRollup : [];
  const checks = rollup.map((x): PrCheck => {
    const c = rec(x);
    if (c.__typename === 'StatusContext' || (str(c.status) === null && str(c.state) !== null)) {
      return {
        name: str(c.context) ?? str(c.name) ?? 'status',
        status: null,
        conclusion: str(c.state),
        url: httpsUrl(c.targetUrl),
      };
    }
    return {
      name: str(c.name) ?? str(c.context) ?? 'check',
      status: str(c.status),
      conclusion: str(c.conclusion),
      url: httpsUrl(c.detailsUrl),
    };
  });
  const reviews = (Array.isArray(o.reviews) ? o.reviews : []).map((x) => {
    const r = rec(x);
    return {
      author: str(rec(r.author).login) ?? '?',
      association: str(r.authorAssociation),
      commit: str(rec(r.commit).oid),
      state: str(r.state) ?? '',
    };
  });
  const state = str(o.state) ?? 'OPEN';
  const count = (v: unknown): number | null =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
  return {
    state,
    merged: state === 'MERGED' || str(o.mergedAt) !== null,
    reviewDecision: str(o.reviewDecision),
    author: str(rec(o.author).login),
    headRefOid: str(o.headRefOid),
    checks,
    reviews,
    files: Array.isArray(o.files)
      ? o.files.map((f) => (typeof f === 'string' ? f : str(rec(f).path))).filter((f) => f !== null)
      : null,
    changedFiles: count(o.changedFiles),
    screenshotPairs: count(o.screenshotPairs),
    mergeable: str(o.mergeable),
    mergeStateStatus: str(o.mergeStateStatus),
  };
}

const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAIL = new Set([
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
]);

function checkVerdict(c: PrCheck): 'pass' | 'fail' | 'pending' {
  // A StatusContext has only a state; a CheckRun's conclusion counts once it is COMPLETED.
  if (c.status !== null && c.status !== 'COMPLETED') return 'pending';
  if (c.conclusion !== null && PASS.has(c.conclusion)) return 'pass';
  if (c.conclusion !== null && FAIL.has(c.conclusion)) return 'fail';
  return 'pending';
}

/** Reviewers whose approval counts: repo owner / member / collaborator, never the PR author. */
const ELIGIBLE_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
function eligibleReviewer(r: PrView['reviews'][number], prAuthor: string | null): boolean {
  if (r.association === null || !ELIGIBLE_ASSOCIATIONS.has(r.association)) return false;
  if (r.author === '?') return false;
  return prAuthor === null || r.author !== prAuthor;
}

const names = (cs: PrCheck[]) => tail(cs.map((c) => c.name).join(', '), 300);
/** Failing checks with their links, so the agent can open the logs: `lint (https://…), test`. */
const failing = (cs: PrCheck[]) =>
  tail(cs.map((c) => (c.url !== null ? `${c.name} (${c.url})` : c.name)).join(', '), 1200);

export function mapCondition(c: Condition, pr: PrView, headSha?: string): ConditionResult {
  if (!GH_TYPES.has(c.type)) return unsupported(c);
  if (headSha !== undefined && pr.headRefOid !== headSha) {
    if (pr.headRefOid === null) {
      return result(c.type, 'pending', null, 'gh reported no head commit for the PR');
    }
    return result(
      c.type,
      'failed',
      pr.headRefOid.slice(0, 12),
      `PR head ${pr.headRefOid} isn't the commit conductor checked (${headSha}); someone pushed to the branch`,
    );
  }
  if (c.type === 'pr_mergeable') {
    if (pr.merged) return result(c.type, 'met', 'merged', null);
    if (pr.state === 'CLOSED') {
      return result(c.type, 'failed', 'closed', 'the PR was closed without merging');
    }
    const state = pr.mergeStateStatus !== null ? ` (${pr.mergeStateStatus.toLowerCase()})` : '';
    if (pr.mergeable === 'MERGEABLE') return result(c.type, 'met', 'mergeable', null);
    if (pr.mergeable === 'CONFLICTING') {
      return result(
        c.type,
        'failed',
        'conflicting',
        `the PR conflicts with its base branch${state}: merge the base branch into it and resolve the conflicts`,
      );
    }
    return result(
      c.type,
      'pending',
      'unknown',
      'GitHub is still computing whether the PR merges cleanly',
    );
  }
  if (c.type === 'pr_merged') {
    if (pr.merged) return result(c.type, 'met', 'merged', null);
    if (pr.state === 'CLOSED') return result(c.type, 'failed', 'closed', 'the PR was closed');
    return result(c.type, 'pending', pr.state.toLowerCase(), 'not merged yet');
  }
  const closed = pr.state === 'CLOSED' && !pr.merged;
  if (c.type === 'pr_screenshots') return mapScreenshots(c, pr, closed);
  if (c.type === 'pr_checks_green') {
    const r = mapChecks(c, pr, closed);
    // ADR-0037 P3: the engine's require_mergeable policy reads GitHub's answer from here.
    if (c.no_checks?.policy !== 'require_mergeable') return r;
    const m = pr.mergeable;
    return { ...r, mergeable: m === 'MERGEABLE' || m === 'CONFLICTING' ? m : 'UNKNOWN' };
  }
  if (c.type !== 'pr_approvals') return unsupported(c);
  return mapApprovals(c, pr, closed);
}

function mapChecks(
  c: Extract<Condition, { type: 'pr_checks_green' }>,
  pr: PrView,
  closed: boolean,
): ConditionResult {
  const total = pr.checks.length;
  const failed = pr.checks.filter((k) => checkVerdict(k) === 'fail');
  const pending = pr.checks.filter((k) => checkVerdict(k) === 'pending');
  const passed = total - failed.length - pending.length;
  const value = `${passed}/${total} passed`;
  if (failed.length > 0) return result(c.type, 'failed', value, `failing: ${failing(failed)}`);
  if (closed) return result(c.type, 'failed', value, 'the PR was closed without merging');
  // value is NO_PR_CHECKS_VALUE here: the engine's `no_checks_after` keys on it (U-072).
  if (total === 0) return result(c.type, 'pending', value, 'no checks reported yet');
  if (pending.length > 0) {
    return result(c.type, 'pending', value, `waiting for: ${names(pending)}`);
  }
  return result(c.type, 'met', value, null);
}

function mapApprovals(
  c: Extract<Condition, { type: 'pr_approvals' }>,
  pr: PrView,
  closed: boolean,
): ConditionResult {
  // Each eligible reviewer's verdict, folded over their reviews in order (COMMENTED / PENDING
  // reviews don't change it). See the header for the rules.
  const verdict = new Map<string, 'approved' | 'blocked' | 'none'>();
  for (const r of pr.reviews) {
    if (!eligibleReviewer(r, pr.author)) continue;
    const prev = verdict.get(r.author) ?? 'none';
    if (r.state === 'CHANGES_REQUESTED') {
      verdict.set(r.author, 'blocked');
    } else if (r.state === 'DISMISSED') {
      verdict.set(r.author, 'none');
    } else if (r.state === 'APPROVED') {
      const onHead = pr.headRefOid !== null && r.commit === pr.headRefOid;
      // A stale approval carries no verdict and does not clear an earlier block.
      verdict.set(r.author, onHead ? 'approved' : prev === 'blocked' ? 'blocked' : 'none');
    }
  }
  const approvers = [...verdict].filter(([, v]) => v === 'approved').map(([a]) => a);
  const blockers = [...verdict].filter(([, v]) => v === 'blocked').map(([a]) => a);
  const value = `${approvers.length}/${c.min}`;
  if (blockers.length > 0 || pr.reviewDecision === 'CHANGES_REQUESTED') {
    const who = blockers.length > 0 ? ` by ${blockers.join(', ')}` : '';
    return result(c.type, 'failed', value, `changes requested${who}`);
  }
  if (closed) return result(c.type, 'failed', value, 'the PR was closed without merging');
  if (pr.reviewDecision === 'REVIEW_REQUIRED') {
    return result(c.type, 'pending', value, 'GitHub still requires a review (branch protection)');
  }
  if (approvers.length >= c.min) {
    return result(c.type, 'met', value, `approved by ${approvers.join(', ')}`);
  }
  return result(
    c.type,
    'pending',
    value,
    approvers.length > 0 ? `approved by ${approvers.join(', ')}` : 'no approvals yet',
  );
}

/** At most `n` items, then `+k more`. */
const some = (xs: readonly string[], n = 5) =>
  xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')}, +${xs.length - n} more`;

function mapScreenshots(
  c: Extract<Condition, { type: 'pr_screenshots' }>,
  pr: PrView,
  closed: boolean,
): ConditionResult {
  if (pr.files === null) return result(c.type, 'pending', null, 'gh listed no changed files');
  const ui = matchingPaths(pr.files, c.ui_paths);
  const unlisted = pr.changedFiles !== null && pr.changedFiles > pr.files.length;
  if (ui.length === 0 && !unlisted) return result(c.type, 'met', 'no UI change', null);
  const need = c.min_pairs ?? 1;
  const pairs = pr.screenshotPairs ?? 0;
  const value = `${pairs}/${need} pairs`;
  const changed =
    ui.length > 0
      ? `UI files changed (${some(ui)})`
      : `more files changed than gh lists (${pr.changedFiles ?? '?'}), so some may be UI files`;
  if (pairs >= need) return result(c.type, 'met', value, `${changed}; screenshots attached`);
  if (closed) return result(c.type, 'failed', value, 'the PR was closed without merging');
  return result(
    c.type,
    'failed',
    value,
    `${changed}, but the PR shows ${pairs} of ${need} before/after screenshot pair${need === 1 ? '' : 's'}. ` +
      'For each changed view, save before-<view>.png (the default branch) and after-<view>.png ' +
      '(this branch) in $CONDUCTOR_SCREENSHOT_DIR, then finish the step again; conductor attaches them to the PR.',
  );
}
