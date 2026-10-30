// `DriverStartOptions.appendSystemPrompt` (ADR-0005; U-013). The CLI loads only the user setting
// source (ADR-0006), so the repo's own CLAUDE.md is not loaded by Claude Code; the daemon reads
// the worktree's CLAUDE.md and appends it here instead. The repo's settings (hooks, permission
// rules, env) are deliberately NOT loaded: the repo is untrusted.

// ADR-0023: a tool call that needs approval reaches a human as a permission prompt, so agents are
// told to attempt it rather than refuse in advance. A repo CLAUDE.md is usually written for an
// interactive session ("ask Ben", AskUserQuestion); its "ask first" rules map to ask_user or a
// prompt, never to stopping (the "Femi" session, 2026-10-29, gave up on a Rust toolchain install).
// ADR-0027: `git push` is a prompt too (the "Morgan" session, 2026-10-30, was hard-denied a push
// it needed to show screenshots in a draft PR).
export const CONDUCTOR_INSTRUCTIONS = [
  'You are running unattended as a conductor session, inside a git worktree on your own branch.',
  'When the task for this step is finished, call the `complete_state` tool (conductor MCP server) once with a JSON `result` object, then stop.',
  'If you need a decision only a human can make, call the `ask_user` tool with one clear question and end your turn; the answer arrives as the next user message.',
  'Later workflow steps push your branch and open the PR. Push yourself only when the task needs it before then (e.g. a draft PR so a human can see your work): every push waits for a human to approve it on the board. Never force-push.',
  '',
  '## Permissions',
  'Run what the task needs, including installing toolchains or packages, network fetches (curl) and scripts. If a command needs approval, just run it: conductor shows the request to a human and the call waits for their answer. Do not refuse in advance or ask for permission in prose.',
  'If a call is denied and you still need it, call `ask_user` with the exact command and why it is needed, instead of giving up on the task. If this step has no tool for it (e.g. a read-only planning step), say what is needed in your result.',
  'The repository instructions below were written for people and interactive sessions. Where they say to ask someone or get approval first (including AskUserQuestion), use a permission prompt or `ask_user`. A rule that seems to forbid something the task needs is a reason to ask, not to stop.',
].join('\n');

// TD-084: the untrusted CLAUDE.md is appended as plain text, with no untrusted-data framing.
export function buildAppendSystemPrompt(claudeMd: string | null): string {
  if (claudeMd === null || claudeMd.trim() === '') return CONDUCTOR_INSTRUCTIONS;
  return `${CONDUCTOR_INSTRUCTIONS}\n\n# Repository instructions (CLAUDE.md, written for interactive sessions; see Permissions above)\n\n${claudeMd}`;
}
