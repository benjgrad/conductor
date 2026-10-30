//! Port of `packages/daemon/src/platform/hook.ts` (MR-T04). ADR-0024 §6: a Claude Code hook
//! `command` string that runs `argv` the same way whichever shell Claude uses for hooks (U-106:
//! Git Bash or cmd.exe on Windows), and blocks when it can't run.
//!
//! POSIX: each word single-quoted for sh, then `|| exit 2` (a missing program or script blocks:
//! only exit 2 blocks a tool call).
//! Windows: each word in double quotes with forward slashes, then `|| exit 2`. Inside double
//! quotes both cmd.exe and bash keep spaces, `'`, `&`, `(` literal, and both read `||` and
//! `exit 2` the same way. What the two shells would still interpret inside double quotes is
//! refused: `"` (ends the quote), `%` (cmd expansion), `!` and `^` (cmd with delayed expansion),
//! `$` and a backtick (bash expansion).

use super::Platform;

/// Characters a Windows hook word can't carry (see the header).
pub const WIN_HOOK_UNSAFE: &[char] = &['"', '%', '!', '^', '$', '`'];

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The hook command for `argv` on `platform`. Errs on Windows when a word holds a character it
/// can't carry, with a message naming it (the session start fails instead of the guard failing
/// open or shut).
pub fn hook_command_for(argv: &[String], platform: Platform) -> Result<String, String> {
    if platform == Platform::Posix {
        let words: Vec<String> = argv.iter().map(|w| shell_quote(w)).collect();
        return Ok(format!("{} || exit 2", words.join(" ")));
    }
    for word in argv {
        if let Some(bad) = word.chars().find(|c| WIN_HOOK_UNSAFE.contains(c)) {
            return Err(format!(
                "cannot build the edit-guard hook: {word} contains {}, which cmd.exe or Git Bash \
                 would reinterpret; set CONDUCTOR_ROOT to a path without \"%!^$`",
                serde_json::to_string(&bad.to_string()).unwrap_or_default()
            ));
        }
    }
    let words: Vec<String> = argv
        .iter()
        .map(|w| format!("\"{}\"", w.replace('\\', "/")))
        .collect();
    Ok(format!("{} || exit 2", words.join(" ")))
}

/// [`hook_command_for`] on this OS.
pub fn hook_command(argv: &[String]) -> Result<String, String> {
    hook_command_for(argv, Platform::current())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn posix_single_quotes_every_word() {
        assert_eq!(
            hook_command_for(&s(&["/usr/bin/node", "/a b/it's.mjs"]), Platform::Posix).unwrap(),
            "'/usr/bin/node' '/a b/it'\\''s.mjs' || exit 2"
        );
    }

    #[test]
    fn windows_double_quotes_with_forward_slashes_and_refuses_unsafe() {
        assert_eq!(
            hook_command_for(
                &s(&["C:\\x y\\node.exe", "C:\\g (1)\\g.mjs"]),
                Platform::Windows
            )
            .unwrap(),
            "\"C:/x y/node.exe\" \"C:/g (1)/g.mjs\" || exit 2"
        );
        for bad in ["C:\\100%", "a!b", "a^b", "$HOME", "a`b", "a\"b"] {
            let e = hook_command_for(&s(&[bad]), Platform::Windows).unwrap_err();
            assert!(e.contains("cannot build the edit-guard hook"), "{e}");
        }
    }
}
