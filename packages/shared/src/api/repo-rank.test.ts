import { describe, expect, it } from 'vitest';
import { rankRepos, REPO_HALF_LIFE_DAYS } from './repo-rank.js';
import { RepoListResponseSchema } from './rest.js';

const NOW = new Date('2026-10-30T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
const uses = (repo: string, ...ages: number[]) =>
  ages.map((d) => ({ repo, created_at: daysAgo(d) }));

describe('rankRepos', () => {
  it('a few recent uses beat many old ones (recency bias)', () => {
    const old = uses('github.com/o/old', ...Array<number>(10).fill(60));
    const recent = uses('github.com/o/new', 1, 2, 3);
    const ranked = rankRepos([...old, ...recent], [], NOW);
    expect(ranked.map((r) => [r.repo, r.ticket_count])).toEqual([
      ['github.com/o/new', 3],
      ['github.com/o/old', 10],
    ]);
    expect(RepoListResponseSchema.parse(ranked)).toEqual(ranked);
  });

  it('frequency wins among repos of the same age', () => {
    const ranked = rankRepos(
      [...uses('github.com/o/a', 5), ...uses('github.com/o/b', 5, 5, 5)],
      [],
      NOW,
    );
    expect(ranked.map((r) => r.repo)).toEqual(['github.com/o/b', 'github.com/o/a']);
  });

  it('a use one half-life ago weighs half', () => {
    const ranked = rankRepos(
      [
        ...uses('github.com/o/a', REPO_HALF_LIFE_DAYS, REPO_HALF_LIFE_DAYS, REPO_HALF_LIFE_DAYS),
        ...uses('github.com/o/b', 0),
      ],
      [],
      NOW,
    );
    // 1.5 vs 1.
    expect(ranked.map((r) => r.repo)).toEqual(['github.com/o/a', 'github.com/o/b']);
  });

  it('equal scores go to the more recently used, then by name', () => {
    const ranked = rankRepos(
      [
        { repo: 'github.com/o/c', created_at: NOW.toISOString() },
        { repo: 'github.com/o/b', created_at: NOW.toISOString() },
        // Future-dated (clock skew) counts as now, but is the latest use.
        { repo: 'github.com/o/a', created_at: daysAgo(-1).toISOString() },
      ],
      [],
      NOW,
    );
    expect(ranked.map((r) => r.repo)).toEqual([
      'github.com/o/a',
      'github.com/o/b',
      'github.com/o/c',
    ]);
  });

  it('merges spellings of one repo and shows the newest', () => {
    const ranked = rankRepos(
      [
        { repo: 'https://github.com/O/App.git', created_at: daysAgo(3) },
        { repo: 'github.com/o/app', created_at: daysAgo(1) },
      ],
      ['github.com/O/APP'],
      NOW,
    );
    expect(ranked).toEqual([
      { repo: 'github.com/o/app', ticket_count: 2, last_used_at: daysAgo(1).toISOString() },
    ]);
  });

  it('machine repos no ticket used follow, by name; local paths stay as they are', () => {
    const ranked = rankRepos(
      uses('/tmp/local-fixture', 1),
      ['github.com/o/zed', 'github.com/o/alpha', 'github.com/o/zed', '/tmp/local-fixture'],
      NOW,
    );
    expect(ranked.map((r) => [r.repo, r.ticket_count, r.last_used_at])).toEqual([
      ['/tmp/local-fixture', 1, daysAgo(1).toISOString()],
      ['github.com/o/alpha', 0, null],
      ['github.com/o/zed', 0, null],
    ]);
  });

  it('nothing in, nothing out', () => {
    expect(rankRepos([], [], NOW)).toEqual([]);
  });
});
