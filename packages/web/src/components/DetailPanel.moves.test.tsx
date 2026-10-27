// @vitest-environment jsdom
// UX-2: what DetailPanel hands OutputLog (FR-5, `moves`) and that new output doesn't re-render
// the Brief (NFR-4). OutputLog is stubbed here, so the other panel tests keep the real one.
import type { MoveDto } from '@conductor/shared';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { DetailPanel } from './DetailPanel.js';
import type { OutputLogProps } from './OutputLog.js';

const seen = vi.hoisted(() => ({ props: [] as OutputLogProps[], tallies: 0 }));

vi.mock('./OutputLog.js', () => ({
  OutputLog: (p: OutputLogProps) => {
    seen.props.push(p);
    return <div role="log">{p.output.length} chunks</div>;
  },
}));

// `tally` runs once per BriefCard render: a counter for re-renders.
vi.mock('../brief/parse.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../brief/parse.js')>();
  return {
    ...mod,
    tally: (...args: Parameters<typeof mod.tally>) => {
      seen.tallies++;
      return mod.tally(...args);
    },
  };
});

afterEach(() => {
  cleanup();
  seen.props = [];
  seen.tallies = 0;
});

const MOVES: MoveDto[] = [
  {
    at: '2026-10-27T10:00:00.000Z',
    from: null,
    to: 'plan',
    transition: null,
    reason: null,
    actor: null,
  },
  {
    at: '2026-10-27T10:05:00.000Z',
    from: 'plan',
    to: 'implement',
    transition: 'plan_ready',
    reason: 'plan done',
    actor: 'agent',
  },
];

async function open() {
  const api = createMockApi({ replyDelayMs: 0 });
  const get = api.getSession.bind(api);
  api.getSession = async (sid) => ({ ...(await get(sid)), moves: MOVES });
  const sid = SEED_IDS.running.session;
  render(<DetailPanel api={api} sessionId={sid} version="1" onClose={() => undefined} />);
  await screen.findByRole('region', { name: 'Brief' });
  return { api, sid };
}

describe('DetailPanel → OutputLog', () => {
  it('FR-5: passes SessionDetail.moves, and the workflow for the dividers', async () => {
    const { api, sid } = await open();
    const last = seen.props.at(-1)!;
    expect(last.moves).toEqual(MOVES);
    expect(last.workflow).toEqual((await api.getSession(sid)).workflow);
  });

  it('NFR-4: 2,000 new chunks re-render the thread, not the Brief', async () => {
    const { api, sid } = await open();
    const before = seen.tallies;
    expect(before).toBeGreaterThan(0);
    act(() => {
      for (let i = 0; i < 2000; i++) api.pushOutput(sid, `line ${i}\n`);
    });
    expect(screen.getByRole('log').textContent).toMatch(/^\d+ chunks$/);
    expect(seen.props.at(-1)!.output.length).toBeGreaterThanOrEqual(2000);
    expect(seen.tallies).toBe(before);
  });
});
