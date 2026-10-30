import type { WorkflowDefinition } from './schema.js';

/**
 * May a person edit the ticket while its card is in `workflowState` (null = Queued, no state yet)?
 * The state's `ticket_editable`, else: Queued and `human` states yes, every other type no. An
 * unknown state or definition is read-only (fail closed). Reading is always allowed.
 */
export function ticketEditable(
  def: Pick<WorkflowDefinition, 'states' | 'queued_ticket_editable'> | null,
  workflowState: string | null,
): boolean {
  if (workflowState === null || workflowState === '') return def?.queued_ticket_editable ?? true;
  if (!def || !Object.prototype.hasOwnProperty.call(def.states, workflowState)) return false;
  const state = def.states[workflowState]!;
  return state.ticket_editable ?? state.type === 'human';
}
