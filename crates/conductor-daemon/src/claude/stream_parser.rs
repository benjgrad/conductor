//! Port of `packages/daemon/src/claude/stream-parser.ts` (MR-T08).
//!
//! Lenient parser for the CLI's stream-json NDJSON (ADR-0005 §Parsing). The format is unversioned
//! and the CLI auto-updates (U-015), so nothing here panics: a line that is not JSON, not an
//! object, or of a type we don't use becomes `debug` output. Only system/init, assistant, user
//! (tool results) and result drive [`DriverEvent`]s.

use serde_json::{Map, Value};

use crate::claude::driver::{DriverEvent, OutputStream, Usage};

/// One item parsed from a stdout line.
#[derive(Clone, Debug, PartialEq)]
pub enum ParsedLine {
    Init {
        session_id: Option<String>,
        cli_version: Option<String>,
    },
    Event(DriverEvent),
}

type Obj = Map<String, Value>;

/// JS `String.prototype.trim() === ''`.
pub(crate) fn js_blank(s: &str) -> bool {
    s.chars().all(|c| c.is_whitespace() || c == '\u{FEFF}')
}

/// `JSON.stringify(v)` for a parsed JSON value: no whitespace, numbers as JS prints them
/// (`1.0` → `1`, `1e21` → `1e+21`), strings escaped as JS does.
///
/// TD-201: object keys come out in serde_json's (sorted) order, not the line's insertion order:
/// the workspace's serde_json has no `preserve_order` (turning it on reorders the T03 protocol
/// codegen). Only display text (tool_use lines, transcript chunks) is affected.
pub(crate) fn js_stringify(v: &Value) -> String {
    let mut out = String::new();
    write_js(v, &mut out);
    out
}

fn write_js(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            if f.is_finite() {
                out.push_str(ryu_js::Buffer::new().format(f));
            } else {
                out.push_str("null");
            }
        }
        Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_js(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (k, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                write_js(item, out);
            }
            out.push('}');
        }
    }
}

/// How a tool_result's `content` renders (shared with the transcript reader): a string as is,
/// text blocks joined with `\n` (other blocks as JSON), absent as `""`, anything else as JSON.
pub(crate) fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        None => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|c| match c.get("text") {
                Some(Value::String(t)) if c.is_object() => t.clone(),
                _ => js_stringify(c),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => js_stringify(other),
    }
}

/// `Name {json input}`, as both the live parser and the transcript render a tool_use block.
pub(crate) fn tool_use_text(block: &Obj) -> String {
    let name = block.get("name").and_then(Value::as_str).unwrap_or("?");
    let input = match block.get("input") {
        None | Some(Value::Null) => "{}".to_string(),
        Some(v) => js_stringify(v),
    };
    format!("{name} {input}")
}

fn debug(text: &str) -> ParsedLine {
    output(OutputStream::Debug, text.to_string())
}

fn output(stream: OutputStream, text: String) -> ParsedLine {
    ParsedLine::Event(DriverEvent::Output { stream, text })
}

fn str_of(m: &Obj, k: &str) -> Option<String> {
    m.get(k).and_then(Value::as_str).map(String::from)
}

/// A finite number, else 0 (TS `num`), as a token count.
fn num(m: &Obj, k: &str) -> u64 {
    match m.get(k).and_then(Value::as_f64) {
        Some(f) if f.is_finite() => f as u64,
        _ => 0,
    }
}

fn content_blocks(m: &Obj) -> Vec<&Obj> {
    let Some(Value::Object(message)) = m.get("message") else {
        return Vec::new();
    };
    match message.get("content") {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_object).collect(),
        _ => Vec::new(),
    }
}

/// A string `message.content` is one text block.
fn string_content(m: &Obj) -> Option<&str> {
    m.get("message")?.get("content")?.as_str()
}

/// Parse one stdout line into zero or more items. Never panics.
pub fn parse_stream_line(line: &str) -> Vec<ParsedLine> {
    if js_blank(line) {
        return Vec::new();
    }
    let Ok(Value::Object(m)) = serde_json::from_str::<Value>(line) else {
        return vec![debug(line)];
    };

    match m.get("type").and_then(Value::as_str) {
        Some("system") => match m.get("subtype").and_then(Value::as_str) {
            Some("init") => vec![ParsedLine::Init {
                session_id: str_of(&m, "session_id"),
                cli_version: str_of(&m, "claude_code_version"),
            }],
            // A running estimate emitted many times per turn; in a real session it was two thirds
            // of the output ring and says nothing a reader needs.
            Some("thinking_tokens") => Vec::new(),
            // ADR-0035: the jobs still running; kept as debug output too, like task_started.
            Some("background_tasks_changed") => {
                let running = match m.get("tasks") {
                    Some(Value::Array(t)) => u32::try_from(t.len()).unwrap_or(u32::MAX),
                    _ => 0,
                };
                vec![
                    debug(line),
                    ParsedLine::Event(DriverEvent::BackgroundTasks { running }),
                ]
            }
            _ => vec![debug(line)],
        },

        Some("assistant") => {
            if let Some(text) = string_content(&m) {
                return vec![output(OutputStream::Assistant, text.to_string())];
            }
            let mut out = Vec::new();
            for c in content_blocks(&m) {
                match c.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(Value::String(t)) = c.get("text") {
                            out.push(output(OutputStream::Assistant, t.clone()));
                        }
                    }
                    Some("tool_use") => out.push(output(OutputStream::ToolUse, tool_use_text(c))),
                    // thinking / redacted_thinking / other blocks: no user-facing text.
                    _ => {}
                }
            }
            out
        }

        Some("user") => content_blocks(&m)
            .into_iter()
            .filter(|c| c.get("type").and_then(Value::as_str) == Some("tool_result"))
            .map(|c| output(OutputStream::ToolResult, tool_result_text(c.get("content"))))
            .collect(),

        Some("result") => {
            let mut out = Vec::new();
            let empty = Obj::new();
            let usage = m.get("usage").and_then(Value::as_object).unwrap_or(&empty);
            if let Some(total) = m.get("total_cost_usd").and_then(Value::as_f64)
                && total.is_finite()
            {
                // Cumulative per Claude session, across --resume (ADR-0005). Missing → no spend.
                out.push(ParsedLine::Event(DriverEvent::Spend {
                    total_usd: total,
                    usage: Usage {
                        input_tokens: num(usage, "input_tokens"),
                        output_tokens: num(usage, "output_tokens"),
                        cache_read_tokens: num(usage, "cache_read_input_tokens"),
                        cache_creation_tokens: num(usage, "cache_creation_input_tokens"),
                    },
                }));
            }
            out.push(ParsedLine::Event(DriverEvent::TurnEnd {
                is_error: m.get("is_error") == Some(&Value::Bool(true)),
                subtype: str_of(&m, "subtype").unwrap_or_else(|| "unknown".into()),
                permission_denials: m
                    .get("permission_denials")
                    .and_then(Value::as_array)
                    .map_or(0, |a| u32::try_from(a.len()).unwrap_or(u32::MAX)),
            }));
            out
        }

        // rate_limit_event, stream_event, tool_progress, …
        _ => vec![debug(line)],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const INIT: &str = r#"{"type":"system","subtype":"init","session_id":"8cba9531-634d-4224-a516-249e74696fa2","tools":[],"claude_code_version":"2.1.308"}"#;
    const RESULT: &str = r#"{"type":"result","subtype":"success","is_error":false,"session_id":"8cba9531-634d-4224-a516-249e74696fa2","total_cost_usd":0.0006282900000000001,"usage":{"input_tokens":2,"cache_creation_input_tokens":3098,"cache_read_input_tokens":649,"output_tokens":4},"permission_denials":[{"tool_name":"Bash"},{"tool_name":"Write"}]}"#;

    fn ev(stream: OutputStream, text: &str) -> ParsedLine {
        output(stream, text.to_string())
    }

    #[test]
    fn reads_session_id_and_cli_version_from_system_init() {
        assert_eq!(
            parse_stream_line(INIT),
            vec![ParsedLine::Init {
                session_id: Some("8cba9531-634d-4224-a516-249e74696fa2".into()),
                cli_version: Some("2.1.308".into()),
            }]
        );
    }

    #[test]
    fn maps_result_to_spend_then_turn_end() {
        assert_eq!(
            parse_stream_line(RESULT),
            vec![
                ParsedLine::Event(DriverEvent::Spend {
                    total_usd: 0.0006282900000000001,
                    usage: Usage {
                        input_tokens: 2,
                        output_tokens: 4,
                        cache_read_tokens: 649,
                        cache_creation_tokens: 3098,
                    },
                }),
                ParsedLine::Event(DriverEvent::TurnEnd {
                    is_error: false,
                    subtype: "success".into(),
                    permission_denials: 2,
                }),
            ]
        );
    }

    #[test]
    fn result_without_a_cost_still_ends_the_turn_and_flags_errors() {
        let line = json!({"type":"result","subtype":"error_max_turns","is_error":true}).to_string();
        assert_eq!(
            parse_stream_line(&line),
            vec![ParsedLine::Event(DriverEvent::TurnEnd {
                is_error: true,
                subtype: "error_max_turns".into(),
                permission_denials: 0,
            })]
        );
        let bare = json!({"type":"result"}).to_string();
        assert_eq!(
            parse_stream_line(&bare),
            vec![ParsedLine::Event(DriverEvent::TurnEnd {
                is_error: false,
                subtype: "unknown".into(),
                permission_denials: 0,
            })]
        );
    }

    #[test]
    fn maps_assistant_text_and_tool_use_blocks_drops_thinking() {
        let line = json!({"type":"assistant","message":{"content":[
            {"type":"thinking","thinking":"hmm"},
            {"type":"text","text":"hello"},
            {"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a"}},
            {"type":"tool_use","id":"t2"}
        ]}})
        .to_string();
        assert_eq!(
            parse_stream_line(&line),
            vec![
                ev(OutputStream::Assistant, "hello"),
                ev(OutputStream::ToolUse, r#"Read {"file_path":"a"}"#),
                ev(OutputStream::ToolUse, "? {}"),
            ]
        );
        let s = json!({"type":"assistant","message":{"content":"plain"}}).to_string();
        assert_eq!(
            parse_stream_line(&s),
            vec![ev(OutputStream::Assistant, "plain")]
        );
    }

    #[test]
    fn maps_user_tool_result_content_string_or_blocks() {
        let line = json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"t1","content":"plain"},
            {"type":"tool_result","tool_use_id":"t2","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]},
            {"type":"tool_result","tool_use_id":"t3","content":[{"type":"image","n":1.0}]},
            {"type":"tool_result","tool_use_id":"t4"}
        ]}})
        .to_string();
        assert_eq!(
            parse_stream_line(&line),
            vec![
                ev(OutputStream::ToolResult, "plain"),
                ev(OutputStream::ToolResult, "a\nb"),
                ev(OutputStream::ToolResult, r#"{"n":1,"type":"image"}"#),
                ev(OutputStream::ToolResult, ""),
            ]
        );
    }

    #[test]
    fn is_lenient_garbage_non_objects_and_unknown_types_become_debug() {
        for line in [
            "not json {",
            "[1,2]",
            "42",
            r#"{"type":"rate_limit_event","rate_limit_info":{}}"#,
            r#"{"type":"system","subtype":"permission_denied"}"#,
            r#"{"type":"tool_progress"}"#,
            r#"{"no_type":true}"#,
        ] {
            assert_eq!(parse_stream_line(line), vec![debug(line)], "{line}");
        }
        assert_eq!(parse_stream_line(""), vec![]);
        assert_eq!(parse_stream_line("  \t "), vec![]);
        assert_eq!(
            parse_stream_line(r#"{"type":"assistant","message":null}"#),
            vec![]
        );
        assert_eq!(parse_stream_line(r#"{"type":"user"}"#), vec![]);
        assert_eq!(
            parse_stream_line(r#"{"type":"system","subtype":"init"}"#),
            vec![ParsedLine::Init {
                session_id: None,
                cli_version: None
            }]
        );
        // Odd shapes never panic.
        for line in [
            r#"{"type":"assistant","message":{"content":[1,null,"x",{"type":"text","text":5}]}}"#,
            r#"{"type":"user","message":{"content":{"type":"tool_result"}}}"#,
            r#"{"type":"result","usage":[1],"total_cost_usd":"1","permission_denials":{}}"#,
            r#"{"type":"result","total_cost_usd":-1e400}"#,
            "\u{0}\u{FEFF}{",
            r#"{"type":5}"#,
        ] {
            let _ = parse_stream_line(line);
        }
    }

    #[test]
    fn drops_system_thinking_tokens_progress_estimates() {
        let line = json!({"type":"system","subtype":"thinking_tokens","estimated_tokens":150,"estimated_tokens_delta":100}).to_string();
        assert_eq!(parse_stream_line(&line), vec![]);
    }

    #[test]
    fn js_stringify_prints_numbers_and_strings_like_js() {
        let v: Value =
            serde_json::from_str(r#"{"a":1.0,"b":1e21,"c":[0.5,-0,true,null],"d":"q\"\n\u2028"}"#)
                .unwrap();
        assert_eq!(
            js_stringify(&v),
            "{\"a\":1,\"b\":1e+21,\"c\":[0.5,0,true,null],\"d\":\"q\\\"\\n\u{2028}\"}"
        );
    }

    #[test]
    fn background_tasks_changed_reports_how_many_jobs_run_and_stays_debug_output() {
        // Shape from claude 2.1.318 (spikes/claude-driver/out/g-background.ndjson).
        let one = r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b1eelwpcm","task_type":"local_bash","description":"Sleep"}],"session_id":"s"}"#;
        assert_eq!(
            parse_stream_line(one),
            vec![
                debug(one),
                ParsedLine::Event(DriverEvent::BackgroundTasks { running: 1 })
            ]
        );
        let none = r#"{"type":"system","subtype":"background_tasks_changed","tasks":[]}"#;
        assert_eq!(
            parse_stream_line(none)[1],
            ParsedLine::Event(DriverEvent::BackgroundTasks { running: 0 })
        );
        // A missing or odd `tasks` counts as none, never panics.
        let odd = r#"{"type":"system","subtype":"background_tasks_changed","tasks":{}}"#;
        assert_eq!(
            parse_stream_line(odd)[1],
            ParsedLine::Event(DriverEvent::BackgroundTasks { running: 0 })
        );
    }
}
