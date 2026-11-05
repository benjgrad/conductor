import { routeHash } from '../nav.js';

// UXR-75: under a transition's checks, the repos whose own checks (ADR-0030) replace them, each a
// link to its Repo checks page.

/** At most this many repos are named; the rest are "+N more", a link to the list. */
export const MAX_NAMED_REPOS = 3;

/** `github.com/acme/shop` → `acme/shop`: drop a leading host (a segment with a dot). */
export function shortRepo(repo: string): string {
  const parts = repo.split('/');
  return parts.length > 2 && parts[0]!.includes('.') ? parts.slice(1).join('/') : repo;
}

/** "1 repo uses its own checks instead:" / "3 repos use their own checks instead:". */
export function repoOverridesText(n: number): string {
  return n === 1
    ? '1 repo uses its own checks instead:'
    : `${n} repos use their own checks instead:`;
}

export function RepoOverridesHint({ repos }: { repos: readonly string[] }) {
  if (repos.length === 0) return null;
  const sorted = [...repos].sort((a, b) => a.localeCompare(b));
  const named = sorted.slice(0, MAX_NAMED_REPOS);
  const more = sorted.length - named.length;
  return (
    <p className="wf-note wf-repo-overrides" role="note">
      {repoOverridesText(sorted.length)}{' '}
      {named.map((repo, i) => (
        <span key={repo}>
          {i > 0 && ', '}
          <a href={routeHash({ view: 'repo-checks', repo })} title={repo}>
            {shortRepo(repo)} ›
          </a>
        </span>
      ))}
      {more > 0 && (
        <>
          {', '}
          <a href={routeHash({ view: 'repo-checks', repo: null })}>+{more} more</a>
        </>
      )}
    </p>
  );
}
