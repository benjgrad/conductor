import { describe, expect, it } from 'vitest';
import {
  AccountScopeSchema,
  AuthModeSchema,
  branchSlug,
  isSafeBranchName,
  jiraKey,
  LOCAL_ACCOUNT_ID,
  LOCAL_USER_ID,
  localScope,
  NON_JIRA_KEY_PREFIXES,
  sessionBranch,
  UuidSchema,
} from './domain.js';

describe('account scope', () => {
  it('localScope is the local account with the given actor', () => {
    for (const actor of [
      { kind: 'system' as const },
      { kind: 'user' as const, user_id: 'u1' },
      { kind: 'machine' as const, machine_id: 'm1' },
    ]) {
      const scope = localScope(actor);
      expect(AccountScopeSchema.parse(scope)).toEqual({ account_id: LOCAL_ACCOUNT_ID, actor });
    }
  });

  it('refuses an unknown actor kind and a non-uuid account', () => {
    expect(
      AccountScopeSchema.safeParse({ account_id: LOCAL_ACCOUNT_ID, actor: { kind: 'admin' } })
        .success,
    ).toBe(false);
    expect(
      AccountScopeSchema.safeParse({ account_id: 'local', actor: { kind: 'system' } }).success,
    ).toBe(false);
  });

  it('the local ids are RFC 9562-valid uuids', () => {
    expect(LOCAL_ACCOUNT_ID).toBe('00000000-0000-4000-8000-000000000001');
    expect(LOCAL_USER_ID).toBe('00000000-0000-4000-8000-000000000002');
    expect(UuidSchema.safeParse(LOCAL_ACCOUNT_ID).success).toBe(true);
    expect(UuidSchema.safeParse(LOCAL_USER_ID).success).toBe(true);
  });

  it('AuthMode is local or password', () => {
    expect(AuthModeSchema.options).toEqual(['local', 'password']);
  });
});

describe('sessionBranch', () => {
  const SID = '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f';
  const t = (title: string, external_ref: string | null = null, body = '') => ({
    title,
    external_ref,
    body,
  });

  it.each([
    [
      'no Jira key: conductor/<slug>-<short>',
      t('Branch names should be logical'),
      'conductor/branch-names-should-be-logical-7d0c5b',
    ],
    [
      'key from external_ref',
      t('Fix login redirect', 'PROJ-123'),
      'PROJ-123-fix-login-redirect-7d0c5b',
    ],
    [
      'key from an external_ref Jira URL',
      t('Fix login', 'https://x.atlassian.net/browse/PROJ-123'),
      'PROJ-123-fix-login-7d0c5b',
    ],
    [
      'key at the start of the title, not repeated',
      t('PROJ-12: Fix login'),
      'PROJ-12-fix-login-7d0c5b',
    ],
    ['bracketed key in the title', t('[PROJ-12] Fix login'), 'PROJ-12-fix-login-7d0c5b'],
    ['key in the middle of the title', t('Fix login (ABC-9)'), 'ABC-9-fix-login-7d0c5b'],
    [
      'Jira URL in the body',
      t('Fix login', null, 'See https://x.atlassian.net/browse/OPS-4 for it'),
      'OPS-4-fix-login-7d0c5b',
    ],
    [
      'a bare key in the body is not a Jira reference',
      t('Fix login', null, 'Per ADR-0031 and WEB-3'),
      'conductor/fix-login-7d0c5b',
    ],
    [
      'ADR-0031 in the title is not a Jira key',
      t('Implement ADR-0031'),
      'conductor/implement-adr-0031-7d0c5b',
    ],
    [
      'UTF-8 in the title is not a Jira key',
      t('Read files as UTF-8'),
      'conductor/read-files-as-utf-8-7d0c5b',
    ],
    ['unicode is ASCII-folded', t('Café crème'), 'conductor/cafe-creme-7d0c5b'],
    ['emoji-only title', t('🚀🔥'), 'conductor/ticket-7d0c5b'],
    ['empty title', t(''), 'conductor/ticket-7d0c5b'],
  ])('%s', (_name, ticket, want) => {
    expect(sessionBranch(ticket, SID)).toBe(want);
  });

  it('is deterministic and unique per session', () => {
    const ticket = t('Add /health');
    expect(sessionBranch(ticket, SID)).toBe(sessionBranch(ticket, SID));
    expect(sessionBranch(ticket, SID)).not.toBe(
      sessionBranch(ticket, '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2'),
    );
  });

  it('is always a safe git branch name', () => {
    for (const title of [
      '..',
      'x.lock',
      '-leading dash',
      '/slash/',
      'a//b/../c',
      '日本語のタイトル',
      'Ünïcödé — “quotes” & <tags>',
      'word '.repeat(50),
      'PROJ-1: ..lock',
      '',
    ]) {
      for (const ref of [null, 'PROJ-99']) {
        const b = sessionBranch(t(title, ref), SID);
        expect(isSafeBranchName(b), b).toBe(true);
      }
    }
  });
});

describe('branchSlug', () => {
  it('cuts long titles at a word boundary, at most 40 chars', () => {
    const s = branchSlug('Make the scheduler fair across many machines and accounts please');
    expect(s).toBe('make-the-scheduler-fair-across-many');
    expect(s.length).toBeLessThanOrEqual(40);
  });

  it('cuts a single long word hard', () => {
    expect(branchSlug('a'.repeat(60))).toBe('a'.repeat(40));
  });
});

describe('jiraKey', () => {
  it('prefers external_ref, then a Jira URL, then the title', () => {
    expect(jiraKey({ title: 'ABC-1 x', external_ref: 'XYZ-2' })).toBe('XYZ-2');
    expect(jiraKey({ title: 'ABC-1 x', external_ref: null, body: 'https://j/browse/URL-3' })).toBe(
      'URL-3',
    );
    expect(jiraKey({ title: 'ABC-1 x', external_ref: null })).toBe('ABC-1');
    expect(jiraKey({ title: 'x', external_ref: 'not a key' })).toBeNull();
  });

  it('skips non-Jira prefixes in the title only', () => {
    for (const p of NON_JIRA_KEY_PREFIXES) {
      expect(jiraKey({ title: `${p}-12 thing`, external_ref: null }), p).toBeNull();
    }
    expect(jiraKey({ title: 'x', external_ref: 'ADR-12' })).toBe('ADR-12');
    expect(jiraKey({ title: 'ISO-8601 dates, then PROJ-5', external_ref: null })).toBe('PROJ-5');
  });
});
