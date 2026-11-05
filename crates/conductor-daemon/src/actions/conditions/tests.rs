//! Port of `conditions.test.ts`: evaluate_conditions against a fake `gh` (a /bin/sh script run as
//! `<sh> <script> <args>`, Git Bash on Windows), plus the pure mapping. The fake-gh cases spawn a
//! process because the hardened env, cwd, cap and timeout are what's under test.

use super::*;
use crate::actions::open_pr::tests::{env_plus, ps, sh};
use crate::platform::Platform;
use conductor_protocol::NO_PR_CHECKS_VALUE;
use serde_json::json;

const PR: &str = "https://github.com/benjgrad/fixture-app/pull/9";

// Logs argv, cwd and the git env it got; prints $FAKE_GH_DIR/out (`gh api …`: $FAKE_GH_DIR/api);
// exits $FAKE_GH_EXIT.
const FAKE_GH: &str = r#"
echo "$*" >> "$FAKE_GH_DIR/argv"
if [ "$1" = api ]; then cat "$FAKE_GH_DIR/api"; exit 0; fi
(pwd -W 2>/dev/null || pwd) >> "$FAKE_GH_DIR/cwd"
echo "GIT_DIR=$GIT_DIR GIT_CONFIG_NOSYSTEM=$GIT_CONFIG_NOSYSTEM GH_REPO=$GH_REPO" >> "$FAKE_GH_DIR/env"
if [ -n "$FAKE_GH_ERR" ]; then echo "$FAKE_GH_ERR" >&2; fi
if [ -n "$FAKE_GH_SLEEP" ]; then sleep "$FAKE_GH_SLEEP"; fi
cat "$FAKE_GH_DIR/out"
exit ${FAKE_GH_EXIT:-0}
"#;

struct Fx {
    tmp: tempfile::TempDir,
    root: tempfile::TempDir,
    script: PathBuf,
}

#[derive(Default)]
struct More {
    pr_url: Option<Option<String>>,
    timeout_ms: Option<u64>,
    head_sha: Option<String>,
    short_circuit: bool,
    cmd: Option<CmdContext>,
}

impl Fx {
    fn new() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let script = tmp.path().join("fake-gh.sh");
        std::fs::write(&script, FAKE_GH).unwrap();
        std::fs::write(tmp.path().join("out"), "{}").unwrap();
        Fx { tmp, root, script }
    }

    fn file(&self, name: &str) -> Option<String> {
        std::fs::read_to_string(self.tmp.path().join(name)).ok()
    }

    async fn eval(
        &self,
        conditions: Vec<Condition>,
        view: &Value,
        env: &[(&str, &str)],
        more: More,
    ) -> EvaluateConditionsResult {
        let out = match view {
            Value::String(s) => s.clone(),
            v => v.to_string(),
        };
        std::fs::write(self.tmp.path().join("out"), out).unwrap();
        let dir = ps(self.tmp.path());
        let mut pairs = vec![
            ("FAKE_GH_DIR", dir.as_str()),
            // Inherited git overrides must not reach gh.
            ("GIT_DIR", "/evil/.git"),
            ("GH_REPO", "evil/repo"),
        ];
        pairs.extend_from_slice(env);
        evaluate_conditions(EvaluateConditionsInput {
            conditions,
            pr_url: more.pr_url.unwrap_or(Some(PR.to_string())),
            head_sha: more.head_sha,
            root: self.root.path().to_path_buf(),
            gh: Some(GhCommand {
                cmd: sh(),
                args: vec![ps(&self.script)],
            }),
            env: Some(env_plus(&pairs)),
            timeout_ms: more.timeout_ms,
            short_circuit: more.short_circuit,
            cmd: more.cmd,
        })
        .await
    }

    async fn ev(&self, conditions: Vec<Condition>, view: &Value) -> EvaluateConditionsResult {
        self.eval(conditions, view, &[], More::default()).await
    }
}

fn cond(v: Value) -> Condition {
    serde_json::from_value(v).unwrap()
}
fn checks() -> Condition {
    cond(json!({"type": "pr_checks_green"}))
}
fn approvals(min: u64) -> Condition {
    cond(json!({"type": "pr_approvals", "min": min}))
}
fn merged() -> Condition {
    cond(json!({"type": "pr_merged"}))
}
fn jira() -> Condition {
    cond(json!({"type": "jira_fields_set", "fields": ["x"]}))
}

fn check_run(name: &str, status: &str, conclusion: Option<&str>) -> Value {
    json!({"__typename": "CheckRun", "name": name, "status": status, "conclusion": conclusion})
}
fn status_ctx(context: &str, state: &str) -> Value {
    json!({"__typename": "StatusContext", "context": context, "state": state})
}

fn head() -> String {
    "a".repeat(40)
}
fn old() -> String {
    "b".repeat(40)
}

fn review(login: &str, state: &str) -> Value {
    review_full(login, state, "MEMBER", &head())
}
fn review_full(login: &str, state: &str, assoc: &str, oid: &str) -> Value {
    json!({"author": {"login": login}, "authorAssociation": assoc, "state": state, "commit": {"oid": oid}})
}

fn view(over: Value) -> Value {
    let mut v = json!({
        "state": "OPEN",
        "mergedAt": null,
        "reviewDecision": "",
        "author": {"login": "pat"},
        "headRefOid": head(),
        "statusCheckRollup": [],
        "reviews": [],
    });
    for (k, x) in over.as_object().unwrap() {
        v[k] = x.clone();
    }
    v
}

fn r(
    t: ConditionType,
    s: ConditionResultStatus,
    value: Option<&str>,
    detail: Option<&str>,
) -> ConditionResult {
    result(t, s, value.map(str::to_string), detail.map(str::to_string))
}

use ConditionResultStatus::{Failed, Met, Pending, Skipped, Unsupported};

fn statuses(res: &EvaluateConditionsResult) -> Vec<ConditionResultStatus> {
    res.results.iter().map(|x| x.status).collect()
}

fn detail(res: &EvaluateConditionsResult, i: usize) -> String {
    res.results[i].detail.clone().unwrap_or_default()
}

fn value(res: &EvaluateConditionsResult, i: usize) -> String {
    res.results[i].value.clone().unwrap_or_default()
}

// ---------------------------------------------------------------- with a fake gh

#[tokio::test]
async fn runs_one_gh_pr_view_outside_any_repo_with_the_hardened_env() {
    let f = Fx::new();
    let res = f
        .ev(vec![checks(), approvals(1), merged()], &view(json!({})))
        .await;
    assert_eq!(res.results.len(), 3);
    let argv = f.file("argv").unwrap();
    let argv: Vec<&str> = argv.trim().lines().collect();
    assert_eq!(argv.len(), 1);
    assert!(argv[0].contains(&format!(
        "pr view {PR} --json statusCheckRollup,reviewDecision,reviews,state,mergedAt,author,headRefOid --jq"
    )));
    let cwd = f.file("cwd").unwrap();
    assert!(
        crate::platform::same_path(cwd.trim(), f.root.path()),
        "{cwd}"
    );
    let nosystem = if Platform::current().is_windows() {
        ""
    } else {
        "1"
    };
    assert_eq!(
        f.file("env").unwrap().trim(),
        format!("GIT_DIR= GIT_CONFIG_NOSYSTEM={nosystem} GH_REPO=")
    );
}

#[tokio::test]
async fn checks_success_met_failure_failed_running_pending() {
    let f = Fx::new();
    let green = f
        .ev(
            vec![checks()],
            &view(json!({"statusCheckRollup": [
                check_run("build", "COMPLETED", Some("SUCCESS")),
                check_run("lint", "COMPLETED", Some("SKIPPED")),
                status_ctx("ci/legacy", "SUCCESS"),
            ]})),
        )
        .await;
    assert_eq!(
        green.results,
        vec![r(
            ConditionType::PrChecksGreen,
            Met,
            Some("3/3 passed"),
            None
        )]
    );
    let red = f
        .ev(
            vec![checks()],
            &view(json!({"statusCheckRollup": [
                check_run("build", "COMPLETED", Some("SUCCESS")),
                check_run("test", "COMPLETED", Some("FAILURE")),
                check_run("e2e", "IN_PROGRESS", None),
            ]})),
        )
        .await;
    assert_eq!(statuses(&red), vec![Failed]);
    assert_eq!(value(&red, 0), "1/3 passed");
    assert!(detail(&red, 0).contains("test"));
    let running = f
        .ev(
            vec![checks()],
            &view(json!({"statusCheckRollup": [
                check_run("build", "COMPLETED", Some("SUCCESS")),
                check_run("test", "IN_PROGRESS", None),
                status_ctx("deploy", "PENDING"),
            ]})),
        )
        .await;
    assert_eq!(statuses(&running), vec![Pending]);
    assert_eq!(value(&running, 0), "1/3 passed");
    assert_eq!(detail(&running, 0), "waiting for: test, deploy");
    let legacy = f
        .ev(
            vec![checks()],
            &view(json!({"statusCheckRollup": [status_ctx("ci", "ERROR")]})),
        )
        .await;
    assert_eq!(statuses(&legacy), vec![Failed]);
    let none = f.ev(vec![checks()], &view(json!({}))).await;
    assert_eq!(statuses(&none), vec![Pending]);
    assert_eq!(detail(&none, 0), "no checks reported yet");
}

#[tokio::test]
async fn approvals_pending_met_and_changes_requested() {
    let f = Fx::new();
    let zero = f
        .ev(
            vec![approvals(1)],
            &view(json!({"reviews": [review("amy", "COMMENTED")]})),
        )
        .await;
    assert_eq!(
        zero.results,
        vec![r(
            ConditionType::PrApprovals,
            Pending,
            Some("0/1"),
            Some("no approvals yet")
        )]
    );
    let one = f
        .ev(
            vec![approvals(1)],
            &view(json!({"reviewDecision": "APPROVED", "reviews": [review("amy", "APPROVED")]})),
        )
        .await;
    assert_eq!(
        one.results,
        vec![r(
            ConditionType::PrApprovals,
            Met,
            Some("1/1"),
            Some("approved by amy")
        )]
    );
    let changes = f
        .ev(
            vec![approvals(1)],
            &view(json!({"reviewDecision": "CHANGES_REQUESTED",
                "reviews": [review("amy", "APPROVED"), review("bob", "CHANGES_REQUESTED")]})),
        )
        .await;
    assert_eq!(
        changes.results,
        vec![r(
            ConditionType::PrApprovals,
            Failed,
            Some("1/1"),
            Some("changes requested by bob")
        )]
    );
}

#[tokio::test]
async fn only_owners_members_collaborators_count_never_the_author() {
    let f = Fx::new();
    let outsiders = f
        .ev(
            vec![approvals(1)],
            &view(json!({"reviews": [
                review_full("rando", "APPROVED", "NONE", &head()),
                review_full("drive-by", "APPROVED", "CONTRIBUTOR", &head()),
                review_full("newbie", "APPROVED", "FIRST_TIME_CONTRIBUTOR", &head()),
                review_full("nobody", "CHANGES_REQUESTED", "NONE", &head()),
            ]})),
        )
        .await;
    assert_eq!(
        outsiders.results,
        vec![r(
            ConditionType::PrApprovals,
            Pending,
            Some("0/1"),
            Some("no approvals yet")
        )]
    );
    let me = f
        .ev(
            vec![approvals(1)],
            &view(json!({"reviews": [review_full("pat", "APPROVED", "OWNER", &head())]})),
        )
        .await;
    assert_eq!((statuses(&me)[0], value(&me, 0)), (Pending, "0/1".into()));
    let eligible = f
        .ev(
            vec![approvals(1)],
            &view(json!({"reviews": [review_full("own", "APPROVED", "OWNER", &head())]})),
        )
        .await;
    assert_eq!(
        (statuses(&eligible)[0], value(&eligible, 0)),
        (Met, "1/1".into())
    );
}

#[tokio::test]
async fn review_decision_required_pending_changes_failed_empty_counts() {
    let f = Fx::new();
    let approvals2 = json!([
        review("amy", "APPROVED"),
        review_full("bob", "APPROVED", "COLLABORATOR", &head())
    ]);
    let required = f
        .ev(
            vec![approvals(2)],
            &view(json!({"reviewDecision": "REVIEW_REQUIRED", "reviews": approvals2})),
        )
        .await;
    assert_eq!(
        (statuses(&required)[0], value(&required, 0)),
        (Pending, "2/2".into())
    );
    let changes = f
        .ev(
            vec![approvals(2)],
            &view(json!({"reviewDecision": "CHANGES_REQUESTED", "reviews": approvals2})),
        )
        .await;
    assert_eq!(
        (statuses(&changes)[0], detail(&changes, 0)),
        (Failed, "changes requested".into())
    );
    let open = f
        .ev(
            vec![approvals(2)],
            &view(json!({"reviewDecision": "", "reviews": approvals2})),
        )
        .await;
    assert_eq!((statuses(&open)[0], value(&open, 0)), (Met, "2/2".into()));
    let unset = f
        .ev(
            vec![approvals(2)],
            &view(json!({"reviewDecision": null, "reviews": approvals2})),
        )
        .await;
    assert_eq!((statuses(&unset)[0], value(&unset, 0)), (Met, "2/2".into()));
}

/// Pure (no gh): the stale-approval rules.
fn approvals_on(reviews: Value, decision: &str) -> ConditionResult {
    let pr = parse_pr_view(&view(
        json!({"reviewDecision": decision, "reviews": reviews}),
    ))
    .unwrap();
    map_condition(&approvals(1), &pr, None)
}

#[tokio::test]
async fn a_stale_approval_doesnt_count_changes_requested_blocks_on_any_commit() {
    let (h, o) = (head(), old());
    let f = Fx::new();
    let stale = f
        .ev(
            vec![approvals(1)],
            &view(json!({"reviews": [review_full("amy", "APPROVED", "MEMBER", &o)]})),
        )
        .await;
    assert_eq!(
        (statuses(&stale)[0], value(&stale, 0)),
        (Pending, "0/1".into())
    );
    let on_head = approvals_on(json!([review_full("amy", "APPROVED", "MEMBER", &h)]), "");
    assert_eq!(
        (on_head.status, on_head.value.as_deref()),
        (Met, Some("1/1"))
    );
    let old_block = approvals_on(
        json!([
            review_full("bob", "CHANGES_REQUESTED", "MEMBER", &o),
            review_full("amy", "APPROVED", "MEMBER", &h)
        ]),
        "",
    );
    assert_eq!(
        old_block,
        r(
            ConditionType::PrApprovals,
            Failed,
            Some("1/1"),
            Some("changes requested by bob")
        )
    );
    let cleared = approvals_on(
        json!([
            review_full("bob", "CHANGES_REQUESTED", "MEMBER", &o),
            review_full("bob", "APPROVED", "MEMBER", &h)
        ]),
        "",
    );
    assert_eq!(
        (cleared.status, cleared.value.as_deref()),
        (Met, Some("1/1"))
    );
    let stale_clear = approvals_on(
        json!([
            review_full("bob", "CHANGES_REQUESTED", "MEMBER", &o),
            review_full("bob", "APPROVED", "MEMBER", &o),
            review_full("amy", "APPROVED", "MEMBER", &h),
        ]),
        "",
    );
    assert_eq!(
        stale_clear,
        r(
            ConditionType::PrApprovals,
            Failed,
            Some("1/1"),
            Some("changes requested by bob")
        )
    );
    let later_block = approvals_on(
        json!([
            review_full("bob", "APPROVED", "MEMBER", &h),
            review_full("bob", "CHANGES_REQUESTED", "MEMBER", &o)
        ]),
        "",
    );
    assert_eq!(
        (later_block.status, later_block.detail.as_deref()),
        (Failed, Some("changes requested by bob"))
    );
    let dismissed = approvals_on(
        json!([
            review_full("bob", "CHANGES_REQUESTED", "MEMBER", &o),
            review_full("bob", "DISMISSED", "MEMBER", &o),
            review_full("amy", "APPROVED", "MEMBER", &h),
        ]),
        "",
    );
    assert_eq!(
        (dismissed.status, dismissed.value.as_deref()),
        (Met, Some("1/1"))
    );
    let decided = approvals_on(
        json!([
            review_full("bob", "CHANGES_REQUESTED", "MEMBER", &o),
            review("amy", "APPROVED")
        ]),
        "CHANGES_REQUESTED",
    );
    assert_eq!(decided.status, Failed);
}

#[tokio::test]
async fn head_sha_a_moved_head_fails_every_pr_condition() {
    let f = Fx::new();
    let green = view(json!({
        "statusCheckRollup": [check_run("build", "COMPLETED", Some("SUCCESS"))],
        "reviews": [review("amy", "APPROVED")],
    }));
    let moved = f
        .eval(
            vec![checks(), approvals(1), merged(), jira()],
            &green,
            &[],
            More {
                head_sha: Some(old()),
                ..Default::default()
            },
        )
        .await;
    assert_eq!(statuses(&moved), vec![Failed, Failed, Failed, Unsupported]);
    assert_eq!(
        detail(&moved, 0),
        format!(
            "PR head {} isn't the commit conductor checked ({}); someone pushed to the branch",
            head(),
            old()
        )
    );
    let pinned = f
        .eval(
            vec![checks(), approvals(1)],
            &green,
            &[],
            More {
                head_sha: Some(head()),
                ..Default::default()
            },
        )
        .await;
    assert_eq!(statuses(&pinned), vec![Met, Met]);
    let unpinned = f.ev(vec![checks(), approvals(1)], &green).await;
    assert_eq!(statuses(&unpinned), vec![Met, Met]);
}

#[test]
fn approvals_count_the_latest_verdict_per_reviewer() {
    let pr = parse_pr_view(&view(json!({"reviews": [
        review("amy", "CHANGES_REQUESTED"),
        review("amy", "APPROVED"),
        review("amy", "COMMENTED"),
        review("bob", "APPROVED"),
        review("bob", "APPROVED"),
        review("cy", "APPROVED"),
        review("cy", "DISMISSED"),
    ]})))
    .unwrap();
    let res = map_condition(&approvals(2), &pr, None);
    assert_eq!((res.status, res.value.as_deref()), (Met, Some("2/2")));
}

#[tokio::test]
async fn merged_met_open_pending_closed_failed() {
    let f = Fx::new();
    let m = f
        .ev(
            vec![merged()],
            &view(json!({"state": "MERGED", "mergedAt": "2026-10-26T00:00:00Z"})),
        )
        .await;
    assert_eq!(statuses(&m), vec![Met]);
    let open = f.ev(vec![merged()], &view(json!({}))).await;
    assert_eq!(statuses(&open), vec![Pending]);
    let closed = f
        .ev(
            vec![merged(), approvals(1)],
            &view(json!({"state": "CLOSED"})),
        )
        .await;
    assert_eq!(statuses(&closed), vec![Failed, Failed]);
}

#[tokio::test]
async fn results_follow_the_conditions_by_position_m5_unsupported() {
    let f = Fx::new();
    let res = f
        .ev(
            vec![
                cond(json!({"type": "azure_pipeline_succeeded", "pipeline": "ci"})),
                approvals(1),
                approvals(2),
                cond(json!({"type": "jira_fields_set", "fields": ["status"]})),
            ],
            &view(json!({"reviews": [review("amy", "APPROVED")]})),
        )
        .await;
    let got: Vec<(ConditionType, ConditionResultStatus)> =
        res.results.iter().map(|x| (x.type_, x.status)).collect();
    assert_eq!(
        got,
        vec![
            (ConditionType::AzurePipelineSucceeded, Unsupported),
            (ConditionType::PrApprovals, Met),
            (ConditionType::PrApprovals, Pending),
            (ConditionType::JiraFieldsSet, Unsupported),
        ]
    );
}

#[tokio::test]
async fn only_unsupported_conditions_gh_is_not_run() {
    let f = Fx::new();
    let res = f.ev(vec![jira()], &view(json!({}))).await;
    assert_eq!(statuses(&res), vec![Unsupported]);
    assert_eq!(f.file("argv"), None);
}

#[tokio::test]
async fn age_below_is_the_engines_unsupported_here_gh_is_not_run() {
    let f = Fx::new();
    let res = f
        .ev(
            vec![cond(json!({"type": "age_below", "max": "2h"}))],
            &view(json!({})),
        )
        .await;
    assert_eq!(statuses(&res), vec![Unsupported]);
    assert_eq!(f.file("argv"), None);
}

#[tokio::test]
async fn gh_missing_every_gh_condition_pending_gh_not_available() {
    let f = Fx::new();
    let res = evaluate_conditions(EvaluateConditionsInput {
        conditions: vec![checks(), merged(), jira()],
        pr_url: Some(PR.into()),
        head_sha: None,
        root: f.root.path().to_path_buf(),
        gh: Some(GhCommand {
            cmd: ps(&f.tmp.path().join("no-such-gh")),
            args: vec![],
        }),
        env: None,
        timeout_ms: None,
        short_circuit: false,
        cmd: None,
    })
    .await;
    assert_eq!(statuses(&res), vec![Pending, Pending, Unsupported]);
    assert!(
        detail(&res, 0).starts_with("gh not available: gh (the GitHub CLI) is not on PATH"),
        "{}",
        detail(&res, 0)
    );
}

#[tokio::test]
async fn gh_not_logged_in_pending_gh_not_available() {
    let f = Fx::new();
    let res = f
        .eval(
            vec![checks()],
            &Value::String(String::new()),
            &[
                ("FAKE_GH_EXIT", "4"),
                (
                    "FAKE_GH_ERR",
                    "To get started with GitHub CLI, please run:  gh auth login",
                ),
            ],
            More::default(),
        )
        .await;
    assert_eq!(statuses(&res), vec![Pending]);
    let d = detail(&res, 0);
    assert!(
        d.starts_with("gh not available: ") && d.contains("gh auth login"),
        "{d}"
    );
}

#[tokio::test]
async fn another_gh_failure_pending_with_its_stderr() {
    let f = Fx::new();
    let res = f
        .eval(
            vec![checks()],
            &Value::String(String::new()),
            &[
                ("FAKE_GH_EXIT", "1"),
                ("FAKE_GH_ERR", "no pull requests found"),
            ],
            More::default(),
        )
        .await;
    assert_eq!(statuses(&res), vec![Pending]);
    assert_eq!(detail(&res, 0), "gh pr view failed: no pull requests found");
}

#[tokio::test]
async fn output_over_16_kb_is_truncated_and_stays_pending() {
    let f = Fx::new();
    let rollup: Vec<Value> = (0..400)
        .map(|i| check_run(&format!("check-{i}"), "COMPLETED", Some("SUCCESS")))
        .collect();
    let big = view(json!({"statusCheckRollup": rollup})).to_string();
    assert!(big.len() > GH_OUTPUT_CAP_BYTES);
    let res = f.ev(vec![checks()], &Value::String(big)).await;
    assert_eq!(statuses(&res), vec![Pending]);
    let d = detail(&res, 0);
    assert!(d.contains("more than 16 KB; output truncated"), "{d}");
    assert!(d.chars().count() < 400);
}

#[tokio::test]
async fn a_gh_that_hangs_is_killed_at_the_timeout() {
    let f = Fx::new();
    let started = std::time::Instant::now();
    let res = f
        .eval(
            vec![checks()],
            &view(json!({})),
            &[("FAKE_GH_SLEEP", "5")],
            More {
                timeout_ms: Some(200),
                ..Default::default()
            },
        )
        .await;
    assert_eq!(statuses(&res), vec![Pending]);
    assert_eq!(detail(&res, 0), "gh pr view timed out after 0.2 s");
    assert!(started.elapsed() < Duration::from_secs(4));
}

#[tokio::test]
async fn no_pr_or_a_non_github_url_pending_without_running_gh() {
    let f = Fx::new();
    let none = f
        .eval(
            vec![checks()],
            &view(json!({})),
            &[],
            More {
                pr_url: Some(None),
                ..Default::default()
            },
        )
        .await;
    assert_eq!(
        (statuses(&none)[0], detail(&none, 0)),
        (Pending, "no pull request yet".into())
    );
    let bad = f
        .eval(
            vec![checks()],
            &view(json!({})),
            &[],
            More {
                pr_url: Some(Some("https://evil.example/pull/1".into())),
                ..Default::default()
            },
        )
        .await;
    assert_eq!(statuses(&bad), vec![Pending]);
    assert_eq!(f.file("argv"), None);
}

#[tokio::test]
async fn unparseable_output_pending() {
    let f = Fx::new();
    let res = f
        .ev(vec![checks()], &Value::String("not json".into()))
        .await;
    assert_eq!(statuses(&res), vec![Pending]);
    assert!(detail(&res, 0).contains("unexpected output"));
}

// ---------------------------------------------------------------- mapping (pure)

#[test]
fn parse_pr_view_reads_the_unprojected_shape_too() {
    let pr = parse_pr_view(&json!({
        "state": "OPEN",
        "mergedAt": "",
        "reviewDecision": "",
        "statusCheckRollup": [
            {"__typename": "CheckRun", "name": "b", "status": "COMPLETED", "conclusion": "NEUTRAL", "detailsUrl": "x"},
            {"__typename": "StatusContext", "context": "c", "state": "SUCCESS", "targetUrl": "y"},
        ],
        "author": {"login": "pat", "name": "Pat"},
        "headRefOid": head(),
        "reviews": [{
            "author": {"login": "amy", "name": "Amy"},
            "authorAssociation": "COLLABORATOR",
            "state": "APPROVED",
            "commit": {"oid": head(), "url": "x"},
            "body": "lgtm",
        }],
    }))
    .unwrap();
    assert!(!pr.merged);
    assert_eq!(map_condition(&checks(), &pr, None).status, Met);
    assert_eq!(map_condition(&approvals(1), &pr, None).status, Met);
    assert_eq!(parse_pr_view(&json!([])), None);
}

#[test]
fn a_failing_check_names_its_https_link_others_dropped() {
    let pr = parse_pr_view(&json!({
        "state": "OPEN",
        "statusCheckRollup": [
            {"__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "FAILURE",
             "detailsUrl": "https://github.com/o/r/actions/runs/1/job/2"},
            {"__typename": "StatusContext", "context": "ci/legacy", "state": "ERROR", "targetUrl": "javascript:alert(1)"},
        ],
    }))
    .unwrap();
    let res = map_condition(&checks(), &pr, None);
    assert_eq!(res.status, Failed);
    assert_eq!(
        res.detail.as_deref(),
        Some("failing: test (https://github.com/o/r/actions/runs/1/job/2), ci/legacy")
    );
}

#[test]
fn no_checks_reports_no_pr_checks_value() {
    let pr = parse_pr_view(&json!({"state": "OPEN", "statusCheckRollup": []})).unwrap();
    let res = map_condition(&checks(), &pr, None);
    assert_eq!(
        (res.status, res.value.as_deref()),
        (Pending, Some(NO_PR_CHECKS_VALUE))
    );
}

// ---------------------------------------------------------------- pr_screenshots (M2-T35a)

fn shots() -> Condition {
    cond(json!({"type": "pr_screenshots", "ui_paths": ["**/*.{tsx,css}"]}))
}
fn shots2() -> Condition {
    cond(json!({"type": "pr_screenshots", "ui_paths": ["**/*.tsx"], "min_pairs": 2}))
}
fn pr_with(over: Value) -> PrView {
    parse_pr_view(&view(over)).unwrap()
}

#[tokio::test]
async fn asks_gh_for_files_and_pairs_only_with_a_screenshots_condition() {
    let f = Fx::new();
    f.ev(vec![checks()], &view(json!({}))).await;
    f.ev(
        vec![checks(), shots()],
        &view(json!({"files": [], "changedFiles": 0})),
    )
    .await;
    let argv = f.file("argv").unwrap();
    let argv: Vec<&str> = argv.trim().lines().collect();
    assert!(!argv[0].contains("files"));
    assert!(argv[1].contains(
        "--json statusCheckRollup,reviewDecision,reviews,state,mergedAt,author,headRefOid,files,changedFiles,body --jq"
    ));
    assert!(argv[1].contains("conductor:screenshots pairs="));
}

#[test]
fn no_ui_file_changed_met() {
    let res = map_condition(
        &shots(),
        &pr_with(json!({"files": ["README.md", "src/a.ts"], "changedFiles": 2})),
        None,
    );
    assert_eq!(
        (res.type_, res.status, res.value.as_deref()),
        (ConditionType::PrScreenshots, Met, Some("no UI change"))
    );
}

#[test]
fn a_ui_file_changed_enough_pairs_met_fewer_failed() {
    let ui = json!({"files": ["packages/web/src/App.tsx", "README.md"], "changedFiles": 2});
    let with = |pairs: Option<u64>| {
        let mut v = ui.clone();
        if let Some(p) = pairs {
            v["screenshotPairs"] = json!(p);
        }
        pr_with(v)
    };
    let met = map_condition(&shots(), &with(Some(1)), None);
    assert_eq!((met.status, met.value.as_deref()), (Met, Some("1/1 pairs")));
    let missing = map_condition(&shots(), &with(None), None);
    assert_eq!(
        (missing.status, missing.value.as_deref()),
        (Failed, Some("0/1 pairs"))
    );
    let d = missing.detail.unwrap();
    assert!(
        d.contains("UI files changed (packages/web/src/App.tsx)"),
        "{d}"
    );
    assert!(d.contains("before-<view>.png"));
    assert!(d.contains("$CONDUCTOR_SCREENSHOT_DIR"));
    let two = map_condition(&shots2(), &with(Some(1)), None);
    assert_eq!(
        (two.status, two.value.as_deref()),
        (Failed, Some("1/2 pairs"))
    );
}

#[test]
fn more_files_than_listed_counts_as_ui_many_are_summarised() {
    let res = map_condition(
        &shots(),
        &pr_with(json!({"files": ["README.md"], "changedFiles": 150})),
        None,
    );
    assert_eq!(res.status, Failed);
    assert!(
        res.detail
            .unwrap()
            .contains("more files changed than gh lists (150)")
    );
    let many: Vec<String> = (0..8).map(|k| format!("src/v{k}.tsx")).collect();
    let res = map_condition(
        &shots(),
        &pr_with(json!({"files": many, "changedFiles": 8})),
        None,
    );
    assert!(res.detail.unwrap().contains("+3 more"));
}

#[test]
fn a_moved_head_fails_it_no_file_list_keeps_it_pending() {
    let o = old();
    let res = map_condition(
        &shots(),
        &pr_with(json!({"files": [], "changedFiles": 0})),
        Some(&o),
    );
    assert_eq!(res.status, Failed);
    assert_eq!(
        map_condition(&shots(), &pr_with(json!({})), None).status,
        Pending
    );
}

#[test]
fn js_seconds_formats_like_js() {
    assert_eq!(js_seconds(60_000), "60");
    assert_eq!(js_seconds(200), "0.2");
}

// ---------------------------------------------------------------- WF-T05: no runner = infrastructure

const JOB: &str = "https://github.com/o/r/actions/runs/11/job/22";

fn cancelled(name: &str, url: &str) -> Value {
    json!({"__typename": "CheckRun", "name": name, "status": "COMPLETED", "conclusion": "CANCELLED",
           "detailsUrl": url})
}

#[test]
fn job_ref_reads_an_actions_job_link_only() {
    assert_eq!(job_ref(JOB), Some(("o".into(), "r".into(), 22)));
    assert_eq!(
        job_ref("https://github.com/o/r.x/actions/runs/1/job/2?pr=9"),
        Some(("o".into(), "r.x".into(), 2))
    );
    assert_eq!(job_ref("https://github.com/o/r/actions/runs/11"), None);
    assert_eq!(job_ref("https://github.com/o/r/actions/runs/x/job/2"), None);
    assert_eq!(
        job_ref("https://github.com/o/r/actions/runs/1/job/2/x"),
        None
    );
    assert_eq!(
        job_ref("https://ci.example.com/o/r/actions/runs/1/job/2"),
        None
    );
    assert_eq!(
        job_ref("https://github.com/o;rm/r/actions/runs/1/job/2"),
        None
    );
}

#[test]
fn parse_job_runner_no_runner_and_no_steps_only() {
    assert_eq!(
        parse_job_runner(&json!({"runner_name": null, "steps": []})),
        Some(true)
    );
    assert_eq!(parse_job_runner(&json!({"runner_name": ""})), Some(true));
    assert_eq!(
        parse_job_runner(&json!({"runner_name": "GitHub Actions 2", "steps": [{"name": "x"}]})),
        Some(false)
    );
    assert_eq!(
        parse_job_runner(&json!({"runner_name": null, "steps": [{}]})),
        Some(false)
    );
    assert_eq!(parse_job_runner(&json!({"runner_name": 3})), None);
    assert_eq!(parse_job_runner(&json!([])), None);
}

fn with_no_runner(pr: &mut PrView, name: &str) {
    for c in &mut pr.checks {
        if c.name == name {
            c.no_runner = Some(true);
        }
    }
}

#[test]
fn a_check_that_never_got_a_runner_is_infrastructure_still_failed() {
    let mut pr = pr_with(json!({"statusCheckRollup": [
        check_run("gates", "COMPLETED", Some("SUCCESS")),
        cancelled("daemon-rust (macos-latest)", JOB),
    ]}));
    // Not asked (or unknown): the plain message, as before.
    let res = map_condition(&checks(), &pr, None);
    assert_eq!(
        res.detail.as_deref(),
        Some(&*format!("failing: daemon-rust (macos-latest) ({JOB})"))
    );

    with_no_runner(&mut pr, "daemon-rust (macos-latest)");
    let res = map_condition(&checks(), &pr, None);
    assert_eq!(
        (res.status, res.value.as_deref()),
        (Failed, Some("1/2 passed"))
    );
    assert_eq!(
        res.detail.as_deref(),
        Some(&*format!(
            "infrastructure, not a test failure: no runner was assigned to daemon-rust (macos-latest) ({JOB}); rerun the job (gh run rerun <run-id> --failed)"
        ))
    );
}

#[test]
fn a_real_failure_and_an_infrastructure_one_are_named_apart() {
    let mut pr = pr_with(json!({"statusCheckRollup": [
        check_run("gates", "COMPLETED", Some("FAILURE")),
        cancelled("daemon-rust (macos-latest)", JOB),
    ]}));
    with_no_runner(&mut pr, "daemon-rust (macos-latest)");
    let res = map_condition(&checks(), &pr, None);
    assert_eq!(res.status, Failed);
    assert_eq!(
        res.detail.as_deref(),
        Some(&*format!(
            "failing: gates; infrastructure, not a test failure (no runner was assigned; rerun the job): daemon-rust (macos-latest) ({JOB})"
        ))
    );
}

#[tokio::test]
async fn a_cancelled_job_is_looked_up_with_gh_api() {
    let f = Fx::new();
    let v = view(json!({"statusCheckRollup": [
        cancelled("daemon-rust (macos-latest)", JOB),
        check_run("lint", "COMPLETED", Some("FAILURE")),
    ]}));
    std::fs::write(
        f.tmp.path().join("api"),
        r#"{"runner_name":null,"steps":[]}"#,
    )
    .unwrap();
    let res = f.ev(vec![checks()], &v).await;
    let argv = f.file("argv").unwrap();
    let argv: Vec<&str> = argv.trim().lines().collect();
    assert_eq!(argv.len(), 2, "{argv:?}");
    assert!(
        argv[1].ends_with("api repos/o/r/actions/jobs/22"),
        "{}",
        argv[1]
    );
    assert_eq!(
        detail(&res, 0),
        format!(
            "failing: lint; infrastructure, not a test failure (no runner was assigned; rerun the job): daemon-rust (macos-latest) ({JOB})"
        )
    );

    // A job that ran (and was cancelled, e.g. by its timeout) stays a plain failure.
    let f = Fx::new();
    std::fs::write(
        f.tmp.path().join("api"),
        r#"{"runner_name":"GitHub Actions 7","steps":[{"name":"x"}]}"#,
    )
    .unwrap();
    let res = f.ev(vec![checks()], &v).await;
    assert_eq!(
        detail(&res, 0),
        format!("failing: daemon-rust (macos-latest) ({JOB}), lint")
    );

    // No pr_checks_green asked: no lookup.
    let f = Fx::new();
    f.ev(vec![merged()], &v).await;
    assert_eq!(f.file("argv").unwrap().trim().lines().count(), 1);
}

// ---- ADR-0037 T5: pr_mergeable, the require_mergeable policy, cmd, short_circuit -------------

use crate::actions::checkout::{FreshCheckout, FreshCheckoutInput};
use crate::actions::condition_cmd::{CheckoutFn, CmdExec, CmdExecResult, ResolveHeadFn};
use std::sync::{Arc, Mutex};

fn mergeable_c() -> Condition {
    cond(json!({"type": "pr_mergeable"}))
}
fn require_mergeable() -> Condition {
    cond(
        json!({"type": "pr_checks_green", "no_checks": {"policy": "require_mergeable", "after": "5m"}}),
    )
}
fn pr_of(over: Value) -> PrView {
    parse_pr_view(&view(over)).unwrap()
}

#[tokio::test]
async fn asks_gh_for_mergeable_only_when_a_condition_needs_it() {
    let f = Fx::new();
    f.ev(vec![checks()], &view(json!({}))).await;
    f.ev(
        vec![mergeable_c()],
        &view(json!({"mergeable": "MERGEABLE"})),
    )
    .await;
    f.ev(
        vec![require_mergeable()],
        &view(json!({"mergeable": "MERGEABLE"})),
    )
    .await;
    let argv = f.file("argv").unwrap();
    let argv: Vec<&str> = argv.trim().lines().collect();
    assert!(!argv[0].contains("mergeable"), "{}", argv[0]);
    assert!(
        argv[1].contains("headRefOid,mergeable,mergeStateStatus --jq"),
        "{}",
        argv[1]
    );
    assert!(
        argv[1].contains(", mergeable, mergeStateStatus}"),
        "{}",
        argv[1]
    );
    assert!(
        argv[2].contains("mergeable,mergeStateStatus"),
        "{}",
        argv[2]
    );
}

#[test]
fn pr_mergeable_mergeable_met_conflicting_failed_unknown_pending() {
    let m = map_condition(
        &mergeable_c(),
        &pr_of(json!({"mergeable": "MERGEABLE"})),
        None,
    );
    assert_eq!((m.status, m.value.as_deref()), (Met, Some("mergeable")));
    let c = map_condition(
        &mergeable_c(),
        &pr_of(json!({"mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY"})),
        None,
    );
    assert_eq!(
        (c.status, c.value.as_deref()),
        (Failed, Some("conflicting"))
    );
    assert!(
        c.detail
            .unwrap()
            .contains("conflicts with its base branch (dirty)")
    );
    let u = map_condition(
        &mergeable_c(),
        &pr_of(json!({"mergeable": "UNKNOWN"})),
        None,
    );
    assert_eq!(u.status, Pending);
    assert_eq!(
        map_condition(&mergeable_c(), &pr_of(json!({})), None).status,
        Pending
    );
}

#[test]
fn pr_mergeable_merged_met_closed_failed_moved_head_failed() {
    let merged = map_condition(&mergeable_c(), &pr_of(json!({"state": "MERGED"})), None);
    assert_eq!(merged.status, Met);
    let closed = map_condition(&mergeable_c(), &pr_of(json!({"state": "CLOSED"})), None);
    assert_eq!(closed.status, Failed);
    let moved = map_condition(
        &mergeable_c(),
        &pr_of(json!({"mergeable": "MERGEABLE"})),
        Some(&old()),
    );
    assert_eq!(moved.status, Failed);
}

#[test]
fn require_mergeable_adds_mergeable_to_the_checks_result_other_policies_dont() {
    let r = map_condition(
        &require_mergeable(),
        &pr_of(json!({"mergeable": "CONFLICTING"})),
        None,
    );
    assert_eq!(r.status, Pending);
    assert_eq!(r.value.as_deref(), Some(NO_PR_CHECKS_VALUE));
    assert_eq!(r.mergeable, Some(ConditionResultMergeable::Conflicting));
    let unknown = map_condition(&require_mergeable(), &pr_of(json!({})), None);
    assert_eq!(unknown.mergeable, Some(ConditionResultMergeable::Unknown));
    let pass =
        cond(json!({"type": "pr_checks_green", "no_checks": {"policy": "pass", "after": "5m"}}));
    assert_eq!(
        map_condition(&pass, &pr_of(json!({"mergeable": "CONFLICTING"})), None).mergeable,
        None
    );
}

/// A fake checkout (a plain dir) and an exec that answers by command; records what ran.
struct Harness {
    ran: Arc<Mutex<Vec<(String, PathBuf, Duration)>>>,
    checkouts: Arc<Mutex<Vec<(String, String, PathBuf)>>>,
    dirs: Arc<Mutex<Vec<PathBuf>>>,
}

fn harness(
    f: &Fx,
    answers: Vec<(&'static str, Option<i32>, bool, &'static str)>,
) -> (Harness, CmdContext) {
    let h = Harness {
        ran: Arc::default(),
        checkouts: Arc::default(),
        dirs: Arc::default(),
    };
    let ran = h.ran.clone();
    let exec: CmdExec = Arc::new(move |cmd: String, cwd: PathBuf, limit: Duration| {
        ran.lock().unwrap().push((cmd.clone(), cwd, limit));
        let a = answers.iter().find(|a| a.0 == cmd).cloned();
        Box::pin(async move {
            match a {
                Some((_, code, timed_out, out)) => CmdExecResult {
                    exit_code: code,
                    timed_out,
                    output_tail: out.to_string(),
                },
                None => CmdExecResult {
                    exit_code: Some(0),
                    timed_out: false,
                    output_tail: String::new(),
                },
            }
        })
    });
    let root = f.root.path().to_path_buf();
    let (checkouts, dirs) = (h.checkouts.clone(), h.dirs.clone());
    let checkout: CheckoutFn = Arc::new(move |i: FreshCheckoutInput| {
        let mut c = checkouts.lock().unwrap();
        c.push((i.sha.clone(), i.branch.clone(), i.worktree.clone()));
        let dir = root.join(format!("check-{}", c.len()));
        std::fs::create_dir_all(&dir).unwrap();
        dirs.lock().unwrap().push(dir.clone());
        Box::pin(async move { FreshCheckout::Ok { dir, sha: i.sha } })
    });
    let resolve: ResolveHeadFn = Arc::new(|_| Box::pin(async { Some("b".repeat(40)) }));
    let ctx = CmdContext {
        root: f.root.path().to_path_buf(),
        worktree: Some((f.tmp.path().join("wt"), "conductor/t-1".into())),
        setup: Some("install-deps".into()),
        exec,
        env: None,
        checkout: Some(checkout),
        resolve_head: Some(resolve),
        path: Some(String::new()),
    };
    (h, ctx)
}

fn merges() -> Condition {
    cond(
        json!({"type": "cmd", "name": "Merges cleanly", "cmd": "merge-check", "needs": "checkout"}),
    )
}
fn tests_c() -> Condition {
    cond(json!({"type": "cmd", "name": "Tests", "cmd": "run-tests", "needs": "setup"}))
}
fn lint() -> Condition {
    cond(
        json!({"type": "cmd", "name": "Lint", "cmd": "run-lint", "needs": "setup", "timeout": "30s"}),
    )
}

async fn eval_cmd(
    conditions: Vec<Condition>,
    ctx: CmdContext,
    head_sha: Option<String>,
    pr_url: Option<String>,
) -> EvaluateConditionsResult {
    evaluate_conditions(EvaluateConditionsInput {
        conditions,
        pr_url,
        head_sha,
        root: ctx.root.clone(),
        gh: None,
        env: None,
        timeout_ms: None,
        short_circuit: false,
        cmd: Some(ctx),
    })
    .await
}

#[tokio::test]
async fn cmd_exit_0_met_non_zero_failed_with_the_tail_timeout_failed() {
    let f = Fx::new();
    let (h, ctx) = harness(
        &f,
        vec![
            ("run-tests", Some(1), false, "1 test failed"),
            ("run-lint", None, true, ""),
        ],
    );
    let res = eval_cmd(
        vec![merges(), tests_c(), lint()],
        ctx,
        None,
        Some(PR.into()),
    )
    .await;
    let t = ConditionType::Cmd;
    assert_eq!(
        res.results,
        vec![
            r(t, Met, Some("exit 0"), None),
            r(t, Failed, Some("exit 1"), Some("exit 1: 1 test failed")),
            r(t, Failed, Some("timed out"), Some("timed out after 30s")),
        ]
    );
    let ran = h.ran.lock().unwrap();
    assert_eq!(
        ran.iter().find(|x| x.0 == "run-lint").unwrap().2,
        Duration::from_secs(30)
    );
}

#[tokio::test]
async fn cmd_needs_checkout_skips_setup_needs_setup_runs_it_once() {
    let f = Fx::new();
    let (h, ctx) = harness(&f, vec![]);
    eval_cmd(vec![merges()], ctx, None, None).await;
    let names = |h: &Harness| -> Vec<String> {
        h.ran.lock().unwrap().iter().map(|x| x.0.clone()).collect()
    };
    assert_eq!(names(&h), vec!["merge-check"]);
    let (h2, ctx2) = harness(&f, vec![]);
    eval_cmd(vec![tests_c(), merges(), lint()], ctx2, None, None).await;
    assert_eq!(
        names(&h2),
        vec!["install-deps", "run-tests", "merge-check", "run-lint"]
    );
}

#[tokio::test]
async fn cmd_one_checkout_of_head_sha_in_its_dir_removed_afterwards() {
    let f = Fx::new();
    let (h, ctx) = harness(&f, vec![]);
    eval_cmd(vec![merges(), lint()], ctx, Some(head()), Some(PR.into())).await;
    let checkouts = h.checkouts.lock().unwrap().clone();
    assert_eq!(checkouts.len(), 1);
    assert_eq!(
        checkouts[0],
        (head(), "conductor/t-1".to_string(), f.tmp.path().join("wt"))
    );
    let dir = h.dirs.lock().unwrap()[0].clone();
    assert!(h.ran.lock().unwrap().iter().all(|x| x.1 == dir));
    assert!(!dir.exists());
    let (h2, ctx2) = harness(&f, vec![]);
    eval_cmd(vec![merges()], ctx2, None, None).await;
    assert_eq!(h2.checkouts.lock().unwrap()[0].0, old());
}

#[tokio::test]
async fn cmd_no_worktree_failed_checkout_or_setup_pending_never_failed() {
    let f = Fx::new();
    let (h, mut ctx) = harness(&f, vec![]);
    ctx.worktree = None;
    let none = eval_cmd(vec![merges()], ctx, None, Some(PR.into())).await;
    assert_eq!(statuses(&none), vec![Pending]);
    assert!(
        none.results[0]
            .detail
            .as_deref()
            .unwrap()
            .contains("doesn't hold the ticket's worktree")
    );
    assert!(h.ran.lock().unwrap().is_empty());
    let (_, mut ctx) = harness(&f, vec![]);
    ctx.checkout = Some(Arc::new(|_| {
        Box::pin(async {
            FreshCheckout::Err {
                error: "the branch moved".into(),
                head: None,
            }
        })
    }));
    let bad = eval_cmd(vec![merges()], ctx, None, Some(PR.into())).await;
    assert_eq!(
        bad.results[0],
        r(
            ConditionType::Cmd,
            Pending,
            None,
            Some("fresh checkout: the branch moved")
        )
    );
    let (h3, ctx) = harness(&f, vec![("install-deps", Some(2), false, "")]);
    let setup = eval_cmd(vec![tests_c(), lint()], ctx, None, Some(PR.into())).await;
    assert_eq!(statuses(&setup), vec![Pending, Pending]);
    assert!(
        setup.results[0]
            .detail
            .as_deref()
            .unwrap()
            .contains("the setup `install-deps` failed")
    );
    assert_eq!(h3.ran.lock().unwrap().len(), 1);
}

async fn short(
    f: &Fx,
    conditions: Vec<Condition>,
    v: Value,
    exit: i32,
    short_circuit: bool,
) -> (EvaluateConditionsResult, Vec<String>) {
    let (h, ctx) = harness(f, vec![("merge-check", Some(exit), false, "")]);
    let res = f
        .eval(
            conditions,
            &v,
            &[],
            More {
                short_circuit,
                cmd: Some(CmdContext {
                    setup: Some(String::new()),
                    ..ctx
                }),
                ..More::default()
            },
        )
        .await;
    let ran = h.ran.lock().unwrap().iter().map(|x| x.0.clone()).collect();
    (res, ran)
}

#[tokio::test]
async fn short_circuit_a_failing_pr_mergeable_stops_before_the_cmd() {
    let f = Fx::new();
    let (res, ran) = short(
        &f,
        vec![mergeable_c(), merges()],
        view(json!({"mergeable": "CONFLICTING"})),
        0,
        true,
    )
    .await;
    assert_eq!(statuses(&res), vec![Failed, Skipped]);
    assert_eq!(
        res.results[1],
        r(ConditionType::Cmd, Skipped, None, Some(SKIPPED_DETAIL))
    );
    assert!(ran.is_empty());
}

#[tokio::test]
async fn short_circuit_all_met_nothing_skipped_without_it_all_evaluated() {
    let f = Fx::new();
    let (met, _) = short(
        &f,
        vec![mergeable_c(), merges()],
        view(json!({"mergeable": "MERGEABLE"})),
        0,
        true,
    )
    .await;
    assert_eq!(statuses(&met), vec![Met, Met]);
    let (all, ran) = short(
        &f,
        vec![mergeable_c(), merges()],
        view(json!({"mergeable": "CONFLICTING"})),
        0,
        false,
    )
    .await;
    assert_eq!(statuses(&all), vec![Failed, Met]);
    assert_eq!(ran, vec!["merge-check"]);
}

#[tokio::test]
async fn short_circuit_a_failing_cmd_first_gh_never_runs() {
    let f = Fx::new();
    let (res, _) = short(&f, vec![merges(), mergeable_c()], view(json!({})), 1, true).await;
    assert_eq!(statuses(&res), vec![Failed, Skipped]);
    assert_eq!(f.file("argv"), None);
}

#[test]
fn parse_duration_reads_the_workflow_durations() {
    use crate::actions::condition_cmd::parse_duration;
    assert_eq!(parse_duration("30s"), Some(Duration::from_secs(30)));
    assert_eq!(parse_duration("15m"), Some(Duration::from_secs(900)));
    assert_eq!(parse_duration("250ms"), Some(Duration::from_millis(250)));
    assert_eq!(parse_duration("0s"), None);
    assert_eq!(parse_duration("soon"), None);
}
