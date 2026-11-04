//! Port of `packages/daemon/src/commands/index.ts` (MR-T07): the command modules and the
//! `create_command_runner` factory.
//!
//! Declared up front (MR-T02): fill the files in, don't edit this list. `run` was added by
//! MR-T13b (the `run` subcommand's body, kept out of `main.rs` so it can be tested).

pub mod config;
pub mod enroll;
pub mod fake_runner;
pub mod process_runner;
pub mod run;
pub mod runner;
pub mod semaphore;
pub mod service;
pub mod tail;

pub use process_runner::{ProcessCommandRunner, ProcessCommandRunnerOptions};

/// `createCommandRunner` (M1-T06, 10-contracts §Seams): the real runner (`sh -c` in its own
/// process group or job, timeout, build semaphore, output tail), sized by
/// `machine.max_concurrent_builds`.
pub fn create_command_runner(max_concurrent: usize) -> Box<dyn runner::CommandRunner> {
    Box::new(
        ProcessCommandRunner::new(ProcessCommandRunnerOptions {
            max_concurrent,
            ..Default::default()
        })
        // `config` refuses CONDUCTOR_MAX_CONCURRENT_BUILDS below 1.
        .expect("max_concurrent_builds >= 1 (config validates it)"),
    )
}

/// Where a subcommand (`enroll`, `config`, `service`) writes its lines: stdout, and stderr with
/// the `[conductor-daemon] ` prefix, as the TS `out` / `err` deps. Tests capture them.
pub trait Output {
    fn out(&mut self, line: &str);
    fn err(&mut self, line: &str);
}

/// The process's stdout and stderr.
pub struct StdOutput;

impl Output for StdOutput {
    fn out(&mut self, line: &str) {
        println!("{line}");
    }
    fn err(&mut self, line: &str) {
        eprintln!("[conductor-daemon] {line}");
    }
}

/// Captured lines, for tests.
#[derive(Debug, Default)]
pub struct CapturedOutput {
    pub out: Vec<String>,
    pub err: Vec<String>,
}

impl CapturedOutput {
    /// Every stdout and stderr line, joined.
    pub fn all(&self) -> String {
        let mut v = self.out.clone();
        v.extend(self.err.iter().cloned());
        v.join("\n")
    }
}

impl Output for CapturedOutput {
    fn out(&mut self, line: &str) {
        self.out.push(line.to_string());
    }
    fn err(&mut self, line: &str) {
        self.err.push(line.to_string());
    }
}

/// Arguments parsed as Node's `util.parseArgs` with `strict: true` parses them (what the TS
/// subcommands used): `--name value`, `--name=value`, boolean flags, `--` ends the options.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ParsedArgs {
    /// The last value of each string option given.
    pub values: std::collections::BTreeMap<String, String>,
    /// The boolean flags given.
    pub flags: std::collections::BTreeSet<String>,
    pub positionals: Vec<String>,
}

/// Parse `args` with the given string and boolean options. Errs (with parseArgs' wording) on an
/// unknown option, a missing value, a value given to a flag, or a positional when none is allowed.
pub fn parse_args(
    args: &[String],
    string_opts: &[&str],
    bool_opts: &[&str],
    allow_positionals: bool,
) -> Result<ParsedArgs, String> {
    let mut p = ParsedArgs::default();
    let mut i = 0;
    let mut only_positionals = false;
    while i < args.len() {
        let a = &args[i];
        i += 1;
        if only_positionals || a == "-" || !a.starts_with('-') {
            if !allow_positionals {
                return Err(format!(
                    "Unexpected argument '{a}'. This command does not take positional arguments"
                ));
            }
            p.positionals.push(a.clone());
            continue;
        }
        if a == "--" {
            only_positionals = true;
            continue;
        }
        let (name, inline) = match a.strip_prefix("--") {
            Some(rest) => match rest.split_once('=') {
                Some((n, v)) => (n.to_string(), Some(v.to_string())),
                None => (rest.to_string(), None),
            },
            None => (a[1..].to_string(), None),
        };
        if string_opts.contains(&name.as_str()) {
            let value = match inline {
                Some(v) => v,
                None => match args.get(i) {
                    Some(v) if v == "-" || !v.starts_with('-') => {
                        i += 1;
                        v.clone()
                    }
                    _ => return Err(format!("Option '--{name} <value>' argument missing")),
                },
            };
            p.values.insert(name, value);
        } else if bool_opts.contains(&name.as_str()) {
            if inline.is_some() {
                return Err(format!("Option '--{name}' does not take an argument"));
            }
            p.flags.insert(name);
        } else {
            return Err(format!("Unknown option '{a}'"));
        }
    }
    Ok(p)
}

#[cfg(test)]
mod parse_args_tests {
    use super::*;

    fn sv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_like_node_parse_args_strict() {
        let p = parse_args(
            &sv(&["--url", "u", "--token=", "--force", "x"]),
            &["url", "token"],
            &["force"],
            true,
        )
        .unwrap();
        assert_eq!(p.values["url"], "u");
        assert_eq!(p.values["token"], "");
        assert!(p.flags.contains("force"));
        assert_eq!(p.positionals, ["x"]);
        assert_eq!(
            parse_args(&sv(&["--token", "-"]), &["token"], &[], false)
                .unwrap()
                .values["token"],
            "-"
        );
        assert!(parse_args(&sv(&["--bogus"]), &["url"], &[], false).is_err());
        assert!(parse_args(&sv(&["--url"]), &["url"], &[], false).is_err());
        assert!(parse_args(&sv(&["--url", "--force"]), &["url"], &["force"], false).is_err());
        assert!(parse_args(&sv(&["pos"]), &["url"], &[], false).is_err());
        assert!(parse_args(&sv(&["--force=1"]), &[], &["force"], false).is_err());
        assert_eq!(
            parse_args(&sv(&["--", "--url"]), &["url"], &[], true)
                .unwrap()
                .positionals,
            ["--url"]
        );
    }
}
