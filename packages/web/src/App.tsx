import type { MeResponse } from '@conductor/shared';
import {
  CircleHelp,
  LayoutDashboard,
  Plus,
  Server,
  ServerCog,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
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
import { NavIcon } from './components/NavIcon.js';
import { useIsMobile, useVisualViewportHeight } from './components/useMediaQuery.js';
import { followInApp, HelpLink, HelpPage } from './help/HelpPage.js';
import { SETUP_GUIDE_URL } from './machines/format.js';
import { MachinesPage } from './machines/Machines.js';
import {
  currentPath,
  goTo,
  parseHash,
  routeHash,
  signInPath,
  useHashRoute,
  usePath,
} from './nav.js';
import { useOpenFromNotification } from './notify/open-ticket.js';
import { useNeedsInputNotifications } from './notify/useNeedsInputNotifications.js';
import { dismiss, isDismissed } from './onboarding/dismissal.js';
import { SetupGuide } from './onboarding/SetupGuide.js';
import { DiscardDraftConfirm, useDraftGuard } from './workflow/draft-guard.js';
import { WorkflowsView } from './workflow/WorkflowsView.js';

export interface AppProps {
  api: ApiClient;
  /** UX-11: icon-only top bar. Defaults to on below the phone breakpoint (11-web-ui). */
  compact?: boolean | undefined;
}

/**
 * M2-T05: the sign-in gate. `/signin`, `/signup` and `/reset` render on their own. Anything else
 * renders the app and asks GET /api/me at once (in `local` mode that is the local user, so dev is
 * unchanged); the account menu waits for the answer. The app's ApiClient sends any 401, REST or
 * SSE, to `/signin?next=<where they were>` (auth/session.ts), as does a 401 from /api/me.
 */
export function App({ api, compact: compactProp }: AppProps) {
  const { pathname, search } = usePath();
  const mobile = useIsMobile();
  useVisualViewportHeight(mobile);
  const compact = compactProp ?? mobile;
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
  // UX-8: the help page needs no account and no API; `#/help/…` is its alias.
  const helpPage = pathname === SETUP_GUIDE_URL;
  const helpAlias = pathname === '/' && parseHash(window.location.hash).view === 'help';

  useEffect(() => {
    if (adminAlias) goTo('/#/admin', { replace: true });
    else if (helpAlias) goTo(SETUP_GUIDE_URL, { replace: true });
  }, [adminAlias, helpAlias]);

  const needsProbe = !authPage && !adminAlias && !helpPage && !helpAlias && me === null;
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
  if (helpPage) return <HelpPage />;
  if (adminAlias || helpAlias) return null;
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
      compact={compact}
      mobile={mobile}
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
  compact: boolean;
  /** 11-web-ui: the phone layout (one board column, full-screen panel and form). */
  mobile: boolean;
}

/** The favicon's mark (index.html), the bar's title on a phone. */
function LogoMark() {
  return (
    <svg className="logo-mark" viewBox="0 0 64 64" width="28" height="28" aria-hidden="true">
      <rect x="4" y="4" width="56" height="56" rx="14" fill="#3b4cca" />
      <path d="M18 22h28M18 32h20M18 42h24" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

function Shell({ api, me, onSignedOut, compact, mobile }: ShellProps) {
  const { board, error } = useBoard(api);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const draft = useDraftGuard();
  const [route, navigate] = useHashRoute(draft.guard, draft.onBlocked);
  // UX-14: title count, favicon dot and a browser notification per new question.
  const openSession = (sessionId: string) => {
    navigate({ view: 'board' });
    setSelected(sessionId);
  };
  useNeedsInputNotifications(board, openSession);
  // UX-16: a push notification's tap opens its ticket (#/?ticket=…).
  useOpenFromNotification(board, openSession);
  // UX-8 FR-1: the account's machine count, asked once per load. With none (and the guide not
  // dismissed this visit), the board area shows the setup guide. Not re-polled, so the guide stays
  // while the new machine connects in its step 3.
  const [machineCount, setMachineCount] = useState<number | null>(null);
  const [firstRun, setFirstRun] = useState(false);
  const userId = me?.user.id ?? null;

  useEffect(() => {
    if (userId === null) return;
    let cancelled = false;
    api.listMachines().then(
      (rows) => {
        if (cancelled) return;
        const count = rows.filter((r) => r.revoked_at === null).length;
        setMachineCount(count);
        setFirstRun(count === 0 && !isDismissed(userId));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api, userId]);

  useEffect(() => {
    if (route.view === 'help') goTo(SETUP_GUIDE_URL, { replace: true });
  }, [route.view]);

  const guide = route.view === 'setup' || (route.view === 'board' && firstRun);

  function hideGuide() {
    setFirstRun(false);
    if (route.view === 'setup') navigate({ view: 'board' });
  }

  // UX-11: in compact mode only the icon shows, so the control is named by its label instead.
  const iconOnly = (label: string) => (compact ? { 'aria-label': label, title: label } : {});
  const labelled = (icon: LucideIcon, label: string) => (
    <>
      <NavIcon icon={icon} />
      <span className="nav-label">{label}</span>
    </>
  );

  // 11-web-ui §Top bar: on a phone, Add a machine and Help move into the account menu.
  const menuLinks = mobile
    ? [
        {
          label: 'Add a machine',
          href: routeHash({ view: 'setup' }),
          icon: <NavIcon icon={ServerCog} />,
        },
        {
          label: 'Help',
          href: SETUP_GUIDE_URL,
          icon: <NavIcon icon={CircleHelp} />,
          onClick: (e: MouseEvent<HTMLAnchorElement>) => followInApp(e, SETUP_GUIDE_URL),
        },
      ]
    : [];

  const selectedCard = selected
    ? [...board.cards.values()].find((c) => c.session_id === selected)
    : undefined;

  return (
    <div className={`app${selected ? ' with-detail' : ''}${mobile ? ' mobile' : ''}`}>
      <header className={`topbar${compact ? ' compact' : ''}`}>
        {mobile ? (
          <h1>
            <LogoMark />
            <span className="visually-hidden">Conductor</span>
          </h1>
        ) : (
          <h1>Conductor</h1>
        )}
        <nav className="nav-tabs" aria-label="Main">
          <a
            href={routeHash({ view: 'board' })}
            aria-current={route.view === 'board' ? 'page' : undefined}
            {...iconOnly('Board')}
          >
            {labelled(LayoutDashboard, 'Board')}
          </a>
          <a
            href={routeHash({ view: 'workflows', workflowId: null })}
            aria-current={route.view === 'workflows' ? 'page' : undefined}
            {...iconOnly('Workflow')}
          >
            {labelled(Workflow, 'Workflow')}
          </a>
          <a
            href={routeHash({ view: 'machines' })}
            aria-current={route.view === 'machines' ? 'page' : undefined}
            {...iconOnly('Machines')}
          >
            {labelled(Server, 'Machines')}
          </a>
        </nav>
        {!mobile && (
          <nav className="nav-tabs help-entry" aria-label="Help">
            <a
              href={routeHash({ view: 'setup' })}
              aria-current={guide ? 'page' : undefined}
              {...iconOnly('Add a machine')}
            >
              {labelled(ServerCog, 'Add a machine')}
            </a>
            <HelpLink {...iconOnly('Help')}>{labelled(CircleHelp, 'Help')}</HelpLink>
          </nav>
        )}
        {route.view === 'board' && !guide && (
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            aria-expanded={creating}
            {...iconOnly(creating ? 'Close form' : 'New ticket')}
          >
            {creating ? labelled(X, 'Close form') : labelled(Plus, 'New ticket')}
          </button>
        )}
        {me && (
          <AccountMenu
            api={api}
            me={me}
            onAdmin={() => navigate({ view: 'admin' })}
            onSignedOut={onSignedOut}
            compact={compact}
            extraItems={menuLinks}
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
      {guide && (
        <SetupGuide
          api={api}
          first={machineCount === 0}
          onDismiss={() => {
            if (userId !== null) dismiss(userId);
            hideGuide();
          }}
          onCreateTicket={() => {
            hideGuide();
            setCreating(true);
          }}
          onFinish={() => setFirstRun(false)}
        />
      )}
      {route.view === 'board' && !guide && creating && (
        <CreateTicketForm
          api={api}
          onCreated={() => setCreating(false)}
          sheet={mobile}
          onClose={() => setCreating(false)}
        />
      )}
      <main hidden={route.view !== 'board' || guide}>
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
            fullScreen={mobile}
            onSelectSession={setSelected}
          />
        )}
      </main>
    </div>
  );
}
