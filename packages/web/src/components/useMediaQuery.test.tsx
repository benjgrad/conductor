// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mockViewport, type MockViewport } from '../test/match-media.js';
import { MOBILE_QUERY, useIsMobile, useMediaQuery } from './useMediaQuery.js';

let viewport: MockViewport | null = null;
afterEach(() => {
  cleanup();
  viewport?.restore();
  viewport = null;
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
