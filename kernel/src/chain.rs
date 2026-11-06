//! Tamper-evident ledger hash chain. Pure: entries in, hashes / first broken row out.
//!
//! hash = sha256(canonical JSON of the entry's content fields, including `prevHash`).
//! Canonical = keys sorted (serde_json::Value objects are BTreeMaps), compact.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// Fields that are hashed. `hash` itself and the global DB `seq` are not part of the content.
const CONTENT_FIELDS: [&str; 13] = [
    "tenantId", "tenantSeq", "threadId", "at", "type", "payload", "rateCardHash", "modelId",
    "provider", "region", "costMinor", "corrects", "prevHash",
];

fn sha_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Missing fields hash as null, so `undefined` and `null` agree across the TS/Rust boundary.
pub fn chain_hash(entry: &Value) -> Option<String> {
    let obj = entry.as_object()?;
    let mut content = serde_json::Map::new();
    for f in CONTENT_FIELDS {
        content.insert(f.to_string(), obj.get(f).cloned().unwrap_or(Value::Null));
    }
    Some(sha_hex(&serde_json::to_string(&Value::Object(content)).ok()?))
}

fn broken(seq: &Value, reason: &str) -> Value {
    json!({"ok": false, "brokenSeq": seq, "reason": reason})
}

/// Entries of ONE tenant in order. Each has the content fields plus the stored `hash`.
/// Returns `{ok:true,count}` or `{ok:false,brokenSeq,reason}` for the first broken row.
pub fn verify_chain(entries: &Value) -> Value {
    let Some(list) = entries.as_array() else {
        return json!({"ok": false, "error": "invalid_input"});
    };
    let mut expected_seq: i64 = 1;
    let mut prev = GENESIS_HASH.to_string();
    for e in list {
        let seq = e.get("tenantSeq").cloned().unwrap_or(Value::Null);
        if seq.as_i64() != Some(expected_seq) {
            return broken(&seq, "seq_gap");
        }
        if e.get("prevHash").and_then(Value::as_str) != Some(prev.as_str()) {
            return broken(&seq, "prev_hash_mismatch");
        }
        let stored = e.get("hash").and_then(Value::as_str);
        if chain_hash(e).as_deref() != stored {
            return broken(&seq, "hash_mismatch");
        }
        prev = stored.unwrap_or_default().to_string();
        expected_seq += 1;
    }
    json!({"ok": true, "count": list.len()})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(n: usize) -> Vec<Value> {
        let mut prev = GENESIS_HASH.to_string();
        (1..=n)
            .map(|i| {
                let mut e = json!({"tenantId":"t","tenantSeq":i,"threadId":"th","at":"2026-01-01T00:00:00.000Z",
                    "type":"quote","payload":{"b":2,"a":[1,2]},"prevHash":prev});
                let h = chain_hash(&e).unwrap();
                e["hash"] = json!(h);
                prev = h;
                e
            })
            .collect()
    }

    #[test]
    fn valid_chain_verifies() {
        assert_eq!(verify_chain(&Value::Array(build(4))), json!({"ok":true,"count":4}));
    }

    #[test]
    fn key_order_does_not_change_hash() {
        let a = json!({"tenantId":"t","payload":{"x":1,"y":2},"prevHash":"p"});
        let b = json!({"prevHash":"p","payload":{"y":2,"x":1},"tenantId":"t"});
        assert_eq!(chain_hash(&a), chain_hash(&b));
    }

    #[test]
    fn edited_payload_reports_that_row() {
        let mut v = build(4);
        v[2]["payload"] = json!({"b":3});
        assert_eq!(verify_chain(&Value::Array(v)), json!({"ok":false,"brokenSeq":3,"reason":"hash_mismatch"}));
    }

    #[test]
    fn rehashed_edit_breaks_the_next_row() {
        let mut v = build(4);
        v[1]["payload"] = json!({"b":3});
        v[1]["hash"] = json!(chain_hash(&v[1]).unwrap());
        assert_eq!(verify_chain(&Value::Array(v)), json!({"ok":false,"brokenSeq":3,"reason":"prev_hash_mismatch"}));
    }

    #[test]
    fn deleted_row_is_a_seq_gap() {
        let mut v = build(4);
        v.remove(1);
        assert_eq!(verify_chain(&Value::Array(v)), json!({"ok":false,"brokenSeq":3,"reason":"seq_gap"}));
    }
}
