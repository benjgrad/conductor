import { useEffect, useState, type RefObject } from 'react';

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
 * While `active` (the phone layout), `--vvh` and `--vvt` on <html> follow `visualViewport.height`
 * and `offsetTop`, so a full-screen panel or sheet ends above the on-screen keyboard and stays in
 * view when iOS pans the layout viewport under it. The CSS falls back to `100dvh` and `0`.
 */
export function useVisualViewportHeight(active: boolean): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) return;
    const root = document.documentElement;
    const update = () => {
      root.style.setProperty('--vvh', `${vv.height}px`);
      root.style.setProperty('--vvt', `${vv.offsetTop}px`);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.style.removeProperty('--vvh');
      root.style.removeProperty('--vvt');
    };
  }, [active]);
}

/** While `active`, <html> has `className` (e.g. `app-shell`, the phone's no-document-scroll lock). */
export function useDocumentClass(className: string, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.classList.add(className);
    return () => root.classList.remove(className);
  }, [className, active]);
}

/**
 * `name` on <html> follows the element's height (e.g. `--topbar-h`, which offsets the sticky
 * session panel below the sticky top bar). Without `ResizeObserver` (jsdom) the CSS fallback applies.
 */
export function useElementHeightVar(ref: RefObject<HTMLElement | null>, name: string): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const update = () => root.style.setProperty(name, `${el.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty(name);
    };
  }, [ref, name]);
}
