// ADR-0039: "skip permissions" (`--permission-mode bypassPermissions`) for working agents, set per
// ticket or as a machine's default.

/**
 * Whether a session start runs its agent with skip permissions: the ticket's own setting wins
 * (`true` / `false`); `null` falls back to the machine's default. A requirements reviewer or QA
 * session (`review`) never does (ADR-0022 D2, ADR-0009): it keeps `dontAsk`.
 */
export function effectiveSkipPermissions(
  ticket: boolean | null | undefined,
  machineDefault: boolean | null | undefined,
  review = false,
): boolean {
  if (review) return false;
  return ticket ?? machineDefault ?? false;
}
