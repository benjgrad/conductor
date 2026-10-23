import type { SessionDetail } from '@conductor/shared';
import { WorkflowDiagram } from './WorkflowDiagram.js';

/** The session's pinned workflow as a compact, read-only diagram, current state highlighted. */
export function SessionWorkflowDiagram({ detail }: { detail: SessionDetail }) {
  return (
    <WorkflowDiagram
      definition={detail.workflow}
      current={detail.card.workflow_state}
      compact
      label={`${detail.workflow.id} v${detail.workflow_version} diagram, current state ${
        detail.card.workflow_state ?? 'none'
      }`}
    />
  );
}
