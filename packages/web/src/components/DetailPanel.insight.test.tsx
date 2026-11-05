// @vitest-environment jsdom
// UXR-84 (FR-3): a finished session's analyst insight on the Details tab, on the mock API.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../api/mock.js';
import { SEED_IDS } from '../api/mock-data.js';
import { DetailPanel } from './DetailPanel.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function open(sessionId: string) {
  const api = createMockApi();
  const get = vi.spyOn(api, 'getSessionInsight');
  render(<DetailPanel api={api} sessionId={sessionId} version="1" onClose={() => undefined} />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Details' }));
  await screen.findByRole('heading', { level: 3, name: /^Situation/ });
  return { api, get };
}

describe('Session insight (UXR-84)', () => {
  it('a done session shows its summary, frictions and that a model wrote it', async () => {
    const { get } = await open(SEED_IDS.done.session);
    const section = within(await screen.findByRole('region', { name: 'Session insight' }));
    expect(get).toHaveBeenCalledWith(SEED_IDS.done.session);
    expect(section.getByText(/Renamed the field across the API/)).toBeTruthy();
    expect(section.getByText('DATABASE_URL was not set for the build step.')).toBeTruthy();
    expect(section.getByText(/Environment in build/)).toBeTruthy();
    expect(section.getByText(/Written by the analyst model \(haiku\)/)).toBeTruthy();
  });

  it('a finished session without an insight (404) shows no section', async () => {
    const { get } = await open(SEED_IDS.failed.session);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Session insight' })).toBeNull();
  });

  it('a running session asks for none', async () => {
    const { get } = await open(SEED_IDS.running.session);
    expect(get).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Session insight' })).toBeNull();
  });
});
