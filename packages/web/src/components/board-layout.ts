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
