import type { SessionDetail } from '@conductor/shared';
import { ColumnsDiagram } from './ColumnsDiagram.js';
import { columnTitle, currentLane, readChecking } from './columns.js';
import { stateLabel } from './review.js';
import { WorkflowDiagram } from './WorkflowDiagram.js';

/**
 * The session's pinned workflow, compact and read-only. A workflow with board columns (ADR-0010)
 * draws as its lanes with the session's column highlighted and, during an entry step, the move it
 * is checking. An older workflow draws as the UML state diagram (ADR-0009) with the current state,
 * or the gated edge under review, highlighted.
 */
export function SessionWorkflowDiagram({ detail }: { detail: SessionDetail }) {
  const { card, workflow } = detail;
  const state = card.workflow_state;
  if (workflow.columns !== undefined) {
    const lane = currentLane(workflow, state, card.status);
    const checking = readChecking(card);
    const where =
      lane === null ? (state ? stateLabel(state) : 'none') : columnTitle(workflow, lane);
    return (
      <ColumnsDiagram
        definition={workflow}
        current={lane}
        checking={checking}
        compact
        label={
          `${workflow.id} v${detail.workflow_version} columns, current column ${where}` +
          (checking ? `, checking requirements to enter ${columnTitle(workflow, checking.to)}` : '')
        }
      />
    );
  }
  return (
    <WorkflowDiagram
      definition={workflow}
      current={state}
      compact
      label={`${workflow.id} v${detail.workflow_version} diagram, current state ${
        state ? stateLabel(state) : 'none'
      }`}
    />
  );
}
