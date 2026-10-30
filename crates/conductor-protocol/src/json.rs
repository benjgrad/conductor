//! `jsonByteLength` (`protocol/ws.ts`): the UTF-8 length of `JSON.stringify(v)`.

use serde_json::Value;

/// UTF-8 byte length of a value's JSON, as JavaScript writes it: no whitespace, numbers in
/// `Number.prototype.toString` form (`1.0` → `1`, `1e21` → `1e+21`), and the same string
/// escapes as serde_json (`"`, `\`, and control characters only). Key order doesn't change the
/// length.
pub fn json_byte_length(v: &Value) -> usize {
    match v {
        Value::Null => 4,
        Value::Bool(true) => 4,
        Value::Bool(false) => 5,
        Value::Number(n) => {
            // Every JS number is an f64; integers past 2^53 round the same way.
            let f = n.as_f64().unwrap_or(f64::NAN);
            ryu_js::Buffer::new().format(f).len()
        }
        Value::String(s) => string_len(s),
        Value::Array(items) => {
            2 + items.iter().map(json_byte_length).sum::<usize>() + items.len().saturating_sub(1)
        }
        Value::Object(map) => {
            2 + map
                .iter()
                .map(|(k, v)| string_len(k) + 1 + json_byte_length(v))
                .sum::<usize>()
                + map.len().saturating_sub(1)
        }
    }
}

fn string_len(s: &str) -> usize {
    serde_json::to_string(s).map_or(0, |j| j.len())
}
