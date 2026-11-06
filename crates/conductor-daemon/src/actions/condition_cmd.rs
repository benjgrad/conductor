//! Port of `packages/daemon/src/actions/condition-cmd.ts` (ADR-0037 T5).
//!
//! ADR-0037 P2 `cmd` conditions: met when the command exits 0, failed otherwise, run in a fresh,
//! conductor-owned checkout of the PR head (ADR-0030, the one `requires.checks` uses), never in
//! the agent's worktree. One checkout per evaluation, shared by its `cmd` conditions; the repo
//! setup runs once, and only when a `cmd` with `needs: setup` (the default) is reached. Anything
//! that keeps the command from running (no worktree on this machine, the branch moved, the setup
//! failed) is `pending`: a condition never fails on missing evidence. The checkout is removed when
//! the runner is dropped, so a killed evaluation (TD-205: the future is dropped) leaves nothing.

use super::checkout::{
    FreshCheckout, FreshCheckoutInput, detect_setup, fetch_budget, fresh_checkout, managed_command,
    missing_manager, remove_checkout,
};
use super::open_pr::resolve_head;
use crate::exec::{Env, tail};
use conductor_protocol::{ConditionNeeds, ConditionResult, ConditionResultStatus, ConditionType};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

/// `DEFAULT_CHECK_TIMEOUT` (shared `engine/review.ts`).
pub const DEFAULT_CHECK_TIMEOUT: &str = "15m";
/// Detail size cap for a failed command's output tail.
const OUTPUT_DETAIL_CHARS: usize = 600;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CmdExecResult {
    /// None: killed by a signal (the timeout included).
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub output_tail: String,
}

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
/// Runs a command with `sh -c` in a dir (the daemon: its command runner, through the build slots).
pub type CmdExec = Arc<dyn Fn(String, PathBuf, Duration) -> BoxFuture<CmdExecResult> + Send + Sync>;
/// Tests: the fresh checkout.
pub type CheckoutFn = Arc<dyn Fn(FreshCheckoutInput) -> BoxFuture<FreshCheckout> + Send + Sync>;
/// Tests: the worktree head.
pub type ResolveHeadFn = Arc<dyn Fn(PathBuf) -> BoxFuture<Option<String>> + Send + Sync>;

/// `parseDuration` (shared `workflow/schema.ts`): `<int><ms|s|m|h|d>`, positive.
pub fn parse_duration(text: &str) -> Option<Duration> {
    let split = text.find(|c: char| !c.is_ascii_digit())?;
    let (n, unit) = text.split_at(split);
    let n: u64 = n.parse().ok().filter(|n| *n > 0)?;
    let ms = match unit {
        "ms" => 1,
        "s" => 1_000,
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        _ => return None,
    };
    Some(Duration::from_millis(n.checked_mul(ms)?))
}

#[derive(Clone)]
pub struct CmdContext {
    pub root: PathBuf,
    /// The session's worktree and branch, from this daemon's own records; None: not held here.
    pub worktree: Option<(PathBuf, String)>,
    /// The setup for `needs: setup`: a command, `""` (none), None (auto-detect).
    pub setup: Option<String>,
    pub exec: CmdExec,
    pub env: Option<Env>,
    pub checkout: Option<CheckoutFn>,
    pub resolve_head: Option<ResolveHeadFn>,
    /// Tests: the PATH searched for a package manager.
    pub path: Option<String>,
}

fn res(
    status: ConditionResultStatus,
    value: Option<String>,
    detail: Option<String>,
) -> ConditionResult {
    ConditionResult {
        type_: ConditionType::Cmd,
        status,
        value,
        detail,
        mergeable: None,
    }
}

fn pending(detail: &str) -> ConditionResult {
    res(
        ConditionResultStatus::Pending,
        None,
        Some(detail.to_string()),
    )
}

/// The `cmd` conditions of one evaluation. Dropping it removes the checkout.
pub struct CmdConditionRunner {
    ctx: CmdContext,
    dir: Option<PathBuf>,
    /// Why the checkout can't be used (sticky for this evaluation).
    broken: Option<String>,
    setup_done: bool,
    /// Why the setup failed (then every `needs: setup` command stays pending).
    setup_failed: Option<String>,
}

impl Drop for CmdConditionRunner {
    fn drop(&mut self) {
        if let Some(d) = self.dir.take() {
            remove_checkout(&d);
        }
    }
}

impl CmdConditionRunner {
    pub fn new(ctx: CmdContext) -> Self {
        CmdConditionRunner {
            ctx,
            dir: None,
            broken: None,
            setup_done: false,
            setup_failed: None,
        }
    }

    /// Run one `cmd` on `sha` (the commit conductor pushed, else the PR head gh reported; None:
    /// the worktree's HEAD).
    pub async fn run(
        &mut self,
        cmd: &str,
        needs: ConditionNeeds,
        timeout: Option<&str>,
        sha: Option<String>,
    ) -> ConditionResult {
        let timeout = timeout.unwrap_or(DEFAULT_CHECK_TIMEOUT);
        let limit = parse_duration(timeout).unwrap_or(Duration::from_secs(15 * 60));
        let Some(dir) = self.prepare(sha, limit).await else {
            return pending(self.broken.as_deref().unwrap_or("no checkout"));
        };
        if needs != ConditionNeeds::Checkout {
            if let Some(f) = &self.setup_failed {
                return pending(f);
            }
            if !self.setup_done {
                if let Some(f) = self.run_setup(&dir).await {
                    let r = pending(&f);
                    self.setup_failed = Some(f);
                    return r;
                }
                self.setup_done = true;
            }
        }
        let cmd = managed_command(&dir, cmd);
        if let Some(m) = missing_manager(&cmd, self.ctx.path.as_deref()) {
            return pending(&m);
        }
        let r = (self.ctx.exec)(cmd, dir, limit).await;
        if r.timed_out {
            return res(
                ConditionResultStatus::Failed,
                Some("timed out".into()),
                Some(format!("timed out after {timeout}")),
            );
        }
        if r.exit_code == Some(0) {
            return res(ConditionResultStatus::Met, Some("exit 0".into()), None);
        }
        let value = r
            .exit_code
            .map_or_else(|| "killed".to_string(), |c| format!("exit {c}"));
        let out = tail(&r.output_tail, OUTPUT_DETAIL_CHARS);
        let detail = if out.is_empty() {
            value.clone()
        } else {
            format!("{value}: {out}")
        };
        res(ConditionResultStatus::Failed, Some(value), Some(detail))
    }

    async fn prepare(&mut self, sha: Option<String>, limit: Duration) -> Option<PathBuf> {
        if let Some(d) = &self.dir {
            return Some(d.clone());
        }
        if self.broken.is_some() {
            return None;
        }
        let Some((path, branch)) = self.ctx.worktree.clone() else {
            self.broken = Some(
                "this machine doesn't hold the ticket's worktree, so the command can't run here"
                    .into(),
            );
            return None;
        };
        let want = match sha {
            Some(s) => Some(s),
            None => match &self.ctx.resolve_head {
                Some(f) => f(path.clone()).await,
                None => resolve_head(&path, None).await,
            },
        };
        let Some(want) = want else {
            self.broken = Some("could not resolve the commit to check".into());
            return None;
        };
        let input = FreshCheckoutInput {
            root: self.ctx.root.clone(),
            worktree: path,
            branch,
            sha: want,
            env: self.ctx.env.clone(),
            timeout: Some(fetch_budget(Some(limit))),
        };
        let co = match &self.ctx.checkout {
            Some(f) => f(input).await,
            None => fresh_checkout(&input).await,
        };
        match co {
            FreshCheckout::Ok { dir, .. } => {
                self.dir = Some(dir.clone());
                Some(dir)
            }
            FreshCheckout::Err { error, .. } => {
                self.broken = Some(format!("fresh checkout: {error}"));
                None
            }
        }
    }

    /// The repo setup; None when it ran (or there is none), else why it failed.
    async fn run_setup(&self, dir: &std::path::Path) -> Option<String> {
        let setup = detect_setup(dir, self.ctx.setup.as_deref())?;
        if let Some(m) = missing_manager(&setup, self.ctx.path.as_deref()) {
            return Some(m);
        }
        let limit = parse_duration(DEFAULT_CHECK_TIMEOUT).unwrap_or(Duration::from_secs(900));
        let r = (self.ctx.exec)(setup.clone(), dir.to_path_buf(), limit).await;
        if r.exit_code == Some(0) && !r.timed_out {
            return None;
        }
        let why = if r.timed_out {
            "timed out".to_string()
        } else {
            r.exit_code
                .map_or_else(|| "killed".to_string(), |c| format!("exit {c}"))
        };
        Some(format!(
            "the setup `{setup}` failed in a fresh checkout ({why}): {}",
            tail(&r.output_tail, 300)
        ))
    }
}
