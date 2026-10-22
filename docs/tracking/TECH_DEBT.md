# Tech debt

Every **deliberate shortcut** gets a row in the same PR that takes it. Leave a `// TD-###` comment at the site in the code. Payoff happens when the trigger fires, or during a milestone's hardening pass.

Severity: `low` (cosmetic/local) · `med` (will slow us down) · `high` (correctness/security risk at next milestone)

| ID | Shortcut | Where | Risk if left | Payoff trigger | Severity | Status |
|---|---|---|---|---|---|---|
<!-- example:
| TD-001 | Short-hold counters kept in memory, lost on restart | packages/orchestrator/src/scheduler/hold.ts | Tickets may be held slightly longer/shorter after restart | Running >1 orchestrator replica (M2+) | low | open |
-->
