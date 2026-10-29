# QA checklist

Every task branch passes this before it merges to `main`. The `qa-reviewer` agent runs it and posts the filled-in checklist as its report. A gate is ✅, ❌, or `n/a`, and every `n/a` needs a reason.

## 1 · Gates (automated, must be green)
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test` (unit + integration)
- [ ] `pnpm build`
- [ ] `pnpm test:e2e`, if the task touches the orchestrator↔daemon contract, the engine, or the web flows (from M1-T10 onward)

Before M1-T01 lands, gates are `n/a (no scaffold)`.

## 2 · Acceptance criteria
- [ ] Every acceptance bullet in the task (milestone file) is checked **individually**, with evidence: a test name, command output, or screenshot path.

## 3 · Correctness review
- [ ] Workflow transitions fire only on outcomes (exit code / structured tool / event), never on free text.
- [ ] Every new failure path ends at `needs_input` or `failed`. No unbounded loops or retries.
- [ ] State change + outgoing command in one transaction (outbox). No direct sends from request handlers.
- [ ] Messages to daemons carry `command_id`. Events from daemons carry `seq` + `fencing_token` and are checked.
- [ ] External side effects have an idempotency key, or are documented as accepted-duplicate.
- [ ] No raw terminal output written to Postgres.
- [ ] No secrets in code, logs, events, or daemon payloads.

## 4 · Tests
- [ ] New logic has unit tests. The pure FSM `apply()` has a test for every new transition.
- [ ] DB code has an integration test against real Postgres (no mocks for SQL).
- [ ] Failure paths are tested, not just happy paths.
- [ ] New tests are small and fast ([TEST_STRATEGY §Write small, fast tests](TEST_STRATEGY.md#write-small-fast-tests)): cases go through a pure function. A test that spawns a process, or uses a real repo, DB or browser, says in a comment why only that can show it, and is in `SLOW_TIERS`.

## 5 · Docs & tracking (the lead or doc-keeper applies these from the report)
- [ ] The design doc matches the code. If behaviour diverged, the doc is updated in this branch, plus an ADR if it reverses a decision.
- [ ] Shortcuts → TD-### rows, with `// TD-###` at the site.
- [ ] New questions → U-### rows.
- [ ] Anything unfinished → UNFINISHED entry. Otherwise the task status is set to `done`.

## Verdict
`PASS` | `PASS WITH DEBT` (TD rows listed) | `FAIL` (blocking items listed, task goes back to implementer)
