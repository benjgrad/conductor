//! Port of `conditions.test.ts`: evaluate_conditions against a fake `gh` (a /bin/sh script run as
//! `<sh> <script> <args>`, Git Bash on Windows), plus the pure mapping. The fake-gh cases spawn a
//! process because the hardened env, cwd, cap and timeout are what's under test.

use super::*;
use crate::actions::open_pr::tests::{env_plus, ps, sh};
use crate::platform::Platform;
use conductor_protocol::NO_PR_CHECKS_VALUE;
use serde_json::json;

const PR: &str = "https://github.com/benjgrad/fixture-app/pull/9";

// Logs argv, cwd and the git env it got; prints $FAKE_GH_DIR/out; exits $FAKE_GH_EXIT.
const FAKE_GH: &str = r#"
echo "$*" >> "$FAKE_GH_DIR/argv"
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

use ConditionResultStatus::{Failed, Met, Pending, Unsupported};

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
