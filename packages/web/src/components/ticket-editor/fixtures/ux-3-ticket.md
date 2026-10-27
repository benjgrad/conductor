## Goal
Writing a good ticket is easy: a rich-text editor pre-filled with the requirement sections, saving plain markdown that agents and the board can parse.

## Context
- Ben's decision (2026-10-27): ticket bodies stay **markdown with fixed sections** (Goal / Context / Functional requirements FR-n / Non-functional requirements NFR-n / Out of scope / Verification). He'd like **BlockNote** or a similar WYSIWYG editor for writing them.
- The create form is `packages/web/src/components/CreateTicketForm.tsx` (+ test). M1b has no ticket-edit API, so this is create-only for now.

## Functional requirements
- FR-1 The ticket body field becomes a WYSIWYG editor. Use **BlockNote** (`@blocknote/react` + its core and theme packages) unless it fails NFR-6/NFR-7. In that case choose an alternative (e.g. TipTap or Milkdown with markdown I/O), and justify the choice in your report.
- FR-2 New tickets start from a template with the six section headings, each with one placeholder bullet or line in grey (e.g. "FR-1 …"). A "Plain markdown" toggle switches to a textarea with the same content (markdown in and out).
- FR-3 What's submitted is markdown (the API's `body` stays a string). Headings, bullet and numbered lists, inline code, code blocks, links, bold/italic and tables survive a round-trip.
- FR-4 Light requirement hints under the editor, non-blocking: e.g. "No functional requirements yet", "FR-2 has no verification". Use a small local heuristic, not UX-2's parser (another ticket owns it), unless UX-2 has merged by then.
- FR-5 The existing form behaviour is unchanged: title, repo, kind (work/personal) required, workflow, priority, validation and submit.

## Non-functional requirements
- NFR-1 **Web-only.** Change only `packages/web/**`. No new API endpoints or fields: this must work against the M1b API, because the lead cherry-picks your web commits onto the pinned board build (2e88cf8) and rebuilds only the web app. If something truly needs an API change, stop and ask (ask_user).
- NFR-2 **No collisions.** M2-T05 is editing the web in parallel (sign-in pages, account menu, admin page, `src/api/**`, `App.tsx`, `Board.tsx`). Don't touch those. Put new styles in a CSS file owned by your component (imported by it), not in `styles.css`.
- NFR-3 **Accessible:** keyboard-operable expand/collapse, `aria-expanded`, and visible focus. Respects `prefers-reduced-motion`.
- NFR-4 **Fast:** a thread of 2,000 entries still renders and scrolls smoothly (measure it in a test or note how you checked).
- NFR-5 New npm dependencies only for the editor. List them with versions in the report. Ben has approved adding the editor.
- NFR-6 Bundle: load the editor lazily (dynamic import when the form opens), so the board's initial JS doesn't grow by more than ~10 kB gzip. Report the before/after sizes from `vite build`.
- NFR-7 Markdown round-trip fidelity: the template and a representative ticket (this one's body) round-trip through the editor with no section, bullet or table lost. If BlockNote's markdown export is lossy for these, that's the reason to pick another editor.
- NFR-8 Works with the app's dark theme.

## Out of scope
- Editing existing tickets (no API yet), collaborative editing, image uploads.

## Verification
| Req | How it's verified |
|---|---|
| FR-1, FR-3, NFR-7 | CreateTicketForm.test.tsx: the template and this ticket's body round-trip markdown → editor → markdown with headings, bullets and the table intact (normalised whitespace) |
| FR-2 | A test: a new form shows the six headings; the toggle switches to a textarea with equal content |
| FR-4 | A test: hints appear and don't block submit |
| FR-5 | The existing CreateTicketForm tests pass unchanged; kind still required |
| NFR-6 | The report has before/after `vite build` sizes; the editor is a separate chunk |
| NFR-8 | A screenshot or a description of the dark-theme check |
