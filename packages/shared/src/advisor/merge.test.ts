import { describe, expect, it } from 'vitest';
import type { RepoChecks } from '../workflow/repo-checks.js';
import { mergeRepoChecks, mergeWorkflow } from './merge.js';

// ADR-0033 §Amendment "apply rebases": a proposal's changes replayed onto what is there now. Pure.

const base = () => ({
  id: 'w',
  version: 1,
  start: 'a',
  columns: ['a', 'b'],
  states: {
    a: { type: 'agent', title: 'A', prompt: 'do it', on: { done: 'b', fail: { goto: 'c' } } },
    b: { type: 'event', title: 'B', on: { 'ui.approve': { goto: 'c', actor: 'human' } } },
    c: { type: 'terminal', title: 'C' },
  },
});
type Def = ReturnType<typeof base>;
const edit = (f: (d: Def) => void, version = 1): Def => {
  const d = base();
  d.version = version;
  f(d);
  return d;
};

describe('mergeWorkflow', () => {
  it('replays disjoint edits onto the latest version', () => {
    const ours = edit((d) => (d.states.a.title = 'Plan it'));
    const theirs = edit((d) => {
      (d.states.b.on as Record<string, unknown>).done = { goto: 'c', actor: 'human' };
    }, 2);
    const res = mergeWorkflow(base(), ours, theirs);
    expect(res.ok && res.applied).toBe(1);
    expect(res.ok && res.merged.states).toMatchObject({
      a: { title: 'Plan it' },
      b: { on: { done: { goto: 'c', actor: 'human' }, 'ui.approve': { goto: 'c' } } },
    });
  });

  it('merges two different transitions added to the same state, in any order', () => {
    const one = edit((d) => ((d.states.b.on as Record<string, unknown>).done = 'c'));
    const two = edit((d) => ((d.states.b.on as Record<string, unknown>).back = 'a'));
    const ab = mergeWorkflow(base(), two, one);
    const ba = mergeWorkflow(base(), one, two);
    expect(ab.ok && ab.merged.states).toEqual(ba.ok && ba.merged.states);
    expect(ab.ok && Object.keys(ab.merged.states as object)).toEqual(['a', 'b', 'c']);
    expect(ab.ok && (ab.merged.states as Def['states']).b.on).toMatchObject({
      done: 'c',
      back: 'a',
    });
  });

  it('an edit that is already there writes nothing', () => {
    const ours = edit((d) => (d.states.a.title = 'X'));
    const res = mergeWorkflow(
      base(),
      ours,
      edit((d) => (d.states.a.title = 'X'), 2),
    );
    expect(res).toMatchObject({ ok: true, applied: 0 });
  });

  it('the same path changed differently is a conflict naming it', () => {
    const ours = edit((d) => (d.states.a.title = 'X'));
    const theirs = edit((d) => (d.states.a.title = 'Y'), 2);
    expect(mergeWorkflow(base(), ours, theirs)).toEqual({
      ok: false,
      conflicts: ['states.a.title'],
    });
  });

  it('editing inside a state the latest removed is a conflict', () => {
    const ours = edit((d) => ((d.states.c as Record<string, unknown>).on = { x: 'a' }));
    const theirs = edit((d) => {
      delete (d.states as Record<string, unknown>).c;
    }, 2);
    const res = mergeWorkflow(base(), ours, theirs);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.conflicts).toEqual(['states.c.on']);
  });

  it('removing what the latest changed is a conflict', () => {
    const ours = edit((d) => {
      delete (d.states.a.on as Record<string, unknown>).fail;
    });
    const theirs = edit((d) => (d.states.a.on.fail = { goto: 'b' }), 2);
    expect(mergeWorkflow(base(), ours, theirs)).toEqual({
      ok: false,
      conflicts: ['states.a.on.fail'],
    });
  });

  it('a transition name with a dot is one path segment', () => {
    const ours = edit((d) => (d.states.b.on['ui.approve'].goto = 'a'));
    const theirs = edit((d) => (d.states.a.prompt = 'new'), 2);
    const res = mergeWorkflow(base(), ours, theirs);
    expect(res.ok && res.merged.states).toMatchObject({
      a: { prompt: 'new' },
      b: { on: { 'ui.approve': { goto: 'a', actor: 'human' } } },
    });
    expect(res.ok && 'ui' in ((res.merged.states as Def['states']).b.on as object)).toBe(false);
  });

  it('arrays are compared whole', () => {
    const ours = edit((d) => d.columns.push('c'));
    const theirs = edit((d) => d.columns.unshift('z'), 2);
    expect(mergeWorkflow(base(), ours, theirs)).toEqual({ ok: false, conflicts: ['columns'] });
  });

  it('ignores version and leaves it out of the result', () => {
    const res = mergeWorkflow(
      base(),
      edit(() => {}, 5),
      edit(() => {}, 7),
    );
    expect(res).toMatchObject({ ok: true, applied: 0 });
    expect(res.ok && 'version' in res.merged).toBe(false);
  });
});

describe('mergeRepoChecks', () => {
  const checks = (setup: string | undefined, ...cmds: string[]): RepoChecks => ({
    ...(setup === undefined ? {} : { setup }),
    checks: cmds.map((cmd) => ({ name: cmd, cmd })),
  });

  it('a setup edit and a checks edit merge', () => {
    const res = mergeRepoChecks(
      checks('i', 'test'),
      checks('i2', 'test'),
      checks('i', 'test', 'lint'),
    );
    expect(res).toEqual({ ok: true, merged: checks('i2', 'test', 'lint'), applied: 1 });
  });

  it('the same setup edit twice writes nothing; different ones conflict', () => {
    expect(mergeRepoChecks(checks('i', 't'), checks('j', 't'), checks('j', 't'))).toMatchObject({
      ok: true,
      applied: 0,
    });
    expect(mergeRepoChecks(checks('i', 't'), checks('j', 't'), checks('k', 't'))).toEqual({
      ok: false,
      conflicts: ['setup'],
    });
  });

  it('adding a setup where there was none', () => {
    const res = mergeRepoChecks(
      checks(undefined, 't'),
      checks('s', 't'),
      checks(undefined, 't', 'u'),
    );
    expect(res).toEqual({ ok: true, merged: checks('s', 't', 'u'), applied: 1 });
  });

  it('two edits to the checks list conflict (compared whole)', () => {
    const res = mergeRepoChecks(checks('i', 't'), checks('i', 't', 'a'), checks('i', 't', 'b'));
    expect(res).toEqual({ ok: false, conflicts: ['checks'] });
  });

  it('clearing merges only when the override is unchanged', () => {
    expect(mergeRepoChecks(checks('i', 't'), null, checks('i', 't'))).toEqual({
      ok: true,
      merged: null,
      applied: 1,
    });
    expect(mergeRepoChecks(checks('i', 't'), null, checks('j', 't'))).toEqual({
      ok: false,
      conflicts: ['override'],
    });
  });

  it('an override made since, when there was none, conflicts unless it is the same', () => {
    expect(mergeRepoChecks(null, checks('i', 't'), checks('j', 't'))).toEqual({
      ok: false,
      conflicts: ['override'],
    });
    expect(mergeRepoChecks(null, checks('i', 't'), checks('i', 't'))).toMatchObject({
      ok: true,
      applied: 0,
    });
  });
});
