//! Port of `packages/daemon/src/inventory/version.ts` (MR-T05): the version token of a CLI's
//! `--version` output (M2-T10). Only the matched `X.Y.Z[-pre]` is ever returned, never the rest of
//! the output, so no account or host text can leak into a report.
//!
//! A hand-written scan for the TS regex `/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/` (first match, the
//! same leftmost-greedy result).

fn digits(b: &[u8], i: usize) -> usize {
    b[i..].iter().take_while(|c| c.is_ascii_digit()).count()
}

/// The `X.Y.Z` (+ optional `-pre`) match starting at `i`, as its end index.
fn match_at(b: &[u8], i: usize) -> Option<usize> {
    let mut j = i;
    for part in 0..3 {
        let n = digits(b, j);
        if n == 0 {
            return None;
        }
        j += n;
        if part < 2 {
            if b.get(j) != Some(&b'.') {
                return None;
            }
            j += 1;
        }
    }
    if b.get(j) == Some(&b'-') {
        let pre = b[j + 1..]
            .iter()
            .take_while(|c| c.is_ascii_alphanumeric() || **c == b'.' || **c == b'-')
            .count();
        if pre > 0 {
            j += 1 + pre;
        }
    }
    Some(j)
}

pub fn cli_version_from(output: &str) -> Option<String> {
    let b = output.as_bytes();
    (0..b.len()).find_map(|i| match_at(b, i).map(|end| output[i..end].to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_the_version_token() {
        for (out, v) in [
            (
                "gh version 2.40.0 (2023-12-07)\nhttps://github.com/cli/cli/releases/tag/v2.40.0\n",
                "2.40.0",
            ),
            (
                "azure-cli                         2.60.0 *\n\ncore 2.60.0\n",
                "2.60.0",
            ),
            ("git version 2.45.0\n", "2.45.0"),
            (
                "(Version=\"1.5.1\", GitCommit=\"\", GoVersion=\"go1.22\")",
                "1.5.1",
            ),
            ("2.1.308 (Claude Code)", "2.1.308"),
            ("tool 3.0.0-rc.1", "3.0.0-rc.1"),
        ] {
            assert_eq!(cli_version_from(out).as_deref(), Some(v), "{out:?}");
        }
    }

    #[test]
    fn garbage_is_none() {
        for out in ["", "gh version unknown", "v2.40", "nothing here"] {
            assert_eq!(cli_version_from(out), None, "{out:?}");
        }
    }

    #[test]
    fn a_bare_dash_is_not_part_of_the_token() {
        assert_eq!(cli_version_from("1.2.3- x").as_deref(), Some("1.2.3"));
        assert_eq!(cli_version_from("a12.3.4.5").as_deref(), Some("12.3.4"));
    }
}
