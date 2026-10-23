import { useCallback, useEffect, useState } from 'react';

// Top-level navigation kept in the URL hash: `#/` (board), `#/workflows`, `#/workflows/<id>`.

export type Route = { view: 'board' } | { view: 'workflows'; workflowId: string | null };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'workflows') {
    return { view: 'workflows', workflowId: parts[1] ? decodeURIComponent(parts[1]) : null };
  }
  return { view: 'board' };
}

export function routeHash(route: Route): string {
  if (route.view === 'board') return '#/';
  return route.workflowId ? `#/workflows/${encodeURIComponent(route.workflowId)}` : '#/workflows';
}

export function useHashRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback((next: Route) => {
    window.location.hash = routeHash(next);
    // hashchange fires asynchronously; update now so the UI does not lag a frame.
    setRoute(next);
  }, []);
  return [route, navigate];
}
