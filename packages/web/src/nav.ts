import { useCallback, useEffect, useRef, useState } from 'react';

// Top-level navigation kept in the URL hash: `#/` (board), `#/workflows`, `#/workflows/<id>`,
// `#/admin`. Every route change, from an in-app link or from the hash itself (typed URL,
// back/forward), goes through an optional guard, so a view with unsaved work can hold the user back.
//
// M2-T05: the sign-in pages are real paths (`/signin`, `/signup?invite=`, `/reset?token=`),
// because the server mints those URLs; they render outside the app shell. `/admin` is an alias
// of `#/admin`. `goTo` / `usePath` move between paths without a reload.

export type Route =
  { view: 'board' } | { view: 'workflows'; workflowId: string | null } | { view: 'admin' };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'workflows') {
    return { view: 'workflows', workflowId: parts[1] ? decodeURIComponent(parts[1]) : null };
  }
  if (parts[0] === 'admin') return { view: 'admin' };
  return { view: 'board' };
}

export function routeHash(route: Route): string {
  if (route.view === 'board') return '#/';
  if (route.view === 'admin') return '#/admin';
  return route.workflowId ? `#/workflows/${encodeURIComponent(route.workflowId)}` : '#/workflows';
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
