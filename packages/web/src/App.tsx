import { useState } from 'react';
import type { ApiClient } from './api/client.js';
import { useBoard } from './board/hooks.js';
import { Board } from './components/Board.js';
import { CreateTicketForm } from './components/CreateTicketForm.js';
import { DetailPanel } from './components/DetailPanel.js';

export interface AppProps {
  api: ApiClient;
}

export function App({ api }: AppProps) {
  const { board, error } = useBoard(api);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const selectedCard = selected
    ? [...board.cards.values()].find((c) => c.session_id === selected)
    : undefined;

  return (
    <div className={`app${selected ? ' with-detail' : ''}`}>
      <header className="topbar">
        <h1>Conductor</h1>
        <button type="button" onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
          {creating ? 'Close form' : 'New ticket'}
        </button>
      </header>
      {error && (
        <p role="alert" className="error banner">
          {error}
        </p>
      )}
      {creating && <CreateTicketForm api={api} onCreated={() => setCreating(false)} />}
      <main>
        <Board board={board} selectedSessionId={selected} onSelect={setSelected} />
        {selected && (
          <DetailPanel
            key={selected}
            api={api}
            sessionId={selected}
            {...(selectedCard ? { ticketId: selectedCard.ticket_id } : {})}
            version={selectedCard?.updated_at ?? ''}
            onClose={() => setSelected(null)}
          />
        )}
      </main>
    </div>
  );
}
