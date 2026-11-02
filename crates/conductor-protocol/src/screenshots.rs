//! Port of `packages/shared/src/workflow/screenshots.ts`'s path globs (MR-T10): the
//! `pr_screenshots` condition matches a PR's changed files against `ui_paths`. Checked against
//! `protocol-json/vectors/matchingPaths.json`, which the TS original runs too.

use regress::Regex;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

/// The default `ui_paths`: files whose change is visible in a UI.
pub const DEFAULT_UI_PATHS: &[&str] = &["**/*.{tsx,jsx,vue,svelte,css,scss,html}"];

/// The ECMAScript source of `globToRegExp(glob)`, anchored: minimatch-style for the subset
/// workflows use: `**` (any directories, including none, as a whole segment), `*` (within a
/// segment), `?` (one character), `{a,b}` (alternatives, not nested). Everything else is literal.
pub fn glob_to_regex_source(glob: &str) -> String {
    let g: Vec<char> = glob.chars().collect();
    let mut re = String::new();
    let mut i = 0;
    let mut in_braces = false;
    while i < g.len() {
        let c = g[i];
        if c == '*' && g.get(i + 1) == Some(&'*') {
            let at_start = i == 0 || g[i - 1] == '/';
            let at_end = i + 2 == g.len() || g.get(i + 2) == Some(&'/');
            if at_start && g.get(i + 2) == Some(&'/') {
                re.push_str("(?:.*/)?");
                i += 3;
                continue;
            }
            if at_start && at_end {
                re.push_str(".*");
                i += 2;
                continue;
            }
            re.push_str("[^/]*");
            i += 2;
            continue;
        }
        if c == '*' {
            re.push_str("[^/]*");
        } else if c == '?' {
            re.push_str("[^/]");
        } else if c == '{' && !in_braces {
            in_braces = true;
            re.push_str("(?:");
        } else if c == '}' && in_braces {
            in_braces = false;
            re.push(')');
        } else if c == ',' && in_braces {
            re.push('|');
        } else {
            if ".+^$()|[]\\{}".contains(c) {
                re.push('\\');
            }
            re.push(c);
        }
        i += 1;
    }
    if in_braces {
        // TS: `re.replace('(?:', '\\{').replaceAll('|', ',')`: the first group only, every `|`.
        re = re.replacen("(?:", "\\{", 1).replace('|', ",");
    }
    format!("^{re}$")
}

static CACHE: LazyLock<Mutex<HashMap<String, Arc<Regex>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// `globToRegExp(glob)`, compiled and cached.
pub fn glob_to_regex(glob: &str) -> Arc<Regex> {
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(r) = cache.get(glob) {
        return r.clone();
    }
    let source = glob_to_regex_source(glob);
    // Every metacharacter is escaped, so the source always compiles; a glob that somehow
    // doesn't matches nothing.
    let r = Arc::new(Regex::new(&source).unwrap_or_else(|_| Regex::new("^(?!)$").unwrap()));
    cache.insert(glob.to_string(), r.clone());
    r
}

/// The paths that match any of `globs`, in order.
pub fn matching_paths<P: AsRef<str>, G: AsRef<str>>(paths: &[P], globs: &[G]) -> Vec<String> {
    let res: Vec<Arc<Regex>> = globs.iter().map(|g| glob_to_regex(g.as_ref())).collect();
    paths
        .iter()
        .map(|p| p.as_ref())
        .filter(|p| res.iter().any(|r| r.find(p).is_some()))
        .map(str::to_string)
        .collect()
}
