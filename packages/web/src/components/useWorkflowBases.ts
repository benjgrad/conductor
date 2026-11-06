import type { WorkflowDefinition } from '@conductor/shared';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client.js';

// ADR-0039 (B3): the `bases` and `base_default` of a workflow's latest version, for the ticket
// Base control and label. Best effort: null until loaded, or when the load fails (the control
// then offers only the default and a custom ref).

export type WorkflowBases = Pick<WorkflowDefinition, 'bases' | 'base_default'>;

/** Loaded once per client and workflow id (a definition rarely changes while a sheet is open). */
const cache = new WeakMap<ApiClient, Map<string, Promise<WorkflowBases>>>();

function load(api: ApiClient, workflowId: string): Promise<WorkflowBases> {
  let byId = cache.get(api);
  if (!byId) cache.set(api, (byId = new Map<string, Promise<WorkflowBases>>()));
  let p = byId.get(workflowId);
  if (!p) {
    p = api.getWorkflow(workflowId).then((d) => ({
      ...(d.definition.bases !== undefined ? { bases: d.definition.bases } : {}),
      ...(d.definition.base_default !== undefined
        ? { base_default: d.definition.base_default }
        : {}),
    }));
    // A failure isn't cached: the next open tries again.
    p.catch(() => byId.delete(workflowId));
    byId.set(workflowId, p);
  }
  return p;
}

export function useWorkflowBases(api: ApiClient, workflowId: string): WorkflowBases | null {
  const [bases, setBases] = useState<WorkflowBases | null>(null);
  useEffect(() => {
    let cancelled = false;
    load(api, workflowId).then(
      (b) => {
        if (!cancelled) setBases(b);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [api, workflowId]);
  return bases;
}
