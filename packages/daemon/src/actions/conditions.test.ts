import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Condition } from '@conductor/shared';
import {
  GH_OUTPUT_CAP_BYTES,
  evaluateConditions,
  mapCondition,
  parsePrView,
} from './conditions.js';

// M1b-T05 acceptance: evaluate_conditions against a fake `gh` (a /bin/sh script run as
// `/bin/sh <script> <args>`, the ADR-0010 open_pr pattern). No real GitHub calls.

const PR = 'https://github.com/benjgrad/fixture-app/pull/9';

// Logs argv, cwd and the git env it got; prints $FAKE_GH_OUT; exits $FAKE_GH_EXIT.
const FAKE_GH = `
echo "$*" >> "$FAKE_GH_DIR/argv"
pwd >> "$FAKE_GH_DIR/cwd"
echo "GIT_DIR=$GIT_DIR GIT_CONFIG_NOSYSTEM=$GIT_CONFIG_NOSYSTEM GH_REPO=$GH_REPO" >> "$FAKE_GH_DIR/env"
if [ -n "$FAKE_GH_ERR" ]; then echo "$FAKE_GH_ERR" >&2; fi
if [ -n "$FAKE_GH_SLEEP" ]; then sleep "$FAKE_GH_SLEEP"; fi
cat "$FAKE_GH_DIR/out"
exit \${FAKE_GH_EXIT:-0}
`;

let tmp: string;
let root: string;
let script: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'conductor-conditions-'));
  root = mkdtempSync(join(tmpdir(), 'conductor-root-'));
  script = join(tmp, 'fake-gh.sh');
  writeFileSync(script, FAKE_GH);
  writeFileSync(join(tmp, 'out'), '{}');
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function evalWith(
  conditions: Condition[],
  view: unknown,
  env: Record<string, string> = {},
  more: { prUrl?: string | null; timeoutMs?: number; headSha?: string } = {},
) {
  writeFileSync(join(tmp, 'out'), typeof view === 'string' ? view : JSON.stringify(view));
  return evaluateConditions({
    conditions,
    prUrl: more.prUrl === undefined ? PR : more.prUrl,
    root,
    gh: { cmd: '/bin/sh', args: [script] },
    env: {
      ...process.env,
      FAKE_GH_DIR: tmp,
      // Inherited git overrides must not reach gh.
      GIT_DIR: '/evil/.git',
      GH_REPO: 'evil/repo',
      ...env,
    },
    ...(more.timeoutMs !== undefined ? { timeoutMs: more.timeoutMs } : {}),
    ...(more.headSha !== undefined ? { headSha: more.headSha } : {}),
  });
}

const checkRun = (name: string, status: string, conclusion: string | null) => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
});
const statusCtx = (context: string, state: string) => ({
  __typename: 'StatusContext',
  context,
  state,
});
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const review = (
  login: string,
  state: string,
  authorAssociation = 'MEMBER',
  oid: string = HEAD,
) => ({
  author: { login },
  authorAssociation,
  state,
  commit: { oid },
});
const view = (over: Record<string, unknown> = {}) => ({
  state: 'OPEN',
  mergedAt: null,
  // Empty: no branch protection (the eligible count decides).
  reviewDecision: '',
  author: { login: 'pat' },
  headRefOid: HEAD,
  statusCheckRollup: [],
  reviews: [],
  ...over,
});

const CHECKS: Condition = { type: 'pr_checks_green' };
const APPROVALS_1: Condition = { type: 'pr_approvals', min: 1 };
const MERGED: Condition = { type: 'pr_merged' };

describe('evaluate_conditions with a fake gh', () => {
  it('runs one gh pr view with the --json fields, outside any repo, with the hardened env', async () => {
    const r = await evalWith([CHECKS, APPROVALS_1, MERGED], view());
    expect(r.results).toHaveLength(3);
    const argv = readFileSync(join(tmp, 'argv'), 'utf8').trim().split('\n');
    expect(argv).toHaveLength(1);
    expect(argv[0]).toContain(
      `pr view ${PR} --json statusCheckRollup,reviewDecision,reviews,state,mergedAt,author,headRefOid --jq`,
    );
    const { realpathSync } = await import('node:fs');
    expect(readFileSync(join(tmp, 'cwd'), 'utf8').trim()).toBe(realpathSync(root));
    expect(readFileSync(join(tmp, 'env'), 'utf8').trim()).toBe(
      'GIT_DIR= GIT_CONFIG_NOSYSTEM=1 GH_REPO=',
    );
  });

  it('checks: all success → met; a failure → failed; in progress → pending', async () => {
    const green = await evalWith(
      [CHECKS],
      view({
        statusCheckRollup: [
          checkRun('build', 'COMPLETED', 'SUCCESS'),
          checkRun('lint', 'COMPLETED', 'SKIPPED'),
          statusCtx('ci/legacy', 'SUCCESS'),
        ],
      }),
    );
    expect(green.results).toEqual([
      { type: 'pr_checks_green', status: 'met', value: '3/3 passed', detail: null },
    ]);

    const red = await evalWith(
      [CHECKS],
      view({
        statusCheckRollup: [
          checkRun('build', 'COMPLETED', 'SUCCESS'),
          checkRun('test', 'COMPLETED', 'FAILURE'),
          checkRun('e2e', 'IN_PROGRESS', null),
        ],
      }),
    );
    expect(red.results[0]).toMatchObject({ status: 'failed', value: '1/3 passed' });
    expect(red.results[0]?.detail).toContain('test');

    const running = await evalWith(
      [CHECKS],
      view({
        statusCheckRollup: [
          checkRun('build', 'COMPLETED', 'SUCCESS'),
          checkRun('test', 'IN_PROGRESS', null),
          statusCtx('deploy', 'PENDING'),
        ],
      }),
    );
    expect(running.results[0]).toMatchObject({ status: 'pending', value: '1/3 passed' });
    expect(running.results[0]?.detail).toBe('waiting for: test, deploy');

    const legacyRed = await evalWith(
      [CHECKS],
      view({ statusCheckRollup: [statusCtx('ci', 'ERROR')] }),
    );
    expect(legacyRed.results[0]?.status).toBe('failed');

    const none = await evalWith([CHECKS], view());
    expect(none.results[0]).toMatchObject({ status: 'pending', detail: 'no checks reported yet' });
  });

  it('approvals: 0/1 → pending, 1/1 → met, changes requested → failed', async () => {
    const zero = await evalWith([APPROVALS_1], view({ reviews: [review('amy', 'COMMENTED')] }));
    expect(zero.results).toEqual([
      { type: 'pr_approvals', status: 'pending', value: '0/1', detail: 'no approvals yet' },
    ]);

    const one = await evalWith(
      [APPROVALS_1],
      view({ reviewDecision: 'APPROVED', reviews: [review('amy', 'APPROVED')] }),
    );
    expect(one.results).toEqual([
      { type: 'pr_approvals', status: 'met', value: '1/1', detail: 'approved by amy' },
    ]);

    const changes = await evalWith(
      [APPROVALS_1],
      view({
        reviewDecision: 'CHANGES_REQUESTED',
        reviews: [review('amy', 'APPROVED'), review('bob', 'CHANGES_REQUESTED')],
      }),
    );
    expect(changes.results[0]).toMatchObject({
      status: 'failed',
      value: '1/1',
      detail: 'changes requested by bob',
    });
  });

  it('only owners, members and collaborators count; never the PR author (security review)', async () => {
    const outsiders = await evalWith(
      [APPROVALS_1],
      view({
        reviews: [
          review('rando', 'APPROVED', 'NONE'),
          review('drive-by', 'APPROVED', 'CONTRIBUTOR'),
          review('newbie', 'APPROVED', 'FIRST_TIME_CONTRIBUTOR'),
          review('nobody', 'CHANGES_REQUESTED', 'NONE'), // can't block either
        ],
      }),
    );
    expect(outsiders.results[0]).toMatchObject({
      status: 'pending',
      value: '0/1',
      detail: 'no approvals yet',
    });

    const self = await evalWith(
      [APPROVALS_1],
      view({ reviews: [review('pat', 'APPROVED', 'OWNER')] }),
    );
    expect(self.results[0]).toMatchObject({ status: 'pending', value: '0/1' });

    const eligible = await evalWith(
      [APPROVALS_1],
      view({ reviews: [review('own', 'APPROVED', 'OWNER')] }),
    );
    expect(eligible.results[0]).toMatchObject({ status: 'met', value: '1/1' });
  });

  it('reviewDecision: REVIEW_REQUIRED → pending, CHANGES_REQUESTED → failed, empty → the count', async () => {
    const two: Condition = { type: 'pr_approvals', min: 2 };
    const approvals = [review('amy', 'APPROVED'), review('bob', 'APPROVED', 'COLLABORATOR')];
    const required = await evalWith(
      [two],
      view({ reviewDecision: 'REVIEW_REQUIRED', reviews: approvals }),
    );
    expect(required.results[0]).toMatchObject({ status: 'pending', value: '2/2' });

    const changes = await evalWith(
      [two],
      view({ reviewDecision: 'CHANGES_REQUESTED', reviews: approvals }),
    );
    expect(changes.results[0]).toMatchObject({ status: 'failed', detail: 'changes requested' });

    const open = await evalWith([two], view({ reviewDecision: '', reviews: approvals }));
    expect(open.results[0]).toMatchObject({ status: 'met', value: '2/2' });
    const unset = await evalWith([two], view({ reviewDecision: null, reviews: approvals }));
    expect(unset.results[0]).toMatchObject({ status: 'met', value: '2/2' });
  });

  it('an approval on an older commit is stale; changes requested blocks on any commit', async () => {
    const old = await evalWith(
      [APPROVALS_1],
      view({ reviews: [review('amy', 'APPROVED', 'MEMBER', OLD)] }),
    );
    expect(old.results[0]).toMatchObject({ status: 'pending', value: '0/1' });

    const onHead = await evalWith(
      [APPROVALS_1],
      view({ reviews: [review('amy', 'APPROVED', 'MEMBER', HEAD)] }),
    );
    expect(onHead.results[0]).toMatchObject({ status: 'met', value: '1/1' });

    // An old CHANGES_REQUESTED still blocks when reviewDecision is empty (no branch protection).
    const oldBlock = await evalWith(
      [APPROVALS_1],
      view({
        reviewDecision: '',
        reviews: [
          review('bob', 'CHANGES_REQUESTED', 'MEMBER', OLD),
          review('amy', 'APPROVED', 'MEMBER', HEAD),
        ],
      }),
    );
    expect(oldBlock.results[0]).toMatchObject({
      status: 'failed',
      value: '1/1',
      detail: 'changes requested by bob',
    });

    // The same reviewer approving on the head clears it.
    const cleared = await evalWith(
      [APPROVALS_1],
      view({
        reviews: [
          review('bob', 'CHANGES_REQUESTED', 'MEMBER', OLD),
          review('bob', 'APPROVED', 'MEMBER', HEAD),
        ],
      }),
    );
    expect(cleared.results[0]).toMatchObject({ status: 'met', value: '1/1' });

    // Approving an OLD commit after requesting changes doesn't clear the block.
    const staleClear = await evalWith(
      [APPROVALS_1],
      view({
        reviews: [
          review('bob', 'CHANGES_REQUESTED', 'MEMBER', OLD),
          review('bob', 'APPROVED', 'MEMBER', OLD),
          review('amy', 'APPROVED', 'MEMBER', HEAD),
        ],
      }),
    );
    expect(staleClear.results[0]).toMatchObject({
      status: 'failed',
      value: '1/1',
      detail: 'changes requested by bob',
    });

    // An approval on the head, then that reviewer's CHANGES_REQUESTED on an older commit → blocked.
    const laterBlock = await evalWith(
      [APPROVALS_1],
      view({
        reviews: [
          review('bob', 'APPROVED', 'MEMBER', HEAD),
          review('bob', 'CHANGES_REQUESTED', 'MEMBER', OLD),
        ],
      }),
    );
    expect(laterBlock.results[0]).toMatchObject({
      status: 'failed',
      detail: 'changes requested by bob',
    });

    // DISMISSED clears a block (no verdict).
    const dismissed = await evalWith(
      [APPROVALS_1],
      view({
        reviews: [
          review('bob', 'CHANGES_REQUESTED', 'MEMBER', OLD),
          review('bob', 'DISMISSED', 'MEMBER', OLD),
          review('amy', 'APPROVED', 'MEMBER', HEAD),
        ],
      }),
    );
    expect(dismissed.results[0]).toMatchObject({ status: 'met', value: '1/1' });

    // GitHub's own decision still wins.
    const decided = await evalWith(
      [APPROVALS_1],
      view({
        reviewDecision: 'CHANGES_REQUESTED',
        reviews: [review('bob', 'CHANGES_REQUESTED', 'MEMBER', OLD), review('amy', 'APPROVED')],
      }),
    );
    expect(decided.results[0]?.status).toBe('failed');
  });

  it('head_sha: a moved PR head fails every PR condition; absent = no head check', async () => {
    const green = view({
      statusCheckRollup: [checkRun('build', 'COMPLETED', 'SUCCESS')],
      reviews: [review('amy', 'APPROVED')],
    });
    const moved = await evalWith(
      [CHECKS, APPROVALS_1, MERGED, { type: 'jira_fields_set', fields: ['x'] }],
      green,
      {},
      { headSha: OLD },
    );
    expect(moved.results.map((x) => x.status)).toEqual([
      'failed',
      'failed',
      'failed',
      'unsupported',
    ]);
    expect(moved.results[0]?.detail).toBe(
      `PR head ${HEAD} isn't the commit conductor checked (${OLD}); someone pushed to the branch`,
    );

    const pinned = await evalWith([CHECKS, APPROVALS_1], green, {}, { headSha: HEAD });
    expect(pinned.results.map((x) => x.status)).toEqual(['met', 'met']);

    const unpinned = await evalWith([CHECKS, APPROVALS_1], green);
    expect(unpinned.results.map((x) => x.status)).toEqual(['met', 'met']);
  });

  it('approvals count the latest verdict per reviewer', async () => {
    const two: Condition = { type: 'pr_approvals', min: 2 };
    const r = await evalWith(
      [two],
      view({
        reviews: [
          review('amy', 'CHANGES_REQUESTED'),
          review('amy', 'APPROVED'), // amy changed her mind
          review('amy', 'COMMENTED'), // a comment doesn't undo it
          review('bob', 'APPROVED'),
          review('bob', 'APPROVED'), // counted once
          review('cy', 'APPROVED'),
          review('cy', 'DISMISSED'),
        ],
      }),
    );
    expect(r.results[0]).toMatchObject({ status: 'met', value: '2/2' });
  });

  it('merged → met, open → pending, closed → failed', async () => {
    const merged = await evalWith(
      [MERGED],
      view({ state: 'MERGED', mergedAt: '2026-10-26T00:00:00Z' }),
    );
    expect(merged.results[0]?.status).toBe('met');
    const open = await evalWith([MERGED], view());
    expect(open.results[0]?.status).toBe('pending');
    const closed = await evalWith([MERGED, APPROVALS_1], view({ state: 'CLOSED' }));
    expect(closed.results.map((x) => x.status)).toEqual(['failed', 'failed']);
  });

  it('results follow the conditions by position; M5 types are unsupported', async () => {
    const r = await evalWith(
      [
        { type: 'azure_pipeline_succeeded', pipeline: 'ci' },
        APPROVALS_1,
        { type: 'pr_approvals', min: 2 },
        { type: 'jira_fields_set', fields: ['status'] },
      ],
      view({ reviews: [review('amy', 'APPROVED')] }),
    );
    expect(r.results.map((x) => [x.type, x.status])).toEqual([
      ['azure_pipeline_succeeded', 'unsupported'],
      ['pr_approvals', 'met'],
      ['pr_approvals', 'pending'],
      ['jira_fields_set', 'unsupported'],
    ]);
  });

  it('only unsupported conditions: gh is not run', async () => {
    const r = await evalWith([{ type: 'jira_fields_set', fields: ['status'] }], view());
    expect(r.results[0]?.status).toBe('unsupported');
    expect(() => readFileSync(join(tmp, 'argv'))).toThrow();
  });

  it('gh missing → every gh condition pending with "gh not available"', async () => {
    const r = await evaluateConditions({
      conditions: [CHECKS, { type: 'pr_merged' }, { type: 'jira_fields_set', fields: ['x'] }],
      prUrl: PR,
      root,
      gh: { cmd: join(tmp, 'no-such-gh'), args: [] },
    });
    expect(r.results.map((x) => x.status)).toEqual(['pending', 'pending', 'unsupported']);
    expect(r.results[0]?.detail).toMatch(/^gh not available: gh \(the GitHub CLI\) is not on PATH/);
  });

  it('gh not logged in → pending with "gh not available"', async () => {
    const r = await evalWith([CHECKS], '', {
      FAKE_GH_EXIT: '4',
      FAKE_GH_ERR: 'To get started with GitHub CLI, please run:  gh auth login',
    });
    expect(r.results[0]).toMatchObject({ status: 'pending' });
    expect(r.results[0]?.detail).toMatch(/^gh not available: .*gh auth login/);
  });

  it('another gh failure → pending with its stderr', async () => {
    const r = await evalWith([CHECKS], '', {
      FAKE_GH_EXIT: '1',
      FAKE_GH_ERR: 'no pull requests found',
    });
    expect(r.results[0]).toMatchObject({
      status: 'pending',
      detail: 'gh pr view failed: no pull requests found',
    });
  });

  it('output over 16 KB is truncated and the conditions stay pending', async () => {
    const big = JSON.stringify(
      view({
        statusCheckRollup: Array.from({ length: 400 }, (_, i) =>
          checkRun(`check-${i}`, 'COMPLETED', 'SUCCESS'),
        ),
      }),
    );
    expect(big.length).toBeGreaterThan(GH_OUTPUT_CAP_BYTES);
    const r = await evalWith([CHECKS], big);
    expect(r.results[0]?.status).toBe('pending');
    expect(r.results[0]?.detail).toContain('more than 16 KB; output truncated');
    expect(r.results[0]?.detail?.length).toBeLessThan(400);
  });

  it('a gh that hangs is killed at the timeout → pending', async () => {
    const r = await evalWith([CHECKS], view(), { FAKE_GH_SLEEP: '5' }, { timeoutMs: 200 });
    expect(r.results[0]).toMatchObject({
      status: 'pending',
      detail: 'gh pr view timed out after 0.2 s',
    });
  }, 10_000);

  it('no PR yet, or a URL that is not a GitHub PR → pending without running gh', async () => {
    const none = await evalWith([CHECKS], view(), {}, { prUrl: null });
    expect(none.results[0]).toMatchObject({ status: 'pending', detail: 'no pull request yet' });
    const bad = await evalWith([CHECKS], view(), {}, { prUrl: 'https://evil.example/pull/1' });
    expect(bad.results[0]?.status).toBe('pending');
    expect(() => readFileSync(join(tmp, 'argv'))).toThrow();
  });

  it('unparseable output → pending', async () => {
    const r = await evalWith([CHECKS], 'not json');
    expect(r.results[0]?.status).toBe('pending');
    expect(r.results[0]?.detail).toContain('unexpected output');
  });
});

describe('condition mapping (pure)', () => {
  it('parsePrView reads the unprojected gh shape too', () => {
    const pr = parsePrView({
      state: 'OPEN',
      mergedAt: '',
      reviewDecision: '',
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          name: 'b',
          status: 'COMPLETED',
          conclusion: 'NEUTRAL',
          detailsUrl: 'x',
        },
        { __typename: 'StatusContext', context: 'c', state: 'SUCCESS', targetUrl: 'y' },
      ],
      author: { login: 'pat', name: 'Pat' },
      headRefOid: HEAD,
      reviews: [
        {
          author: { login: 'amy', name: 'Amy' },
          authorAssociation: 'COLLABORATOR',
          state: 'APPROVED',
          commit: { oid: HEAD, url: 'x' },
          body: 'lgtm',
        },
      ],
    });
    expect(pr.merged).toBe(false);
    expect(mapCondition(CHECKS, pr).status).toBe('met');
    expect(mapCondition(APPROVALS_1, pr).status).toBe('met');
    expect(() => parsePrView([])).toThrow();
  });
});
