import { z } from 'zod';
import { isCanonicalRemote, REPO_PREFIX_RE } from './inventory.js';

// Machine repo rules (ADR-0013 §Routing, amendment 2026-10-30; 10-contracts "Matching"). A machine
// may take only repos its `repo_allow` matches (null = any), and a repo some other unrevoked
// machine of the account lists in `repo_exclusive` is that machine's alone. The claim's SQL
// (orchestrator gateway/routing.ts `REPO_PATTERN_MATCH_SQL`) is the same match.

/** Cap on each of `repo_allow` / `repo_exclusive`. */
export const REPO_RULE_MAX = 50;

/**
 * A repo pattern: a canonical remote (`github.com/org/app`), or `host/org[/sub…]/*` for every repo
 * under that prefix. Not `*`, not `host/*`.
 */
export function isRepoPattern(p: string): boolean {
  if (p.endsWith('/*')) {
    const prefix = p.slice(0, -2);
    return REPO_PREFIX_RE.test(prefix) && !prefix.split('/').some((s) => s === '.' || s === '..');
  }
  return isCanonicalRemote(p);
}

/** A pattern as stored: trimmed, host lower-cased (org / repo keep their case). */
export const RepoPatternSchema = z
  .string()
  .trim()
  .max(255)
  .transform((p) => {
    const slash = p.indexOf('/');
    return slash < 0 ? p.toLowerCase() : p.slice(0, slash).toLowerCase() + p.slice(slash);
  })
  .refine(isRepoPattern, 'expected host/org/repo or host/org/*');

/** A rule list: at most REPO_RULE_MAX patterns, duplicates removed (case-insensitively). */
export const RepoRuleListSchema = z
  .array(RepoPatternSchema)
  .max(REPO_RULE_MAX)
  .transform((ps) => {
    const seen = new Set<string>();
    return ps.filter((p) => {
      const k = p.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });

/**
 * Whether `pattern` matches the ticket repo `repo`, case-insensitively: the same repo, or for
 * `prefix/*` any repo under `prefix/`.
 */
export function repoPatternMatches(pattern: string, repo: string): boolean {
  const p = pattern.toLowerCase();
  const r = repo.toLowerCase();
  return p.endsWith('/*') ? r.startsWith(p.slice(0, -1)) : r === p;
}

/** Whether any of `patterns` matches `repo`. */
export function repoRulesMatch(patterns: readonly string[], repo: string): boolean {
  return patterns.some((p) => repoPatternMatches(p, repo));
}
