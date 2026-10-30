//! Port of `packages/daemon/src/test-support/fake-bin.ts` (MR-T04): portable fake executables for
//! tests (ADR-0024 §9, windows-spike FR-2 N13).
//!
//! POSIX: `<dir>/<name>`, a `#!/usr/bin/env node` script, mode 755.
//! Windows: `<dir>/<name>.mjs` plus a `<dir>/<name>.cmd` shim (`@node "%~dp0<name>.mjs" %*`), so
//! a `PATH` lookup of `<name>` finds the `.cmd` through `PATHEXT`. A `.cmd` can only be started
//! through `cmd.exe`, which `platform::spawn` does with escaped arguments.
//!
//! `js_source` runs as an ES module on Windows (`.mjs`) and through Node's module detection on
//! POSIX (an extensionless file), so write it with `import`, never `require`.
//!
//! No OS `cfg` here (tests/seam.rs): the OS facts come from `platform`.

use crate::platform::{self, Platform};
use std::io;
use std::path::{Path, PathBuf};

/// Write a fake `name` into `dir` for `platform`. Returns the path to start: the script on POSIX,
/// the `.cmd` shim on Windows.
pub fn write_fake_bin(
    dir: &Path,
    name: &str,
    js_source: &str,
    platform: Platform,
) -> io::Result<PathBuf> {
    if platform == Platform::Windows {
        std::fs::write(dir.join(format!("{name}.mjs")), js_source)?;
        let shim = dir.join(format!("{name}.cmd"));
        std::fs::write(&shim, format!("@node \"%~dp0{name}.mjs\" %*\r\n"))?;
        return Ok(shim);
    }
    let file = dir.join(name);
    std::fs::write(&file, format!("#!/usr/bin/env node\n{js_source}"))?;
    platform::fs::set_executable(&file)?;
    Ok(file)
}

/// `dirs` joined with this OS's `PATH` delimiter (`:` on POSIX, `;` on Windows), dropping empties.
pub fn path_with(dirs: &[&str]) -> String {
    dirs.iter()
        .filter(|d| !d.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(&Platform::current().path_delimiter().to_string())
}

/// `base` with `PATH` replaced. Every case variant is removed first: Windows env names are
/// case-insensitive, and a second `PATH` key next to a `Path` would lose to it in a
/// case-insensitive lookup (`platform::spawn::env_get` takes the first match).
pub fn env_with_path(base: &[(String, String)], path: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = base
        .iter()
        .filter(|(k, _)| !k.eq_ignore_ascii_case("path"))
        .cloned()
        .collect();
    out.push(("PATH".to_string(), path.to_string()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::spawn::{CliOptions, exec_file_cli_sync, process_env};

    fn node_dir() -> String {
        let out = std::process::Command::new("node")
            .args(["-p", "require('node:path').dirname(process.execPath)"])
            .output()
            .expect("node on PATH");
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    #[test]
    fn echoes_args_with_spaces_and_cmd_metacharacters_back_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let bin = write_fake_bin(
            dir.path(),
            "echo-args",
            "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
            Platform::current(),
        )
        .unwrap();
        let args: Vec<String> = [
            "plain",
            "with space",
            "a&b",
            "up^caret",
            "100%",
            "%PATH%",
            "say \"hi\"",
            "trailing\\",
            "back\\\"slash",
            "",
            "mix & ^ % \" end",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let env = env_with_path(&process_env(), &path_with(&[&node_dir()]));
        let opts = CliOptions {
            env: Some(env),
            ..Default::default()
        };
        let out = exec_file_cli_sync(&bin.to_string_lossy(), &args, &opts).unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let got: Vec<String> = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(got, args);
    }

    #[test]
    fn writes_a_node_script_mode_755_on_posix() {
        let dir = tempfile::tempdir().unwrap();
        let bin = write_fake_bin(dir.path(), "tool", "console.log(1);\n", Platform::Posix).unwrap();
        assert_eq!(bin, dir.path().join("tool"));
        assert_eq!(
            std::fs::read_to_string(&bin).unwrap(),
            "#!/usr/bin/env node\nconsole.log(1);\n"
        );
        if !Platform::current().is_windows() {
            let probe = format!(
                "process.stdout.write((require('node:fs').statSync({}).mode & 0o777).toString(8))",
                serde_json::to_string(&bin.to_string_lossy()).unwrap()
            );
            let out = std::process::Command::new("node")
                .args(["-e", &probe])
                .output()
                .unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout), "755");
        }
    }

    #[test]
    fn writes_name_mjs_plus_a_name_cmd_shim_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let bin =
            write_fake_bin(dir.path(), "tool", "console.log(1);\n", Platform::Windows).unwrap();
        assert_eq!(bin, dir.path().join("tool.cmd"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("tool.mjs")).unwrap(),
            "console.log(1);\n"
        );
        assert_eq!(
            std::fs::read_to_string(&bin).unwrap(),
            "@node \"%~dp0tool.mjs\" %*\r\n"
        );
    }

    #[test]
    fn path_with_joins_with_the_platform_delimiter_dropping_empties() {
        let d = Platform::current().path_delimiter();
        assert_eq!(path_with(&["a", "", "b"]), format!("a{d}b"));
    }

    #[test]
    fn env_with_path_drops_every_case_variant() {
        let base = vec![
            ("Path".to_string(), "x".to_string()),
            ("HOME".to_string(), "h".to_string()),
        ];
        assert_eq!(
            env_with_path(&base, "p"),
            vec![
                ("HOME".to_string(), "h".to_string()),
                ("PATH".to_string(), "p".to_string())
            ]
        );
    }
}
