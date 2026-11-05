//! Port of `packages/daemon/src/actions/conditions.ts` (MR-T10).
//!
//! ADR-0011 `run_action {action: 'evaluate_conditions'}`: external facts about conductor's PR,
//! evaluated on this machine with its own `gh` login (ADR-0016). Read-only: the engine re-polls
//! until every condition is met, one fails, or `condition_timeout` passes.
//!
//! One `gh pr view <pr_url> --json … --jq …` per call, hardened like open_pr: it runs in the daemon
//! root, with no inherited `GIT_*` / `GH_REPO` / `GH_HOST` and `GIT_CONFIG_NOSYSTEM=1`; a 60 s
//! timeout; stdout and stderr each capped at 16 KB (a cap hit keeps the conditions pending).
//!
//! The mapping (ADR-0016 §The connector registry, see the TS header for every rule):
//! `pr_checks_green`, `pr_approvals {min}` (only OWNER / MEMBER / COLLABORATOR reviewers, never
//! the author; stale approvals don't count; a changes-requested blocks until that reviewer
//! approves the head or is dismissed), `pr_merged`, `pr_screenshots {ui_paths, min_pairs}`, head
//! pinning with `head_sha`; Azure / Jira → unsupported (M5). A missing or logged-out gh keeps every
//! gh condition pending.
//!
//! ADR-0037 (T5): `pr_mergeable` (GitHub's `mergeable`: MERGEABLE met, CONFLICTING failed,
//! UNKNOWN pending; `mergeable,mergeStateStatus` are only asked for when a pr_mergeable, or a
//! pr_checks_green with `no_checks.policy: require_mergeable`, is evaluated, and the latter's
//! result then carries `mergeable` for the engine); `cmd` (condition_cmd.rs); `age_below` is the
//! engine's (unsupported here); `short_circuit` stops at the first condition not met and reports
//! the rest `skipped` (gh then runs only when a gh condition is reached).
//!
//! WF-T05: a `pr_checks_green` whose failing checks include a CANCELLED Actions job asks
//! `gh api repos/<o>/<r>/actions/jobs/<id>` (at most [`MAX_JOB_LOOKUPS`]) whether the job ever got
//! a runner. One that never did is still failing (it can't merge) but is reported as
//! infrastructure, not a test failure, so the agent reruns it instead of debugging (or asking
//! Ben about) a failure its branch didn't cause. Any lookup error keeps the plain `failing:`.

use super::condition_cmd::{CmdConditionRunner, CmdContext};
use super::open_pr::GhCommand;
use crate::exec::{Env, clean_env, spawn_failure, tail};
use crate::platform::{self, CliOptions, StdioKind, kill_tree};
use conductor_protocol::screenshots::matching_paths;
use conductor_protocol::{
    Condition, ConditionNoChecksPolicy, ConditionResult, ConditionResultMergeable,
    ConditionResultStatus, ConditionType, EvaluateConditionsResult,
};
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::AsyncReadExt;

pub const GH_CONDITION_TIMEOUT_MS: u64 = 60_000;
/// Cap on gh's stdout (and, separately, stderr).
pub const GH_OUTPUT_CAP_BYTES: usize = 16 * 1024;
/// At most this many `gh api …/actions/jobs/<id>` lookups per evaluation (WF-T05).
pub const MAX_JOB_LOOKUPS: usize = 5;

const GH_FIELDS: &str = "statusCheckRollup,reviewDecision,reviews,state,mergedAt,author,headRefOid";
/// Keeps only the fields the mapping reads (same names, so unprojected output parses too).
const GH_JQ: &str = concat!(
    "{state, mergedAt, reviewDecision, headRefOid, author: {login: .author.login},",
    " statusCheckRollup: [(.statusCheckRollup // [])[] | {__typename, name, context, status, conclusion, state, detailsUrl, targetUrl}],",
    " reviews: [(.reviews // [])[] | {author: {login: .author.login}, authorAssociation, state, commit: {oid: .commit.oid}}]"
);
/// pr_screenshots adds the changed paths and the body's pair count (never the body itself).
const GH_SCREENSHOT_FIELDS: &str = ",files,changedFiles,body";
const GH_SCREENSHOT_JQ: &str = concat!(
    ", files: [(.files // [])[] | .path], changedFiles,",
    " screenshotPairs: ((((.body // \"\") | capture(\"<!-- conductor:screenshots pairs=(?<n>[0-9]{1,3}) -->\") | .n | tonumber)) // null)"
);

/// The condition's `type` tag.
pub fn condition_type(c: &Condition) -> ConditionType {
    match c {
        Condition::PrChecksGreen { .. } => ConditionType::PrChecksGreen,
        Condition::PrApprovals { .. } => ConditionType::PrApprovals,
        Condition::PrMerged { .. } => ConditionType::PrMerged,
        Condition::PrScreenshots { .. } => ConditionType::PrScreenshots,
        Condition::AzurePipelineSucceeded { .. } => ConditionType::AzurePipelineSucceeded,
        Condition::JiraFieldsSet { .. } => ConditionType::JiraFieldsSet,
        Condition::Cmd { .. } => ConditionType::Cmd,
        Condition::PrMergeable { .. } => ConditionType::PrMergeable,
        Condition::AgeBelow { .. } => ConditionType::AgeBelow,
    }
}

fn is_gh_type(t: ConditionType) -> bool {
    matches!(
        t,
        ConditionType::PrChecksGreen
            | ConditionType::PrApprovals
            | ConditionType::PrMerged
            | ConditionType::PrScreenshots
            | ConditionType::PrMergeable
    )
}

/// ADR-0037: pr_mergeable and the require_mergeable no-CI policy add GitHub's mergeability.
const GH_MERGEABLE_FIELDS: &str = ",mergeable,mergeStateStatus";
const GH_MERGEABLE_JQ: &str = ", mergeable, mergeStateStatus";

/// Does this condition need GitHub's `mergeable`?
pub fn needs_mergeable(c: &Condition) -> bool {
    match c {
        Condition::PrMergeable { .. } => true,
        Condition::PrChecksGreen { no_checks, .. } => no_checks
            .as_ref()
            .is_some_and(|n| n.policy == ConditionNoChecksPolicy::RequireMergeable),
        _ => false,
    }
}

/// `{status: skipped}`'s detail (short_circuit).
pub const SKIPPED_DETAIL: &str = "not checked: an earlier condition is not met";

/// The `gh pr view` args for `conditions`.
pub fn gh_view_args(pr_url: &str, conditions: &[Condition]) -> Vec<String> {
    let shots = conditions
        .iter()
        .any(|c| matches!(c, Condition::PrScreenshots { .. }));
    let merge = conditions.iter().any(needs_mergeable);
    let fields = format!(
        "{GH_FIELDS}{}{}",
        if shots { GH_SCREENSHOT_FIELDS } else { "" },
        if merge { GH_MERGEABLE_FIELDS } else { "" }
    );
    let jq = format!(
        "{GH_JQ}{}{}}}",
        if shots { GH_SCREENSHOT_JQ } else { "" },
        if merge { GH_MERGEABLE_JQ } else { "" }
    );
    ["pr", "view", pr_url, "--json", &fields, "--jq", &jq]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

pub struct EvaluateConditionsInput {
    /// The move step's conditions, in declaration order (results match by position).
    pub conditions: Vec<Condition>,
    /// `context.__pr.pr_url` (None: no PR opened yet).
    pub pr_url: Option<String>,
    /// The commit conductor checked and pushed; set → the PR head must equal it.
    pub head_sha: Option<String>,
    /// The daemon root: gh's cwd, outside every repository.
    pub root: PathBuf,
    /// Default `gh` from PATH.
    pub gh: Option<GhCommand>,
    /// Default this process's; cleaned like open_pr's.
    pub env: Option<Env>,
    /// Default [`GH_CONDITION_TIMEOUT_MS`].
    pub timeout_ms: Option<u64>,
    /// ADR-0037 P1: stop at the first condition not met; the rest are `skipped`.
    pub short_circuit: bool,
    /// ADR-0037 P2 `cmd`: how to run them (worktree, setup, the command runner). None: `cmd`
    /// conditions stay pending.
    pub cmd: Option<CmdContext>,
}

#[derive(Debug, Default)]
struct GhRun {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    /// stdout went over the cap (the rest was dropped and gh was killed).
    truncated: bool,
    timed_out: bool,
    spawn_error: Option<crate::exec::SpawnFailure>,
}

/// Run gh with capped output and a timeout. On a cap hit or the timeout the tree is killed and
/// this returns at once: gh's own children could hold the pipes open.
async fn run_capped(
    cmd: &str,
    args: &[String],
    cwd: PathBuf,
    env: Env,
    timeout: Duration,
) -> GhRun {
    let opts = CliOptions {
        cwd: Some(cwd),
        env: Some(env),
        stdin: Some(StdioKind::Null),
        stdout: Some(StdioKind::Piped),
        stderr: Some(StdioKind::Piped),
        ..Default::default()
    };
    let mut child = match platform::spawn_cli(cmd, args, opts) {
        Ok(c) => c,
        Err(e) => {
            return GhRun {
                spawn_error: Some(spawn_failure(&e)),
                ..Default::default()
            };
        }
    };
    let mut out = child.child.stdout.take();
    let mut err = child.child.stderr.take();
    let mut obuf: Vec<u8> = Vec::new();
    let mut ebuf: Vec<u8> = Vec::new();
    let mut b1 = [0u8; 8192];
    let mut b2 = [0u8; 8192];
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let finish = |obuf: &[u8], ebuf: &[u8], code, truncated, timed_out| GhRun {
        code,
        stdout: String::from_utf8_lossy(obuf).into_owned(),
        stderr: String::from_utf8_lossy(ebuf).into_owned(),
        truncated,
        timed_out,
        spawn_error: None,
    };
    let stop = |mut child: platform::CliChild| {
        let tree = child.tree.clone();
        if let Ok(h) = kill_tree::kill_tree(
            kill_tree::KillTarget::Child(&tree),
            kill_tree::KillTreeOptions {
                signal: Some(kill_tree::Signal::Kill),
                grace: None,
            },
        ) {
            drop(h);
        }
        // Reap it in the background; don't wait for the pipes.
        tokio::spawn(async move {
            let _ = child.wait().await;
            drop(tree);
        });
    };
    loop {
        if out.is_none() && err.is_none() {
            break;
        }
        tokio::select! {
            _ = &mut deadline => {
                stop(child);
                return finish(&obuf, &ebuf, None, false, true);
            }
            n = async { out.as_mut().expect("guarded").read(&mut b1).await }, if out.is_some() => {
                match n {
                    Ok(0) | Err(_) => out = None,
                    Ok(n) => {
                        let room = GH_OUTPUT_CAP_BYTES - obuf.len();
                        if n > room {
                            obuf.extend_from_slice(&b1[..room]);
                            stop(child);
                            return finish(&obuf, &ebuf, None, true, false);
                        }
                        obuf.extend_from_slice(&b1[..n]);
                    }
                }
            }
            n = async { err.as_mut().expect("guarded").read(&mut b2).await }, if err.is_some() => {
                match n {
                    Ok(0) | Err(_) => err = None,
                    Ok(n) => {
                        let room = GH_OUTPUT_CAP_BYTES.saturating_sub(ebuf.len());
                        ebuf.extend_from_slice(&b2[..n.min(room)]);
                    }
                }
            }
        }
    }
    tokio::select! {
        _ = &mut deadline => {
            stop(child);
            finish(&obuf, &ebuf, None, false, true)
        }
        status = child.wait() => {
            let code = status.ok().and_then(|s| s.code());
            finish(&obuf, &ebuf, code, false, false)
        }
    }
}

fn result(
    t: ConditionType,
    status: ConditionResultStatus,
    value: Option<String>,
    detail: Option<String>,
) -> ConditionResult {
    ConditionResult {
        type_: t,
        status,
        value,
        detail,
        mergeable: None,
    }
}

fn unsupported(c: &Condition) -> ConditionResult {
    let t = condition_type(c);
    result(
        t,
        ConditionResultStatus::Unsupported,
        None,
        Some(format!("{t} can't be evaluated on this machine yet")),
    )
}

fn gh_missing(e: &crate::exec::SpawnFailure) -> String {
    if e.code == "ENOENT" {
        "gh not available: gh (the GitHub CLI) is not on PATH: install it and run `gh auth login` on this machine".into()
    } else {
        format!("gh not available: {}", e.message)
    }
}

/// `/auth|login|token|credential|401|403/i`
fn is_auth_error(msg: &str) -> bool {
    let m = msg.to_lowercase();
    ["auth", "login", "token", "credential", "401", "403"]
        .iter()
        .any(|w| m.contains(w))
}

/// JS number formatting for a seconds value (`0.2`, `60`).
fn js_seconds(ms: u64) -> String {
    let s = ms as f64 / 1000.0;
    format!("{s}")
}

/// The PR view, or why there is none (every gh condition is then `pending` with it).
async fn fetch_view(i: &EvaluateConditionsInput) -> Result<PrView, String> {
    let Some(pr_url) = i.pr_url.as_deref() else {
        return Err("no pull request yet".into());
    };
    if !super::open_pr::is_github_pr_url(pr_url) {
        return Err(format!("not a GitHub pull request URL: {pr_url}"));
    }
    let gh = i.gh.clone().unwrap_or_default();
    let timeout_ms = i.timeout_ms.unwrap_or(GH_CONDITION_TIMEOUT_MS);
    let base = i.env.clone().unwrap_or_else(platform::spawn::process_env);
    let mut args = gh.args.clone();
    args.extend(gh_view_args(pr_url, &i.conditions));
    let r = run_capped(
        &gh.cmd,
        &args,
        i.root.clone(),
        clean_env(&base),
        Duration::from_millis(timeout_ms),
    )
    .await;
    if let Some(e) = &r.spawn_error {
        return Err(gh_missing(e));
    }
    if r.timed_out {
        return Err(format!(
            "gh pr view timed out after {} s",
            js_seconds(timeout_ms)
        ));
    }
    if r.truncated {
        return Err(format!(
            "gh pr view printed more than {} KB; output truncated: {}",
            GH_OUTPUT_CAP_BYTES / 1024,
            tail(&r.stdout, 200)
        ));
    }
    if r.code != Some(0) {
        let src = if r.stderr.is_empty() {
            &r.stdout
        } else {
            &r.stderr
        };
        let mut msg = tail(src, 600);
        if msg.is_empty() {
            msg = format!(
                "exit {}",
                r.code.map_or("null".to_string(), |c| c.to_string())
            );
        }
        return Err(if is_auth_error(&msg) {
            format!("gh not available: {msg}")
        } else {
            format!("gh pr view failed: {msg}")
        });
    }
    let pr = serde_json::from_str::<Value>(&r.stdout)
        .ok()
        .and_then(|v| parse_pr_view(&v));
    let Some(mut pr) = pr else {
        return Err(format!(
            "gh pr view printed unexpected output: {}",
            tail(&r.stdout, 200)
        ));
    };
    if i.conditions
        .iter()
        .any(|c| matches!(c, Condition::PrChecksGreen { .. }))
    {
        // WF-T05: did each cancelled job ever get a runner?
        let lookups: Vec<usize> = pr
            .checks
            .iter()
            .enumerate()
            .filter(|(_, c)| c.conclusion.as_deref() == Some("CANCELLED"))
            .filter(|(_, c)| c.url.as_deref().and_then(job_ref).is_some())
            .map(|(n, _)| n)
            .take(MAX_JOB_LOOKUPS)
            .collect();
        for n in lookups {
            let Some((owner, repo, job)) = pr.checks[n].url.as_deref().and_then(job_ref) else {
                continue;
            };
            let mut args = gh.args.clone();
            args.extend([
                "api".to_string(),
                format!("repos/{owner}/{repo}/actions/jobs/{job}"),
            ]);
            let r = run_capped(
                &gh.cmd,
                &args,
                i.root.clone(),
                clean_env(&base),
                Duration::from_millis(timeout_ms),
            )
            .await;
            if r.code == Some(0) && !r.truncated && !r.timed_out {
                pr.checks[n].no_runner = serde_json::from_str::<Value>(&r.stdout)
                    .ok()
                    .and_then(|v| parse_job_runner(&v));
            }
        }
    }
    Ok(pr)
}

pub async fn evaluate_conditions(i: EvaluateConditionsInput) -> EvaluateConditionsResult {
    // One gh call per evaluation, made when the first gh condition needs it (with short_circuit
    // a failing earlier condition means gh never runs).
    let mut view: Option<Result<PrView, String>> = None;
    if !i.short_circuit && i.conditions.iter().any(|c| is_gh_type(condition_type(c))) {
        view = Some(fetch_view(&i).await);
    }
    let mut cmds: Option<CmdConditionRunner> = None;
    let mut results = Vec::with_capacity(i.conditions.len());
    let mut stopped = false;
    for c in &i.conditions {
        let t = condition_type(c);
        if stopped {
            results.push(result(
                t,
                ConditionResultStatus::Skipped,
                None,
                Some(SKIPPED_DETAIL.to_string()),
            ));
            continue;
        }
        let r = if is_gh_type(t) {
            if view.is_none() {
                view = Some(fetch_view(&i).await);
            }
            match view.as_ref().expect("set above") {
                Ok(pr) => map_condition(c, pr, i.head_sha.as_deref()),
                Err(why) => result(t, ConditionResultStatus::Pending, None, Some(why.clone())),
            }
        } else if let Condition::Cmd {
            cmd,
            needs,
            timeout,
            ..
        } = c
        {
            match &i.cmd {
                None => result(
                    t,
                    ConditionResultStatus::Pending,
                    None,
                    Some("this daemon has no command runner for cmd conditions".into()),
                ),
                Some(ctx) => {
                    let runner = cmds.get_or_insert_with(|| CmdConditionRunner::new(ctx.clone()));
                    // The commit conductor pushed, else the PR head gh reported (when gh ran).
                    let sha = i.head_sha.clone().or_else(|| match &view {
                        Some(Ok(pr)) => pr.head_ref_oid.clone(),
                        _ => None,
                    });
                    runner
                        .run(cmd, *needs, timeout.as_ref().map(|t| t.as_str()), sha)
                        .await
                }
            }
        } else {
            unsupported(c)
        };
        if i.short_circuit && r.status != ConditionResultStatus::Met {
            stopped = true;
        }
        results.push(r);
    }
    // Dropping the runner removes its checkout.
    drop(cmds);
    EvaluateConditionsResult { results }
}

// ---- mapping (pure) ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrCheck {
    pub name: String,
    /// CheckRun: QUEUED / IN_PROGRESS / COMPLETED / …; None for a StatusContext.
    pub status: Option<String>,
    /// CheckRun conclusion, or a StatusContext's state.
    pub conclusion: Option<String>,
    /// CheckRun `detailsUrl` / StatusContext `targetUrl` when https; None otherwise.
    pub url: Option<String>,
    /// WF-T05: a cancelled Actions job that never got a runner (Some(true)); None: not asked or
    /// unknown.
    pub no_runner: Option<bool>,
}

/// `(owner, repo, job id)` of a GitHub Actions job link
/// (`https://github.com/<o>/<r>/actions/runs/<run>/job/<id>`, a CheckRun's `detailsUrl`).
pub fn job_ref(url: &str) -> Option<(String, String, u64)> {
    let rest = url.strip_prefix("https://github.com/")?;
    let rest = rest.split(['?', '#']).next()?;
    let parts: Vec<&str> = rest.split('/').collect();
    let [owner, repo, "actions", "runs", run, "job", job] = parts.as_slice() else {
        return None;
    };
    let name_ok = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    if !name_ok(owner) || !name_ok(repo) || run.parse::<u64>().is_err() {
        return None;
    }
    Some((owner.to_string(), repo.to_string(), job.parse().ok()?))
}

/// From `gh api repos/<o>/<r>/actions/jobs/<id>`: Some(true) when the job never got a runner (no
/// runner name and no steps), Some(false) when it did, None for anything else.
pub fn parse_job_runner(job: &Value) -> Option<bool> {
    let o = job.as_object()?;
    let runner = match o.get("runner_name") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.as_str()),
        Some(_) => return None,
    };
    let steps = match o.get("steps") {
        None | Some(Value::Null) => 0,
        Some(Value::Array(a)) => a.len(),
        Some(_) => return None,
    };
    Some(runner.is_none_or(str::is_empty) && steps == 0)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrReview {
    pub author: String,
    pub association: Option<String>,
    pub state: String,
    pub commit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrView {
    pub state: String,
    pub merged: bool,
    pub review_decision: Option<String>,
    pub checks: Vec<PrCheck>,
    /// The PR author's login (None: unknown).
    pub author: Option<String>,
    /// The PR's current head commit (None: unknown).
    pub head_ref_oid: Option<String>,
    pub reviews: Vec<PrReview>,
    /// The changed paths gh listed (None: not asked for).
    pub files: Option<Vec<String>>,
    pub changed_files: Option<u64>,
    /// The pair count in the body's screenshots marker (None: none).
    pub screenshot_pairs: Option<u64>,
    /// ADR-0037: GitHub's MERGEABLE / CONFLICTING / UNKNOWN (None: not asked for).
    pub mergeable: Option<String>,
    pub merge_state_status: Option<String>,
}

/// A non-empty string.
fn js_str(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// A check's link, only when it is a plain https URL (it reaches the agent as evidence).
fn https_url(v: Option<&Value>) -> Option<String> {
    let s = js_str(v)?;
    let rest = s.strip_prefix("https://")?;
    let n = rest.chars().count();
    ((1..=500).contains(&n) && !rest.chars().any(crate::workspace::is_js_space)).then_some(s)
}

static EMPTY: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);

fn rec(v: Option<&Value>) -> &Map<String, Value> {
    match v {
        Some(Value::Object(m)) => m,
        _ => &EMPTY,
    }
}

fn count(v: Option<&Value>) -> Option<u64> {
    let f = v?.as_f64()?;
    (v?.is_number() && f >= 0.0 && f.fract() == 0.0 && f <= u64::MAX as f64).then_some(f as u64)
}

/// gh's JSON (projected or not) → PrView. None on a non-object.
pub fn parse_pr_view(raw: &Value) -> Option<PrView> {
    let o = raw.as_object()?;
    let arr = |k: &str| -> &[Value] {
        match o.get(k) {
            Some(Value::Array(a)) => a,
            _ => &[],
        }
    };
    let checks = arr("statusCheckRollup")
        .iter()
        .map(|x| {
            let c = rec(Some(x));
            let typename = c.get("__typename").and_then(Value::as_str);
            let status_ctx = typename == Some("StatusContext")
                || (js_str(c.get("status")).is_none() && js_str(c.get("state")).is_some());
            if status_ctx {
                PrCheck {
                    name: js_str(c.get("context"))
                        .or_else(|| js_str(c.get("name")))
                        .unwrap_or_else(|| "status".into()),
                    status: None,
                    conclusion: js_str(c.get("state")),
                    url: https_url(c.get("targetUrl")),
                    no_runner: None,
                }
            } else {
                PrCheck {
                    name: js_str(c.get("name"))
                        .or_else(|| js_str(c.get("context")))
                        .unwrap_or_else(|| "check".into()),
                    status: js_str(c.get("status")),
                    conclusion: js_str(c.get("conclusion")),
                    url: https_url(c.get("detailsUrl")),
                    no_runner: None,
                }
            }
        })
        .collect();
    let reviews = arr("reviews")
        .iter()
        .map(|x| {
            let r = rec(Some(x));
            PrReview {
                author: js_str(rec(r.get("author")).get("login")).unwrap_or_else(|| "?".into()),
                association: js_str(r.get("authorAssociation")),
                commit: js_str(rec(r.get("commit")).get("oid")),
                state: js_str(r.get("state")).unwrap_or_default(),
            }
        })
        .collect();
    let state = js_str(o.get("state")).unwrap_or_else(|| "OPEN".into());
    let files = match o.get("files") {
        Some(Value::Array(a)) => Some(
            a.iter()
                .filter_map(|f| match f {
                    Value::String(s) => Some(s.clone()),
                    other => js_str(rec(Some(other)).get("path")),
                })
                .collect(),
        ),
        _ => None,
    };
    Some(PrView {
        merged: state == "MERGED" || js_str(o.get("mergedAt")).is_some(),
        state,
        review_decision: js_str(o.get("reviewDecision")),
        author: js_str(rec(o.get("author")).get("login")),
        head_ref_oid: js_str(o.get("headRefOid")),
        checks,
        reviews,
        files,
        changed_files: count(o.get("changedFiles")),
        screenshot_pairs: count(o.get("screenshotPairs")),
        mergeable: js_str(o.get("mergeable")),
        merge_state_status: js_str(o.get("mergeStateStatus")),
    })
}

/// How a check cancelled before it got a runner is reported (WF-T05).
pub const INFRA_FAILURE: &str = "infrastructure, not a test failure";

const PASS: &[&str] = &["SUCCESS", "NEUTRAL", "SKIPPED"];
const FAIL: &[&str] = &[
    "FAILURE",
    "ERROR",
    "CANCELLED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
];

#[derive(PartialEq)]
enum Verdict {
    Pass,
    Fail,
    Pending,
}

fn check_verdict(c: &PrCheck) -> Verdict {
    // A StatusContext has only a state; a CheckRun's conclusion counts once it is COMPLETED.
    if c.status.as_deref().is_some_and(|s| s != "COMPLETED") {
        return Verdict::Pending;
    }
    match c.conclusion.as_deref() {
        Some(x) if PASS.contains(&x) => Verdict::Pass,
        Some(x) if FAIL.contains(&x) => Verdict::Fail,
        _ => Verdict::Pending,
    }
}

/// Reviewers whose approval counts: repo owner / member / collaborator, never the PR author.
fn eligible_reviewer(r: &PrReview, pr_author: Option<&str>) -> bool {
    let Some(a) = r.association.as_deref() else {
        return false;
    };
    if !["OWNER", "MEMBER", "COLLABORATOR"].contains(&a) || r.author == "?" {
        return false;
    }
    pr_author.is_none_or(|p| r.author != p)
}

fn names(cs: &[&PrCheck]) -> String {
    tail(
        &cs.iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        300,
    )
}

/// Failing checks with their links: `lint (https://…), test`.
fn failing(cs: &[&PrCheck]) -> String {
    tail(
        &cs.iter()
            .map(|c| match &c.url {
                Some(u) => format!("{} ({u})", c.name),
                None => c.name.clone(),
            })
            .collect::<Vec<_>>()
            .join(", "),
        1200,
    )
}

#[derive(Clone, Copy, PartialEq)]
enum Approval {
    Approved,
    Blocked,
    None,
}

pub fn map_condition(c: &Condition, pr: &PrView, head_sha: Option<&str>) -> ConditionResult {
    use ConditionResultStatus::{Failed, Met, Pending};
    let t = condition_type(c);
    if !is_gh_type(t) {
        return unsupported(c);
    }
    let some = |s: &str| Some(s.to_string());
    if let Some(head) = head_sha
        && pr.head_ref_oid.as_deref() != Some(head)
    {
        let Some(actual) = &pr.head_ref_oid else {
            return result(
                t,
                Pending,
                None,
                some("gh reported no head commit for the PR"),
            );
        };
        return result(
            t,
            Failed,
            Some(actual.chars().take(12).collect()),
            Some(format!(
                "PR head {actual} isn't the commit conductor checked ({head}); someone pushed to the branch"
            )),
        );
    }
    let closed = pr.state == "CLOSED" && !pr.merged;
    match c {
        Condition::PrMergeable { .. } => {
            if pr.merged {
                return result(t, Met, some("merged"), None);
            }
            if pr.state == "CLOSED" {
                return result(
                    t,
                    Failed,
                    some("closed"),
                    some("the PR was closed without merging"),
                );
            }
            match pr.mergeable.as_deref() {
                Some("MERGEABLE") => result(t, Met, some("mergeable"), None),
                Some("CONFLICTING") => {
                    let state = pr
                        .merge_state_status
                        .as_deref()
                        .map(|s| format!(" ({})", s.to_lowercase()))
                        .unwrap_or_default();
                    result(
                        t,
                        Failed,
                        some("conflicting"),
                        Some(format!(
                            "the PR conflicts with its base branch{state}: merge the base branch into it and resolve the conflicts"
                        )),
                    )
                }
                _ => result(
                    t,
                    Pending,
                    some("unknown"),
                    some("GitHub is still computing whether the PR merges cleanly"),
                ),
            }
        }
        Condition::PrMerged { .. } => {
            if pr.merged {
                return result(t, Met, some("merged"), None);
            }
            if pr.state == "CLOSED" {
                return result(t, Failed, some("closed"), some("the PR was closed"));
            }
            result(
                t,
                Pending,
                Some(pr.state.to_lowercase()),
                some("not merged yet"),
            )
        }
        Condition::PrScreenshots {
            ui_paths,
            min_pairs,
            ..
        } => {
            let globs: Vec<&str> = ui_paths.iter().map(|g| g.as_str()).collect();
            map_screenshots(t, &globs, min_pairs.map(|n| n.get()), pr, closed)
        }
        Condition::PrChecksGreen { no_checks, .. } => {
            let r = map_checks(t, pr, closed);
            // ADR-0037 P3: the engine's require_mergeable policy reads GitHub's answer from here.
            if !no_checks
                .as_ref()
                .is_some_and(|n| n.policy == ConditionNoChecksPolicy::RequireMergeable)
            {
                return r;
            }
            let m = match pr.mergeable.as_deref() {
                Some("MERGEABLE") => ConditionResultMergeable::Mergeable,
                Some("CONFLICTING") => ConditionResultMergeable::Conflicting,
                _ => ConditionResultMergeable::Unknown,
            };
            ConditionResult {
                mergeable: Some(m),
                ..r
            }
        }
        Condition::PrApprovals { min, .. } => {
            let min = min.get();
            // Each eligible reviewer's verdict, folded over their reviews in order.
            let mut verdict: Vec<(String, Approval)> = Vec::new();
            for r in &pr.reviews {
                if !eligible_reviewer(r, pr.author.as_deref()) {
                    continue;
                }
                let idx = match verdict.iter().position(|(a, _)| *a == r.author) {
                    Some(i) => i,
                    None => {
                        verdict.push((r.author.clone(), Approval::None));
                        verdict.len() - 1
                    }
                };
                let prev = verdict[idx].1;
                let next = match r.state.as_str() {
                    "CHANGES_REQUESTED" => Approval::Blocked,
                    "DISMISSED" => Approval::None,
                    "APPROVED" => {
                        let on_head = pr.head_ref_oid.is_some() && r.commit == pr.head_ref_oid;
                        if on_head {
                            Approval::Approved
                        } else if prev == Approval::Blocked {
                            Approval::Blocked
                        } else {
                            Approval::None
                        }
                    }
                    _ => prev,
                };
                verdict[idx].1 = next;
            }
            let approvers: Vec<&str> = verdict
                .iter()
                .filter(|(_, v)| *v == Approval::Approved)
                .map(|(a, _)| a.as_str())
                .collect();
            let blockers: Vec<&str> = verdict
                .iter()
                .filter(|(_, v)| *v == Approval::Blocked)
                .map(|(a, _)| a.as_str())
                .collect();
            let value = Some(format!("{}/{min}", approvers.len()));
            if !blockers.is_empty() || pr.review_decision.as_deref() == Some("CHANGES_REQUESTED") {
                let who = if blockers.is_empty() {
                    String::new()
                } else {
                    format!(" by {}", blockers.join(", "))
                };
                return result(t, Failed, value, Some(format!("changes requested{who}")));
            }
            if closed {
                return result(t, Failed, value, some("the PR was closed without merging"));
            }
            if pr.review_decision.as_deref() == Some("REVIEW_REQUIRED") {
                return result(
                    t,
                    Pending,
                    value,
                    some("GitHub still requires a review (branch protection)"),
                );
            }
            if approvers.len() as u64 >= min {
                return result(
                    t,
                    Met,
                    value,
                    Some(format!("approved by {}", approvers.join(", "))),
                );
            }
            let detail = if approvers.is_empty() {
                "no approvals yet".to_string()
            } else {
                format!("approved by {}", approvers.join(", "))
            };
            result(t, Pending, value, Some(detail))
        }
        _ => unsupported(c),
    }
}

/// `pr_checks_green` without the no-CI policy (the engine applies it).
fn map_checks(t: ConditionType, pr: &PrView, closed: bool) -> ConditionResult {
    use ConditionResultStatus::{Failed, Met, Pending};
    let some = |s: &str| Some(s.to_string());
    let total = pr.checks.len();
    let failed: Vec<&PrCheck> = pr
        .checks
        .iter()
        .filter(|k| check_verdict(k) == Verdict::Fail)
        .collect();
    let pending: Vec<&PrCheck> = pr
        .checks
        .iter()
        .filter(|k| check_verdict(k) == Verdict::Pending)
        .collect();
    let passed = total - failed.len() - pending.len();
    let value = Some(format!("{passed}/{total} passed"));
    if !failed.is_empty() {
        // WF-T05: a job cancelled before any runner was assigned is infrastructure.
        let (infra, real): (Vec<&PrCheck>, Vec<&PrCheck>) =
            failed.iter().partition(|k| k.no_runner == Some(true));
        let detail = match (real.is_empty(), infra.is_empty()) {
            (_, true) => format!("failing: {}", failing(&real)),
            (true, false) => format!(
                "{INFRA_FAILURE}: no runner was assigned to {}; rerun the job (gh run rerun <run-id> --failed)",
                failing(&infra)
            ),
            (false, false) => format!(
                "failing: {}; {INFRA_FAILURE} (no runner was assigned; rerun the job): {}",
                failing(&real),
                failing(&infra)
            ),
        };
        return result(t, Failed, value, Some(detail));
    }
    if closed {
        return result(t, Failed, value, some("the PR was closed without merging"));
    }
    // value is NO_PR_CHECKS_VALUE here: the engine's `no_checks_after` keys on it (U-072).
    if total == 0 {
        return result(t, Pending, value, some("no checks reported yet"));
    }
    if !pending.is_empty() {
        return result(
            t,
            Pending,
            value,
            Some(format!("waiting for: {}", names(&pending))),
        );
    }
    result(t, Met, value, None)
}

/// At most `n` items, then `+k more`.
fn some_of(xs: &[String], n: usize) -> String {
    if xs.len() <= n {
        xs.join(", ")
    } else {
        format!("{}, +{} more", xs[..n].join(", "), xs.len() - n)
    }
}

fn map_screenshots(
    t: ConditionType,
    ui_paths: &[&str],
    min_pairs: Option<u64>,
    pr: &PrView,
    closed: bool,
) -> ConditionResult {
    use ConditionResultStatus::{Failed, Met, Pending};
    let Some(files) = &pr.files else {
        return result(t, Pending, None, Some("gh listed no changed files".into()));
    };
    let ui = matching_paths(files, ui_paths);
    let unlisted = pr.changed_files.is_some_and(|n| n > files.len() as u64);
    if ui.is_empty() && !unlisted {
        return result(t, Met, Some("no UI change".into()), None);
    }
    let need = min_pairs.unwrap_or(1);
    let pairs = pr.screenshot_pairs.unwrap_or(0);
    let value = Some(format!("{pairs}/{need} pairs"));
    let changed = if !ui.is_empty() {
        format!("UI files changed ({})", some_of(&ui, 5))
    } else {
        format!(
            "more files changed than gh lists ({}), so some may be UI files",
            pr.changed_files.map_or("?".to_string(), |n| n.to_string())
        )
    };
    if pairs >= need {
        return result(
            t,
            Met,
            value,
            Some(format!("{changed}; screenshots attached")),
        );
    }
    if closed {
        return result(
            t,
            Failed,
            value,
            Some("the PR was closed without merging".into()),
        );
    }
    result(
        t,
        Failed,
        value,
        Some(format!(
            "{changed}, but the PR shows {pairs} of {need} before/after screenshot pair{}. \
             For each changed view, save before-<view>.png (the default branch) and after-<view>.png \
             (this branch) in $CONDUCTOR_SCREENSHOT_DIR, then finish the step again; conductor attaches them to the PR.",
            if need == 1 { "" } else { "s" }
        )),
    )
}

#[cfg(test)]
mod tests;
