// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockViewport, type MockViewport } from '../test/match-media.js';
import {
  MOBILE_QUERY,
  useDocumentClass,
  useElementHeightVar,
  useIsMobile,
  useMediaQuery,
  useVisualViewportHeight,
} from './useMediaQuery.js';

let viewport: MockViewport | null = null;
afterEach(() => {
  cleanup();
  viewport?.restore();
  viewport = null;
  vi.unstubAllGlobals();
});

function Probe() {
  return <p>{useIsMobile() ? 'mobile' : 'desktop'}</p>;
}

describe('useMediaQuery', () => {
  it('answers the query on the first render', () => {
    viewport = mockViewport(375);
    render(<Probe />);
    expect(screen.getByText('mobile')).toBeTruthy();
  });

  it('follows the change event', () => {
    viewport = mockViewport(1440);
    render(<Probe />);
    expect(screen.getByText('desktop')).toBeTruthy();
    act(() => viewport!.resize(360));
    expect(screen.getByText('mobile')).toBeTruthy();
    act(() => viewport!.resize(700));
    expect(screen.getByText('desktop')).toBeTruthy();
  });

  it('is false without matchMedia (jsdom), so tests render the desktop layout', () => {
    expect(typeof window.matchMedia).not.toBe('function');
    function Q() {
      return <p>{String(useMediaQuery(MOBILE_QUERY))}</p>;
    }
    render(<Q />);
    expect(screen.getByText('false')).toBeTruthy();
  });

  it('the breakpoint is below 700 px', () => {
    viewport = mockViewport(699);
    expect(window.matchMedia(MOBILE_QUERY).matches).toBe(true);
    viewport.resize(700);
    expect(window.matchMedia(MOBILE_QUERY).matches).toBe(false);
  });
});

describe('useElementHeightVar', () => {
  let height = 49;
  function Bar() {
    const ref = useRef<HTMLElement>(null);
    useElementHeightVar(ref, '--topbar-h');
    return <header ref={ref} />;
  }
  const value = () => document.documentElement.style.getPropertyValue('--topbar-h');

  it("sets the variable from the element's height, follows resizes and clears it on unmount", () => {
    let onResize: (() => void) | null = null;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          onResize = cb;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height);
    height = 49;
    const { unmount } = render(<Bar />);
    expect(value()).toBe('49px');
    height = 65;
    act(() => onResize!());
    expect(value()).toBe('65px');
    unmount();
    expect(disconnect).toHaveBeenCalled();
    expect(value()).toBe('');
    vi.restoreAllMocks();
  });

  it('does nothing without ResizeObserver (jsdom), so the CSS fallback applies', () => {
    expect(typeof globalThis.ResizeObserver).toBe('undefined');
    render(<Bar />);
    expect(value()).toBe('');
  });
});

describe('useVisualViewportHeight', () => {
  function Shell({ active }: { active: boolean }) {
    useVisualViewportHeight(active);
    return null;
  }
  const prop = (name: string) => document.documentElement.style.getPropertyValue(name);

  it('sets --vvh and --vvt, follows resize and scroll, and clears them on unmount', () => {
    const vv = Object.assign(new EventTarget(), { height: 600, offsetTop: 0 });
    vi.stubGlobal('visualViewport', vv);
    const { unmount } = render(<Shell active />);
    expect([prop('--vvh'), prop('--vvt')]).toEqual(['600px', '0px']);
    vv.height = 320;
    act(() => void vv.dispatchEvent(new Event('resize')));
    expect(prop('--vvh')).toBe('320px');
    vv.offsetTop = 140;
    act(() => void vv.dispatchEvent(new Event('scroll')));
    expect(prop('--vvt')).toBe('140px');
    unmount();
    expect([prop('--vvh'), prop('--vvt')]).toEqual(['', '']);
  });

  it('does nothing while inactive', () => {
    vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { height: 1, offsetTop: 1 }));
    render(<Shell active={false} />);
    expect(prop('--vvh')).toBe('');
  });
});

describe('useDocumentClass', () => {
  function Lock({ active }: { active: boolean }) {
    useDocumentClass('app-shell', active);
    return null;
  }
  const has = () => document.documentElement.classList.contains('app-shell');

  it('adds the class to <html> while active and removes it after', () => {
    const { rerender, unmount } = render(<Lock active={false} />);
    expect(has()).toBe(false);
    rerender(<Lock active />);
    expect(has()).toBe(true);
    rerender(<Lock active={false} />);
    expect(has()).toBe(false);
    rerender(<Lock active />);
    unmount();
    expect(has()).toBe(false);
  });
});
