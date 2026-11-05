import type { WorkflowDefinition } from '@conductor/shared';
import { columnTitle, type ColumnIssue } from './columns.js';
import { EditorHead } from './EditorHead.js';
import { TransitionList } from './TransitionList.js';
import { arrowTransitions } from './transitions.js';

// An arrow that stands for several transitions (UXR-64): the list of them, before any one is
// open. Picking a row opens that transition; Back and the first crumb open the column.

export interface ArrowEditorProps {
  definition: WorkflowDefinition;
  from: string;
  to: string;
  issues: ColumnIssue[];
  onSelectTransition: (name: string) => void;
  onSelectColumn: (state: string) => void;
  onClose: () => void;
  /** UXR-44: the phone's full-screen panel. */
  fullScreen?: boolean;
}

export function ArrowEditor({
  definition,
  from,
  to,
  issues,
  onSelectTransition,
  onSelectColumn,
  onClose,
  fullScreen = false,
}: ArrowEditorProps) {
  const names = arrowTransitions(definition, from, to);
  const fromTitle = columnTitle(definition, from);
  const arrow = `${fromTitle} → ${columnTitle(definition, to)}`;
  return (
    <aside className={`wf-editor${fullScreen ? ' full-screen' : ''}`} aria-label="Arrow">
      <EditorHead
        crumbs={[{ label: fromTitle, onClick: () => onSelectColumn(from) }, { label: arrow }]}
        title={arrow}
        back={{ label: `Back to ${fromTitle}`, onClick: () => onSelectColumn(from) }}
        closeLabel="Close arrow"
        onClose={onClose}
        fullScreen={fullScreen}
      />
      <p className="muted wf-note">
        {names.length} transitions on this arrow. Pick one to edit it.
      </p>
      <TransitionList
        definition={definition}
        from={from}
        names={names}
        issues={issues}
        onSelect={onSelectTransition}
        label="Transitions on this arrow"
      />
    </aside>
  );
}
