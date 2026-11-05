//! `daemon.test.ts › daemon core: run_action evaluate_conditions (ADR-0011)`.

use super::run_action::fake_gh;
use super::*;

/// A fake gh whose `pr view` reports green checks and one approval.
fn fake_gh_view() -> GhCommand {
    let sha = "a".repeat(40);
    let view = format!(
        "echo '{{\"state\":\"OPEN\",\"mergedAt\":null,\"reviewDecision\":\"APPROVED\",\"headRefOid\":\"{sha}\",\
\"statusCheckRollup\":[{{\"__typename\":\"CheckRun\",\"name\":\"build\",\"status\":\"COMPLETED\",\"conclusion\":\"SUCCESS\"}}],\
\"reviews\":[{{\"author\":{{\"login\":\"amy\"}},\"authorAssociation\":\"MEMBER\",\"state\":\"APPROVED\",\"commit\":{{\"oid\":\"{sha}\"}}}}]}}'"
    );
    fake_gh(&["if [ \"$1 $2\" != \"pr view\" ]; then exit 9; fi", &view])
}

fn evaluate(sid: Uuid, args: Value) -> (OrchestratorToDaemon, Uuid) {
    let cid = Uuid::new_v4();
    (
        cmd(
            "run_action",
            sid,
            json!({
                "command_id": cid,
                "workflow_state": "implementing → waiting_external (ready_for_testing)",
                "target_state": "waiting_external",
                "action": "evaluate_conditions",
                "idempotency_key": format!("{sid}:conditions:1"),
                "args": args,
                "branch": "ignored",
                "expected_sha": null,
            }),
            4,
        ),
        cid,
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acks_accepted_and_reports_one_action_result_with_a_result_per_condition() {
    let c = Ctx::new().await;
    c.make(
        driver(complete(json!({}))),
        Make {
            gh: Some(fake_gh_view()),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    // Read-only and worktree-free: no session on this daemon is needed (ADR-0016).
    let (action, id) = evaluate(
        Uuid::new_v4(),
        json!({
            "conditions": [
                { "type": "pr_checks_green" },
                { "type": "pr_approvals", "min": 2 },
                { "type": "jira_fields_set", "fields": ["status"], "enabled": false },
            ],
            "pr_url": "https://github.com/benjgrad/fixture-app/pull/9",
            "branch": "b",
        }),
    );
    c.send(&action);
    assert_eq!(c.ack(id).await["accepted"], true);
    let res = c
        .until_for(15_000, || c.data("action_result").into_iter().next())
        .await;
    assert_eq!(
        res,
        json!({
            "command_id": id,
            "action": "evaluate_conditions",
            "result": {
                "results": [
                    { "type": "pr_checks_green", "status": "met", "value": "1/1 passed", "detail": null },
                    { "type": "pr_approvals", "status": "pending", "value": "1/2", "detail": "approved by amy" },
                    {
                        "type": "jira_fields_set",
                        "status": "unsupported",
                        "value": null,
                        "detail": "jira_fields_set can't be evaluated on this machine yet",
                    },
                ],
            },
            "error": null,
        })
    );
    assert_eq!(c.data("action_result").len(), 1);
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_args_accepted_then_an_action_result_error() {
    let c = Ctx::new().await;
    c.make(
        driver(complete(json!({}))),
        Make {
            gh: Some(fake_gh_view()),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    let (action, id) = evaluate(
        Uuid::new_v4(),
        json!({ "conditions": [], "pr_url": null, "branch": "b" }),
    );
    c.send(&action);
    assert_eq!(c.ack(id).await["accepted"], true);
    let res = c.first_data("action_result").await;
    assert_eq!(res["result"], Value::Null);
    assert!(
        res["error"]
            .as_str()
            .unwrap()
            .contains("evaluate_conditions: invalid args")
    );
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cmd_condition_for_a_session_this_daemon_does_not_hold_stays_pending() {
    let c = Ctx::new().await;
    c.make(
        driver(complete(json!({}))),
        Make {
            gh: Some(fake_gh_view()),
            ..Make::default()
        },
    );
    c.registered_and_asked().await;
    // The worktree comes from the daemon's own records, never from the message's branch.
    let (action, _) = evaluate(
        Uuid::new_v4(),
        json!({
            "conditions": [{ "type": "cmd", "name": "Merges cleanly", "cmd": "true", "needs": "checkout" }],
            "pr_url": null,
            "branch": "b",
        }),
    );
    c.send(&action);
    let res = c
        .until_for(15_000, || c.data("action_result").into_iter().next())
        .await;
    assert_eq!(
        res["result"],
        json!({
            "results": [{
                "type": "cmd",
                "status": "pending",
                "value": null,
                "detail": "this machine doesn't hold the ticket's worktree, so the command can't run here",
            }],
        })
    );
    c.done().await;
}
