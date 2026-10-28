import { PERMISSION_REQUEST_DTO_FIXTURES, PERMISSION_RULE_MAX } from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { alwaysRuleFor } from './rule.js';

// U-100: the `always_rule` grammar (10-contracts §Permission prompts).

describe('alwaysRuleFor', () => {
  it('matches the shared Bash DTO fixtures', () => {
    // The WebFetch fixture (`denied`) predates U-100 and shows always_rule null; under U-100 it
    // would be `WebFetch(domain:example.com)` (asserted below).
    const { pending, allowed_always, expired, denied } = PERMISSION_REQUEST_DTO_FIXTURES;
    for (const dto of [pending, allowed_always, expired]) {
      expect(alwaysRuleFor(dto.tool, dto.input)).toBe(dto.always_rule);
    }
    expect(alwaysRuleFor(denied.tool, denied.input)).toBe('WebFetch(domain:example.com)');
  });

  describe('Bash', () => {
    it.each([
      ['pnpm exec tsc -b', 'Bash(pnpm exec tsc -b)'],
      ['chmod 755 scripts/db.sh', 'Bash(chmod 755 scripts/db.sh)'],
      ['git -C /w add -A', 'Bash(git -C /w add -A)'],
      ['  git status  ', 'Bash(  git status  )'],
    ])('the exact command %j', (command, rule) => {
      expect(alwaysRuleFor('Bash', { command })).toBe(rule);
    });

    it.each([
      ['a `)`', 'diff <(sort a) b'],
      ['a newline', 'echo a\necho b'],
      ['a carriage return', 'echo a\recho b'],
      ['a trailing :* (prefix rule)', 'git log:*'],
      ['a * wildcard', 'ls *.ts'],
      ['an empty command', ''],
      ['a blank command', '   '],
    ])('null for %s', (_what, command) => {
      expect(alwaysRuleFor('Bash', { command })).toBeNull();
    });

    it('null without a string command, or past PERMISSION_RULE_MAX', () => {
      expect(alwaysRuleFor('Bash', {})).toBeNull();
      expect(alwaysRuleFor('Bash', { command: 42 })).toBeNull();
      const long = 'x'.repeat(PERMISSION_RULE_MAX - 'Bash()'.length);
      expect(alwaysRuleFor('Bash', { command: long })).toBe(`Bash(${long})`);
      expect(alwaysRuleFor('Bash', { command: `${long}x` })).toBeNull();
    });
  });

  it('an MCP tool is its bare name, whatever the input', () => {
    expect(alwaysRuleFor('mcp__github__create_issue', { title: 'x' })).toBe(
      'mcp__github__create_issue',
    );
    expect(alwaysRuleFor('mcp__', {})).toBeNull();
    expect(alwaysRuleFor('mcp__x(y)', {})).toBeNull();
  });

  describe('file edits', () => {
    it('Edit / MultiEdit / NotebookEdit → Edit(//<absolute path>); Write → Write(//<path>)', () => {
      expect(alwaysRuleFor('Edit', { file_path: '/w/src/a.ts', old_string: 'a' })).toBe(
        'Edit(//w/src/a.ts)',
      );
      expect(alwaysRuleFor('MultiEdit', { file_path: '/w/src/a.ts', edits: [] })).toBe(
        'Edit(//w/src/a.ts)',
      );
      expect(alwaysRuleFor('NotebookEdit', { notebook_path: '/w/n.ipynb' })).toBe(
        'Edit(//w/n.ipynb)',
      );
      expect(alwaysRuleFor('Write', { file_path: '/w/new file.md', content: 'x' })).toBe(
        'Write(//w/new file.md)',
      );
    });

    it.each([
      ['a relative path', 'src/a.ts'],
      ['a home-relative path', '~/a.ts'],
      ['a `)`', '/w/a).ts'],
      ['a newline', '/w/a\n.ts'],
      ['a glob *', '/w/*.ts'],
      ['a glob ?', '/w/a?.ts'],
      ['a glob [', '/w/[ab].ts'],
      ['a backslash', '/w/a\\b.ts'],
    ])('null for %s', (_what, path) => {
      expect(alwaysRuleFor('Edit', { file_path: path })).toBeNull();
      expect(alwaysRuleFor('Write', { file_path: path })).toBeNull();
    });

    it('null without a path', () => {
      expect(alwaysRuleFor('Edit', {})).toBeNull();
      expect(alwaysRuleFor('NotebookEdit', { file_path: '/w/n.ipynb' })).toBeNull();
    });
  });

  describe('WebFetch', () => {
    it('WebFetch(domain:<host>) from the URL', () => {
      expect(alwaysRuleFor('WebFetch', { url: 'https://docs.github.com/en/rest?x=1' })).toBe(
        'WebFetch(domain:docs.github.com)',
      );
      expect(alwaysRuleFor('WebFetch', { url: 'http://LOCALHOST:8080/a', prompt: 'p' })).toBe(
        'WebFetch(domain:localhost)',
      );
    });

    it.each([['not a url'], ['mailto:ben@example.com'], ['']])('null for %j', (url) => {
      expect(alwaysRuleFor('WebFetch', { url })).toBeNull();
    });
  });

  it('null for any other tool', () => {
    expect(alwaysRuleFor('Read', { file_path: '/w/a.ts' })).toBeNull();
    expect(alwaysRuleFor('WebSearch', { query: 'x' })).toBeNull();
    expect(alwaysRuleFor('Task', { prompt: 'x' })).toBeNull();
    expect(alwaysRuleFor('bash', { command: 'ls' })).toBeNull();
  });
});
