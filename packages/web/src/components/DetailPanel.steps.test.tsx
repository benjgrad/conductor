// @vitest-environment jsdom
// UXR-88: the Details tab's Steps section, from the mock done ticket's moves and context.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockApi } from '../api/mock.js';
import { SEED_IDS } from '../api/mock-data.js';
import { DetailPanel } from './DetailPanel.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('Steps (UXR-88)', () => {
  it('lists each state with its outcome and duration; Result shows the recorded result', async () => {
    const api = createMockApi({ replyDelayMs: 0 });
    render(
      <DetailPanel
        api={api}
        sessionId={SEED_IDS.done.session}
        version="1"
        onClose={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    const heading = await screen.findByRole('heading', { level: 3, name: /^Steps/ });
    expect(heading.textContent).toContain('4 steps');
    const list = within(screen.getByRole('list', { name: 'Steps' }));
    const rows = list.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows[0]).toMatch(/^Implement\s*Done\s*1h 20m/);
    expect(rows[1]).toMatch(/^Build\s*Exit 0\s*8m/);
    expect(rows[3]).toMatch(/^Done\s*Ended here$/);
    const result = list.getByRole('button', { name: /^Result/ });
    expect(list.queryByText(/Renamed/)).toBeNull();
    fireEvent.click(result);
    expect(list.getByText('user.fullname', { selector: 'code' })).toBeTruthy();
    expect(list.getByText('Files')).toBeTruthy();
  });
});
