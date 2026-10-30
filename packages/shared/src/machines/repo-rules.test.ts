import { describe, expect, it } from 'vitest';
import {
  isRepoPattern,
  REPO_RULE_MAX,
  RepoPatternSchema,
  RepoRuleListSchema,
  repoPatternMatches,
  repoRulesMatch,
} from './repo-rules.js';

// Machine repo rules (ADR-0013 amendment 2026-10-30). The orchestrator's REPO_PATTERN_MATCH_SQL
// is the same match; test/gateway/claim.test.ts checks it against these cases' shape.

describe('isRepoPattern / RepoPatternSchema', () => {
  it.each([
    'github.com/org/app',
    'github.com/org/*',
    'gitlab.com/group/sub/*',
    'gitlab.com/group/sub/app',
    'github.com/my_org/my_app',
  ])('accepts %s', (p) => {
    expect(isRepoPattern(p)).toBe(true);
  });

  it.each([
    '*',
    'github.com/*',
    'github.com',
    'github.com/org',
    'https://github.com/org/app',
    'github.com/org/app.git',
    'github.com/org/../*',
    'github.com/org/a*',
    'git@github.com:org/app',
    '',
  ])('refuses %j', (p) => {
    expect(isRepoPattern(p)).toBe(false);
    expect(RepoPatternSchema.safeParse(p).success).toBe(false);
  });

  it('trims and lower-cases the host only', () => {
    expect(RepoPatternSchema.parse('  GitHub.com/Acme/*  ')).toBe('github.com/Acme/*');
  });

  it('a list drops case-insensitive duplicates and is capped', () => {
    expect(
      RepoRuleListSchema.parse(['github.com/a/b', 'github.com/A/B', 'github.com/a/*']),
    ).toEqual(['github.com/a/b', 'github.com/a/*']);
    const many = Array.from({ length: REPO_RULE_MAX + 1 }, (_, i) => `github.com/o/r${i}`);
    expect(RepoRuleListSchema.safeParse(many).success).toBe(false);
  });
});

describe('repoPatternMatches', () => {
  it.each([
    ['github.com/org/app', 'github.com/org/app', true],
    ['github.com/Org/App', 'github.com/org/app', true],
    ['github.com/org/app', 'github.com/org/app2', false],
    ['github.com/org/*', 'github.com/org/app', true],
    ['github.com/org/*', 'github.com/ORG/app', true],
    ['github.com/org/*', 'github.com/org2/app', false],
    ['github.com/org/*', 'github.com/org', false],
    ['gitlab.com/g/*', 'gitlab.com/g/sub/app', true],
    ['github.com/my_org/*', 'github.com/myXorg/app', false],
  ])('%s vs %s → %s', (pattern, repo, want) => {
    expect(repoPatternMatches(pattern, repo)).toBe(want);
  });

  it('repoRulesMatch: any pattern', () => {
    expect(repoRulesMatch([], 'github.com/o/r')).toBe(false);
    expect(repoRulesMatch(['github.com/x/*', 'github.com/o/r'], 'github.com/o/r')).toBe(true);
  });
});
