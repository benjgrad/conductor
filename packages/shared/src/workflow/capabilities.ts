import type { CapabilityRequirement } from '../machines/capabilities.js';
import {
  conditionEnabled,
  type ConditionType,
  type TicketKind,
  type TransitionAction,
  type WorkflowDefinition,
} from './schema.js';
import { transitionMatchesKind, transitionObject } from './transition-rules.js';

// The capability registry (ADR-0013 §Routing, ADR-0016): what a machine needs to run each part
// of a workflow, as capability keys (10-contracts §Machines protocol v2, "Capability keys").

/** Every agent state and every reviewer runs Claude Code. */
export const CLAUDE_CAPABILITY = 'claude';

/** What each external condition needs on the machine that evaluates it. */
export const CONDITION_CAPABILITIES = {
  pr_checks_green: 'cli:gh:authed',
  pr_approvals: 'cli:gh:authed',
  pr_merged: 'cli:gh:authed',
  azure_pipeline_succeeded: 'cli:az:authed',
  // Placeholder until M5 decides CLI vs MCP for Jira (U-065).
  jira_fields_set: 'cli:jira:authed',
} as const satisfies Record<ConditionType, CapabilityRequirement>;

/** What each of conductor's actions needs on the session's machine. */
export const ACTION_CAPABILITIES = {
  open_pr: 'cli:gh:authed',
  // Placeholder until M5 decides CLI vs MCP for Jira (U-065).
  update_jira: 'cli:jira:authed',
  slack_message: 'mcp:slack',
} as const satisfies Record<TransitionAction, CapabilityRequirement>;

/**
 * ADR-0013 §Routing: the capabilities a ticket of `kind` (null = both, U-062) needs on a machine,
 * sorted and de-duplicated. "Every transition it could take" is read as every transition whose
 * `kinds` match (no reachability analysis): its `requires` actions, enabled conditions and review.
 * An ADR-0010 `entry` belongs to its state, so it counts for every kind. Disabled conditions add
 * nothing; any agent state or reviewer adds `claude`.
 */
export function requiredCapabilitiesOf(
  def: WorkflowDefinition,
  kind: TicketKind | null,
): CapabilityRequirement[] {
  const out = new Set<CapabilityRequirement>();
  for (const state of Object.values(def.states)) {
    if (state.type === 'agent') out.add(CLAUDE_CAPABILITY);
    // TD-145: connector states (`action` / `actions`) have no capability mapping until M5.
    if (state.entry !== undefined) {
      for (const a of state.entry.actions ?? []) out.add(ACTION_CAPABILITIES[a]);
      if (state.entry.review !== undefined) out.add(CLAUDE_CAPABILITY);
    }
    if (state.type === 'terminal') continue;
    for (const raw of Object.values(state.on ?? {})) {
      if (!transitionMatchesKind(raw, kind)) continue;
      const t = transitionObject(raw);
      if (t.requirements !== undefined) out.add(CLAUDE_CAPABILITY);
      const req = t.requires;
      if (req === undefined) continue;
      if (req.review !== undefined) out.add(CLAUDE_CAPABILITY);
      for (const a of req.actions ?? []) out.add(ACTION_CAPABILITIES[a]);
      for (const c of req.conditions ?? []) {
        if (conditionEnabled(c)) out.add(CONDITION_CAPABILITIES[c.type]);
      }
    }
  }
  return [...out].sort();
}
