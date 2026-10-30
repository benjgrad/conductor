//! The repo grammar (`api/rest.ts` `canonicalRepo`, `machines/inventory.ts`
//! `isCanonicalRemote`). The regexes run on `regress`, an ECMAScript engine, so `\s` and the
//! anchors mean what they mean in the TypeScript originals.

use std::sync::LazyLock;

use regress::Regex;

const LABEL: &str = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const SEGMENT: &str = "[A-Za-z0-9_][A-Za-z0-9._-]*";

fn host() -> String {
    format!("{LABEL}(?:\\.{LABEL})*")
}
fn repo_path() -> String {
    format!("{SEGMENT}(?:/{SEGMENT})+")
}
fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid ECMAScript regex")
}

static CANONICAL_RE: LazyLock<Regex> =
    LazyLock::new(|| re(&format!("^({})/({})$", host(), repo_path())));
static SCP_RE: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        "^[A-Za-z0-9_][A-Za-z0-9._-]*@({}):({})$",
        host(),
        repo_path()
    ))
});
static URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        "^(https|ssh)://(?:([A-Za-z0-9_][A-Za-z0-9._-]*)@)?({})/({})$",
        host(),
        repo_path()
    ))
});
static SCHEME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::with_flags("^[a-z][a-z0-9+.-]*:", "i").expect("valid ECMAScript regex")
});
static SPACE_OR_NUL_RE: LazyLock<Regex> = LazyLock::new(|| re("[\\s\\0]"));
static CANONICAL_REMOTE_RE: LazyLock<Regex> = LazyLock::new(|| re(crate::CANONICAL_REMOTE_RE));

fn group<'t>(m: &regress::Match, text: &'t str, i: usize) -> Option<&'t str> {
    m.group(i).map(|r| &text[r])
}

/// `/\.git$/i` on the ASCII names the grammar allows.
fn ends_with_dot_git(s: &str) -> bool {
    s.len() >= 4 && s.is_char_boundary(s.len() - 4) && s[s.len() - 4..].eq_ignore_ascii_case(".git")
}

/// The canonical `host/org/repo` form of a repo reference (`canonicalRepo`), or `None`.
/// Accepts `host/org/repo`, `https://host/org/repo`, `ssh://user@host/org/repo` and scp-style
/// `user@host:org/repo`, each with an optional `.git` (any case) and trailing `/`; the host is
/// lower-cased and the path keeps its case.
pub fn canonical_repo(repo: &str) -> Option<String> {
    // `repo.length` counts UTF-16 code units.
    if repo.is_empty()
        || repo.encode_utf16().count() > 1024
        || SPACE_OR_NUL_RE.find(repo).is_some()
        || repo.starts_with('-')
    {
        return None;
    }
    let trimmed = repo.strip_suffix('/').unwrap_or(repo);
    let (host, path) = if let Some(m) = URL_RE.find(trimmed) {
        let scheme = group(&m, trimmed, 1)?;
        if scheme.eq_ignore_ascii_case("https") && m.group(2).is_some() {
            return None;
        }
        (group(&m, trimmed, 3)?, group(&m, trimmed, 4)?)
    } else if SCHEME_RE.find(trimmed).is_some() && SCP_RE.find(trimmed).is_none() {
        return None;
    } else {
        let m = SCP_RE
            .find(trimmed)
            .or_else(|| CANONICAL_RE.find(trimmed))?;
        (group(&m, trimmed, 1)?, group(&m, trimmed, 2)?)
    };
    let path = if ends_with_dot_git(path) {
        &path[..path.len() - 4]
    } else {
        path
    };
    // GitHub repo names can't end in `.git`; one is stripped, never two.
    if ends_with_dot_git(path) {
        return None;
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() < 2
        || segments
            .iter()
            .any(|s| s.is_empty() || *s == "." || *s == "..")
    {
        return None;
    }
    Some(format!("{}/{path}", host.to_ascii_lowercase()))
}

/// Whether `s` is a canonical remote (`isCanonicalRemote`): `host/org/repo[/sub…]` with a
/// lower-case host, no `.git` suffix and no `.` / `..` segment.
pub fn is_canonical_remote(s: &str) -> bool {
    CANONICAL_REMOTE_RE.find(s).is_some()
        && !ends_with_dot_git(s)
        && !s.split('/').any(|seg| seg == "." || seg == "..")
}
