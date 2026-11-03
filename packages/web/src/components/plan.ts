// 06 §Plan approval: where a session's plan is. The logic lives in @conductor/shared (MCP's
// get_ticket_artifacts reads it too, ADR-0031); the panel's Plan sheet (TicketStrip.tsx), the
// plan card and the Details timeline (star.ts) import it from here.
export { latestPlan, planText } from '@conductor/shared';
