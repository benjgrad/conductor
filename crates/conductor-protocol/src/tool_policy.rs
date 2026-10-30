//! `resolveToolPolicy` (`workflow/tools.ts`) over the generated `TOOL_ALIASES` table.

use crate::{BASE_TOOL_POLICY, TOOL_ALIASES, ToolPolicyFragment};

/// The resolved `--tools` / `--allowedTools` / `--disallowedTools` lists (the daemon's
/// `ToolPolicy`).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ToolPolicy {
    pub builtin: Vec<String>,
    pub allow: Vec<String>,
    pub deny: Vec<String>,
}

/// `UnknownToolAliasError`: workflow tool names that are no alias, in input order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnknownToolAlias {
    pub names: Vec<String>,
}

impl std::fmt::Display for UnknownToolAlias {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "unknown workflow tool name(s): {}",
            self.names.join(", ")
        )
    }
}

impl std::error::Error for UnknownToolAlias {}

/// The fragment of one alias name.
pub fn tool_alias(name: &str) -> Option<&'static ToolPolicyFragment> {
    TOOL_ALIASES
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, f)| f)
}

/// The base policy merged with each alias's fragment, de-duplicated in first-seen order. Deny
/// wins: an `allow` rule that is also denied is dropped.
pub fn resolve_tool_policy<S: AsRef<str>>(tools: &[S]) -> Result<ToolPolicy, UnknownToolAlias> {
    let unknown: Vec<String> = tools
        .iter()
        .map(AsRef::as_ref)
        .filter(|t| tool_alias(t).is_none())
        .map(str::to_string)
        .collect();
    if !unknown.is_empty() {
        return Err(UnknownToolAlias { names: unknown });
    }
    let frags: Vec<&ToolPolicyFragment> = std::iter::once(&BASE_TOOL_POLICY)
        .chain(tools.iter().filter_map(|t| tool_alias(t.as_ref())))
        .collect();
    let uniq = |pick: fn(&ToolPolicyFragment) -> &'static [&'static str]| {
        let mut out: Vec<String> = Vec::new();
        for rule in frags.iter().flat_map(|f| pick(f)) {
            if !out.iter().any(|r| r == rule) {
                out.push((*rule).to_string());
            }
        }
        out
    };
    let deny = uniq(|f| f.deny);
    let allow = uniq(|f| f.allow)
        .into_iter()
        .filter(|r| !deny.contains(r))
        .collect();
    Ok(ToolPolicy {
        builtin: uniq(|f| f.builtin),
        allow,
        deny,
    })
}
