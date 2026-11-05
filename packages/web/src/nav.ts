import { useCallback, useEffect, useRef, useState } from 'react';

// Top-level navigation kept in the URL hash: `#/` (board), `#/workflows`, `#/workflows/<id>`,
// `#/admin`, `#/machines` (M2-T11), `#/setup` (UX-8: the guided machine setup), `#/repo-checks`
// and `#/repo-checks/<repo>` (ADR-0030: per-repo check overrides), `#/schedules` and
// `#/schedules/<id>` (ADR-0032: recurring jobs; the id opens its edit sheet), `#/archive`
// (UXR-85: done and cancelled tickets), `#/insights` (UXR-84: the advisor's metrics and findings)
// and `#/workflows?proposal=<id>` (opens a change proposal). `#/help/…` is an
// alias of the `/help/…` page, which renders outside the app shell. Every route change, from an in-app link or from the hash itself (typed URL,
// back/forward), goes through an optional guard, so a view with unsaved work can hold the user back.
//
// M2-T05: the sign-in pages are real paths (`/signin`, `/signup?invite=`, `/reset?token=`),
// because the server mints those URLs; they render outside the app shell. `/admin` is an alias
// of `#/admin`. `goTo` / `usePath` move between paths without a reload.

export type Route =
  | { view: 'board' }
  | {
      view: 'workflows';
      workflowId: string | null;
      /** UXR-84: the change proposal to open in the Workflow page's proposals panel. */
      proposalId?: string | null;
    }
  | { view: 'admin' }
  | { view: 'machines' }
  | { view: 'insights' }
  | { view: 'archive' }
  | { view: 'repo-checks'; repo: string | null }
  | { view: 'schedules'; scheduleId: string | null }
  | { view: 'setup' }
  | { view: 'help' };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  const query = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'workflows') {
    const workflowId = parts[1] ? decodeURIComponent(parts[1]) : null;
    const proposalId = query.get('proposal');
    return proposalId
      ? { view: 'workflows', workflowId, proposalId }
      : { view: 'workflows', workflowId };
  }
  if (parts[0] === 'insights') return { view: 'insights' };
  if (parts[0] === 'admin') return { view: 'admin' };
  if (parts[0] === 'machines') return { view: 'machines' };
  if (parts[0] === 'archive') return { view: 'archive' };
  if (parts[0] === 'repo-checks') {
    // A repo has slashes: everything after `repo-checks/` is one encoded segment.
    return { view: 'repo-checks', repo: parts[1] ? decodeURIComponent(parts[1]) : null };
  }
  if (parts[0] === 'schedules') {
    return { view: 'schedules', scheduleId: parts[1] ? decodeURIComponent(parts[1]) : null };
  }
  if (parts[0] === 'setup') return { view: 'setup' };
  if (parts[0] === 'help') return { view: 'help' };
  return { view: 'board' };
}

export function routeHash(route: Route): string {
  if (route.view === 'board') return '#/';
  if (route.view === 'admin') return '#/admin';
  if (route.view === 'machines') return '#/machines';
  if (route.view === 'insights') return '#/insights';
  if (route.view === 'archive') return '#/archive';
  if (route.view === 'setup') return '#/setup';
  if (route.view === 'help') return '#/help/add-a-machine';
  if (route.view === 'schedules') {
    return route.scheduleId ? `#/schedules/${encodeURIComponent(route.scheduleId)}` : '#/schedules';
  }
  if (route.view === 'repo-checks') {
    return route.repo ? `#/repo-checks/${encodeURIComponent(route.repo)}` : '#/repo-checks';
  }
  const base = route.workflowId
    ? `#/workflows/${encodeURIComponent(route.workflowId)}`
    : '#/workflows';
  return route.proposalId ? `${base}?proposal=${encodeURIComponent(route.proposalId)}` : base;
}

export const sameRoute = (a: Route, b: Route) => routeHash(a) === routeHash(b);

/**
 * - `allow`: go.
 * - `block`: stay, put the old hash back, and report the attempt (the caller asks the user).
 * - `ignore`: stay and put the old hash back, silently.
 */
export type RouteVerdict = 'allow' | 'block' | 'ignore';
export type RouteGuard = (next: Route, current: Route) => RouteVerdict;

export interface NavigateOptions {
  /** Skip the guard (the user already confirmed). */
  force?: boolean | undefined;
  /** Replace the history entry instead of adding one. */
  replace?: boolean | undefined;
}

export function useHashRoute(
  guard?: RouteGuard,
  onBlocked?: (next: Route) => void,
): [Route, (route: Route, opts?: NavigateOptions) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const current = useRef(route);
  const handlers = useRef({ guard, onBlocked });
  useEffect(() => {
    handlers.current = { guard, onBlocked };
  }, [guard, onBlocked]);

  const apply = useCallback((next: Route, opts: NavigateOptions = {}) => {
    const from = current.current;
    const verdict: RouteVerdict =
      opts.force || sameRoute(next, from)
        ? 'allow'
        : (handlers.current.guard?.(next, from) ?? 'allow');
    if (verdict !== 'allow') {
      // Undo a hash the browser already changed; replaceState fires no hashchange.
      if (!sameRoute(parseHash(window.location.hash), from)) {
        window.history.replaceState(null, '', routeHash(from));
      }
      if (verdict === 'block') handlers.current.onBlocked?.(next);
      return;
    }
    current.current = next;
    setRoute(next);
    const hash = routeHash(next);
    if (!sameRoute(parseHash(window.location.hash), next)) {
      if (opts.replace) window.history.replaceState(null, '', hash);
      else window.location.hash = hash;
    }
  }, []);

  useEffect(() => {
    const onChange = () => apply(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, [apply]);

  return [route, apply];
}

const NAVIGATE_EVENT = 'conductor:navigate';

export interface PathLocation {
  pathname: string;
  search: string;
}

const readPath = (): PathLocation => ({
  pathname: window.location.pathname,
  search: window.location.search,
});

/** Go to a same-origin URL (path, query, hash) without a reload. */
export function goTo(url: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

/** The current path and query, updated by `goTo` and back/forward. */
export function usePath(): PathLocation {
  const [path, setPath] = useState(readPath);
  useEffect(() => {
    const onChange = () =>
      setPath((prev) => {
        const next = readPath();
        return next.pathname === prev.pathname && next.search === prev.search ? prev : next;
      });
    window.addEventListener('popstate', onChange);
    window.addEventListener(NAVIGATE_EVENT, onChange);
    return () => {
      window.removeEventListener('popstate', onChange);
      window.removeEventListener(NAVIGATE_EVENT, onChange);
    };
  }, []);
  return path;
}

/** Where the user is, as a `next` value: path + query + hash; the board's `#/` is just `/`. */
export function currentPath(): string {
  const { pathname, search, hash } = window.location;
  return pathname + search + (hash === '' || hash === '#' || hash === '#/' ? '' : hash);
}

export function signInPath(next: string): string {
  return `/signin?next=${encodeURIComponent(next)}`;
}
