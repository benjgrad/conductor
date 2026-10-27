import { describe, expect, it } from 'vitest';
import { canonicalRepo, TicketDtoSchema } from './rest.js';

describe('canonicalRepo', () => {
  it.each([
    'git@github.com:org/app.git',
    'git@github.com:org/app',
    'https://github.com/org/app',
    'https://github.com/org/app.git',
    'https://github.com/org/app/',
    'ssh://git@github.com/org/app.git',
    'github.com/org/app',
    'github.com/org/app.git',
    'GitHub.com/org/app',
  ])('%s → github.com/org/app', (repo) => {
    expect(canonicalRepo(repo)).toBe('github.com/org/app');
  });

  it.each([
    ['https://GitHub.com/Org/App.GIT', 'github.com/Org/App'],
    ['git@GITHUB.COM:Org/App.Git', 'github.com/Org/App'],
    ['ssh://git@GitHub.com/org/app.GIT/', 'github.com/org/app'],
    ['github.com/org/app.Git', 'github.com/org/app'],
  ])('strips .git case-insensitively: %s → %s', (repo, out) => {
    expect(canonicalRepo(repo)).toBe(out);
  });

  it.each([
    'github.com/org/app.git.git',
    'https://github.com/org/app.GIT.git',
    'git@github.com:org/app.git.GIT',
    'github.com/org/.git',
  ])('refuses a name still ending in .git after one strip: %s', (repo) => {
    expect(canonicalRepo(repo)).toBeNull();
  });

  it('keeps path case and subgroups', () => {
    expect(canonicalRepo('gitlab.com/Group/Sub/App')).toBe('gitlab.com/Group/Sub/App');
  });

  it.each([
    'ext::sh -c x',
    'ext::sh',
    '../x',
    './x',
    '/tmp/x',
    'file:///x',
    'http://github.com/org/app',
    'git://github.com/org/app',
    'https://tok@github.com/org/app',
    'https://github.com:8443/org/app',
    'https://github.com/org/app?x=1',
    'github.com/app',
    'github.com/org/../app',
    'github.com:org/app',
    '-x/y/z',
    '',
    'github.com/org/app\n',
  ])('%j → null', (repo) => {
    expect(canonicalRepo(repo)).toBeNull();
  });
});

describe('canonicalRepo properties', () => {
  const hosts = ['github.com', 'GitHub.com', 'GITHUB.COM', 'gitlab.example.org'];
  const paths = ['org/app', 'Org/App', 'group/sub/App_1', 'o-r/a.b'];
  const suffixes = ['', '.git', '.GIT', '.Git', '.git.git', '/', '.git/'];
  const inputs = hosts.flatMap((h) =>
    paths.flatMap((p) =>
      suffixes.flatMap((sfx) => [
        `${h}/${p}${sfx}`,
        `https://${h}/${p}${sfx}`,
        `git@${h}:${p}${sfx}`,
        `ssh://git@${h}/${p}${sfx}`,
      ]),
    ),
  );
  const GRAMMAR =
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*){2,}$/;

  it('is idempotent', () => {
    for (const x of inputs) {
      const once = canonicalRepo(x);
      expect(once === null ? null : canonicalRepo(once), x).toBe(once);
    }
  });

  it('every non-null output is lower-case-host host/org/repo, not ending in .git', () => {
    let nonNull = 0;
    for (const x of inputs) {
      const out = canonicalRepo(x);
      if (out === null) continue;
      nonNull++;
      expect(out, x).toMatch(GRAMMAR);
      expect(out.toLowerCase().endsWith('.git'), x).toBe(false);
    }
    expect(nonNull).toBeGreaterThan(inputs.length / 2);
  });
});

describe('TicketDto.warnings', () => {
  const ticket = {
    id: '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2',
    external_ref: null,
    repo: 'github.com/org/app',
    title: 't',
    body: '',
    workflow_id: 'conductor',
    workflow_version: null,
    required_tags: [],
    repo_allow_machines: null,
    status: 'ready',
    priority: 0,
    created_at: '2026-10-22T12:00:00.000Z',
  };

  it('is optional and accepts no_machine_has_repo only', () => {
    expect(TicketDtoSchema.parse(ticket).warnings).toBeUndefined();
    expect(
      TicketDtoSchema.parse({ ...ticket, warnings: ['no_machine_has_repo'] }).warnings,
    ).toEqual(['no_machine_has_repo']);
    expect(TicketDtoSchema.safeParse({ ...ticket, warnings: ['other'] }).success).toBe(false);
  });
});
