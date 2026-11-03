//! `units.test.ts › helpers › cloneSource / repoSlug` (the helpers live in `workspace`).

use crate::workspace::{RepoPolicy, clone_source, repo_slug};

#[test]
fn clone_source_and_repo_slug() {
    let local = RepoPolicy {
        allow_local_repos: true,
        allowed_repo_hosts: vec![],
    };
    let none = RepoPolicy::default();
    assert_eq!(
        clone_source("github.com/org/app", &none).unwrap(),
        "https://github.com/org/app.git"
    );
    if !crate::platform::Platform::current().is_windows() {
        assert_eq!(
            clone_source("/srv/repos/app", &local).unwrap(),
            "/srv/repos/app"
        );
    }
    assert_eq!(
        clone_source("git@github.com:org/app.git", &none).unwrap(),
        "git@github.com:org/app.git"
    );
    assert_eq!(
        clone_source("file:///tmp/x", &local).unwrap(),
        "file:///tmp/x"
    );
    let slug = repo_slug("github.com/org/app");
    let (head, hash) = slug.rsplit_once('-').unwrap();
    assert_eq!(head, "github.com_org_app");
    assert_eq!(hash.len(), 8);
    assert!(
        hash.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    );
    assert_ne!(repo_slug("a/b"), repo_slug("a_b"));
}
