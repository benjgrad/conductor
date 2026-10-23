import type { SessionDetail } from '@conductor/shared';
import { stateLabel } from './review.js';
import { WorkflowDiagram } from './WorkflowDiagram.js';

/**
 * The session's pinned workflow as a compact, read-only diagram with the current state
 * highlighted, or, during a requirements review, the gated edge under review.
 */
export function SessionWorkflowDiagram({ detail }: { detail: SessionDetail }) {
  const state = detail.card.workflow_state;
  return (
    <WorkflowDiagram
      definition={detail.workflow}
      current={state}
      compact
      label={`${detail.workflow.id} v${detail.workflow_version} diagram, current state ${
        state ? stateLabel(state) : 'none'
      }`}
    />
  );
}
