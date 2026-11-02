//! Port of `packages/daemon/src/claude/outcome-server.ts` (MR-T08).
//!
//! MR-T06 ported only the pure helpers the fake driver shares with the server (below). MR-T08
//! adds the MCP server itself, building on them.

use std::time::{SystemTime, UNIX_EPOCH};

use conductor_protocol::{AgentTransitionOption, JsonObject, PERMISSION_MESSAGE_MAX};
use serde::Serialize;

use crate::claude::driver::PermissionDecision;
use conductor_protocol::{PermissionBehavior, PermissionScope};

// ---- Pure helpers (MR-T06; MR-T08 adds the server below) ----

pub const OUTCOME_SERVER_NAME: &str = "conductor";

/// The transition `complete_state` takes when it names none (old prompts, ADR-0011).
pub const DEFAULT_TRANSITION: &str = "done";

/// A deny without a note. The decision frame names no user, so "a human" (10-contracts).
pub const PERMISSION_DENIED_ON_BOARD: &str = "Permission denied by a human on the board.";
/// The agent's process went away while the call was held (unregister).
pub const PERMISSION_SESSION_ENDED: &str = "Permission denied: the agent session ended.";

/// ADR-0011: whether `complete_state` naming `name` is refused with the corrective text. Only the
/// first unknown name is refused (`nudged` false); no list (old workflows, reviewers) accepts any.
pub fn refuse_transition(
    transitions: Option<&[AgentTransitionOption]>,
    name: Option<&str>,
    nudged: bool,
) -> bool {
    let Some(transitions) = transitions else {
        return false;
    };
    if transitions.is_empty() || nudged {
        return false;
    }
    let effective = name.unwrap_or(DEFAULT_TRANSITION);
    !transitions.iter().any(|t| t.name.as_str() == effective)
}

/// One rule of a permission reply's `updatedPermissions`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRule {
    pub tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_content: Option<String>,
}

/// `{type: 'addRules', rules, behavior: 'allow', destination: 'session'}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PermissionUpdate {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub rules: Vec<PermissionRule>,
    pub behavior: &'static str,
    pub destination: &'static str,
}

/// The permission-prompt-tool reply Claude reads (the tool's text content, as JSON).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "behavior", rename_all = "lowercase")]
pub enum PermissionReply {
    Allow {
        #[serde(rename = "updatedInput")]
        updated_input: JsonObject,
        #[serde(rename = "updatedPermissions", skip_serializing_if = "Option::is_none")]
        updated_permissions: Option<Vec<PermissionUpdate>>,
    },
    Deny {
        message: String,
    },
}

/// `Bash(pnpm exec tsc -b)` → `{toolName: 'Bash', ruleContent: 'pnpm exec tsc -b'}`; `Read` →
/// `{toolName: 'Read'}` (the TS regex `^([^()]+)\(([\s\S]*)\)$`).
pub fn parse_permission_rule(rule: &str) -> PermissionRule {
    let whole = || PermissionRule {
        tool_name: rule.to_string(),
        rule_content: None,
    };
    let Some(open) = rule.find('(') else {
        return whole();
    };
    let name = &rule[..open];
    if name.is_empty() || name.contains(')') || !rule.ends_with(')') || rule.len() < open + 2 {
        return whole();
    }
    PermissionRule {
        tool_name: name.to_string(),
        rule_content: Some(rule[open + 1..rule.len() - 1].to_string()),
    }
}

/// JS `String.prototype.trim` (Unicode white space plus U+FEFF).
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}')
}

/// JS `s.slice(0, max)`: the first `max` UTF-16 code units. A surrogate pair cut in half is
/// dropped (JS would keep a lone surrogate, which Rust strings can't hold).
fn js_slice_utf16(s: &str, max: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &s[..i];
        }
    }
    s
}

/// The reply for a human's decision on `input` (10-contracts §Permission prompts).
pub fn permission_reply(input: &JsonObject, d: &PermissionDecision) -> PermissionReply {
    if d.behavior == PermissionBehavior::Deny {
        let note = d
            .message
            .as_deref()
            .map(|m| js_slice_utf16(js_trim(m), PERMISSION_MESSAGE_MAX));
        return PermissionReply::Deny {
            message: match note {
                Some(n) if !n.is_empty() => {
                    format!("Permission denied by a human on the board: {n}")
                }
                _ => PERMISSION_DENIED_ON_BOARD.to_string(),
            },
        };
    }
    let updated_permissions = match (&d.scope, &d.rule) {
        (PermissionScope::Always, Some(rule)) => Some(vec![PermissionUpdate {
            kind: "addRules",
            rules: vec![parse_permission_rule(rule)],
            behavior: "allow",
            destination: "session",
        }]),
        _ => None,
    };
    PermissionReply::Allow {
        updated_input: input.clone(),
        updated_permissions,
    }
}

/// JS `new Date(t).toISOString()`: `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC, milliseconds). Times before
/// 1970 are clamped to the epoch.
pub fn iso_string(t: SystemTime) -> String {
    let ms = t
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let (secs, millis) = ((ms / 1000) as i64, (ms % 1000) as u32);
    let (days, sod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn transitions(names: &[&str]) -> Vec<AgentTransitionOption> {
        names
            .iter()
            .map(|n| {
                serde_json::from_value(
                    serde_json::json!({"name": n, "when": null, "question": false}),
                )
                .unwrap()
            })
            .collect()
    }

    #[test]
    fn parses_exact_rules_into_tool_name_rule_content() {
        let r = |t: &str, c: Option<&str>| PermissionRule {
            tool_name: t.into(),
            rule_content: c.map(String::from),
        };
        assert_eq!(
            parse_permission_rule("Bash(git status)"),
            r("Bash", Some("git status"))
        );
        assert_eq!(
            parse_permission_rule("Bash(echo (a))"),
            r("Bash", Some("echo (a)"))
        );
        assert_eq!(parse_permission_rule("WebFetch"), r("WebFetch", None));
        assert_eq!(parse_permission_rule("(x)"), r("(x)", None));
        assert_eq!(parse_permission_rule("Bash(x"), r("Bash(x", None));
        assert_eq!(parse_permission_rule("Bash()"), r("Bash", Some("")));
    }

    #[test]
    fn refuse_transition_refuses_an_unknown_name_once_and_never_without_a_list() {
        let t = transitions(&["plan_ready", "done"]);
        assert!(!refuse_transition(None, Some("x"), false));
        assert!(!refuse_transition(Some(&[]), Some("x"), false));
        assert!(refuse_transition(Some(&t), Some("x"), false));
        assert!(!refuse_transition(Some(&t), Some("x"), true));
        assert!(!refuse_transition(Some(&t), Some("plan_ready"), false));
        assert!(!refuse_transition(Some(&t), None, false));
        let no_done = transitions(&["plan_ready"]);
        assert!(refuse_transition(Some(&no_done), None, false));
    }

    #[test]
    fn permission_reply_serialises_as_claude_reads_it() {
        let input: JsonObject =
            serde_json::from_value(serde_json::json!({"command": "ls"})).unwrap();
        let allow_always = PermissionDecision {
            behavior: PermissionBehavior::Allow,
            scope: PermissionScope::Always,
            message: None,
            rule: Some("Bash(ls)".into()),
        };
        assert_eq!(
            serde_json::to_value(permission_reply(&input, &allow_always)).unwrap(),
            serde_json::json!({
                "behavior": "allow",
                "updatedInput": {"command": "ls"},
                "updatedPermissions": [{
                    "type": "addRules",
                    "rules": [{"toolName": "Bash", "ruleContent": "ls"}],
                    "behavior": "allow",
                    "destination": "session"
                }]
            })
        );
        let allow_once = PermissionDecision {
            scope: PermissionScope::Once,
            ..allow_always.clone()
        };
        assert_eq!(
            serde_json::to_value(permission_reply(&input, &allow_once)).unwrap(),
            serde_json::json!({"behavior": "allow", "updatedInput": {"command": "ls"}})
        );
        let deny = |m: Option<&str>| PermissionDecision {
            behavior: PermissionBehavior::Deny,
            scope: PermissionScope::Once,
            message: m.map(String::from),
            rule: None,
        };
        assert_eq!(
            serde_json::to_value(permission_reply(&input, &deny(Some("  not now \n")))).unwrap(),
            serde_json::json!({"behavior": "deny", "message": "Permission denied by a human on the board: not now"})
        );
        for m in [None, Some("   ")] {
            assert_eq!(
                permission_reply(&input, &deny(m)),
                PermissionReply::Deny {
                    message: PERMISSION_DENIED_ON_BOARD.into()
                }
            );
        }
        let long = "é".repeat(PERMISSION_MESSAGE_MAX + 5);
        let PermissionReply::Deny { message } = permission_reply(&input, &deny(Some(&long))) else {
            panic!("deny expected")
        };
        assert!(message.ends_with(&"é".repeat(PERMISSION_MESSAGE_MAX)));
        assert!(!message.ends_with(&"é".repeat(PERMISSION_MESSAGE_MAX + 1)));
    }

    #[test]
    fn iso_string_matches_js_to_iso_string() {
        assert_eq!(iso_string(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_string(UNIX_EPOCH + Duration::from_millis(1_700_000_000_123)),
            "2023-11-14T22:13:20.123Z"
        );
        assert_eq!(
            iso_string(UNIX_EPOCH + Duration::from_millis(951_782_400_000)),
            "2000-02-29T00:00:00.000Z"
        );
    }
}
