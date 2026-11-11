// R11: what a GitHub delivery points at, and which sessions it wakes (event → sessions). Pure.
import { describe, expect, it } from 'vitest';
import {
  normPrUrl,
  sessionsToNudge,
  webhookTarget,
  type NudgeCandidate,
  type WebhookTarget,
} from '../../src/github-webhook/events.js';

const repository = { full_name: 'Acme/App' };
const PR7 = 'https://github.com/acme/app/pull/7';

describe('webhookTarget', () => {
  it('check_suite completed: the repo, its PRs by number and the head branch', () => {
    expect(
      webhookTarget('check_suite', {
        action: 'completed',
        repository,
        check_suite: { head_branch: 'conductor/fix-1', pull_requests: [{ number: 7 }] },
      }),
    ).toEqual({
      repo: 'github.com/acme/app',
      prUrls: [PR7],
      branches: ['conductor/fix-1'],
      repoMerged: false,
    });
  });

  it('check_run completed with no pull_requests (a fork) matches by branch only', () => {
    expect(
      webhookTarget('check_run', {
        action: 'completed',
        repository,
        check_run: { check_suite: { head_branch: 'feat-x' }, pull_requests: [] },
      }),
    ).toEqual({ repo: 'github.com/acme/app', prUrls: [], branches: ['feat-x'], repoMerged: false });
  });

  it('a check that has not completed changes nothing', () => {
    for (const action of ['created', 'requested', 'rerequested', 'in_progress']) {
      expect(
        webhookTarget('check_run', { action, repository, check_run: { pull_requests: [] } }),
      ).toBeNull();
      expect(
        webhookTarget('check_suite', { action, repository, check_suite: { head_branch: 'x' } }),
      ).toBeNull();
    }
  });

  const pr = (merged: boolean) => ({
    html_url: 'https://github.com/Acme/App/pull/7/',
    head: { ref: 'conductor/fix-1' },
    merged,
  });

  it('pull_request closed and merged: the PR, its branch, and the repo moved', () => {
    expect(
      webhookTarget('pull_request', { action: 'closed', repository, pull_request: pr(true) }),
    ).toEqual({
      repo: 'github.com/acme/app',
      prUrls: [PR7],
      branches: ['conductor/fix-1'],
      repoMerged: true,
    });
  });

  it('pull_request closed unmerged, or synchronize: the PR only', () => {
    for (const action of ['closed', 'synchronize', 'reopened', 'ready_for_review']) {
      expect(
        webhookTarget('pull_request', { action, repository, pull_request: pr(false) })?.repoMerged,
      ).toBe(false);
    }
  });

  it('pull_request actions that settle nothing are ignored', () => {
    for (const action of ['opened', 'labeled', 'assigned', 'review_requested']) {
      expect(
        webhookTarget('pull_request', { action, repository, pull_request: pr(false) }),
      ).toBeNull();
    }
  });

  it('pull_request_review submitted or dismissed: the PR, never a repo move', () => {
    expect(
      webhookTarget('pull_request_review', {
        action: 'submitted',
        repository,
        pull_request: pr(true),
      }),
    ).toEqual({
      repo: 'github.com/acme/app',
      prUrls: [PR7],
      branches: ['conductor/fix-1'],
      repoMerged: false,
    });
    expect(
      webhookTarget('pull_request_review', {
        action: 'dismissed',
        repository,
        pull_request: pr(false),
      }),
    ).not.toBeNull();
  });

  it('other events and malformed payloads give null', () => {
    expect(webhookTarget('push', { ref: 'refs/heads/main', repository })).toBeNull();
    expect(webhookTarget('ping', { zen: 'Keep it logically awesome.' })).toBeNull();
    expect(webhookTarget('check_suite', { action: 'completed' })).toBeNull();
    expect(
      webhookTarget('pull_request', { action: 'closed', repository, pull_request: {} }),
    ).toBeNull();
    expect(webhookTarget('check_suite', null)).toBeNull();
    expect(
      webhookTarget('check_suite', {
        action: 'completed',
        repository: { full_name: 'no-slash' },
        check_suite: {},
      }),
    ).toBeNull();
  });
});

describe('normPrUrl', () => {
  it('lower-cases and drops trailing slashes', () => {
    expect(normPrUrl(' https://github.com/Acme/App/pull/7// ')).toBe(PR7);
  });
});

describe('sessionsToNudge', () => {
  const target: WebhookTarget = {
    repo: 'github.com/acme/app',
    prUrls: [PR7],
    branches: ['conductor/fix-1'],
    repoMerged: false,
  };
  const c = (id: string, o: Partial<NudgeCandidate>): NudgeCandidate => ({
    id,
    repo: 'github.com/acme/app',
    pr_url: null,
    branch: null,
    conditions_pending: false,
    watching: false,
    ...o,
  });
  const candidates = [
    // (a) a PR gate waiting on its conditions, matched by PR (stored with another case)
    c('a', { pr_url: 'https://github.com/Acme/App/pull/7', conditions_pending: true }),
    // (b) matched by branch only, the ticket's repo stored as a URL
    c('b', { repo: 'https://github.com/Acme/App.git', branch: 'conductor/fix-1', watching: true }),
    // (c) watched in review with the PR
    c('c', { pr_url: PR7, watching: true }),
    // (d) watched on the same repo, another PR
    c('d', { pr_url: 'https://github.com/acme/app/pull/8', branch: 'other', watching: true }),
    // (e) same PR number and branch on another repo
    c('e', {
      repo: 'github.com/acme/other',
      pr_url: 'https://github.com/acme/other/pull/7',
      branch: 'conductor/fix-1',
      conditions_pending: true,
      watching: true,
    }),
    // (f) matched, but nothing ahead to bring forward
    c('f', { pr_url: PR7 }),
  ];

  it('wakes the matching conditions phase and the matching watches only', () => {
    expect(sessionsToNudge(target, candidates)).toEqual({
      conditions: ['a'],
      watches: ['b', 'c'],
    });
  });

  it('a merge wakes every watch on the repo, conditions only where they match', () => {
    expect(sessionsToNudge({ ...target, repoMerged: true }, candidates)).toEqual({
      conditions: ['a'],
      watches: ['b', 'c', 'd'],
    });
  });

  it('a target without PRs or branches wakes nothing unless the repo moved', () => {
    expect(sessionsToNudge({ ...target, prUrls: [], branches: [] }, candidates)).toEqual({
      conditions: [],
      watches: [],
    });
  });
});
