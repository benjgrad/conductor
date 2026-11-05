import type { MeResponse, TicketSearchResult } from '@conductor/shared';
import {
  Archive,
  CalendarClock,
  CircleHelp,
  LayoutDashboard,
  ListChecks,
  Plug,
  Plus,
  Server,
  ServerCog,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { ApiClient } from './api/client.js';
import { AdminPage } from './admin/Admin.js';
import { AccountMenu } from './auth/AccountMenu.js';
import { NETWORK } from './auth/errors.js';
import { Reset } from './auth/Reset.js';
import { isUnauthorized, withAuthRedirect } from './auth/session.js';
import { SignIn } from './auth/SignIn.js';
import { SignUp } from './auth/SignUp.js';
import { useBoard } from './board/hooks.js';
import { ArchivePage } from './components/ArchivePage.js';
import { Board } from './components/Board.js';
import { CreateTicketForm } from './components/CreateTicketForm.js';
import { DetailPanel } from './components/DetailPanel.js';
import { TicketPanel } from './components/TicketPanel.js';
import { TicketSearch } from './components/TicketSearch.js';
import { ToastProvider } from './components/Toast.js';
import { NavIcon } from './components/NavIcon.js';
import {
  useDocumentClass,
  useElementHeightVar,
  useIsMobile,
  useVisualViewportHeight,
} from './components/useMediaQuery.js';
import {
  CONNECT_CLAUDE_URL,
  followInApp,
  HelpLink,
  HelpPage,
  isHelpPath,
} from './help/HelpPage.js';
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
import { useTransitionNotifications } from './notify/useTransitionNotifications.js';
import { dismiss, isDismissed } from './onboarding/dismissal.js';
import { SetupGuide } from './onboarding/SetupGuide.js';
import { RepoChecksPage } from './repo-checks/RepoChecksPage.js';
import { SchedulesPage } from './schedules/SchedulesPage.js';
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
export function App(props: AppProps) {
  // UXR-55: the toast region wraps every page (shell, setup, admin, help, sign-in).
  return (
    <ToastProvider>
      <AppRoutes {...props} />
    </ToastProvider>
  );
}

function AppRoutes({ api, compact: compactProp }: AppProps) {
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
  // UX-8: the help pages need no account and no API; `#/help/…` is the first one's alias.
  const helpPage = isHelpPath(pathname);
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
  if (helpPage) return <HelpPage path={pathname} />;
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
  const [selected, setSelectedSession] = useState<string | null>(null);
  // A card with no session (Queued) opens by its ticket; at most one of the two is set.
  const [selectedTicket, setSelectedTicket] = useState<string | null>(null);
  const setSelected = useCallback((sessionId: string | null) => {
    setSelectedSession(sessionId);
    setSelectedTicket(null);
  }, []);
  const selectTicket = useCallback((ticketId: string) => {
    setSelectedSession(null);
    setSelectedTicket(ticketId);
  }, []);
  const [creating, setCreating] = useState(false);
  const topbarRef = useRef<HTMLElement>(null);
  useElementHeightVar(topbarRef, '--topbar-h');
  // 11-web-ui §Breakpoint: on a phone the document never scrolls; `.app.mobile` does.
  useDocumentClass('app-shell', mobile);
  const draft = useDraftGuard();
  const [route, navigate] = useHashRoute(draft.guard, draft.onBlocked);
  // UX-14: title count, favicon dot and a browser notification per new question.
  const openSession = (sessionId: string) => {
    navigate({ view: 'board' });
    setSelected(sessionId);
  };
  // UXR-85: a search result or an Archive row opens its panel over the board (or the Archive).
  const openResult = (t: TicketSearchResult) => {
    if (route.view !== 'board' && route.view !== 'archive') {
      navigate({ view: 'board' });
      // The draft guard held the user back: stay, open nothing.
      if (parseHash(window.location.hash).view !== 'board') return;
    }
    if (t.session_id !== null) setSelected(t.session_id);
    else selectTicket(t.id);
  };
  useNeedsInputNotifications(board, openSession);
  useTransitionNotifications(board, openSession);
  // UX-16: a push notification's tap opens its ticket (#/?ticket=…).
  // UXR-83: a queued ticket (a schedule's fresh run) has no session yet: open it by its ticket.
  useOpenFromNotification(board, openSession, (ticketId) => {
    navigate({ view: 'board' });
    selectTicket(ticketId);
  });
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

  // 11-web-ui §Top bar: on a phone, Add a machine and Help move into the account menu. Connect
  // Claude (the MCP setup guide) is in the menu at every width.
  const menuLinks = [
    ...(mobile
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
      : []),
    {
      label: 'Connect Claude',
      href: CONNECT_CLAUDE_URL,
      icon: <NavIcon icon={Plug} />,
      onClick: (e: MouseEvent<HTMLAnchorElement>) => followInApp(e, CONNECT_CLAUDE_URL),
    },
    // ADR-0030: per-repo check overrides, a settings page (not a top-bar tab).
    {
      label: 'Repo checks',
      href: routeHash({ view: 'repo-checks', repo: null }),
      icon: <NavIcon icon={ListChecks} />,
    },
  ];

  const showForm = route.view === 'board' && !guide && creating;
  // UXR-41: the page under the desktop New ticket sheet doesn't scroll (the phone locks `.app`).
  useDocumentClass('modal-open', showForm && !mobile);
  // UXR-26: on the desktop board the document never scrolls; the shell is the window's height.
  const boardView = route.view === 'board' && !guide;
  const selectedCard = selected
    ? [...board.cards.values()].find((c) => c.session_id === selected)
    : undefined;
  const ticketCard = selectedTicket ? board.cards.get(selectedTicket) : undefined;
  // The open queued ticket was claimed: its card has a session now, so show that.
  const claimed = ticketCard?.session_id ?? null;
  if (claimed !== null) {
    setSelectedSession(claimed);
    setSelectedTicket(null);
  }

  return (
    <div
      className={`app${selected || selectedTicket ? ' with-detail' : ''}${mobile ? ' mobile' : ''}${showForm ? ' creating' : ''}${boardView && !mobile ? ' board-view' : ''}`}
    >
      <header ref={topbarRef} className={`topbar${compact ? ' compact' : ''}`}>
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
          {/* ADR-0032 / UXR-83: recurring jobs. */}
          <a
            href={routeHash({ view: 'schedules', scheduleId: null })}
            aria-current={route.view === 'schedules' ? 'page' : undefined}
            {...iconOnly('Schedules')}
          >
            {labelled(CalendarClock, 'Schedules')}
          </a>
          <a
            href={routeHash({ view: 'archive' })}
            aria-current={route.view === 'archive' ? 'page' : undefined}
            {...iconOnly('Archive')}
          >
            {labelled(Archive, 'Archive')}
          </a>
        </nav>
        {!guide && <TicketSearch api={api} onOpen={openResult} mobile={mobile} />}
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
            // UXR-41: the sheet covers the bar at every width, so this only opens it.
            onClick={() => setCreating(true)}
            aria-haspopup="dialog"
            {...iconOnly('New ticket')}
          >
            {labelled(Plus, 'New ticket')}
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
      {route.view === 'machines' && (
        <MachinesPage
          api={api}
          ticketTitle={(id) => [...board.cards.values()].find((c) => c.ticket_id === id)?.title}
        />
      )}
      {route.view === 'schedules' && (
        <SchedulesPage
          api={api}
          scheduleId={route.scheduleId}
          onOpen={(scheduleId) => navigate({ view: 'schedules', scheduleId })}
        />
      )}
      {route.view === 'repo-checks' && (
        <RepoChecksPage
          api={api}
          repo={route.repo}
          onSelect={(repo) => navigate({ view: 'repo-checks', repo })}
          onDirtyChange={draft.setDirty}
        />
      )}
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
      {showForm && (
        <CreateTicketForm
          api={api}
          onCreated={() => setCreating(false)}
          onClose={() => setCreating(false)}
        />
      )}
      <main hidden={(route.view !== 'board' && route.view !== 'archive') || guide}>
        {route.view === 'archive' ? (
          <ArchivePage api={api} onOpen={openResult} />
        ) : (
          <Board
            board={board}
            selectedSessionId={selected}
            onSelect={setSelected}
            selectedTicketId={selectedTicket}
            onSelectTicket={selectTicket}
            api={api}
          />
        )}
        {selectedTicket && !selected && (
          <TicketPanel
            key={selectedTicket}
            api={api}
            ticketId={selectedTicket}
            version={ticketCard?.updated_at ?? ''}
            onClose={() => setSelectedTicket(null)}
            fullScreen={mobile}
            routing={ticketCard?.routing}
          />
        )}
        {selected && (
          <DetailPanel
            key={selected}
            api={api}
            sessionId={selected}
            {...(selectedCard ? { card: selectedCard } : {})}
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
