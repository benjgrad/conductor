//! Port of `packages/daemon/src/commands/config.ts` (M2-T10; MR-T13a): `conductor-daemon config …`
//! (ADR-0013 §Inventory): the repo roots the inventory scans and each repo's working-copy mode
//! (U-060), in `<root>/config.json` (0600). A running daemon re-reads the file on its next scan:
//! `conductor-daemon rescan` (or SIGHUP, or a restart) applies a change now.

use super::{Output, parse_args};
use crate::claude::transcript::realpath;
use crate::config::{
    Env, RepoFileConfig, file_config_path, read_file_config, root_dir_from, roots_from_env,
    write_file_config,
};
use crate::platform;
use conductor_protocol::WorkingCopyMode;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const CONFIG_USAGE: &str = "usage: conductor-daemon config roots <dir…>
       conductor-daemon config repo <path> --mode reference|checkout
       conductor-daemon config auto-update on|off
       conductor-daemon config show";

const APPLY_HINT: &str = "a running daemon picks this up on its next scan; `conductor-daemon rescan` \
     (or `kill -HUP <pid>`, or a restart) applies it now";

/// An existing directory as a realpath (the inventory reports realpaths), or an error.
fn existing_dir(raw: &str) -> Result<PathBuf, String> {
    let abs = platform::resolve(raw);
    match std::fs::metadata(&abs) {
        Ok(m) if m.is_dir() => {
            realpath(&abs).map_err(|_| format!("{} does not exist", abs.display()))
        }
        Ok(_) => Err(format!("{} is not a directory", abs.display())),
        Err(_) => Err(format!("{} does not exist", abs.display())),
    }
}

fn under(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

#[derive(Serialize)]
struct Shown<'a> {
    file: String,
    roots: Vec<String>,
    roots_from: &'a str,
    repos: &'a BTreeMap<String, RepoFileConfig>,
    auto_update: bool,
}

/// Run `config …` for the daemon root of `env` (`home` is the default root's parent); returns the
/// exit code (0 ok, 1 failed, 2 usage).
pub fn config_command(argv: &[String], env: &Env, home: &Path, io: &mut dyn Output) -> i32 {
    let root = root_dir_from(env, home);
    match run(argv, env, &root, io) {
        Ok(code) => code,
        Err(e) => {
            io.err(&e);
            1
        }
    }
}

fn usage(io: &mut dyn Output, msg: &str) -> i32 {
    io.err(msg);
    io.err(CONFIG_USAGE);
    2
}

fn run(argv: &[String], env: &Env, root: &Path, io: &mut dyn Output) -> Result<i32, String> {
    let s = |p: &Path| p.to_string_lossy().into_owned();
    let (sub, rest) = match argv.split_first() {
        Some((sub, rest)) => (sub.as_str(), rest),
        None => return Ok(usage(io, "config needs a subcommand")),
    };
    match sub {
        "roots" => {
            if rest.is_empty() {
                return Ok(usage(io, "config roots needs at least one directory"));
            }
            let mut roots: Vec<String> = Vec::new();
            for raw in rest {
                match existing_dir(raw) {
                    Ok(p) => {
                        let p = s(&p);
                        if !roots.contains(&p) {
                            roots.push(p);
                        }
                    }
                    Err(e) => {
                        io.err(&e);
                        return Ok(2);
                    }
                }
            }
            let mut cfg = read_file_config(root).map_err(|e| e.to_string())?;
            cfg.roots = roots.clone();
            let path = write_file_config(root, &cfg).map_err(|e| e.to_string())?;
            io.out(&format!(
                "roots: {} (saved to {})",
                roots.join(", "),
                path.display()
            ));
            if roots_from_env(env).is_some() {
                io.err("note: CONDUCTOR_ROOTS is set and overrides these");
            }
            io.out(APPLY_HINT);
            Ok(0)
        }
        "repo" => {
            let parsed = match parse_args(rest, &["mode"], &[], true) {
                Ok(p) => p,
                Err(e) => return Ok(usage(io, &e)),
            };
            let mode_raw = parsed.values.get("mode");
            let mode = mode_raw.and_then(|m| m.parse::<WorkingCopyMode>().ok());
            let (Some(mode), [path]) = (mode, parsed.positionals.as_slice()) else {
                let msg = if parsed.positionals.len() != 1 {
                    "config repo needs exactly one <path>".to_string()
                } else {
                    format!(
                        "--mode must be reference or checkout (got {})",
                        mode_raw.map_or("nothing", String::as_str)
                    )
                };
                return Ok(usage(io, &msg));
            };
            let repo = match existing_dir(path) {
                Ok(p) => p,
                Err(e) => {
                    io.err(&e);
                    return Ok(2);
                }
            };
            if std::fs::symlink_metadata(repo.join(".git")).is_err() {
                io.err(&format!(
                    "{} is not a git work tree (no .git)",
                    repo.display()
                ));
                return Ok(2);
            }
            let mut cfg = read_file_config(root).map_err(|e| e.to_string())?;
            let roots: Vec<PathBuf> = roots_from_env(env)
                .unwrap_or_else(|| cfg.roots.iter().map(PathBuf::from).collect());
            cfg.repos.insert(s(&repo), RepoFileConfig { mode });
            let saved = write_file_config(root, &cfg).map_err(|e| e.to_string())?;
            io.out(&format!(
                "{}: mode {mode} (saved to {})",
                repo.display(),
                saved.display()
            ));
            if !roots.iter().any(|r| under(&repo, r)) {
                io.err(&format!(
                    "warning: {} is not under a configured root, so it isn't scanned",
                    repo.display()
                ));
            }
            io.out(APPLY_HINT);
            Ok(0)
        }
        "show" => {
            let cfg = read_file_config(root).map_err(|e| e.to_string())?;
            let over = roots_from_env(env);
            let shown = Shown {
                file: s(&file_config_path(root)),
                roots_from: if over.is_some() {
                    "CONDUCTOR_ROOTS"
                } else {
                    "file"
                },
                roots: match over {
                    Some(r) => r.iter().map(|p| s(p)).collect(),
                    None => cfg.roots.clone(),
                },
                repos: &cfg.repos,
                auto_update: cfg.auto_update,
            };
            io.out(&serde_json::to_string_pretty(&shown).expect("serialises"));
            Ok(0)
        }
        "auto-update" => {
            // ADR-0021 §4: read by the running daemon on each `update_available`, so no restart.
            let on = match rest {
                [v] if v == "on" => true,
                [v] if v == "off" => false,
                _ => return Ok(usage(io, "config auto-update needs on or off")),
            };
            let mut cfg = read_file_config(root).map_err(|e| e.to_string())?;
            cfg.auto_update = on;
            let path = write_file_config(root, &cfg).map_err(|e| e.to_string())?;
            io.out(&format!(
                "auto-update: {} (saved to {})",
                if on { "on" } else { "off" },
                path.display()
            ));
            if !on {
                io.out(
                    "this machine no longer updates itself; the Machines page shows it as outdated \
                     until you re-run the install command",
                );
            }
            Ok(0)
        }
        other => Ok(usage(io, &format!("unknown config command: {other}"))),
    }
}

#[cfg(test)]
mod tests;
