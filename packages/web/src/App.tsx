import type { MeResponse } from '@conductor/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiClient } from './api/client.js';
import { AdminPage } from './admin/Admin.js';
import { AccountMenu } from './auth/AccountMenu.js';
import { NETWORK } from './auth/errors.js';
import { Reset } from './auth/Reset.js';
import { isUnauthorized, withAuthRedirect } from './auth/session.js';
import { SignIn } from './auth/SignIn.js';
import { SignUp } from './auth/SignUp.js';
import { useBoard } from './board/hooks.js';
import { Board } from './components/Board.js';
import { CreateTicketForm } from './components/CreateTicketForm.js';
import { DetailPanel } from './components/DetailPanel.js';
import { MachinesPage } from './machines/Machines.js';
import { currentPath, goTo, routeHash, signInPath, useHashRoute, usePath } from './nav.js';
import { DiscardDraftConfirm, useDraftGuard } from './workflow/draft-guard.js';
import { WorkflowsView } from './workflow/WorkflowsView.js';

export interface AppProps {
  api: ApiClient;
}

/**
 * M2-T05: the sign-in gate. `/signin`, `/signup` and `/reset` render on their own. Anything else
 * renders the app and asks GET /api/me at once (in `local` mode that is the local user, so dev is
 * unchanged); the account menu waits for the answer. The app's ApiClient sends any 401, REST or
 * SSE, to `/signin?next=<where they were>` (auth/session.ts), as does a 401 from /api/me.
 */
export function App({ api }: AppProps) {
  const { pathname, search } = usePath();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probeNonce, setProbeNonce] = useState(0);

  const onUnauthorized = useCallback(() => {
    setMe(null);
    if (window.location.pathname !== '/signin') {
      goTo(signInPath(currentPath()), { replace: true });
    }
  }, []);
  const guarded = useMemo(() => withAuthRedirect(api, onUnauthorized), [api, onUnauthorized]);

  const authPage = pathname === '/signin' || pathname === '/signup' || pathname === '/reset';
  const adminAlias = pathname === '/admin';

  useEffect(() => {
    if (adminAlias) goTo('/#/admin', { replace: true });
  }, [adminAlias]);

  const needsProbe = !authPage && !adminAlias && me === null;
  useEffect(() => {
    if (!needsProbe) return;
    let cancelled = false;
    api.me().then(
      (res) => {
        if (!cancelled) setMe(res);
      },
      (err: unknown) => {
        if (cancelled) return;
        if (isUnauthorized(err)) onUnauthorized();
        else setProbeError(NETWORK);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, needsProbe, onUnauthorized, probeNonce]);

  const params = new URLSearchParams(search);
  if (pathname === '/signin') {
    return <SignIn api={api} next={params.get('next')} onSignedIn={setMe} />;
  }
  if (pathname === '/signup') {
    return <SignUp api={api} invite={params.get('invite')} onSignedIn={setMe} />;
  }
  if (pathname === '/reset') return <Reset api={api} token={params.get('token')} />;
  if (adminAlias) return null;
  if (probeError !== null) {
    return (
      <div className="app-gate">
        <p role="alert" className="error">
          {probeError}
        </p>
        <button
          type="button"
          onClick={() => {
            setProbeError(null);
            setProbeNonce((n) => n + 1);
          }}
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <Shell
      api={guarded}
      me={me}
      onSignedOut={() => {
        setMe(null);
        goTo('/signin', { replace: true });
      }}
    />
  );
}

interface ShellProps {
  api: ApiClient;
  /** null until GET /api/me answers. */
  me: MeResponse | null;
  onSignedOut: () => void;
}

function Shell({ api, me, onSignedOut }: ShellProps) {
  const { board, error } = useBoard(api);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const draft = useDraftGuard();
  const [route, navigate] = useHashRoute(draft.guard, draft.onBlocked);

  const selectedCard = selected
    ? [...board.cards.values()].find((c) => c.session_id === selected)
    : undefined;

  return (
    <div className={`app${selected ? ' with-detail' : ''}`}>
      <header className="topbar">
        <h1>Conductor</h1>
        <nav className="nav-tabs" aria-label="Main">
          <a
            href={routeHash({ view: 'board' })}
            aria-current={route.view === 'board' ? 'page' : undefined}
          >
            Board
          </a>
          <a
            href={routeHash({ view: 'workflows', workflowId: null })}
            aria-current={route.view === 'workflows' ? 'page' : undefined}
          >
            Workflow
          </a>
          <a
            href={routeHash({ view: 'machines' })}
            aria-current={route.view === 'machines' ? 'page' : undefined}
          >
            Machines
          </a>
        </nav>
        {route.view === 'board' && (
          <button type="button" onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
            {creating ? 'Close form' : 'New ticket'}
          </button>
        )}
        {me && (
          <AccountMenu
            api={api}
            me={me}
            onAdmin={() => navigate({ view: 'admin' })}
            onSignedOut={onSignedOut}
          />
        )}
      </header>
      {error && (
        <p role="alert" className="error banner">
          {error}
        </p>
      )}
      <DiscardDraftConfirm draft={draft} navigate={navigate} />
      {route.view === 'workflows' && <WorkflowsView api={api} onDirtyChange={draft.setDirty} />}
      {route.view === 'machines' && <MachinesPage api={api} />}
      {route.view === 'admin' &&
        (me ? <AdminPage api={api} me={me} /> : <p className="loading">Loading…</p>)}
      {route.view === 'board' && creating && (
        <CreateTicketForm api={api} onCreated={() => setCreating(false)} />
      )}
      <main hidden={route.view !== 'board'}>
        <Board board={board} selectedSessionId={selected} onSelect={setSelected} api={api} />
        {selected && (
          <DetailPanel
            key={selected}
            api={api}
            sessionId={selected}
            {...(selectedCard ? { ticketId: selectedCard.ticket_id } : {})}
            // UX-5: a `card.badge` (e.g. the build-slot wait) doesn't touch updated_at; refetch on it too.
            version={
              selectedCard ? `${selectedCard.updated_at}|${selectedCard.badges.join(',')}` : ''
            }
            onClose={() => setSelected(null)}
            onSelectSession={setSelected}
          />
        )}
      </main>
    </div>
  );
}
