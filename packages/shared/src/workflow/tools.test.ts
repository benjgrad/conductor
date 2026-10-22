import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GUARD_REGISTRY, isRegisteredGuard } from './guards.js';
import { WorkflowDefinitionSchema } from './schema.js';
import {
  isToolAlias,
  resolveToolPolicy,
  TOOL_ALIAS_NAMES,
  UnknownToolAliasError,
} from './tools.js';

const wf = (name: string) =>
  WorkflowDefinitionSchema.parse(
    JSON.parse(
      readFileSync(new URL(`../../../../docs/design/workflows/${name}`, import.meta.url), 'utf8'),
    ),
  );

describe('TOOL_ALIASES (ADR-0005 ToolPolicy)', () => {
  it('covers every tool name in both reference workflows', () => {
    for (const def of [wf('m1_basic.v1.json'), wf('pr_flow.v1.json')]) {
      for (const st of Object.values(def.states)) {
        if (st.type === 'agent') for (const t of st.tools ?? []) expect(isToolAlias(t)).toBe(true);
      }
    }
    expect(TOOL_ALIAS_NAMES).toEqual(expect.arrayContaining(['edit', 'bash', 'git', 'pr_skill']));
  });

  it('scopes file tools to the worktree and never allows a bare Edit/Write', () => {
    const p = resolveToolPolicy(['edit', 'bash', 'git']);
    expect(p.allow).toContain('Edit(./**)');
    expect(p.allow).toContain('Write(./**)');
    expect(p.allow).not.toContain('Edit');
    expect(p.allow).not.toContain('Write');
    expect(p.builtin).toEqual(expect.arrayContaining(['Read', 'Edit', 'Write', 'Bash']));
    expect(
      p.allow.filter((r) => r.startsWith('Bash')).every((r) => /^Bash\(.+:\*\)$/.test(r)),
    ).toBe(true);
  });

  it('always denies git push, even with only the read base', () => {
    for (const tools of [[], ['git'], ['pr_skill', 'bash']]) {
      const p = resolveToolPolicy(tools);
      expect(p.deny).toContain('Bash(git push:*)');
      expect(p.allow.some((r) => r.includes('git push'))).toBe(false);
    }
    expect(resolveToolPolicy([]).builtin).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('de-duplicates and rejects unknown names', () => {
    const p = resolveToolPolicy(['git', 'git', 'bash']);
    expect(new Set(p.builtin).size).toBe(p.builtin.length);
    expect(() => resolveToolPolicy(['edit', 'WebFetch'])).toThrow(UnknownToolAliasError);
  });
});

describe('guard registry', () => {
  it('is empty in M1, so pr_flow`s branch_has_commits is unregistered (validator error)', () => {
    expect(Object.keys(GUARD_REGISTRY)).toEqual([]);
    expect(isRegisteredGuard('branch_has_commits')).toBe(false);
    expect(isRegisteredGuard('ok', { ok: () => true })).toBe(true);
    expect(isRegisteredGuard('toString')).toBe(false);
  });
});
