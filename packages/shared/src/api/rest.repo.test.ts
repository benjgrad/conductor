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
