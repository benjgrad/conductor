// UX-2's own ticket body, verbatim: the example of the sectioned format (tests, mock data).
export const UX2_TICKET_BODY = `## Goal
Anyone opening a session sees, before anything else, what the agent was asked to do: its goal, functional and non-functional requirements, what's out of scope, and how the result will be verified.

## Context
- Design review 2026-10-27. Today the ticket body appears nowhere in the session panel, and the exact prompt the agent received can't be viewed.
- Ben decided (2026-10-27) that tickets use **markdown sections** in the body: \`## Goal\`, \`## Context\`, \`## Functional requirements\` (bullets \`FR-n …\`), \`## Non-functional requirements\` (\`NFR-n …\`), \`## Out of scope\`, \`## Verification\` (a table or a bullet list mapping each FR/NFR to its proof). Other sections may follow. THIS ticket's body is an example.
- The panel is \`packages/web/src/components/DetailPanel.tsx\`; the thread is \`OutputLog.tsx\` (owned by UX-1, which is adding an optional \`moves\` prop).

## Functional requirements
- FR-1 A pure parser \`packages/web/src/brief/parse.ts\`: markdown body → \`{goal, context, functional: {id, text}[], nonFunctional: {id, text}[], outOfScope, verification: {req, how}[], other: {heading, markdown}[], warnings: string[]}\`. Headings match case-insensitively. FR/NFR ids come from a leading \`FR-n\` / \`NFR-n\`. Verification rows are matched to requirement ids. A missing section adds a warning, and a body with no recognised sections is all \`other\` (legacy tickets still render).
- FR-2 A **Brief** card pinned at the top of the Messages tab, above the thread, collapsible, and open by default the first time a session is opened (the choice remembered per session in localStorage, wrapped in try/catch). It shows the goal, then FR and NFR checklists (read-only for now), with each requirement's verification "how" shown inline next to it; out of scope; the warnings in a muted line; and "Full ticket ▸" for the raw rendered markdown.
- FR-3 The card's header shows a tally: "FR 7 · NFR 4 · 11/11 with a verification", or "3 without verification" in a warning colour.
- FR-4 **View prompt:** a link on the card opens the exact initial prompt the agent received, if the data the web already has contains it (e.g. the first transcript/user entry or a start_session payload exposed today). Investigate first. If it isn't available without an API change, ship FR-1..3 and FR-5, and in your report state precisely what API addition is needed. Don't make it.
- FR-5 Wire UX-1's optional \`moves\` prop: pass \`SessionDetail.moves\` into \`<OutputLog>\` in DetailPanel. A one-line change. If UX-1 hasn't merged when you start, add it anyway: an unknown prop is harmless in TS only if typed, so guard with a typed optional prop on your side, or coordinate via ask_user.

## Non-functional requirements
- NFR-1 **Web-only.** Change only \`packages/web/**\`. No new API endpoints or fields: this must work against the M1b API, because the lead cherry-picks your web commits onto the pinned board build (2e88cf8) and rebuilds only the web app. If something truly needs an API change, stop and ask (ask_user).
- NFR-2 **No collisions.** M2-T05 is editing the web in parallel (sign-in pages, account menu, admin page, \`src/api/**\`, \`App.tsx\`, \`Board.tsx\`). Don't touch those. Put new styles in a CSS file owned by your component (imported by it), not in \`styles.css\`.
- NFR-3 **Accessible:** keyboard-operable expand/collapse, \`aria-expanded\`, and visible focus. Respects \`prefers-reduced-motion\`.
- NFR-4 **Fast:** a thread of 2,000 entries still renders and scrolls smoothly (measure it in a test or note how you checked).
- NFR-5 The parser is pure and has no DOM dependency, so it can later move to \`@conductor/shared\` for agents and the MCP server.

## Out of scope
- Per-requirement verification STATUS (agent claim / checks / reviewer / human). That needs engine + API work and is planned after M2.
- Editing tickets (UX-3 covers the create form).

## Verification
| Req | How it's verified |
|---|---|
| FR-1 | parse.test.ts: this ticket's own body parses to 5 FR, 5 NFR, a 7-row verification table matched to ids, no warnings; a legacy body → all \`other\` plus warnings; mixed-case headings |
| FR-2 | DetailPanel.test.tsx: the Brief card renders above the thread with the goal and FR list; collapse persists; open by default |
| FR-3 | A test: the tally counts and the warning colour when a requirement lacks verification |
| FR-4 | A test if implemented; otherwise the report section "View prompt: needs API X" |
| FR-5 | A test: moves passed to OutputLog |
| NFR-5 | parse.ts imports nothing from react/DOM (a lint or test assertion) |
## Gates
\`pnpm typecheck && pnpm lint && pnpm test && pnpm build\` (e2e isn't required for web-only changes, but run \`pnpm test:e2e\` if you touch anything the e2e asserts).
`;
