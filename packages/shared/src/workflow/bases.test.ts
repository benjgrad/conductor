import { describe, expect, it } from 'vitest';
import {
  baseSubstitutionFields,
  baseTokenUses,
  cmdBaseCapability,
  substituteBase,
  usesBaseToken,
} from './bases.js';
import {
  BaseNameSchema,
  BaseSpecSchema,
  PlanBaseSchema,
  SessionBaseSchema,
  TicketBaseSchema,
  WorkflowDefinitionSchema,
} from './schema.js';

// ADR-0039 (B1): the base-ref schemas and the pure helpers.

const SHA = 'a'.repeat(40);
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;

describe('base schemas', () => {
  it('BaseName is a lower-case slug', () => {
    for (const n of ['sprint', 'hot-fix', 'sb_1', 'm2']) expect(ok(BaseNameSchema, n)).toBe(true);
    for (const n of ['', 'Sprint', '1x', '-x', 'a b', 'x'.repeat(41)]) {
      expect(ok(BaseNameSchema, n)).toBe(false);
    }
  });

  it('BaseSpec: {ref} a branch or $default_branch; {cmd, timeout?, pr_into?}', () => {
    expect(ok(BaseSpecSchema, { ref: '$default_branch' })).toBe(true);
    expect(ok(BaseSpecSchema, { ref: 'master' })).toBe(true);
    expect(ok(BaseSpecSchema, { ref: 'release/2026-11' })).toBe(true);
    expect(ok(BaseSpecSchema, { cmd: 'git rev-parse x', timeout: '1m', pr_into: 'master' })).toBe(
      true,
    );
    expect(ok(BaseSpecSchema, { ref: '$other' })).toBe(false);
    expect(ok(BaseSpecSchema, { ref: 'a..b' })).toBe(false);
    expect(ok(BaseSpecSchema, { ref: '-x' })).toBe(false);
    expect(ok(BaseSpecSchema, { cmd: ' ' })).toBe(false);
    expect(ok(BaseSpecSchema, { cmd: 'x', timeout: 'soon' })).toBe(false);
    expect(ok(BaseSpecSchema, { ref: 'main', cmd: 'x' })).toBe(false);
    expect(ok(BaseSpecSchema, {})).toBe(false);
  });

  it('a workflow parses with bases and base_default per kind', () => {
    const base = {
      id: 'w',
      version: 1,
      start: 'a',
      budget: { usd: 1, minutes: 1, max_loop_retries: 1 },
      states: { a: { type: 'terminal' } },
    };
    const parse = (extra: object) =>
      WorkflowDefinitionSchema.safeParse({ ...base, ...extra }).success;
    expect(parse({ bases: { sprint: { ref: 'main' } }, base_default: { work: 'sprint' } })).toBe(
      true,
    );
    expect(parse({ base_default: { other: 'sprint' } })).toBe(false);
    expect(parse({ bases: { Bad: { ref: 'main' } } })).toBe(false);
  });

  it('TicketBase: a name, or {ref, pr_into?} where a sha needs pr_into', () => {
    expect(ok(TicketBaseSchema, 'hotfix')).toBe(true);
    expect(ok(TicketBaseSchema, { ref: 'master' })).toBe(true);
    expect(ok(TicketBaseSchema, { ref: SHA, pr_into: 'master' })).toBe(true);
    expect(ok(TicketBaseSchema, { ref: SHA })).toBe(false);
    expect(ok(TicketBaseSchema, 'Not A Name')).toBe(false);
    expect(ok(TicketBaseSchema, { ref: 'master', extra: 1 })).toBe(false);
  });

  it('PlanBase: exactly one of name / ref, a reason, a sha needs pr_into', () => {
    expect(ok(PlanBaseSchema, { name: 'master', reason: 'spans three Jira tickets' })).toBe(true);
    expect(ok(PlanBaseSchema, { ref: SHA, pr_into: 'master', reason: 'hotfix' })).toBe(true);
    expect(ok(PlanBaseSchema, { name: 'master', ref: 'master', reason: 'x' })).toBe(false);
    expect(ok(PlanBaseSchema, { reason: 'x' })).toBe(false);
    expect(ok(PlanBaseSchema, { name: 'master' })).toBe(false);
    expect(ok(PlanBaseSchema, { ref: SHA, reason: 'x' })).toBe(false);
  });

  it('SessionBase: {name, ref, sha, pr_into}', () => {
    expect(ok(SessionBaseSchema, { name: 'sprint', ref: 'x-sb-1', sha: SHA, pr_into: null })).toBe(
      true,
    );
    expect(ok(SessionBaseSchema, { name: null, ref: 'main', sha: 'abc', pr_into: null })).toBe(
      false,
    );
  });
});

describe('$base tokens', () => {
  it('matches $base and $base_sha, not $basement or ${base}', () => {
    expect(usesBaseToken('git merge origin/$base')).toBe(true);
    expect(usesBaseToken('git diff $base_sha..HEAD')).toBe(true);
    expect(usesBaseToken('$base')).toBe(true);
    expect(usesBaseToken('echo $basement')).toBe(false);
    expect(usesBaseToken('echo ${base}')).toBe(false);
    expect(usesBaseToken('echo $base_shark')).toBe(false);
  });

  it('substitutes both tokens and leaves the rest', () => {
    expect(
      substituteBase('merge origin/$base; diff $base_sha..HEAD; $basement ${base}', {
        base: 'master',
        base_sha: SHA,
      }),
    ).toBe(`merge origin/master; diff ${SHA}..HEAD; $basement \${base}`);
  });

  it('walks every substitution site and skips $instructions refs', () => {
    const def = WorkflowDefinitionSchema.parse({
      id: 'w',
      version: 1,
      start: 'a',
      budget: { usd: 1, minutes: 1, max_loop_retries: 1 },
      instructions: { resync: 'merge origin/$base' },
      states: {
        a: {
          type: 'agent',
          prompt: 'p',
          on: {
            done: {
              goto: 'b',
              requires: {
                checks: [{ name: 'c', cmd: 'git merge-base --is-ancestor origin/$base HEAD' }],
                conditions: [{ type: 'cmd', name: 'n', cmd: 'test $base_sha' }],
                condition_timeout: '1h',
              },
              on_unmet: { goto: 'a', instruction: 'rebase on $base', else: 'b' },
            },
            other: {
              goto: 'b',
              on_unmet: { goto: 'a', instruction: '$instructions.resync', else: 'b' },
            },
          },
        },
        b: {
          type: 'human',
          on: { go: { goto: 'c', actor: 'human' } },
          watch: {
            conditions: [{ type: 'cmd', name: 'w', cmd: 'echo $base' }],
            on_broken: { goto: 'a', instruction: 'plain text' },
          },
        },
        c: { type: 'terminal' },
      },
    });
    expect(baseSubstitutionFields(def).map(([p]) => p.join('.'))).toEqual(
      expect.arrayContaining(['instructions.resync', 'states.b.watch.on_broken.instruction']),
    );
    expect(
      baseTokenUses(def)
        .map((p) => p.join('.'))
        .sort(),
    ).toEqual(
      [
        'instructions.resync',
        'states.a.on.done.on_unmet.instruction',
        'states.a.on.done.requires.checks.0.cmd',
        'states.a.on.done.requires.conditions.0.cmd',
        'states.b.watch.conditions.0.cmd',
      ].sort(),
    );
  });
});

describe('cmdBaseCapability', () => {
  it('az as a command word needs cli:az:authed; anything else needs nothing', () => {
    expect(cmdBaseCapability('az pipelines runs list')).toBe('cli:az:authed');
    expect(cmdBaseCapability('x=$(az repos ref list) && echo $x')).toBe('cli:az:authed');
    expect(cmdBaseCapability('git fetch && az boards query')).toBe('cli:az:authed');
    expect(cmdBaseCapability('git ls-remote --heads origin')).toBeNull();
    expect(cmdBaseCapability('echo hazard ')).toBeNull();
  });
});
