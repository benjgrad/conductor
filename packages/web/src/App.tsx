import { useState } from 'react';
import type { ApiClient } from './api/client.js';
import { useBoard } from './board/hooks.js';
import { Board } from './components/Board.js';
import { CreateTicketForm } from './components/CreateTicketForm.js';
import { DetailPanel } from './components/DetailPanel.js';
import { routeHash, useHashRoute } from './nav.js';
import { DiscardDraftConfirm, useDraftGuard } from './workflow/draft-guard.js';
import { WorkflowsView } from './workflow/WorkflowsView.js';

export interface AppProps {
  api: ApiClient;
}

export function App({ api }: AppProps) {
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
            Workflows
          </a>
        </nav>
        {route.view === 'board' && (
          <button type="button" onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
            {creating ? 'Close form' : 'New ticket'}
          </button>
        )}
      </header>
      {error && (
        <p role="alert" className="error banner">
          {error}
        </p>
      )}
      <DiscardDraftConfirm draft={draft} navigate={navigate} />
      {route.view === 'workflows' && (
        <WorkflowsView
          // One view per workflow: a draft can never show under another workflow's selection.
          key={route.workflowId ?? ''}
          api={api}
          workflowId={route.workflowId}
          onSelectWorkflow={(workflowId, replace) =>
            navigate({ view: 'workflows', workflowId }, { replace })
          }
          onDirtyChange={draft.setDirty}
        />
      )}
      {route.view === 'board' && creating && (
        <CreateTicketForm api={api} onCreated={() => setCreating(false)} />
      )}
      <main hidden={route.view !== 'board'}>
        <Board board={board} selectedSessionId={selected} onSelect={setSelected} />
        {selected && (
          <DetailPanel
            key={selected}
            api={api}
            sessionId={selected}
            {...(selectedCard ? { ticketId: selectedCard.ticket_id } : {})}
            version={selectedCard?.updated_at ?? ''}
            onClose={() => setSelected(null)}
            onSelectSession={setSelected}
          />
        )}
      </main>
    </div>
  );
}
