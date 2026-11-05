// UXR-37: the desktop panel header's focus-mode toggle (11-web-ui §Desktop detail layout). Focus
// mode swaps the board for a ticket list and gives the panel the rest of the window.
import { Maximize2, Minimize2 } from 'lucide-react';

/** The toggle, for the session and the ticket panel. */
export function FocusToggle({ focus, onToggle }: { focus: boolean; onToggle: () => void }) {
  // A toggle keeps its name; aria-pressed says whether it is on. The tooltip says what a click does.
  const Icon = focus ? Minimize2 : Maximize2;
  return (
    <button
      type="button"
      className="icon-button focus-toggle"
      aria-pressed={focus}
      aria-label="Focus mode"
      title={focus ? 'Exit focus mode' : 'Focus mode'}
      onClick={onToggle}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}
