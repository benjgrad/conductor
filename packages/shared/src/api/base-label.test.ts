import { describe, expect, it } from 'vitest';
import { baseLabel } from './base-label.js';

const SHA = 'a1b2c3d'.padEnd(40, '0');
const DEF = {
  bases: { sprint: { cmd: 'echo x' }, master: { ref: 'master' } },
  base_default: { work: 'sprint' },
};

describe('baseLabel (ADR-0039, B3)', () => {
  it('a started session: name, ref and short sha', () => {
    const ref = { name: 'sprint', ref: 'ncng-26-sb-2', sha: SHA, pr_into: null };
    expect(baseLabel('sprint', ref, null, 'work')).toEqual({
      text: 'sprint (ncng-26-sb-2 @ a1b2c3d)',
      short: 'sprint',
      explicit: true,
    });
    expect(baseLabel(null, { ...ref, sha: null }, null, null).text).toBe('sprint (ncng-26-sb-2)');
  });

  it('a commit base with a PR target, and an explicit ref with no name', () => {
    const ref = { name: 'hotfix', ref: SHA, sha: SHA, pr_into: 'master' };
    expect(baseLabel(null, ref, null, null).text).toBe(
      `hotfix (${SHA} @ a1b2c3d) → PR into master`,
    );
    const anon = { name: null, ref: 'release/1', sha: SHA, pr_into: null };
    expect(baseLabel(null, anon, null, null)).toMatchObject({
      text: 'release/1 @ a1b2c3d',
      short: 'release/1',
    });
  });

  it('before a start: the ticket’s own base', () => {
    expect(baseLabel('sprint', null, DEF, 'work').text).toBe('sprint (resolved at start)');
    expect(baseLabel({ ref: 'master' }, null, null, null)).toEqual({
      text: 'master',
      short: 'master',
      explicit: true,
    });
    expect(baseLabel({ ref: SHA, pr_into: 'master' }, null, null, null).text).toBe(
      'a1b2c3d → PR into master',
    );
  });

  it('no base of its own: the kind’s default, else the default branch', () => {
    expect(baseLabel(null, null, DEF, 'work')).toEqual({
      text: 'sprint (default for work, resolved at start)',
      short: 'sprint',
      explicit: false,
    });
    expect(baseLabel(null, null, DEF, 'personal')).toMatchObject({
      text: 'default branch',
      explicit: false,
    });
    expect(baseLabel(null, null, null, null).text).toBe('default branch');
  });
});
