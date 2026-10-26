import { spawn } from 'node:child_process';
import {
  GITHUB_PR_URL_RE,
  type Condition,
  type ConditionResult,
  type EvaluateConditionsResult,
} from '@conductor/shared';
import { cleanEnv, tail } from './open-pr.js';

// ADR-0011 `run_action {action: 'evaluate_conditions'}`: external facts about conductor's PR,
// evaluated on this machine with its own `gh` login (ADR-0016: no third-party secrets on the
// server). Read-only, so no idempotency rules: the engine re-polls until every condition is met,
// one fails, or `condition_timeout` passes.
//
// One `gh pr view <pr_url> --json statusCheckRollup,reviewDecision,reviews,state,mergedAt` per
// call, whatever the number of gh conditions. Hardened like open_pr (ADR-0010 implementation
// notes): it runs in the daemon root (outside every repository, so no agent-writable repo config
// is read), with no inherited GIT_* / GH_REPO / GH_HOST and GIT_CONFIG_NOSYSTEM=1; a 60 s timeout;
// stdout and stderr each capped at 16 KB (a `--jq` projection keeps the output small, so a cap hit
// means something is wrong and the conditions stay pending).
//
// Mapping (ADR-0016 §The connector registry):
//   - pr_checks_green: every check SUCCESS / NEUTRAL / SKIPPED → met; any failure → failed; else
//     pending. No checks reported yet is pending (CI may not have started).
//   - pr_approvals {min}: the latest APPROVED / CHANGES_REQUESTED / DISMISSED review per reviewer
//     (COMMENTED doesn't change a verdict); any CHANGES_REQUESTED (or reviewDecision
//     CHANGES_REQUESTED) → failed; approvals ≥ min → met; else pending.
//   - pr_merged: merged → met; else pending.
//   - A closed, unmerged PR fails every gh condition (it can't become true without a human).
//   - azure_pipeline_succeeded / jira_fields_set → unsupported (M5).
// A missing gh, or gh failing to authenticate, is not an error: every gh condition is `pending`
// with the detail "gh not available: …", so the engine keeps polling until the timeout.

export const GH_CONDITION_TIMEOUT_MS = 60_000;
/** Cap on gh's stdout (and, separately, stderr). */
export const GH_OUTPUT_CAP_BYTES = 16 * 1024;

const GH_TYPES: ReadonlySet<Condition['type']> = new Set([
  'pr_checks_green',
  'pr_approvals',
  'pr_merged',
]);

const GH_FIELDS = 'statusCheckRollup,reviewDecision,reviews,state,mergedAt';
/** Keeps only the fields the mapping reads (same names, so unprojected output parses too). */
const GH_JQ =
  '{state, mergedAt, reviewDecision,' +
  ' statusCheckRollup: [(.statusCheckRollup // [])[] | {__typename, name, context, status, conclusion, state}],' +
  ' reviews: [(.reviews // [])[] | {author: {login: .author.login}, state}]}';

export interface EvaluateConditionsInput {
  /** The move step's conditions, in declaration order (results match by position). */
  conditions: readonly Condition[];
  /** `context.__pr.pr_url` (null: no PR opened yet). */
  prUrl: string | null;
  /** The daemon root: gh's cwd, outside every repository. */
  root: string;
  /** How to run gh (default `gh` from PATH). Tests: `{cmd: '/bin/sh', args: [fakeScript]}`. */
  gh?: { cmd: string; args: readonly string[] };
  /** Default process.env; cleaned like open_pr's. */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Default GH_CONDITION_TIMEOUT_MS. */
  timeoutMs?: number;
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
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(signal ? { signal } : {}),
    });
    // gh's own children could hold the pipes open after the kill: settle now, don't wait for 'close'.
    const stop = () => {
      child.kill('SIGKILL');
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

/** Every gh condition `pending` with `detail`; other types `unsupported`. */
function allPending(conditions: readonly Condition[], detail: string): EvaluateConditionsResult {
  return {
    results: conditions.map((c) =>
      GH_TYPES.has(c.type) ? result(c.type, 'pending', null, detail) : unsupported(c),
    ),
  };
}

function unsupported(c: Condition): ConditionResult {
  return result(c.type, 'unsupported', null, `${c.type} can't be evaluated on this machine yet`);
}

const ghMissing = (e: NodeJS.ErrnoException) =>
  e.code === 'ENOENT'
    ? 'gh not available: gh (the GitHub CLI) is not on PATH: install it and run `gh auth login` on this machine'
    : `gh not available: ${e.message}`;

const AUTH_RE = /auth|login|token|credential|401|403/i;

export async function evaluateConditions(
  i: EvaluateConditionsInput,
): Promise<EvaluateConditionsResult> {
  if (!i.conditions.some((c) => GH_TYPES.has(c.type))) {
    return { results: i.conditions.map(unsupported) };
  }
  if (i.prUrl === null) return allPending(i.conditions, 'no pull request yet');
  if (!GITHUB_PR_URL_RE.test(i.prUrl)) {
    return allPending(i.conditions, `not a GitHub pull request URL: ${i.prUrl}`);
  }
  const gh = i.gh ?? { cmd: 'gh', args: [] };
  const r = await runCapped(
    gh.cmd,
    [...gh.args, 'pr', 'view', i.prUrl, '--json', GH_FIELDS, '--jq', GH_JQ],
    i.root,
    cleanEnv(i.env ?? process.env),
    i.timeoutMs ?? GH_CONDITION_TIMEOUT_MS,
    i.signal,
  );
  if (r.spawnError && r.spawnError.name !== 'AbortError') {
    return allPending(i.conditions, ghMissing(r.spawnError));
  }
  if (r.timedOut) {
    const s = (i.timeoutMs ?? GH_CONDITION_TIMEOUT_MS) / 1000;
    return allPending(i.conditions, `gh pr view timed out after ${s} s`);
  }
  if (r.truncated) {
    return allPending(
      i.conditions,
      `gh pr view printed more than ${GH_OUTPUT_CAP_BYTES / 1024} KB; output truncated: ${tail(r.stdout, 200)}`,
    );
  }
  if (r.code !== 0) {
    const msg = tail(r.stderr || r.stdout) || `exit ${String(r.code)}`;
    return allPending(
      i.conditions,
      AUTH_RE.test(msg) ? `gh not available: ${msg}` : `gh pr view failed: ${msg}`,
    );
  }
  let pr: PrView;
  try {
    pr = parsePrView(JSON.parse(r.stdout));
  } catch {
    return allPending(i.conditions, `gh pr view printed unexpected output: ${tail(r.stdout, 200)}`);
  }
  return { results: i.conditions.map((c) => mapCondition(c, pr)) };
}

// ---- mapping (pure) ---------------------------------------------------------------------------

export interface PrCheck {
  name: string;
  /** CheckRun: QUEUED / IN_PROGRESS / COMPLETED / …; null for a StatusContext. */
  status: string | null;
  /** CheckRun conclusion, or a StatusContext's state (SUCCESS / FAILURE / ERROR / PENDING …). */
  conclusion: string | null;
}

export interface PrView {
  state: string;
  merged: boolean;
  reviewDecision: string | null;
  checks: PrCheck[];
  reviews: { author: string; state: string }[];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
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
      };
    }
    return {
      name: str(c.name) ?? str(c.context) ?? 'check',
      status: str(c.status),
      conclusion: str(c.conclusion),
    };
  });
  const reviews = (Array.isArray(o.reviews) ? o.reviews : []).map((x) => {
    const r = rec(x);
    return { author: str(rec(r.author).login) ?? '?', state: str(r.state) ?? '' };
  });
  const state = str(o.state) ?? 'OPEN';
  return {
    state,
    merged: state === 'MERGED' || str(o.mergedAt) !== null,
    reviewDecision: str(o.reviewDecision),
    checks,
    reviews,
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

const names = (cs: PrCheck[]) => tail(cs.map((c) => c.name).join(', '), 300);

export function mapCondition(c: Condition, pr: PrView): ConditionResult {
  if (!GH_TYPES.has(c.type)) return unsupported(c);
  if (c.type === 'pr_merged') {
    if (pr.merged) return result(c.type, 'met', 'merged', null);
    if (pr.state === 'CLOSED') return result(c.type, 'failed', 'closed', 'the PR was closed');
    return result(c.type, 'pending', pr.state.toLowerCase(), 'not merged yet');
  }
  const closed = pr.state === 'CLOSED' && !pr.merged;
  if (c.type === 'pr_checks_green') {
    const total = pr.checks.length;
    const failed = pr.checks.filter((k) => checkVerdict(k) === 'fail');
    const pending = pr.checks.filter((k) => checkVerdict(k) === 'pending');
    const passed = total - failed.length - pending.length;
    const value = `${passed}/${total} passed`;
    if (failed.length > 0) return result(c.type, 'failed', value, `failing: ${names(failed)}`);
    if (closed) return result(c.type, 'failed', value, 'the PR was closed without merging');
    if (total === 0) return result(c.type, 'pending', value, 'no checks reported yet');
    if (pending.length > 0) {
      return result(c.type, 'pending', value, `waiting for: ${names(pending)}`);
    }
    return result(c.type, 'met', value, null);
  }
  if (c.type !== 'pr_approvals') return unsupported(c);
  // The latest verdict per reviewer (COMMENTED / PENDING reviews don't change it).
  const latest = new Map<string, string>();
  for (const r of pr.reviews) {
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED') {
      latest.set(r.author, r.state);
    }
  }
  const approvers = [...latest].filter(([, s]) => s === 'APPROVED').map(([a]) => a);
  const blockers = [...latest].filter(([, s]) => s === 'CHANGES_REQUESTED').map(([a]) => a);
  const value = `${approvers.length}/${c.min}`;
  if (blockers.length > 0 || pr.reviewDecision === 'CHANGES_REQUESTED') {
    const who = blockers.length > 0 ? ` by ${blockers.join(', ')}` : '';
    return result(c.type, 'failed', value, `changes requested${who}`);
  }
  if (closed) return result(c.type, 'failed', value, 'the PR was closed without merging');
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
