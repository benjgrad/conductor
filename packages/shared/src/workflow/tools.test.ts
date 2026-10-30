import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '../engine/types.js';
import { evaluateGuard, GUARD_REGISTRY, isRegisteredGuard, type GuardInput } from './guards.js';
import { WorkflowDefinitionSchema } from './schema.js';
import {
  BASE_TOOL_POLICY,
  isToolAlias,
  PROMPTABLE_DENY_RULES,
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
    expect(TOOL_ALIAS_NAMES).toEqual(
      expect.arrayContaining(['edit', 'bash', 'git', 'pr_skill', 'qa']),
    );
  });

  it('scopes file tools to the worktree and never allows a bare Edit/Write', () => {
    const p = resolveToolPolicy(['edit', 'bash', 'git']);
    expect(p.allow).toContain('Edit(./**)');
    expect(p.allow).toContain('Write(./**)');
    expect(p.allow).not.toContain('Edit');
    expect(p.allow).not.toContain('Write');
    expect(p.builtin).toEqual(expect.arrayContaining(['Read', 'Edit', 'Write', 'Bash']));
    expect(p.allow.filter((r) => r.startsWith('Bash')).every((r) => /^Bash\(.+\)$/.test(r))).toBe(
      true,
    );
  });

  it('scopes reads to the worktree and grants no interpreters or file-writing git flags', () => {
    const p = resolveToolPolicy(['edit', 'bash', 'git', 'pr_skill']);
    expect(p.allow).toEqual(expect.arrayContaining(['Read(./**)', 'Glob(./**)', 'Grep(./**)']));
    for (const bare of ['Read', 'Glob', 'Grep']) expect(p.allow).not.toContain(bare);
    for (const runner of ['node', 'npx', 'pnpm dlx', 'pnpm exec node', 'pnpm exec:', 'cat', 'ls'])
      expect(p.allow.some((r) => r.startsWith(`Bash(${runner}`))).toBe(false);
    // `pnpm` itself is never a bare prefix (that would allow `pnpm dlx`, `pnpm exec <anything>`).
    expect(p.allow.some((r) => r === 'Bash(pnpm:*)' || r === 'Bash(pnpm exec:*)')).toBe(false);
    // diff/log/show take --output=<file>: only exact forms may be allowed.
    for (const sub of ['diff', 'log', 'show'])
      expect(p.allow.some((r) => r.startsWith(`Bash(git ${sub}`) && r.endsWith(':*)'))).toBe(false);
    expect(p.allow.some((r) => r.includes('gh pr create'))).toBe(false);
    // Real agents commit as `git commit -q -m …`; the rule must be a plain `git commit` prefix.
    expect(p.allow).toContain('Bash(git commit:*)');
    expect(p.deny).toContain('Bash(gh pr create:*)');
  });

  it('M2-T30: bash pre-approves the npm and pnpm script runners, exact installs and chmod +x', () => {
    const p = resolveToolPolicy(['bash']);
    const bash = p.allow.filter((r) => r.startsWith('Bash('));
    expect(bash).toEqual([
      'Bash(npm run:*)',
      'Bash(npm test:*)',
      'Bash(npm install)',
      'Bash(npm ci)',
      'Bash(pnpm run:*)',
      'Bash(pnpm test:*)',
      'Bash(pnpm install)',
      'Bash(pnpm i)',
      'Bash(pnpm install --frozen-lockfile)',
      'Bash(pnpm i --frozen-lockfile)',
      'Bash(pnpm typecheck)',
      'Bash(pnpm lint)',
      'Bash(pnpm build)',
      'Bash(pnpm format)',
      'Bash(pnpm vitest:*)',
      'Bash(pnpm exec vitest:*)',
      'Bash(pnpm exec prettier:*)',
      'Bash(pnpm exec eslint:*)',
      'Bash(pnpm exec tsc -b)',
      'Bash(chmod +x:*)',
    ]);
    // Installs are exact: no `pnpm install <pkg>` / `pnpm add`; only `--frozen-lockfile`.
    expect(bash.some((r) => /^Bash\(pnpm (install|i|add):/.test(r))).toBe(false);
    expect(
      bash
        .filter((r) => /^Bash\(pnpm (install|i|add) /.test(r))
        .every((r) => r.endsWith(' --frozen-lockfile)')),
    ).toBe(true);
    // No general runner: `pnpm exec` and `pnpm dlx` only for named tools.
    expect(bash.some((r) => /^Bash\(pnpm (exec|dlx)(:|\))/.test(r))).toBe(false);
    // Only the `+x` prefix rule (`chmod 777` is not pre-approved). TD-175: the prefix still
    // matches `chmod +x -R …`, absolute paths and `--reference=`.
    expect(bash.filter((r) => r.startsWith('Bash(chmod'))).toEqual(['Bash(chmod +x:*)']);
    expect(p.builtin).toContain('Bash');
  });

  it('always denies git push, even with only the read base', () => {
    for (const tools of [[], ['git'], ['pr_skill', 'bash']]) {
      const p = resolveToolPolicy(tools);
      expect(p.deny).toContain('Bash(git push:*)');
      expect(p.allow.some((r) => r.includes('git push'))).toBe(false);
    }
    expect(resolveToolPolicy([]).builtin).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('ADR-0027: the promptable denies are base denies (only git push)', () => {
    expect(PROMPTABLE_DENY_RULES).toEqual(['Bash(git push:*)']);
    for (const r of PROMPTABLE_DENY_RULES) expect(BASE_TOOL_POLICY.deny).toContain(r);
  });

  it('qa alias has no edit tools and denies commit/push/gh', () => {
    const p = resolveToolPolicy(['qa']);
    expect(p.builtin).toEqual(['Read', 'Glob', 'Grep', 'Bash']);
    expect(p.deny).toEqual(
      expect.arrayContaining([
        'Edit',
        'Write',
        'Bash(git add:*)',
        'Bash(git commit:*)',
        'Bash(gh:*)',
        'Bash(git push:*)',
      ]),
    );
    expect(p.allow).toEqual(
      expect.arrayContaining([
        'Read(./**)',
        'Bash(git status)',
        'Bash(git diff --stat qa-base...HEAD)',
        'Bash(git diff qa-base...HEAD)',
        'Bash(git log --oneline qa-base..HEAD)',
        'Bash(pnpm test:*)',
        'Bash(pnpm vitest:*)',
        'Bash(pnpm exec vitest:*)',
        'Bash(npm test:*)',
        'Bash(npm run:*)',
        'Bash(pnpm typecheck)',
        'Bash(pnpm lint)',
      ]),
    );
    for (const sub of ['diff', 'log', 'show'])
      expect(p.allow.some((r) => r.startsWith(`Bash(git ${sub}`) && r.endsWith(':*)'))).toBe(false);
    for (const bad of [
      'Edit',
      'Write',
      'Bash(gh',
      'Bash(git commit',
      'Bash(git add',
      'Bash(git push',
    ])
      expect(p.allow.some((r) => r.startsWith(bad))).toBe(false);
  });

  it('de-duplicates and rejects unknown names', () => {
    const p = resolveToolPolicy(['git', 'git', 'bash']);
    expect(new Set(p.builtin).size).toBe(p.builtin.length);
    expect(() => resolveToolPolicy(['edit', 'WebFetch'])).toThrow(UnknownToolAliasError);
  });
});

describe('guard registry', () => {
  it('is empty in M1, so pr_flow`s branch_has_commits is unregistered', () => {
    expect(Object.keys(GUARD_REGISTRY)).toEqual([]);
    expect(isRegisteredGuard('branch_has_commits')).toBe(false);
    expect(isRegisteredGuard('ok', { ok: () => true })).toBe(true);
    expect(isRegisteredGuard('toString')).toBe(false);
  });

  it('an unregistered guard fails closed in M1 (TD-017); a registered one decides', () => {
    const input: GuardInput = {
      def: wf('pr_flow.v1.json'),
      snapshot: {} as SessionSnapshot,
      result: {},
    };
    const guarded = Object.values(input.def.states).flatMap((s) =>
      'guard' in s && s.guard ? [s.guard] : [],
    );
    expect(guarded).toEqual(['branch_has_commits']);
    expect(evaluateGuard('branch_has_commits', input)).toBe(false);
    expect(evaluateGuard('toString', input)).toBe(false);
    expect(evaluateGuard('no', input, { no: () => false })).toBe(false);
    expect(evaluateGuard('yes', input, { yes: () => true })).toBe(true);
  });
});
