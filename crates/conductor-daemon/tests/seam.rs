//! The platform seam (ADR-0024 §1, ADR-0026 §6): every OS branch in the daemon lives in
//! `src/platform/`, next to its other-OS twin, and runs on every OS in the `daemon-rust` matrix.
//! The Rust twin of `packages/daemon/src/platform/seam.test.ts`: any `cfg(…)`, `cfg!(…)` or
//! `cfg_attr(…)` naming `windows`, `unix`, `target_os` or `target_family` outside `src/platform/`
//! fails this test on every OS.

use std::fs;
use std::path::{Path, PathBuf};

const OS_WORDS: &[&str] = &["windows", "unix", "target_os", "target_family"];

/// `(line, text)` of every OS-specific cfg in `src`.
fn os_cfg_hits(src: &str) -> Vec<(usize, String)> {
    let bytes = src.as_bytes();
    let mut hits = Vec::new();
    let mut i = 0;
    while let Some(off) = src[i..].find("cfg") {
        let start = i + off;
        i = start + 3;
        // `cfg` must be a whole word: not the tail of `xcfg` or the head of `cfgs`.
        if start > 0 && is_ident(bytes[start - 1]) {
            continue;
        }
        let mut j = i;
        if src[j..].starts_with("_attr") {
            j += 5;
        }
        if src[j..].starts_with('!') {
            j += 1;
        }
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        if j >= bytes.len() || bytes[j] != b'(' {
            continue;
        }
        let Some(end) = closing_paren(bytes, j) else {
            continue;
        };
        let inner = &src[j + 1..end];
        if words(inner).any(|w| OS_WORDS.contains(&w)) {
            let line = src[..start].matches('\n').count() + 1;
            hits.push((line, src[start..=end].to_string()));
        }
        i = end + 1;
    }
    hits
}

fn is_ident(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn closing_paren(bytes: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (k, &b) in bytes.iter().enumerate().skip(open) {
        match b {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(k);
                }
            }
            _ => {}
        }
    }
    None
}

fn words(s: &str) -> impl Iterator<Item = &str> {
    s.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
}

fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("read src dir") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn no_os_cfg_outside_platform() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_sources(&src, &mut files);
    files.sort();
    let mut offenders = Vec::new();
    for file in files {
        let rel = file
            .strip_prefix(&src)
            .expect("under src")
            .to_string_lossy()
            .replace('\\', "/");
        if rel.starts_with("platform/") {
            continue;
        }
        let text = fs::read_to_string(&file).expect("read source");
        for (line, cfg) in os_cfg_hits(&text) {
            offenders.push(format!("src/{rel}:{line}: {cfg}"));
        }
    }
    assert!(
        offenders.is_empty(),
        "move the OS branch into src/platform/ (with its other-OS twin):\n{}",
        offenders.join("\n")
    );
}

#[test]
fn scanner_flags_os_cfgs() {
    for flagged in [
        "#[cfg(windows)]\nfn f() {}",
        "#[cfg(unix)]",
        "#[cfg(target_os = \"macos\")]",
        "#[cfg(not(windows))]",
        "#[cfg(any(test, unix))]",
        "#[cfg(target_family = \"wasm\")]",
        "if cfg!(windows) {}",
        "#[cfg_attr(unix, allow(dead_code))]",
        "#[cfg (\n  windows\n)]",
    ] {
        assert_eq!(os_cfg_hits(flagged).len(), 1, "should flag {flagged:?}");
    }
    for clean in [
        "#[cfg(test)]",
        "#[cfg(feature = \"x\")]",
        "#[cfg(debug_assertions)]",
        "#[cfg_attr(test, allow(dead_code))]",
        "let cfgs = (windows);",
        "let xcfg = (unix);",
        "fn cfg_windows() {}",
    ] {
        assert!(os_cfg_hits(clean).is_empty(), "should not flag {clean:?}");
    }
    assert_eq!(os_cfg_hits("a\n\n#[cfg(unix)]")[0].0, 3, "reports the line");
}
