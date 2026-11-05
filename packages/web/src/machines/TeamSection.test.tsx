// @vitest-environment jsdom
import type { TeamMember } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../api/client.js';
import { createMockApi } from '../api/mock.js';
import { hiredLabel, teamStatus, TeamSection } from './TeamSection.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TICKET = 'a1000000-0000-4000-8000-000000000003';
const ADA: TeamMember = {
  name: 'Ada',
  hired_at: '2026-10-01T09:00:00.000Z',
  last_assigned_at: '2026-11-04T09:00:00.000Z',
  active_ticket_id: TICKET,
};
const KOFI: TeamMember = {
  name: 'Kofi',
  hired_at: '2026-10-20T09:00:00.000Z',
  last_assigned_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
  active_ticket_id: null,
};
const NEW: TeamMember = { ...KOFI, name: 'Zuri', last_assigned_at: null };

function withTeam(team: TeamMember[] | Error) {
  const api = createMockApi();
  const spy = vi
    .spyOn(api, 'listTeam')
    .mockImplementation(() =>
      team instanceof Error ? Promise.reject(team) : Promise.resolve(team),
    );
  return { api, spy };
}

const rowOf = (name: string) =>
  within(screen.getByText(name, { selector: '.team-name' }).closest('li') as HTMLElement);

describe('Team section (UX-13b FR-3)', () => {
  it('lists each teammate: avatar, name, hire date, the ticket (linked) or free since', async () => {
    const { api, spy } = withTeam([ADA, KOFI, NEW]);
    render(
      <TeamSection
        api={api}
        ticketTitle={(id) => (id === TICKET ? 'Add pagination' : undefined)}
      />,
    );
    const list = await screen.findByRole('list', { name: 'Agent team' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(1);

    const ada = rowOf('Ada');
    expect(ada.getByText(hiredLabel(ADA.hired_at))).toBeTruthy();
    expect(screen.getByText('Ada').closest('li')!.querySelector('svg')).toBeTruthy();
    const link = ada.getByRole('link', { name: 'Add pagination' });
    expect(link.getAttribute('href')).toBe(`#/?ticket=${TICKET}`);

    expect(rowOf('Kofi').getByText(/Free since/).textContent).toBe('Free since 3h ago');
    expect(rowOf('Kofi').queryByRole('link')).toBeNull();
    expect(rowOf('Zuri').getByText('Free: no tickets yet')).toBeTruthy();
  });

  it('links "a ticket" when the title is not on the board', async () => {
    const { api } = withTeam([ADA]);
    render(<TeamSection api={api} />);
    expect((await screen.findByRole('link', { name: 'a ticket' })).getAttribute('href')).toBe(
      `#/?ticket=${TICKET}`,
    );
  });

  it('says so when there is no team yet', async () => {
    const { api } = withTeam([]);
    render(<TeamSection api={api} />);
    expect(await screen.findByText(/No teammates yet/)).toBeTruthy();
  });

  it('shows an error with Retry', async () => {
    const { api, spy } = withTeam(new ApiRequestError(500, 'internal', 'boom'));
    render(<TeamSection api={api} />);
    const alert = await screen.findByRole('alert');
    spy.mockResolvedValue([ADA]);
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Ada')).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('teamStatus and hiredLabel are pure', () => {
    expect(teamStatus(ADA)).toEqual({ kind: 'on', ticketId: TICKET });
    expect(teamStatus(KOFI)).toEqual({ kind: 'free', since: KOFI.last_assigned_at });
    expect(teamStatus(NEW)).toEqual({ kind: 'free', since: null });
    expect(hiredLabel('2026-10-01T12:00:00.000Z', 'en-GB')).toBe('1 Oct 2026');
  });
});
