// Spend accounting (ADR-0005, 02 `session.claude_spend_totals`, 03 `spend`, 09 §Budgets).
// `total_usd` is cumulative for a Claude session and survives `--resume`, so the engine keeps
// the last total per claude_session_id and adds only the positive delta. Replays, duplicates
// and out-of-order reports are therefore harmless.

export interface SpendState {
  spend_usd: number;
  claude_spend_totals: Record<string, number>;
}

/** Positive delta of a cumulative report against the last total for that Claude session. */
export function spendDelta(state: SpendState, claudeSessionId: string, totalUsd: number): number {
  const last = state.claude_spend_totals[claudeSessionId] ?? 0;
  return totalUsd > last ? totalUsd - last : 0;
}

/** Fold one cumulative report into the state (pure; returns a new object). */
export function applySpend<T extends SpendState>(
  state: T,
  claudeSessionId: string,
  totalUsd: number,
): T {
  const delta = spendDelta(state, claudeSessionId, totalUsd);
  if (delta === 0) return state;
  return {
    ...state,
    spend_usd: state.spend_usd + delta,
    claude_spend_totals: { ...state.claude_spend_totals, [claudeSessionId]: totalUsd },
  };
}
