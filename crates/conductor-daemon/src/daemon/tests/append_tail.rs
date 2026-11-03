//! `daemon.test.ts › appendTail (exit stderr_tail)`.

use super::*;

#[test]
fn keeps_the_last_stderr_tail_lines_lines_across_chunk_boundaries() {
    let mut tail = String::new();
    for i in 0..30 {
        tail = append_tail(&tail, &format!("l{i}\n"));
    }
    let lines: Vec<&str> = tail.split('\n').filter(|l| !l.is_empty()).collect();
    let want: Vec<String> = (0..20).map(|i| format!("l{}", i + 10)).collect();
    assert_eq!(lines, want);
    assert_eq!(append_tail("par", "tial"), "partial");
}

#[test]
fn caps_the_characters() {
    assert_eq!(
        append_tail("", &"y".repeat(10_000)).chars().count(),
        STDERR_TAIL_CHARS
    );
}

/// JS `slice(-n)` counts UTF-16 code units (an astral char is two).
#[test]
fn js_slices_count_utf16_code_units() {
    assert_eq!(js_tail_utf16("abc", 2), "bc");
    assert_eq!(js_tail_utf16("a😀", 2), "😀");
    assert_eq!(js_tail_utf16("a😀", 1), "");
    assert_eq!(js_head_utf16("😀b", 3), "😀b");
    assert_eq!(js_head_utf16("😀b", 1), "");
    assert_eq!(err_text("x".repeat(400)).len(), 300);
}
