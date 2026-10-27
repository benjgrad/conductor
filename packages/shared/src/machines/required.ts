import type { TicketKind, WorkflowDefinition } from '../workflow/schema.js';
import type { CapabilityRequirement } from './capabilities.js';

export type RequiredCapabilitiesFn = (
  def: WorkflowDefinition,
  kind: TicketKind | null,
) => CapabilityRequirement[];

/**
 * ADR-0013 §Routing: the capabilities a ticket of `kind` (null = both, U-062) needs on a machine,
 * the union over every transition it could take, sorted and de-duplicated. Pure. Computed when a
 * workflow version is saved (M2-T12) and read by the claim (M2-T16).
 */
// M2-T06: stub; implemented from the capability registry (workflow/capabilities.ts).
export const requiredCapabilities: RequiredCapabilitiesFn = () => [];
