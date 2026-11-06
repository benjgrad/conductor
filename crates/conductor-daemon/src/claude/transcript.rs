//! Port of `packages/daemon/src/claude/transcript.ts` (MR-T08).
//!
//! Read a session's history from Claude Code's own transcript (ADR-0008). Claude Code writes every
//! conversation to `<config dir>/projects/<cwd-slug>/<claude_session_id>.jsonl`, where the slug is
//! the realpath of the cwd with every non-alphanumeric character replaced by `-`. The daemon maps
//! its lines to the same output streams the live stream parser produces (`stream_parser`), so the
//! web renders history and live output the same way. Read-only; nothing here writes.

use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use conductor_protocol::json::json_byte_length;
use conductor_protocol::{
    OutputStream, TRANSCRIPT_MAX_BYTES, TRANSCRIPT_RESULT_CHARS, TranscriptChunk,
};
use serde_json::Value;

use crate::claude::outcome_server::{iso_string, js_slice_utf16};
use crate::claude::stream_parser::{js_blank, tool_result_text, tool_use_text};
use crate::orphan::is_claude_session_id;

/// Cap on any non-tool-result chunk (a tool_use with a large Write input, a long message).
pub const TRANSCRIPT_TEXT_CHARS: usize = 64 * 1024;
/// Only the last this many bytes of a transcript file are read (the reply keeps the recent end).
pub const TRANSCRIPT_READ_BYTES: u64 = 32 * 1024 * 1024;

/// Claude Code's project dir name for a cwd: the realpath with non-alphanumerics → `-` (per UTF-16
/// code unit, as the JS regex replaces them: a character outside the BMP gives two).
pub fn claude_project_slug(real_cwd: &str) -> String {
    let mut out = String::with_capacity(real_cwd.len());
    for c in real_cwd.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                out.push('-');
            }
        }
    }
    out
}

/// A Windows verbatim path as Node prints it: `\\?\C:\x` → `C:\x`, `\\?\UNC\srv\sh` →
/// `\\srv\sh`. Anything else is returned as is. (Pure string code: `std::fs::canonicalize` returns
/// verbatim paths on Windows, and Node's realpath doesn't.)
pub(crate) fn strip_verbatim(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = p.strip_prefix(r"\\?\") {
        let b = rest.as_bytes();
        if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            return rest.to_string();
        }
    }
    p.to_string()
}

/// `fs.realpathSync`, without Windows' verbatim prefix.
pub(crate) fn realpath(p: &Path) -> io::Result<PathBuf> {
    let c = std::fs::canonicalize(p)?;
    Ok(PathBuf::from(strip_verbatim(&c.to_string_lossy())))
}

/// The realpath Claude saw as its cwd. The worktree may be gone (removed after the session); its
/// parent (`<root>/wt`) normally still exists, so resolve that and re-append the name, which
/// keeps symlinked roots right (`/tmp` → `/private/tmp` on macOS).
pub fn real_cwd(cwd: &Path) -> PathBuf {
    if let Ok(r) = realpath(cwd) {
        return r;
    }
    if let (Some(parent), Some(name)) = (cwd.parent(), cwd.file_name())
        && let Ok(r) = realpath(parent)
    {
        return r.join(name);
    }
    cwd.to_path_buf()
}

fn project_file(config_dir: &Path, cwd: &Path, id: &str) -> PathBuf {
    config_dir
        .join("projects")
        .join(claude_project_slug(&real_cwd(cwd).to_string_lossy()))
        .join(format!("{id}.jsonl"))
}

/// Where Claude Code keeps the transcript of conversation `claude_session_id` run in `cwd`:
/// `<config_dir>/projects/<slug(real_cwd(cwd))>/<id>.jsonl`. None for a non-uuid id.
pub fn transcript_path_for(
    config_dir: &Path,
    cwd: &Path,
    claude_session_id: &str,
) -> Option<PathBuf> {
    is_claude_session_id(claude_session_id)
        .then(|| project_file(config_dir, cwd, claude_session_id))
}

/// Can `claude --resume <id>` run in `cwd`? It resolves the conversation from the cwd's own
/// project dir only, so a transcript under another project dir doesn't count (unlike
/// [`find_transcript`], which history and reopen use to read it from anywhere).
pub fn has_transcript_in_cwd(config_dir: &Path, cwd: &Path, claude_session_id: &str) -> bool {
    transcript_path_for(config_dir, cwd, claude_session_id)
        .and_then(|p| std::fs::metadata(p).ok())
        .is_some_and(|m| m.is_file())
}

/// The transcript file for a Claude session that ran in `cwd`, or None. First the exact path;
/// then any project dir holding `<id>.jsonl` (a `--resume` from another cwd), newest first. The id
/// comes from the daemon's own store and must be a uuid, so it can't escape `projects/`.
pub fn find_transcript(config_dir: &Path, cwd: &Path, claude_session_id: &str) -> Option<PathBuf> {
    if !is_claude_session_id(claude_session_id) {
        return None;
    }
    let exact = project_file(config_dir, cwd, claude_session_id);
    if exact.exists() {
        return Some(exact);
    }
    let file = format!("{claude_session_id}.jsonl");
    let mut best: Option<(PathBuf, SystemTime)> = None;
    for entry in std::fs::read_dir(config_dir.join("projects"))
        .ok()?
        .flatten()
    {
        let p = entry.path().join(&file);
        let Ok(m) = std::fs::metadata(&p) else {
            continue;
        };
        let mtime = m.modified().unwrap_or(UNIX_EPOCH);
        if m.is_file() && best.as_ref().is_none_or(|(_, t)| mtime > *t) {
            best = Some((p, mtime));
        }
    }
    best.map(|(p, _)| p)
}

/// The last [`TRANSCRIPT_READ_BYTES`] of the file, cut at a line start; `true` if anything was
/// skipped.
pub fn read_transcript_tail(path: &Path) -> io::Result<(String, bool)> {
    let mut f = std::fs::File::open(path)?;
    let size = f.metadata()?.len();
    let start = size.saturating_sub(TRANSCRIPT_READ_BYTES);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.take(size - start).read_to_end(&mut buf)?;
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        // JS `text.slice(text.indexOf('\n') + 1)`: no newline keeps it all.
        let cut = text.find('\n').map_or(0, |i| i + 1);
        text.drain(..cut);
    }
    Ok((text, start > 0))
}

/// JS `text.length` (UTF-16 code units).
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn cap(text: &str, max: usize) -> String {
    let len = js_len(text);
    if len <= max {
        return text.to_string();
    }
    format!(
        "{}\n… [truncated: {} more characters]",
        js_slice_utf16(text, max),
        len - max
    )
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's days_from_civil).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// JS `Date.parse` for the ISO-8601 forms Claude Code writes: `YYYY-MM-DD` and
/// `YYYY-MM-DDTHH:MM[:SS[.fff…]][Z|±HH:MM]`. None for anything else (JS returns NaN).
///
/// TD-202: JS reads a date-time without a zone as local time (here: UTC) and also accepts
/// non-ISO fallback formats (here: refused, so the chunk inherits the previous timestamp).
pub(crate) fn parse_js_date(s: &str) -> Option<SystemTime> {
    fn digits(s: &str, n: usize) -> Option<i64> {
        (s.len() == n && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse().ok())
            .flatten()
    }
    let (date, time) = match s.split_once('T') {
        Some((d, t)) => (d, Some(t)),
        None => (s, None),
    };
    let mut dp = date.split('-');
    let (y, mo, d) = (
        digits(dp.next()?, 4)?,
        digits(dp.next()?, 2)?,
        digits(dp.next()?, 2)?,
    );
    if dp.next().is_some() || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let mut ms = days_from_civil(y, mo, d) * 86_400_000;
    if let Some(t) = time {
        let (clock, offset_min) = if let Some(c) = t.strip_suffix('Z') {
            (c, 0)
        } else if let Some(i) = t.rfind(['+', '-']) {
            let (c, off) = (&t[..i], &t[i..]);
            let sign = if off.starts_with('-') { -1 } else { 1 };
            let (oh, om) = off[1..].split_once(':')?;
            let (oh, om) = (digits(oh, 2)?, digits(om, 2)?);
            if oh > 23 || om > 59 {
                return None;
            }
            (c, sign * (oh * 60 + om))
        } else {
            (t, 0)
        };
        let (hm, frac) = match clock.split_once('.') {
            Some((hm, f)) => (hm, Some(f)),
            None => (clock, None),
        };
        let mut parts = hm.split(':');
        let h = digits(parts.next()?, 2)?;
        let mi = digits(parts.next()?, 2)?;
        let sec = match parts.next() {
            Some(x) => digits(x, 2)?,
            None if frac.is_some() => return None,
            None => 0,
        };
        if parts.next().is_some() || h > 24 || mi > 59 || sec > 59 {
            return None;
        }
        if h == 24 && (mi != 0 || sec != 0) {
            return None;
        }
        let frac_ms = match frac {
            None => 0,
            Some(f) if !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()) => {
                let mut three = f.chars().take(3).collect::<String>();
                while three.len() < 3 {
                    three.push('0');
                }
                three.parse::<i64>().ok()?
            }
            Some(_) => return None,
        };
        ms += ((h * 60 + mi) * 60 + sec) * 1000 + frac_ms - offset_min * 60_000;
    }
    Some(if ms >= 0 {
        UNIX_EPOCH + Duration::from_millis(ms as u64)
    } else {
        UNIX_EPOCH - Duration::from_millis(ms.unsigned_abs())
    })
}

fn chunk(stream: OutputStream, text: String, ts: &str) -> TranscriptChunk {
    TranscriptChunk {
        stream,
        text,
        ts: ts.parse().unwrap_or_else(|_| {
            iso_string(UNIX_EPOCH)
                .parse()
                .expect("epoch is an ISO date")
        }),
    }
}

/// Map transcript JSONL to output chunks (ADR-0008):
/// - `assistant` `text` → `assistant`; `tool_use` → `tool_use` as `Name {json input}`, exactly
///   like the live parser; `thinking` and other blocks are skipped;
/// - `user` string prompt or `text` blocks → `user`; `tool_result` → `tool_result`, each cut at
///   TRANSCRIPT_RESULT_CHARS with a marker;
/// - everything else (attachments, queue operations, api requests, system lines, meta and
///   sidechain lines, unparseable lines) is skipped.
///
/// Then the most recent chunks whose JSON fits TRANSCRIPT_MAX_BYTES are kept (`true` if any were
/// dropped). `ts` is the line's timestamp, else the previous one, else the epoch.
pub fn transcript_chunks(jsonl: &str) -> (Vec<TranscriptChunk>, bool) {
    let mut all: Vec<TranscriptChunk> = Vec::new();
    let mut last_ts = iso_string(UNIX_EPOCH);
    for line in jsonl.split('\n') {
        if js_blank(line) {
            continue;
        }
        let Ok(Value::Object(m)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let ty = m.get("type").and_then(Value::as_str);
        if ty != Some("user") && ty != Some("assistant") {
            continue;
        }
        let is_assistant = ty == Some("assistant");
        if m.get("isSidechain") == Some(&Value::Bool(true))
            || m.get("isMeta") == Some(&Value::Bool(true))
        {
            continue;
        }
        if let Some(t) = m
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_js_date)
        {
            last_ts = iso_string(t);
        }
        let ts = last_ts.clone();
        let mut push = |stream: OutputStream, text: String, max: usize| {
            all.push(chunk(stream, cap(&text, max), &ts));
        };
        let content = m
            .get("message")
            .and_then(|msg| msg.as_object())
            .and_then(|msg| msg.get("content"));
        if !is_assistant && let Some(Value::String(s)) = content {
            if !js_blank(s) {
                push(OutputStream::User, s.clone(), TRANSCRIPT_TEXT_CHARS);
            }
            continue;
        }
        let Some(Value::Array(blocks)) = content else {
            continue;
        };
        let mut user_text: Vec<&str> = Vec::new();
        for c in blocks.iter().filter_map(Value::as_object) {
            let bt = c.get("type").and_then(Value::as_str);
            if is_assistant {
                match (bt, c.get("text")) {
                    (Some("text"), Some(Value::String(t))) if !js_blank(t) => {
                        push(OutputStream::Assistant, t.clone(), TRANSCRIPT_TEXT_CHARS);
                    }
                    (Some("tool_use"), _) => {
                        push(
                            OutputStream::ToolUse,
                            tool_use_text(c),
                            TRANSCRIPT_TEXT_CHARS,
                        );
                    }
                    _ => {}
                }
            } else if bt == Some("tool_result") {
                push(
                    OutputStream::ToolResult,
                    tool_result_text(c.get("content")),
                    TRANSCRIPT_RESULT_CHARS,
                );
            } else if let (Some("text"), Some(Value::String(t))) = (bt, c.get("text")) {
                user_text.push(t);
            }
        }
        let prompt = user_text.join("\n");
        if !js_blank(&prompt) {
            push(OutputStream::User, prompt, TRANSCRIPT_TEXT_CHARS);
        }
    }
    // Keep the most recent chunks that fit the byte cap.
    let mut bytes = 0usize;
    let mut first = all.len();
    while first > 0 {
        let size = serde_json::to_value(&all[first - 1]).map_or(0, |v| json_byte_length(&v)) + 1;
        if bytes + size > TRANSCRIPT_MAX_BYTES {
            break;
        }
        bytes += size;
        first -= 1;
    }
    let truncated = first > 0;
    (all.split_off(first), truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::driver::DriverEvent;
    use crate::claude::stream_parser::{ParsedLine, parse_stream_line};
    use serde_json::json;

    const FIXTURE: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../e2e/fixtures/transcript.jsonl"
    ));
    const ID: &str = "f024ace5-2382-4541-a297-6126caa8f4de";

    fn tmp() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let p = realpath(d.path()).unwrap();
        (d, p)
    }

    fn pairs(chunks: &[TranscriptChunk]) -> Vec<(String, String)> {
        chunks
            .iter()
            .map(|c| (c.stream.to_string(), c.text.clone()))
            .collect()
    }

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "").unwrap();
    }

    #[test]
    fn maps_a_real_shaped_transcript_to_the_live_parser_streams() {
        let (chunks, truncated) = transcript_chunks(FIXTURE);
        assert!(!truncated);
        let want: Vec<(&str, &str)> = vec![
            (
                "user",
                "# Ticket: Add a greeting file\n\nCreate greeting.txt and commit it.",
            ),
            (
                "tool_use",
                r#"mcp__conductor__ask_user {"question":"Which language?"}"#,
            ),
            (
                "tool_result",
                "Your question was sent to a human. End your turn now.",
            ),
            ("assistant", "I've asked which language to use."),
            ("user", "French"),
            ("assistant", "Writing it now."),
            (
                "tool_use",
                r#"Bash {"command":"printf 'Bonjour\\n' > greeting.txt && git commit -qam greeting","description":"Write and commit"}"#,
            ),
            ("tool_result", "43ff3e0 greeting\nBonjour"),
            (
                "tool_use",
                r#"mcp__conductor__complete_state {"result":{"summary":"done"}}"#,
            ),
            ("tool_result", "Recorded. Stop now."),
            ("assistant", "Created greeting.txt and committed it."),
        ];
        let want: Vec<(String, String)> = want
            .into_iter()
            .map(|(a, b)| (a.into(), b.into()))
            .collect();
        assert_eq!(pairs(&chunks), want);
        assert_eq!(chunks[0].ts.as_str(), "2026-10-22T20:41:01.000Z");
        assert_eq!(
            chunks.last().unwrap().ts.as_str(),
            "2026-10-22T20:41:11.000Z"
        );
    }

    #[test]
    fn renders_assistant_and_tool_lines_exactly_like_the_live_parser() {
        let assistant = json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"hi"},
            {"type":"tool_use","name":"Read","input":{"file_path":"a.ts"}}
        ]}})
        .to_string();
        let user = json!({"type":"user","message":{"content":[
            {"type":"tool_result","content":[{"type":"text","text":"x"},7]}
        ]}})
        .to_string();
        let live: Vec<(String, String)> = parse_stream_line(&assistant)
            .into_iter()
            .chain(parse_stream_line(&user))
            .filter_map(|p| match p {
                ParsedLine::Event(DriverEvent::Output { stream, text }) => {
                    Some((stream.as_str().to_string(), text))
                }
                _ => None,
            })
            .collect();
        let (chunks, _) = transcript_chunks(&format!("{assistant}\n{user}\n"));
        assert_eq!(pairs(&chunks), live);
        assert_eq!(live.len(), 3);
    }

    #[test]
    fn cuts_each_tool_result_at_transcript_result_chars_with_a_marker() {
        let big = "x".repeat(TRANSCRIPT_RESULT_CHARS + 10);
        let line =
            json!({"type":"user","message":{"content":[{"type":"tool_result","content":big}]}})
                .to_string();
        let (chunks, _) = transcript_chunks(&line);
        assert!(
            chunks[0]
                .text
                .starts_with(&"x".repeat(TRANSCRIPT_RESULT_CHARS))
        );
        assert!(
            chunks[0]
                .text
                .ends_with("\n… [truncated: 10 more characters]")
        );
        // Lengths are UTF-16 units, as in JS.
        assert_eq!(cap("😀😀", 2), "😀\n… [truncated: 2 more characters]");
        assert_eq!(cap("😀", 2), "😀");
    }

    #[test]
    fn keeps_the_most_recent_chunks_within_transcript_max_bytes() {
        let text = "y".repeat(10_000);
        let lines: Vec<String> = (0..400)
            .map(|i| {
                json!({"type":"assistant","message":{"content":[{"type":"text","text":format!("{i} {text}")}]}})
                    .to_string()
            })
            .collect();
        let (chunks, truncated) = transcript_chunks(&lines.join("\n"));
        assert!(truncated);
        let bytes: usize = chunks
            .iter()
            .map(|c| serde_json::to_string(c).unwrap().len() + 1)
            .sum();
        assert!(bytes <= TRANSCRIPT_MAX_BYTES);
        assert!(chunks.len() > 100);
        assert!(chunks.last().unwrap().text.starts_with("399 "));
    }

    #[test]
    fn skips_meta_sidechain_and_other_lines_and_inherits_timestamps() {
        let jsonl = [
            json!({"type":"user","isMeta":true,"message":{"content":"meta"}}).to_string(),
            json!({"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"side"}]}}).to_string(),
            json!({"type":"queue-operation"}).to_string(),
            "garbage".into(),
            json!({"type":"user","message":{"content":"first"}}).to_string(),
            json!({"type":"user","timestamp":"2026-01-02T03:04:05.678+01:00","message":{"content":"  "}}).to_string(),
            json!({"type":"user","timestamp":"not a date","message":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}).to_string(),
        ]
        .join("\n");
        let (chunks, _) = transcript_chunks(&jsonl);
        assert_eq!(
            pairs(&chunks),
            vec![
                ("user".into(), "first".into()),
                ("user".into(), "a\nb".into())
            ]
        );
        assert_eq!(chunks[0].ts.as_str(), "1970-01-01T00:00:00.000Z");
        assert_eq!(chunks[1].ts.as_str(), "2026-01-02T02:04:05.678Z");
    }

    #[test]
    fn parse_js_date_reads_the_iso_forms() {
        let iso = |s: &str| parse_js_date(s).map(iso_string);
        assert_eq!(
            iso("2026-10-22T20:41:01.000Z").as_deref(),
            Some("2026-10-22T20:41:01.000Z")
        );
        assert_eq!(
            iso("2026-10-22T20:41:01.1234Z").as_deref(),
            Some("2026-10-22T20:41:01.123Z")
        );
        assert_eq!(
            iso("2026-10-22T20:41Z").as_deref(),
            Some("2026-10-22T20:41:00.000Z")
        );
        assert_eq!(
            iso("2026-10-22").as_deref(),
            Some("2026-10-22T00:00:00.000Z")
        );
        assert_eq!(
            iso("2000-03-01T00:30:00-01:00").as_deref(),
            Some("2000-03-01T01:30:00.000Z")
        );
        assert_eq!(
            iso("2026-10-22T24:00:00Z").as_deref(),
            Some("2026-10-23T00:00:00.000Z")
        );
        for bad in [
            "",
            "x",
            "2026-13-01",
            "2026-10-22T25:00Z",
            "2026-1-2",
            "2026-10-22T20:41:01.Z",
        ] {
            assert_eq!(parse_js_date(bad), None, "{bad}");
        }
    }

    #[test]
    fn slug_and_verbatim_paths() {
        assert_eq!(claude_project_slug("/tmp/x_y.z"), "-tmp-x-y-z");
        assert_eq!(claude_project_slug("C:\\Users\\x"), "C--Users-x");
        assert_eq!(claude_project_slug("/é😀"), "-".to_string() + "---");
        assert_eq!(strip_verbatim(r"\\?\C:\Users\x"), r"C:\Users\x");
        assert_eq!(strip_verbatim(r"\\?\UNC\srv\share\x"), r"\\srv\share\x");
        assert_eq!(strip_verbatim(r"\\?\GLOBALROOT\x"), r"\\?\GLOBALROOT\x");
        assert_eq!(strip_verbatim("/tmp/x"), "/tmp/x");
    }

    #[test]
    fn uses_the_realpath_slug_of_the_cwd_even_when_the_worktree_is_gone() {
        let (_d, root) = tmp();
        let config = root.join("claude");
        let real = root.join("real");
        std::fs::create_dir_all(real.join("wt")).unwrap();
        let link = root.join("link");
        // Windows needs Developer Mode or admin for a symlink: there, use the real dir.
        let base = if crate::platform::fs::symlink(&real, &link).is_ok() {
            link
        } else {
            real.clone()
        };
        let cwd = base.join("wt").join("gone-session");
        assert_eq!(real_cwd(&cwd), real.join("wt").join("gone-session"));
        let slug = claude_project_slug(&real.join("wt").join("gone-session").to_string_lossy());
        assert!(slug.ends_with("-real-wt-gone-session"), "{slug}");
        assert!(
            slug.starts_with('-') || slug.as_bytes().get(1..3) == Some(b"--"),
            "{slug}"
        );
        let file = config
            .join("projects")
            .join(&slug)
            .join(format!("{ID}.jsonl"));
        touch(&file);
        assert_eq!(find_transcript(&config, &cwd, ID), Some(file));
    }

    #[test]
    fn falls_back_to_the_newest_project_dir_holding_the_id() {
        let (_d, config) = tmp();
        let older = config
            .join("projects")
            .join("-a")
            .join(format!("{ID}.jsonl"));
        let newer = config
            .join("projects")
            .join("-b")
            .join(format!("{ID}.jsonl"));
        touch(&older);
        touch(&newer);
        std::fs::File::options()
            .write(true)
            .open(&older)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_secs(1))
            .unwrap();
        let elsewhere = Path::new("/nowhere/else");
        assert_eq!(find_transcript(&config, elsewhere, ID), Some(newer));
        assert_eq!(
            find_transcript(&config, elsewhere, "c0ffee00-0000-4000-8000-000000000000"),
            None
        );
    }

    #[test]
    fn find_transcript_refuses_an_id_that_is_not_a_uuid() {
        let (_d, config) = tmp();
        touch(&config.join("projects").join("x").join("..jsonl"));
        assert_eq!(
            find_transcript(&config, Path::new("/w"), "../../etc/passwd"),
            None
        );
        assert_eq!(find_transcript(&config, Path::new("/w"), "."), None);
    }

    #[test]
    fn read_transcript_tail_reads_a_small_file_whole() {
        let (_d, dir) = tmp();
        let f = dir.join("t.jsonl");
        std::fs::write(&f, "a\nb\n").unwrap();
        assert_eq!(
            read_transcript_tail(&f).unwrap(),
            ("a\nb\n".to_string(), false)
        );
    }

    #[test]
    fn only_the_cwds_own_project_dir_counts_for_resume() {
        let (_d, root) = tmp();
        let config = root.join("claude");
        let cwd = root.join("wt").join("s1");
        std::fs::create_dir_all(&cwd).unwrap();
        let elsewhere = config
            .join("projects")
            .join("-other-cwd")
            .join(format!("{ID}.jsonl"));
        touch(&elsewhere);
        assert_eq!(find_transcript(&config, &cwd, ID), Some(elsewhere));
        assert!(!has_transcript_in_cwd(&config, &cwd, ID));

        let own = transcript_path_for(&config, &cwd, ID).unwrap();
        assert_eq!(
            own,
            config
                .join("projects")
                .join(claude_project_slug(&real_cwd(&cwd).to_string_lossy()))
                .join(format!("{ID}.jsonl"))
        );
        touch(&own);
        assert!(has_transcript_in_cwd(&config, &cwd, ID));
    }

    #[test]
    fn has_transcript_in_cwd_refuses_an_id_that_is_not_a_uuid() {
        assert_eq!(
            transcript_path_for(Path::new("/c"), Path::new("/w"), "../../etc/passwd"),
            None
        );
        assert!(!has_transcript_in_cwd(
            Path::new("/c"),
            Path::new("/w"),
            "claude-abc"
        ));
    }
}
