import type { TeamMember } from '@conductor/shared';
import { useCallback, useEffect, useState } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { AgentAvatar } from '../components/agent-identity.js';
import { ago } from '../components/format.js';

// UX-13b FR-3: the agent team (GET /api/team, UX-13a), a section of the Machines page. One request
// per load (NFR-1); the ticket titles come from the board the app already holds (`ticketTitle`).

interface TeamSectionProps {
  api: ApiClient;
  /** The title of a ticket on the board, for the "On …" link; undefined → "a ticket". */
  ticketTitle?: ((ticketId: string) => string | undefined) | undefined;
}

type Team =
  { kind: 'loading' } | { kind: 'error'; text: string } | { kind: 'loaded'; members: TeamMember[] };

/** What a teammate is doing now: on a ticket, or free since their last assignment (null: never). */
export type TeamStatus = { kind: 'on'; ticketId: string } | { kind: 'free'; since: string | null };

export function teamStatus(m: TeamMember): TeamStatus {
  if (m.active_ticket_id !== null) return { kind: 'on', ticketId: m.active_ticket_id };
  return { kind: 'free', since: m.last_assigned_at };
}

/** "5 Nov 2026" in the browser's locale. */
export function hiredLabel(iso: string, locale?: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function TeamSection({ api, ticketTitle }: TeamSectionProps) {
  const [team, setTeam] = useState<Team>({ kind: 'loading' });

  // Only the async result sets state here (react-hooks/set-state-in-effect); Retry shows Loading.
  const load = useCallback(() => {
    api.listTeam().then(
      (members) => setTeam({ kind: 'loaded', members }),
      (err: unknown) => setTeam({ kind: 'error', text: errorMessage(err) }),
    );
  }, [api]);

  useEffect(() => load(), [load]);

  return (
    <section className="team" aria-labelledby="team-heading">
      <h2 id="team-heading">Team</h2>
      {team.kind === 'loading' && <p className="loading">Loading…</p>}
      {team.kind === 'error' && (
        <p role="alert" className="error">
          {team.text}{' '}
          <button
            type="button"
            onClick={() => {
              setTeam({ kind: 'loading' });
              load();
            }}
          >
            Retry
          </button>
        </p>
      )}
      {team.kind === 'loaded' && team.members.length === 0 && (
        <p className="muted">No teammates yet: one is hired when a ticket starts.</p>
      )}
      {team.kind === 'loaded' && team.members.length > 0 && (
        <ul className="team-list" aria-label="Agent team">
          {team.members.map((m) => (
            <li key={m.name} className="team-row">
              <AgentAvatar seed={m.name} size={32} />
              <span className="team-name">{m.name}</span>
              <span className="team-hired muted">
                Hired{' '}
                <time dateTime={m.hired_at} title={new Date(m.hired_at).toLocaleString()}>
                  {hiredLabel(m.hired_at)}
                </time>
              </span>
              <StatusText status={teamStatus(m)} ticketTitle={ticketTitle} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusText({
  status,
  ticketTitle,
}: {
  status: TeamStatus;
  ticketTitle: TeamSectionProps['ticketTitle'];
}) {
  if (status.kind === 'on') {
    // useOpenFromNotification opens `#/?ticket=…` from any page: the board, with the card selected.
    return (
      <span className="team-status">
        On{' '}
        <a href={`#/?ticket=${encodeURIComponent(status.ticketId)}`}>
          {ticketTitle?.(status.ticketId) ?? 'a ticket'}
        </a>
      </span>
    );
  }
  if (status.since === null) return <span className="team-status muted">Free: no tickets yet</span>;
  return (
    <span className="team-status muted">
      Free since{' '}
      <time dateTime={status.since} title={new Date(status.since).toLocaleString()}>
        {ago(status.since)}
      </time>
    </span>
  );
}
