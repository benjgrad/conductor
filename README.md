# conductor

An autonomous orchestrator for Claude Code. Machine daemons on developer laptops and build servers dial out to a central control plane. That control plane claims tickets, runs them through user-defined FSM workflows (implement → build → test → PR → notify → approve → update tickets), and shows every session on a kanban board. Sessions that need a human go to a *Needs input* column. You answer there and the agent continues.

**Status**: design complete, M1 not started. See [docs/tracking/STATUS.md](docs/tracking/STATUS.md).

- Design: [docs/design/00-overview.md](docs/design/00-overview.md)
- Roadmap: [docs/plan/ROADMAP.md](docs/plan/ROADMAP.md)
- How we work (planning, multi-agent sessions, QA): [CLAUDE.md](CLAUDE.md)
