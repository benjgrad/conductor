// UX-9: the board's stored layout, the collapsed column ids, per browser and per workflow.

/** ADR-0010: the board shows one workflow; its name keys the remembered layout. */
export const DEFAULT_BOARD_WORKFLOW = 'conductor';

export const boardLayoutKey = (workflow: string) => `conductor.board.collapsed.${workflow}`;

/**
 * The stored collapsed ids; with `columnIds`, only those (a stored id that is no longer a column
 * is ignored). The board reads them all and filters when it renders: before GET /api/board it
 * shows the default columns, and a custom workflow's ids must survive that.
 */
export function readCollapsed(workflow: string, columnIds?: readonly string[]): Set<string> {
  try {
    const raw = localStorage.getItem(boardLayoutKey(workflow));
    if (raw === null) return new Set();
    const saved: unknown = JSON.parse(raw);
    if (!Array.isArray(saved)) return new Set();
    const known = columnIds && new Set(columnIds);
    return new Set(
      saved.filter((id): id is string => typeof id === 'string' && (!known || known.has(id))),
    );
  } catch {
    return new Set();
  }
}

export function writeCollapsed(workflow: string, collapsed: ReadonlySet<string>) {
  try {
    if (collapsed.size === 0) localStorage.removeItem(boardLayoutKey(workflow));
    else localStorage.setItem(boardLayoutKey(workflow), JSON.stringify([...collapsed].sort()));
  } catch {
    // Private mode or a full quota: the choice just isn't remembered.
  }
}

/** UXR-37: the focus-mode ticket list's collapsed groups, kept apart from the board's columns. */
export const ticketListKey = (workflow: string) => `conductor.ticketList.collapsed.${workflow}`;

/** The stored collapsed group ids, or null when nothing was ever stored (use the defaults). */
export function readListCollapsed(workflow: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(ticketListKey(workflow));
    if (raw === null) return null;
    const saved: unknown = JSON.parse(raw);
    if (!Array.isArray(saved)) return null;
    return new Set(saved.filter((id): id is string => typeof id === 'string'));
  } catch {
    return null;
  }
}

/** Stored even when empty: "everything open" is a choice, unlike "never touched". */
export function writeListCollapsed(workflow: string, collapsed: ReadonlySet<string>) {
  try {
    localStorage.setItem(ticketListKey(workflow), JSON.stringify([...collapsed].sort()));
  } catch {
    // Private mode or a full quota: the choice just isn't remembered.
  }
}

/** UXR-37: whether focus mode is on, remembered per browser. */
export const FOCUS_KEY = 'conductor.detail.focus';

export function readFocus(): boolean {
  try {
    return localStorage.getItem(FOCUS_KEY) === 'on';
  } catch {
    return false;
  }
}

export function writeFocus(on: boolean) {
  try {
    if (on) localStorage.setItem(FOCUS_KEY, 'on');
    else localStorage.removeItem(FOCUS_KEY);
  } catch {
    // Private mode or a full quota: the choice just isn't remembered.
  }
}
