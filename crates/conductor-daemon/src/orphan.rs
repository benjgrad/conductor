//! Port of `packages/daemon/src/orphan.ts` (MR-T05). BUG-1b (10-contracts §Orphaned processes rule
//! 7, ADR-0005 amendment): how the startup sweep decides a live pid is a Claude process this daemon
//! started. A process is ours only if its start time equals the one recorded at spawn, its argv is
//! the configured Claude binary, and that argv carries `--session-id <id>` / `--resume <id>` with
//! the stored (UUID-shaped) id. Anything else is someone else's (a user's own `claude --resume`, a
//! `grep <uuid>`, a reused pid) and is left alone.

use crate::platform::procinfo::parse_ps_line;
use crate::platform::{Platform, exe_name, same_executable};

pub use crate::platform::{ProcInfo, read_proc_info};

/// TS `CLAUDE_SESSION_ID` (`claude/transcript.ts`): a UUID, any case,
/// `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`. Defined here (MR-T05) so
/// MR-T08's `transcript.rs` can use the same check.
pub fn is_claude_session_id(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, &c)| match i {
            8 | 13 | 18 | 23 => c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Parse the start of a `ps lstart` field (printed in UTC) to ms epoch.
pub fn parse_lstart(s: &str) -> Option<i64> {
    parse_ps_line(s).map(|p| p.started_at_ms)
}

/// The process facts `check_ours` reads (TS `Pick<ProcInfo, 'startedAt' | 'command'> & {argv?}`).
#[derive(Debug, Clone)]
pub struct ProcFacts<'a> {
    pub started_at_ms: i64,
    pub command: &'a str,
    /// The parsed argv (Windows: CommandLineToArgvW rules); None splits `command` on whitespace.
    pub argv: Option<&'a [String]>,
}

impl<'a> From<&'a ProcInfo> for ProcFacts<'a> {
    fn from(p: &'a ProcInfo) -> Self {
        ProcFacts {
            started_at_ms: p.started_at_ms,
            command: &p.command,
            argv: Some(&p.argv),
        }
    }
}

/// What the daemon recorded at spawn.
#[derive(Debug, Clone, Default)]
pub struct StoredAgent<'a> {
    pub started_at_ms: Option<i64>,
    pub claude_session_id: Option<&'a str>,
}

/// `node`, `node22`, …: `#!/usr/bin/env node` launchers.
fn is_interpreter(name: &str) -> bool {
    name.strip_prefix("node")
        .is_some_and(|rest| rest.chars().all(|c| c.is_ascii_digit()))
}

/// argv[0] is the binary, or argv[1] after `node` (a `#!/usr/bin/env node` launcher such as npm's
/// `claude`, or `node.exe …\cli.js` on win32). Names compare via `exe_name` (win32: `claude.exe`
/// is `claude`, case-insensitive).
fn is_claude_binary(command: &str, tokens: &[&str], claude_bin: &str, platform: Platform) -> bool {
    // A configured path with spaces doesn't survive whitespace tokenising: compare the raw prefix.
    if command == claude_bin || command.starts_with(&format!("{claude_bin} ")) {
        return true;
    }
    let matches = |tok: Option<&&str>| {
        tok.is_some_and(|t| {
            same_executable(t, claude_bin, platform)
                || exe_name(t, platform) == "claude"
                || exe_name(t, platform) == exe_name(claude_bin, platform)
        })
    };
    if matches(tokens.first()) {
        return true;
    }
    is_interpreter(&exe_name(tokens.first().copied().unwrap_or(""), platform))
        && matches(tokens.get(1))
}

/// Is `info` the Claude process the daemon recorded as `stored`? Err carries the reason for the
/// log (the TS `{ok: false, reason}`).
pub fn check_ours(
    info: Option<&ProcFacts<'_>>,
    stored: &StoredAgent<'_>,
    claude_bin: &str,
) -> Result<(), &'static str> {
    check_ours_for(info, stored, claude_bin, Platform::current())
}

/// `check_ours` with the OS rules to apply (tests pass the other one).
pub fn check_ours_for(
    info: Option<&ProcFacts<'_>>,
    stored: &StoredAgent<'_>,
    claude_bin: &str,
    platform: Platform,
) -> Result<(), &'static str> {
    let Some(id) = stored
        .claude_session_id
        .filter(|id| is_claude_session_id(id))
    else {
        return Err("invalid stored claude session id");
    };
    let Some(started) = stored.started_at_ms else {
        return Err("no recorded start time");
    };
    let Some(info) = info else {
        return Err("cannot read process info");
    };
    if info.started_at_ms != started {
        return Err("start time differs (pid reused)");
    }
    let tokens: Vec<&str> = match info.argv {
        Some(argv) => argv.iter().map(String::as_str).collect(),
        None => info.command.split_whitespace().collect(),
    };
    if !is_claude_binary(info.command.trim(), &tokens, claude_bin, platform) {
        return Err("not the claude binary");
    }
    let found = tokens
        .windows(2)
        .any(|w| (w[0] == "--session-id" || w[0] == "--resume") && w[1] == id);
    if found {
        Ok(())
    } else {
        Err("argv lacks --session-id/--resume <id>")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "3c1f7a52-2b9e-4d61-8f04-6e5d4c3b2a19";
    /// Date.UTC(2026, 9, 27, 10, 11, 12)
    const T: i64 = 1_793_095_872_000;

    fn at(command: &str, started_at_ms: i64) -> ProcFacts<'_> {
        ProcFacts {
            started_at_ms,
            command,
            argv: None,
        }
    }

    fn stored() -> StoredAgent<'static> {
        StoredAgent {
            started_at_ms: Some(T),
            claude_session_id: Some(ID),
        }
    }

    #[test]
    fn parses_ps_lstart_utc_to_ms_epoch() {
        assert_eq!(parse_lstart("Tue Oct 27 10:11:12 2026"), Some(T));
        // Date.UTC(2026, 9, 7, 1, 2, 3)
        assert_eq!(
            parse_lstart("Wed Oct  7 01:02:03 2026"),
            Some(1_791_334_923_000)
        );
        assert_eq!(parse_lstart("Tue 27 Oct 10:11:12 2026"), Some(T));
    }

    #[test]
    fn returns_none_for_anything_else() {
        assert_eq!(parse_lstart(""), None);
        assert_eq!(parse_lstart("yesterday"), None);
        assert_eq!(parse_lstart("Tue Foo 27 10:11:12 2026"), None);
    }

    #[test]
    fn read_proc_info_reads_this_process_and_none_for_no_such_pid() {
        let me = read_proc_info(std::process::id()).expect("this process");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        // Started before now, and not before this test binary could have been built.
        assert!(me.started_at_ms <= now + 2_000, "{me:?}");
        assert!(now - me.started_at_ms < 3_600_000, "{me:?}");
        assert!(!me.command.is_empty());
        assert_eq!(read_proc_info((1 << 22) + 12345), None);
    }

    #[test]
    fn check_ours_cases() {
        let cases: [(&str, Option<ProcFacts<'_>>, Result<(), &str>); 10] = [
            (
                "our claude --session-id",
                Some(at(
                    format!("claude -p --verbose --session-id {ID} --model x").leak(),
                    T,
                )),
                Ok(()),
            ),
            (
                "our claude --resume, absolute path",
                Some(at(format!("/opt/x/claude -p --resume {ID}").leak(), T)),
                Ok(()),
            ),
            (
                "an npm (node shebang) claude",
                Some(at(format!("node /opt/x/claude --resume {ID}").leak(), T)),
                Ok(()),
            ),
            (
                "(a) same argv, another start time",
                Some(at(format!("claude --resume {ID}").leak(), T + 1000)),
                Err("start time differs (pid reused)"),
            ),
            (
                "(b) grep mentioning the id",
                Some(at(format!("grep -r {ID} .").leak(), T)),
                Err("not the claude binary"),
            ),
            (
                "(b) id not adjacent to the flag",
                Some(at(format!("claude --foo {ID}").leak(), T)),
                Err("argv lacks --session-id/--resume <id>"),
            ),
            (
                "(b) id as a prefix",
                Some(at(format!("claude --session-id {ID}x").leak(), T)),
                Err("argv lacks --session-id/--resume <id>"),
            ),
            (
                "(e) another binary",
                Some(at(
                    format!("/usr/bin/notclaude --session-id {ID}").leak(),
                    T,
                )),
                Err("not the claude binary"),
            ),
            (
                "(e) claude deeper in argv",
                Some(at(format!("sh -c x /tmp/claude --resume {ID}").leak(), T)),
                Err("not the claude binary"),
            ),
            ("no process info", None, Err("cannot read process info")),
        ];
        for (name, info, want) in cases {
            assert_eq!(
                check_ours_for(info.as_ref(), &stored(), "claude", Platform::Posix),
                want,
                "{name}"
            );
        }
    }

    #[test]
    fn matches_the_configured_binary_by_exact_path_even_with_spaces() {
        let bin = "/Users/x/My Tools/claude-wrapper";
        let c1 = format!("{bin} --resume {ID}");
        let c2 = format!("/elsewhere/claude-wrapper --resume {ID}");
        assert_eq!(
            check_ours_for(Some(&at(&c1, T)), &stored(), bin, Platform::Posix),
            Ok(())
        );
        assert_eq!(
            check_ours_for(Some(&at(&c2, T)), &stored(), bin, Platform::Posix),
            Ok(())
        );
    }

    #[test]
    fn an_empty_or_non_uuid_stored_id_is_never_ours() {
        for id in [Some(""), Some("not-a-uuid"), None] {
            let cmd = format!("claude --resume {}", id.unwrap_or(""));
            let s = StoredAgent {
                started_at_ms: Some(T),
                claude_session_id: id,
            };
            assert_eq!(
                check_ours(Some(&at(&cmd, T)), &s, "claude"),
                Err("invalid stored claude session id")
            );
        }
    }

    #[test]
    fn no_recorded_start_time_is_never_ours() {
        let cmd = format!("claude --resume {ID}");
        let s = StoredAgent {
            started_at_ms: None,
            claude_session_id: Some(ID),
        };
        assert_eq!(
            check_ours(Some(&at(&cmd, T)), &s, "claude"),
            Err("no recorded start time")
        );
    }

    #[test]
    fn windows_argv_and_exe_names() {
        let argv: Vec<String> = [
            r"C:\Program Files\nodejs\node.exe",
            r"C:\x\claude",
            "--resume",
            ID,
        ]
        .map(String::from)
        .to_vec();
        let info = ProcFacts {
            started_at_ms: T,
            command: "ignored when argv is given",
            argv: Some(&argv),
        };
        assert_eq!(
            check_ours_for(Some(&info), &stored(), "claude", Platform::Windows),
            Ok(())
        );
        assert!(is_claude_session_id(&ID.to_uppercase()));
        assert!(!is_claude_session_id(&ID.replace('-', "_")));
    }
}
