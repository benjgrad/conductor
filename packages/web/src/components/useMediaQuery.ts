import { useEffect, useState } from 'react';

/** 11-web-ui §Breakpoint: the phone layout below 700 px; the desktop layout above it is unchanged. */
export const MOBILE_QUERY = '(max-width: 699.98px)';

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false;
}

/** `matchMedia(query).matches`, kept current. False without `matchMedia` (jsdom), so tests stay on desktop. */
export function useMediaQuery(query: string): boolean {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setValue(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return value;
}

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

/**
 * While `active` (the phone layout), `--vvh` on <html> follows `visualViewport.height`, so a
 * full-screen panel or sheet ends above the on-screen keyboard. The CSS falls back to `100dvh`.
 */
export function useVisualViewportHeight(active: boolean): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty('--vvh', `${vv.height}px`);
    update();
    vv.addEventListener('resize', update);
    return () => {
      vv.removeEventListener('resize', update);
      root.style.removeProperty('--vvh');
    };
  }, [active]);
}
