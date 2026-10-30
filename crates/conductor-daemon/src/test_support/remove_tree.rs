//! Port of `packages/daemon/src/test-support/remove-tree.ts` (MR-T04).
//!
//! No OS `cfg` here (tests/seam.rs): the OS facts come from `platform`.

use crate::platform::{self, Platform};
use std::io;
use std::path::Path;
use std::time::Duration;

/// Remove a test's temp tree while a daemon's background `git` may still be writing into it.
/// TD-111: the daemon fires an inventory scan without awaiting it, and its `git status` rewrites
/// the shared clone's `.git/index` after `stop()` returns, so removal is retried from the top
/// until the tree is gone (about 4 s at most). A missing tree is gone.
pub async fn remove_tree(path: &Path, attempts: u32, delay: Duration) -> io::Result<()> {
    let mut i = 1;
    loop {
        match std::fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) if i >= attempts => return Err(e),
            Err(_) => tokio::time::sleep(delay).await,
        }
        i += 1;
    }
}

/// [`remove_tree`] with the TS defaults: 40 attempts, 100 ms apart.
pub async fn remove_tree_default(path: &Path) -> io::Result<()> {
    remove_tree(path, 40, Duration::from_millis(100)).await
}

/// [`remove_tree_default`], but on Windows a tree still held open after the last attempt is left
/// behind instead of failing the test: a Git Bash background job can outlive its kill (TD-189) and
/// keep its cwd open for as long as it runs. POSIX still errs.
pub async fn remove_tree_or_leave(path: &Path) -> io::Result<()> {
    match remove_tree_default(path).await {
        Err(e) if Platform::current().is_windows() && platform::fs::is_held_open(&e) => Ok(()),
        r => r,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn removes_a_tree_and_a_missing_one() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("t");
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/b/f"), "x").unwrap();
        remove_tree(&root, 3, Duration::from_millis(1))
            .await
            .unwrap();
        assert!(!root.exists());
        remove_tree_or_leave(&root).await.unwrap();
    }

    #[tokio::test]
    async fn gives_up_after_the_last_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f");
        std::fs::write(&file, "x").unwrap();
        // A file is not a directory: every attempt fails.
        assert!(
            remove_tree(&file, 2, Duration::from_millis(1))
                .await
                .is_err()
        );
    }
}
