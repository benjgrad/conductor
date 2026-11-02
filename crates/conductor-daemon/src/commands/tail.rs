//! Port of `packages/daemon/src/commands/tail.ts` (MR-T05): a bounded byte buffer keeping the last
//! `limit` bytes of combined stdout+stderr (`cmd_exit.output_tail`).

use std::collections::VecDeque;

#[derive(Debug, Clone)]
pub struct TailBuffer {
    limit: usize,
    buf: VecDeque<u8>,
}

impl TailBuffer {
    pub fn new(limit: usize) -> Self {
        TailBuffer {
            limit,
            buf: VecDeque::new(),
        }
    }

    pub fn limit(&self) -> usize {
        self.limit
    }

    pub fn push(&mut self, chunk: &[u8]) {
        if self.limit == 0 || chunk.is_empty() {
            return;
        }
        if chunk.len() >= self.limit {
            self.buf.clear();
            self.buf.extend(&chunk[chunk.len() - self.limit..]);
            return;
        }
        self.buf.extend(chunk);
        let over = self.buf.len().saturating_sub(self.limit);
        self.buf.drain(..over);
    }
}

/// UTF-8 text of the tail (`to_string()`); a multi-byte character cut at the front is dropped,
/// not mangled. Any other invalid UTF-8 becomes U+FFFD, as `Buffer.toString('utf8')` does.
impl std::fmt::Display for TailBuffer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let bytes: Vec<u8> = self.buf.iter().copied().collect();
        // Skip UTF-8 continuation bytes (10xxxxxx) left over from a character cut by the trim.
        let start = bytes
            .iter()
            .take(3)
            .take_while(|&&b| b & 0xc0 == 0x80)
            .count();
        f.write_str(&String::from_utf8_lossy(&bytes[start..]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_a_multi_byte_character_cut_at_the_front() {
        let mut t = TailBuffer::new(4);
        t.push("aé€".as_bytes()); // 1 + 2 + 3 bytes; the last 4 = é's 2nd byte + €
        assert_eq!(t.to_string(), "€");
    }

    #[test]
    fn keeps_everything_under_the_limit_across_chunks() {
        let mut t = TailBuffer::new(5);
        t.push(b"ab");
        t.push(b"cd");
        t.push(b"efg");
        assert_eq!(t.to_string(), "cdefg");
    }

    #[test]
    fn a_zero_limit_keeps_nothing() {
        let mut t = TailBuffer::new(0);
        t.push(b"abc");
        assert_eq!(t.to_string(), "");
    }
}
