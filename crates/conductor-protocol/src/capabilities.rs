//! Capability keys and CLI version checks (`machines/capabilities.ts`).

use std::cmp::Ordering;
use std::sync::LazyLock;

use regress::Regex;

use crate::Capability;

/// The most specific key of a capability (`capabilityKey`): `cli:gh:authed` (`cli:gh` when not
/// authed), `mcp:slack`, `skill:review` / `skill:review@github.com/org/app`, `agent:…`, `claude`.
pub fn capability_key(c: &Capability) -> String {
    match c {
        Capability::Cli { name, authed, .. } => {
            if *authed {
                format!("cli:{}:authed", name.as_str())
            } else {
                format!("cli:{}", name.as_str())
            }
        }
        Capability::Mcp { name } => format!("mcp:{}", name.as_str()),
        Capability::Skill { name, repo } => scoped("skill", name, repo.as_deref()),
        Capability::Agent { name, repo } => scoped("agent", name, repo.as_deref()),
        Capability::Claude { .. } => "claude".to_string(),
    }
}

fn scoped(kind: &str, name: &str, repo: Option<&str>) -> String {
    match repo {
        None => format!("{kind}:{name}"),
        Some(repo) => format!("{kind}:{name}@{repo}"),
    }
}

/// Every key a capability satisfies (`capabilityKeys`): an authed cli also satisfies
/// `cli:<name>`.
pub fn capability_keys(c: &Capability) -> Vec<String> {
    match c {
        Capability::Cli {
            name, authed: true, ..
        } => vec![format!("cli:{}", name.as_str()), capability_key(c)],
        _ => vec![capability_key(c)],
    }
}

static VERSION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+\S*)?$")
        .expect("valid ECMAScript regex")
});

/// ECMAScript `WhiteSpace` and `LineTerminator`, what `String.prototype.trim` removes (not
/// Rust's `char::is_whitespace`: that one has U+0085 and lacks U+FEFF).
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

struct Version {
    nums: [f64; 3],
    pre: Option<String>,
}

fn parse_version(v: &str) -> Option<Version> {
    let v = v.trim_matches(is_js_space);
    let m = VERSION_RE.find(v)?;
    // `Number(digits)`, as the TS does.
    let num = |i| m.group(i).and_then(|r| v[r].parse::<f64>().ok());
    Some(Version {
        nums: [num(1)?, num(2)?, num(3)?],
        pre: m.group(4).map(|r| v[r].to_string()),
    })
}

/// Whether `version` (`X.Y.Z`, optional `v`, `-pre` and `+build`) is at least `min`
/// (`cliVersionAtLeast`). A pre-release sorts below its release; anything unparsable → false.
pub fn cli_version_at_least(version: Option<&str>, min: &str) -> bool {
    let Some(version) = version else { return false };
    let (Some(a), Some(b)) = (parse_version(version), parse_version(min)) else {
        return false;
    };
    for i in 0..3 {
        if a.nums[i] != b.nums[i] {
            return a.nums[i] > b.nums[i];
        }
    }
    match (&a.pre, &b.pre) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(x), Some(y)) => compare_prerelease(x, y) != Ordering::Less,
    }
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum Element<'a> {
    // Declaration order is the collation order: punctuation, then numbers, then letters.
    Punct(u8),
    // Digits without leading zeros: by length, then lexically = by value.
    Number(usize, &'a str),
    Letter(u8),
}

/// `a.localeCompare(b, 'en', {numeric: true})` on the pre-release grammar `[0-9A-Za-z.-]+`
/// (the only strings VERSION_RE lets through). ICU's root collation there: `-` < `.` < digits
/// (digit runs compare by numeric value, so `rc.01` = `rc.1`) < letters, letters without case
/// first; a tie on all of that is broken by case, lower-case first.
// TD-197: exact on that grammar only; the vectors pin it against V8's ICU.
fn compare_prerelease(a: &str, b: &str) -> Ordering {
    let (ea, eb) = (elements(a), elements(b));
    ea.cmp(&eb).then_with(|| {
        // Tertiary: the first case difference, lower-case first.
        let case = |s: &str| {
            s.bytes()
                .filter(u8::is_ascii_alphabetic)
                .map(|c| c.is_ascii_uppercase())
                .collect::<Vec<_>>()
        };
        case(a).cmp(&case(b))
    })
}

fn elements(s: &str) -> Vec<Element<'_>> {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            let digits = s[start..i].trim_start_matches('0');
            out.push(Element::Number(digits.len(), digits));
            continue;
        }
        out.push(if c.is_ascii_alphabetic() {
            Element::Letter(c.to_ascii_lowercase())
        } else {
            // `-` (0x2d) sorts before `.` (0x2e) in ICU too.
            Element::Punct(c)
        });
        i += 1;
    }
    out
}
