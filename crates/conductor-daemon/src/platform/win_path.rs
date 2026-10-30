//! Node's `path.win32`, as plain string functions that behave the same on every OS (`std::path`
//! follows the host). The pure win32 rules (PATHEXT resolution, Git Bash candidates, exe names)
//! use these, so they are tested on Linux and macOS too.

fn is_sep(c: char) -> bool {
    c == '\\' || c == '/'
}

/// The `C:` drive prefix, if any.
fn drive(p: &str) -> Option<&str> {
    let b = p.as_bytes();
    (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':').then(|| &p[..2])
}

/// `path.win32.isAbsolute`: a leading separator, or a drive followed by one.
pub fn is_absolute(p: &str) -> bool {
    match p.chars().next() {
        Some(c) if is_sep(c) => true,
        _ => drive(p).is_some() && p[2..].chars().next().is_some_and(is_sep),
    }
}

/// `path.win32.normalize`: `/` → `\`, repeated separators collapsed, `.` and `..` resolved (never
/// above the root), the drive and a trailing separator kept. `""` → `"."`.
pub fn normalize(p: &str) -> String {
    if p.is_empty() {
        return ".".to_string();
    }
    let (prefix, rest) = match drive(p) {
        Some(d) => (d.to_string(), &p[2..]),
        None => (String::new(), p),
    };
    // A UNC root `\\server\share` stays as it is.
    let unc = prefix.is_empty() && (rest.starts_with("\\\\") || rest.starts_with("//"));
    let rooted = rest.chars().next().is_some_and(is_sep);
    let trailing = rest.chars().last().is_some_and(is_sep);
    let mut parts: Vec<&str> = Vec::new();
    for seg in rest.split(is_sep) {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|l| *l != "..") {
                    parts.pop();
                } else if !rooted {
                    parts.push("..");
                }
            }
            s => parts.push(s),
        }
    }
    let mut out = prefix;
    if unc {
        out.push_str("\\\\");
    } else if rooted {
        out.push('\\');
    }
    out.push_str(&parts.join("\\"));
    if trailing && !parts.is_empty() {
        out.push('\\');
    }
    if out.is_empty() {
        out.push('.');
    }
    out
}

/// `path.win32.join`: the non-empty parts joined with `\`, then normalized.
pub fn join(parts: &[&str]) -> String {
    let joined: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    if joined.is_empty() {
        return ".".to_string();
    }
    normalize(&joined.join("\\"))
}

/// `path.win32.resolve(cwd, p)` for the shapes the daemon uses: an absolute `p` wins (a rooted
/// `p` without a drive takes `cwd`'s drive), otherwise `cwd\p`. No trailing separator except at a
/// root.
pub fn resolve(cwd: &str, p: &str) -> String {
    let out = if drive(p).is_some() && is_absolute(p) {
        normalize(p)
    } else if p.chars().next().is_some_and(is_sep) {
        normalize(&format!("{}{p}", drive(cwd).unwrap_or("")))
    } else if cwd.is_empty() {
        normalize(p)
    } else {
        normalize(&format!("{cwd}\\{p}"))
    };
    let root_len = if drive(&out).is_some() { 3 } else { 1 };
    if out.len() > root_len && out.ends_with('\\') {
        out[..out.len() - 1].to_string()
    } else {
        out
    }
}

/// `path.win32.basename`: the last component (trailing separators ignored).
pub fn basename(p: &str) -> &str {
    let p = drive(p).map_or(p, |d| &p[d.len()..]);
    let trimmed = p.trim_end_matches(is_sep);
    match trimmed.rfind(is_sep) {
        Some(i) => &trimmed[i + 1..],
        None => trimmed,
    }
}

/// `path.win32.extname`: from the last `.` of the basename, unless that is its first character.
pub fn extname(p: &str) -> &str {
    let base = basename(p);
    match base.rfind('.') {
        Some(0) | None => "",
        Some(i) => &base[i..],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_and_normalize() {
        assert!(is_absolute("C:\\x"));
        assert!(is_absolute("C:/x"));
        assert!(is_absolute("\\x"));
        assert!(!is_absolute("C:x"));
        assert!(!is_absolute("rel\\dir"));
        assert_eq!(
            normalize("C:/Program Files (x86)/a.cmd"),
            "C:\\Program Files (x86)\\a.cmd"
        );
        assert_eq!(normalize("C:\\a\\.\\b\\..\\c\\"), "C:\\a\\c\\");
        assert_eq!(normalize("\\\\server\\share\\x"), "\\\\server\\share\\x");
        assert_eq!(normalize("a\\..\\..\\b"), "..\\b");
    }

    #[test]
    fn join_resolve_basename_extname() {
        assert_eq!(join(&["C:\\npm", "claude.cmd"]), "C:\\npm\\claude.cmd");
        assert_eq!(
            join(&["C:\\WINDOWS", "System32", "cmd.exe"]),
            "C:\\WINDOWS\\System32\\cmd.exe"
        );
        assert_eq!(resolve("D:\\w", "tools\\run"), "D:\\w\\tools\\run");
        assert_eq!(resolve("D:\\w", "C:\\npm\\claude"), "C:\\npm\\claude");
        assert_eq!(resolve("D:\\w", "\\x\\"), "D:\\x");
        assert_eq!(resolve("", "C:\\"), "C:\\");
        assert_eq!(basename("C:\\a\\Claude.EXE"), "Claude.EXE");
        assert_eq!(basename("C:\\a\\b\\"), "b");
        assert_eq!(extname("claude.ps1"), ".ps1");
        assert_eq!(extname("C:\\x.y\\claude"), "");
        assert_eq!(extname(".bashrc"), "");
    }
}
