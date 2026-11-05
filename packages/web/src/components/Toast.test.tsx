// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOAST_MS, ToastProvider, useToast } from './Toast.js';

// UXR-55: the one shared confirmation for completed actions.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Trigger({ text }: { text: string }) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast(text)}>
      {text}
    </button>
  );
}

const region = () => screen.getByRole('status', { name: 'Notifications' });

describe('Toast', () => {
  it('is one polite live region that exists before any toast', () => {
    render(
      <ToastProvider>
        <Trigger text="Copied" />
      </ToastProvider>,
    );
    expect(region().getAttribute('aria-live')).toBe('polite');
    expect(region().getAttribute('aria-atomic')).toBe('true');
    expect(region().textContent).toBe('');
  });

  it('shows the text, then clears it after TOAST_MS', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger text="Invite created" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Invite created' }));
    expect(region().textContent).toBe('Invite created');
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 1);
    });
    expect(region().textContent).toBe('Invite created');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(region().textContent).toBe('');
  });

  it('a new toast replaces the old one and restarts the timer', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger text="Copied" />
        <Trigger text="Saved as v4" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 500);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Saved as v4' }));
    expect(region().textContent).toBe('Saved as v4');
    expect(region().querySelectorAll('.toast')).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 1);
    });
    expect(region().textContent).toBe('Saved as v4');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(region().textContent).toBe('');
  });

  it('the same text twice is a new element (announced again)', () => {
    render(
      <ToastProvider>
        <Trigger text="Copied" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
    const first = region().querySelector('.toast');
    fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
    expect(region().querySelector('.toast')).not.toBe(first);
    expect(region().textContent).toBe('Copied');
  });

  it('outside a provider, useToast does nothing', () => {
    render(<Trigger text="Copied" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
