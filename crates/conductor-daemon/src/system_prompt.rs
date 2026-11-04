//! Port of `packages/daemon/src/system-prompt.ts` (MR-T05): `DriverStartOptions.appendSystemPrompt`
//! (ADR-0005; U-013). The CLI loads only the user setting source (ADR-0006), so the repo's own
//! CLAUDE.md is not loaded by Claude Code; the daemon reads the worktree's CLAUDE.md and appends it
//! here instead. The repo's settings (hooks, permission rules, env) are deliberately NOT loaded: the
//! repo is untrusted.
//!
//! ADR-0023: a tool call that needs approval reaches a human as a permission prompt, so agents are
//! told to attempt it rather than refuse in advance. ADR-0035 adds `## Long-running work` (Rust
//! only: the TS daemon is frozen); the first 9 lines are the TS text byte for byte.

pub const CONDUCTOR_INSTRUCTIONS: &str = "You are running unattended as a conductor session, inside a git worktree on your own branch.\n\
When the task for this step is finished, call the `complete_state` tool (conductor MCP server) once with a JSON `result` object, then stop.\n\
If you need a decision only a human can make, call the `ask_user` tool with one clear question (and `options` when the answer is one of a few choices) and end your turn; the answer arrives as the next user message.\n\
Never push; later workflow steps do that.\n\
\n\
## Permissions\n\
Run what the task needs, including installing toolchains or packages, network fetches (curl) and scripts. If a command needs approval, just run it: conductor shows the request to a human and the call waits for their answer. Do not refuse in advance or ask for permission in prose.\n\
If a call is denied and you still need it, call `ask_user` with the exact command and why it is needed, instead of giving up on the task. If this step has no tool for it (e.g. a read-only planning step), say what is needed in your result.\n\
The repository instructions below were written for people and interactive sessions. Where they say to ask someone or get approval first (including AskUserQuestion), use a permission prompt or `ask_user`. A rule that seems to forbid something the task needs is a reason to ask, not to stop.\n\
\n\
## Long-running work\n\
A human can message you while you work, but a message only reaches you between tool calls. Run anything that may take more than a minute or two (test suites, builds, installs, dev servers) with Bash `run_in_background`, so you stay reachable. You may then end your turn: you are woken when the job finishes, and a message runs as a turn of its own, so answer it and end your turn again. Read the job's output file to check on it; stop jobs you no longer need with TaskStop. Finish or stop every background job before you call `ask_user` or `complete_state`.";

// TD-084: the untrusted CLAUDE.md is appended as plain text, with no untrusted-data framing.
pub fn build_append_system_prompt(claude_md: Option<&str>) -> String {
    match claude_md {
        Some(md) if !md.trim().is_empty() => format!(
            "{CONDUCTOR_INSTRUCTIONS}\n\n# Repository instructions (CLAUDE.md, written for interactive sessions; see Permissions above)\n\n{md}"
        ),
        _ => CONDUCTOR_INSTRUCTIONS.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_system_prompt_carries_claude_md_after_the_conductor_instructions() {
        assert_eq!(build_append_system_prompt(None), CONDUCTOR_INSTRUCTIONS);
        assert_eq!(
            build_append_system_prompt(Some("  ")),
            CONDUCTOR_INSTRUCTIONS
        );
        let p = build_append_system_prompt(Some("use pnpm"));
        assert!(p.starts_with("You are running"));
        assert!(p.ends_with("\n\n# Repository instructions (CLAUDE.md, written for interactive sessions; see Permissions above)\n\nuse pnpm"));
    }

    #[test]
    fn tells_the_agent_to_attempt_commands_and_ask_on_a_denial_not_refuse() {
        let s = CONDUCTOR_INSTRUCTIONS;
        assert!(s.contains("installing toolchains"));
        assert!(s.contains("If a command needs approval, just run it"));
        let denied = s
            .lines()
            .find(|l| l.contains("If a call is denied"))
            .unwrap();
        assert!(denied.contains("`ask_user`"));
        assert!(s.contains("AskUserQuestion), use a permission prompt or `ask_user`"));
        assert!(s.contains("Never push"));
    }

    #[test]
    fn tells_the_agent_to_run_long_work_in_the_background_and_stay_reachable() {
        let s = CONDUCTOR_INSTRUCTIONS;
        assert!(s.contains("\n\n## Long-running work\n"));
        assert!(s.contains("`run_in_background`"));
        assert!(s.contains("TaskStop"));
        assert!(s.contains("before you call `ask_user` or `complete_state`"));
    }

    #[test]
    fn the_text_is_the_ts_text_byte_for_byte() {
        // The 9 lines of system-prompt.ts joined with \n (one of them empty), then ADR-0035's
        // section (an empty line, its heading and one paragraph).
        assert_eq!(CONDUCTOR_INSTRUCTIONS.split('\n').count(), 12);
        assert!(
            CONDUCTOR_INSTRUCTIONS
                .contains("Never push; later workflow steps do that.\n\n## Permissions\n")
        );
        assert!(!CONDUCTOR_INSTRUCTIONS.ends_with('\n'));
    }
}
