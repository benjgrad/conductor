//! R4 (Rust only): `run_gate`, the outcome server's tool that runs the checks a transition's gate
//! runs, in a fresh conductor-owned checkout of the agent's HEAD, before the agent takes it
//! (05 §Self-checks, 10-contracts §run_gate). This module holds the pieces that need no daemon
//! state: the orchestrator calls (POST `/api/daemon/sessions/<id>/gate` for the checks, which
//! records the call; POST `…/gate-result` for the outcome) and the text the agent reads. The
//! daemon core (`daemon/run_gate.rs`) runs the checks.

use std::time::Duration;

use conductor_protocol::{DAEMON_AUTH_HEADER, auth::daemon_auth_header_value};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::attachments::upload::{AttachTarget, encode_uri_component};

/// How long one orchestrator call may take.
pub const RUN_GATE_HTTP_TIMEOUT: Duration = Duration::from_secs(60);
/// The whole run's budget: under the agent's MCP tool timeout (`agent_env_pins`, 35 min), so the
/// agent always gets an answer. The gate itself has no such limit.
pub const RUN_GATE_BUDGET: Duration = Duration::from_secs(30 * 60);
/// Output kept per failed item in the agent's text, and in all (UTF-16 units, as the CLI counts).
pub const TAIL_PER_ITEM: usize = 4_000;
pub const TAIL_TOTAL: usize = 12_000;

/// FR-3: the worktree has uncommitted changes (the status lines follow).
pub const DIRTY_TEXT: &str = "Not run: you have uncommitted changes. Commit them first (`git add` and `git commit`): run_gate checks your last commit, as the gate does. Uncommitted:";

/// One check, as the orchestrator sends it.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct GateCheck {
    pub name: String,
    pub cmd: String,
    /// `<n><ms|s|m|h|d>`, as the workflow writes it.
    #[serde(default)]
    pub timeout: Option<String>,
}

/// The orchestrator's answer: what to run.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct GateSpec {
    pub run_id: String,
    pub transition: String,
    pub title: String,
    /// None = auto-detect from the lockfile, Some("") = none.
    pub setup: Option<String>,
    pub checks: Vec<GateCheck>,
}

/// One item's outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Pass,
    Fail,
    Skipped,
    /// Conductor could not run it (a missing package manager, …).
    NotRun,
}

impl Status {
    fn label(self) -> &'static str {
        match self {
            Status::Pass => "pass",
            Status::Fail => "FAIL",
            Status::Skipped => "skipped",
            Status::NotRun => "not run",
        }
    }
}

/// A setup or check that ran (or didn't).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ItemOutcome {
    pub name: String,
    pub status: Status,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub duration_ms: u64,
    /// The output tail (failures only matter).
    pub output: String,
}

impl ItemOutcome {
    pub fn skipped(name: impl Into<String>) -> Self {
        ItemOutcome {
            name: name.into(),
            status: Status::Skipped,
            exit_code: None,
            timed_out: false,
            duration_ms: 0,
            output: String::new(),
        }
    }
}

/// A whole run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GateOutcome {
    pub transition: String,
    pub sha: String,
    /// The setup that ran (its name is the command), None when none did.
    pub setup: Option<ItemOutcome>,
    pub checks: Vec<ItemOutcome>,
    /// Why nothing (or not everything) ran: no commits ahead, the checkout failed, the budget.
    pub not_run: Option<String>,
    pub duration_ms: u64,
}

impl GateOutcome {
    /// Every check passed (and none was skipped or not run).
    pub fn passed(&self) -> bool {
        self.not_run.is_none()
            && self.setup.as_ref().is_none_or(|s| s.status == Status::Pass)
            && !self.checks.is_empty()
            && self.checks.iter().all(|c| c.status == Status::Pass)
    }

    /// The `RunGateResult` body.
    pub fn result_body(&self, run_id: &str) -> Value {
        let item = |o: &ItemOutcome| {
            serde_json::json!({
                "name": crate::claude::outcome_server::js_slice_utf16(&o.name, 200),
                "status": o.status,
                "exit_code": o.exit_code,
                "timed_out": o.timed_out,
                "duration_ms": o.duration_ms,
            })
        };
        let mut v = serde_json::json!({
            "run_id": run_id,
            "passed": self.passed(),
            "duration_ms": self.duration_ms,
            "setup": self.setup.as_ref().map(|s| serde_json::json!({
                "cmd": crate::claude::outcome_server::js_slice_utf16(&s.name, 2_000),
                "status": s.status,
            })),
            "results": self.checks.iter().take(20).map(item).collect::<Vec<_>>(),
        });
        if let Some(why) = &self.not_run {
            v["not_run"] = Value::String(
                crate::claude::outcome_server::js_slice_utf16(why, 2_000).to_string(),
            );
        }
        v
    }
}

/// `90s`, `5m`, `2h` → a Duration (the workflow's DurationSchema); None when it doesn't parse.
pub fn parse_duration(s: &str) -> Option<Duration> {
    let digits = s.trim_end_matches(|c: char| c.is_ascii_alphabetic());
    let n: u64 = digits.parse().ok()?;
    let ms = match &s[digits.len()..] {
        "ms" => n,
        "s" => n * 1_000,
        "m" => n * 60_000,
        "h" => n * 3_600_000,
        "d" => n * 86_400_000,
        _ => return None,
    };
    (ms > 0).then(|| Duration::from_millis(ms))
}

fn seconds(ms: u64) -> String {
    if ms < 1_000 {
        format!("{ms}ms")
    } else {
        format!("{}s", (ms + 500) / 1_000)
    }
}

/// The last `max` UTF-16 units of `s` (whole characters), trimmed.
fn tail_utf16(s: &str, max: usize) -> String {
    let s = s.trim_end();
    let mut units = 0;
    let mut start = s.len();
    for (i, c) in s.char_indices().rev() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        start = i;
    }
    let cut = &s[start..];
    if cut.len() < s.len() {
        format!("…{cut}")
    } else {
        cut.to_string()
    }
}

/// The text the agent reads (pure).
pub fn format_run_gate(o: &GateOutcome) -> String {
    let short = &o.sha[..o.sha.len().min(12)];
    let verdict = if o.passed() { "PASSED" } else { "FAILED" };
    let mut lines = vec![format!(
        "run_gate {} on {short} (a fresh checkout, the same checks the gate runs): {verdict}",
        o.transition
    )];
    if let Some(why) = &o.not_run {
        lines.push(format!("Not everything ran: {why}"));
    }
    let mut budget = TAIL_TOTAL;
    let mut line = |label: &str, it: &ItemOutcome, lines: &mut Vec<String>| {
        let mut l = format!("- {label}: {}", it.status.label());
        match it.status {
            Status::Pass | Status::Fail => {
                let why = if it.timed_out {
                    "timed out, ".to_string()
                } else {
                    match (it.status, it.exit_code) {
                        (Status::Fail, Some(c)) => format!("exit {c}, "),
                        (Status::Fail, None) => "killed, ".to_string(),
                        _ => String::new(),
                    }
                };
                l.push_str(&format!(" ({why}{})", seconds(it.duration_ms)));
            }
            Status::Skipped => {}
            Status::NotRun => {}
        }
        lines.push(l);
        if matches!(it.status, Status::Fail | Status::NotRun) && budget > 0 {
            let t = tail_utf16(&it.output, TAIL_PER_ITEM.min(budget));
            if !t.is_empty() {
                budget = budget.saturating_sub(t.encode_utf16().count());
                lines.push(format!("  output (last lines):\n```\n{t}\n```"));
            }
        }
    };
    if let Some(s) = &o.setup {
        line(&format!("setup `{}`", s.name), s, &mut lines);
    }
    for c in &o.checks {
        line(&c.name, c, &mut lines);
    }
    if o.passed() {
        lines.push(format!(
            "All checks pass on {}. The gate runs these same checks when you take {}; run run_gate again if you commit more.",
            o.sha, o.transition
        ));
    } else if o
        .setup
        .as_ref()
        .is_some_and(|s| matches!(s.status, Status::Fail | Status::NotRun))
    {
        lines.push(format!(
            "The setup failed, so no check ran. If your branch broke it, fix it, commit, and call run_gate again before you take {}. If it fails because of conductor's check config (it can't work in a fresh checkout), propose the fix with ask_user's `proposed_checks` instead of retrying.",
            o.transition
        ));
    } else {
        lines.push(format!(
            "Fix it, commit, and call run_gate again before you take {}.",
            o.transition
        ));
    }
    lines.join("\n")
}

/// The agent-readable text for a refused request.
fn refusal(status: u16, body: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(String::from));
    match (status, message) {
        (404, _) => "the conductor server doesn't run gates for this session (it may be an older server, or the session has ended)".into(),
        (401, _) => "the conductor server refused this machine's credential".into(),
        (_, Some(m)) => m,
        (_, None) => format!("the conductor server answered HTTP {status}"),
    }
}

fn session_url(target: &AttachTarget, leaf: &str) -> Result<reqwest::Url, String> {
    target
        .base
        .join(&format!(
            "api/daemon/sessions/{}/{leaf}",
            encode_uri_component(&target.session_id)
        ))
        .map_err(|e| format!("bad URL: {e}"))
}

fn post(
    client: &reqwest::Client,
    target: &AttachTarget,
    url: reqwest::Url,
    body: &Value,
) -> reqwest::RequestBuilder {
    let mut r = client
        .post(url)
        .timeout(RUN_GATE_HTTP_TIMEOUT)
        .header("content-type", "application/json")
        .body(body.to_string());
    if let Some(c) = &target.credential {
        r = r.header(DAEMON_AUTH_HEADER, daemon_auth_header_value(c));
    }
    r
}

/// Ask the orchestrator what `transition` runs (and record the call). Err: the text for the agent.
pub async fn fetch_spec(
    client: &reqwest::Client,
    target: &AttachTarget,
    transition: &str,
    sha: &str,
) -> Result<GateSpec, String> {
    let url = session_url(target, "gate")?;
    let body = serde_json::json!({ "transition": transition, "sha": sha });
    let res = post(client, target, url, &body)
        .send()
        .await
        .map_err(|e| format!("could not ask the conductor server for the checks: {e}"))?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(refusal(status, &text));
    }
    serde_json::from_str(&text)
        .map_err(|_| "the conductor server's answer was not a gate spec".into())
}

/// Report the outcome. Best effort: an error is only logged by the caller.
pub async fn post_result(
    client: &reqwest::Client,
    target: &AttachTarget,
    body: &Value,
) -> Result<(), String> {
    let url = session_url(target, "gate-result")?;
    let res = post(client, target, url, body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(refusal(status, &res.text().await.unwrap_or_default()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    fn item(name: &str, status: Status, output: &str) -> ItemOutcome {
        ItemOutcome {
            name: name.into(),
            status,
            exit_code: match status {
                Status::Pass => Some(0),
                Status::Fail => Some(1),
                _ => None,
            },
            timed_out: false,
            duration_ms: 2_400,
            output: output.into(),
        }
    }

    fn outcome(setup: Option<ItemOutcome>, checks: Vec<ItemOutcome>) -> GateOutcome {
        GateOutcome {
            transition: "pr_ready".into(),
            sha: SHA.into(),
            setup,
            checks,
            not_run: None,
            duration_ms: 5_000,
        }
    }

    #[test]
    fn a_pass_lists_every_item_and_says_the_gate_runs_the_same() {
        let o = outcome(
            Some(item("npm ci", Status::Pass, "added 3")),
            vec![
                item("Build passes", Status::Pass, "ok"),
                item("Tests pass", Status::Pass, "ok"),
            ],
        );
        assert!(o.passed());
        let t = format_run_gate(&o);
        assert!(t.starts_with("run_gate pr_ready on 0123456789ab"), "{t}");
        assert!(t.contains(": PASSED"));
        assert!(t.contains("- setup `npm ci`: pass (2s)"));
        assert!(t.contains("- Tests pass: pass (2s)"));
        assert!(t.contains("All checks pass on"));
        // A pass shows no output.
        assert!(!t.contains("```"));
    }

    #[test]
    fn a_failure_shows_its_tail_capped_and_the_rest_skipped() {
        let long = format!("{}\nTHE END", "x".repeat(10_000));
        let o = outcome(
            None,
            vec![
                item("Lint", Status::Fail, &long),
                ItemOutcome::skipped("Tests pass"),
            ],
        );
        assert!(!o.passed());
        let t = format_run_gate(&o);
        assert!(t.contains(": FAILED"));
        assert!(t.contains("- Lint: FAIL (exit 1, 2s)"));
        assert!(t.contains("THE END"));
        assert!(t.contains("- Tests pass: skipped"));
        assert!(t.contains("Fix it, commit, and call run_gate again before you take pr_ready."));
        assert!(
            t.encode_utf16().count() < TAIL_PER_ITEM + 1_000,
            "{}",
            t.len()
        );
        // The body the orchestrator gets.
        let b = o.result_body("r1");
        assert_eq!(b["passed"], false);
        assert_eq!(b["results"][0]["status"], "fail");
        assert_eq!(b["results"][1]["status"], "skipped");
        assert_eq!(b["setup"], Value::Null);
    }

    #[test]
    fn a_failed_setup_points_at_proposed_checks() {
        let o = outcome(
            Some(item(
                "pnpm install --frozen-lockfile",
                Status::Fail,
                "ERR_PNPM",
            )),
            vec![ItemOutcome::skipped("Build passes")],
        );
        let t = format_run_gate(&o);
        assert!(t.contains("- setup `pnpm install --frozen-lockfile`: FAIL"));
        assert!(t.contains("ERR_PNPM"));
        assert!(t.contains("`proposed_checks`"));
        assert_eq!(o.result_body("r")["setup"]["status"], "fail");
    }

    #[test]
    fn nothing_to_check_is_not_a_pass() {
        let mut o = outcome(None, vec![ItemOutcome::skipped("Build passes")]);
        o.not_run = Some("the branch has no commits ahead of origin/main".into());
        assert!(!o.passed());
        let t = format_run_gate(&o);
        assert!(t.contains("Not everything ran: the branch has no commits ahead"));
        assert_eq!(
            o.result_body("r")["not_run"],
            "the branch has no commits ahead of origin/main"
        );
    }

    #[test]
    fn durations_parse_like_the_workflow() {
        assert_eq!(parse_duration("10m"), Some(Duration::from_secs(600)));
        assert_eq!(parse_duration("90s"), Some(Duration::from_secs(90)));
        assert_eq!(parse_duration("2h"), Some(Duration::from_secs(7_200)));
        assert_eq!(parse_duration("0m"), None);
        assert_eq!(parse_duration("ten"), None);
    }

    #[test]
    fn refusals_read_well() {
        assert!(refusal(404, "").contains("doesn't run gates"));
        assert_eq!(
            refusal(
                400,
                r#"{"error":{"code":"bad_request","message":"\"x\" runs no checks"}}"#
            ),
            "\"x\" runs no checks"
        );
        assert_eq!(
            refusal(502, "oops"),
            "the conductor server answered HTTP 502"
        );
    }
}
