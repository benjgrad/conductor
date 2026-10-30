import { canonicalRepo, type RepoSuggestion } from './rest.js';

// GET /api/repos (10-contracts §Repo suggestions): the create-ticket form's repo list, ranked by
// frecency. The orchestrator and the web mock both rank with this.

/** A ticket's weight halves every this many days: frequency, with a recency bias. */
export const REPO_HALF_LIFE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One ticket's repo and when it was created. */
export interface RepoUse {
  repo: string;
  created_at: Date | string;
}

/** Same comparison as `no_machine_has_repo`: canonical, github org/repo case-insensitive. */
const repoKey = (repo: string): string => canonicalRepo(repo)?.toLowerCase() ?? repo;

/**
 * The account's repos, best first. A repo scores Σ 0.5^(age_days / REPO_HALF_LIFE_DAYS) over its
 * tickets; ties go to the more recently used, then by name. `known` (the machines' repos) that no
 * ticket used follow with `ticket_count` 0, by name. Spellings of one repo are merged; the newest
 * ticket's spelling is shown, else the machine's.
 */
export function rankRepos(uses: RepoUse[], known: string[], now: Date): RepoSuggestion[] {
  const used = new Map<string, { repo: string; score: number; count: number; last: number }>();
  for (const u of uses) {
    const at = new Date(u.created_at).getTime();
    const age = Math.max(0, now.getTime() - at) / DAY_MS;
    const key = repoKey(u.repo);
    const entry = used.get(key) ?? { repo: u.repo, score: 0, count: 0, last: -Infinity };
    entry.score += 0.5 ** (age / REPO_HALF_LIFE_DAYS);
    entry.count += 1;
    if (at > entry.last) {
      entry.last = at;
      entry.repo = u.repo;
    }
    used.set(key, entry);
  }
  const ranked = [...used.values()].sort(
    (a, b) => b.score - a.score || b.last - a.last || a.repo.localeCompare(b.repo),
  );
  const unused = new Map<string, string>();
  for (const repo of known) {
    const key = repoKey(repo);
    if (!used.has(key) && !unused.has(key)) unused.set(key, repo);
  }
  return [
    ...ranked.map((e) => ({
      repo: e.repo,
      ticket_count: e.count,
      last_used_at: new Date(e.last).toISOString(),
    })),
    ...[...unused.values()]
      .sort((a, b) => a.localeCompare(b))
      .map((repo) => ({ repo, ticket_count: 0, last_used_at: null })),
  ];
}
