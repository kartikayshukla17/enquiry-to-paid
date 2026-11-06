//! Money kernel. Pure functions, JSON in / JSON out, integer minor units only.
//! No clocks, no I/O, no free text, no floats.

mod card;
mod chain;
mod date;
mod eval;

use sha2::{Digest, Sha256};

fn err(code: &str) -> String {
    format!(r#"{{"ok":false,"error":"{code}"}}"#)
}

/// SHA-256 (lowercase hex) of the canonical card JSON: keys sorted, compact.
/// `serde_json::Value` objects are BTreeMaps here, so serialisation is canonical.
pub fn rate_card_hash(card_json: &str) -> Result<String, String> {
    let v: serde_json::Value = serde_json::from_str(card_json).map_err(|_| err("invalid_input"))?;
    let canonical = serde_json::to_string(&v).map_err(|_| err("invalid_input"))?;
    let digest = Sha256::digest(canonical.as_bytes());
    Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
}

/// Hash for one ledger entry (content fields incl. prevHash), or a typed error.
pub fn chain_hash(entry_json: &str) -> String {
    serde_json::from_str::<serde_json::Value>(entry_json)
        .ok()
        .and_then(|v| chain::chain_hash(&v))
        .unwrap_or_else(|| err("invalid_input"))
}

/// One tenant's ordered entries in, `{ok:true,count}` or `{ok:false,brokenSeq,reason}` out.
pub fn verify_chain(entries_json: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(entries_json) {
        Ok(v) => chain::verify_chain(&v).to_string(),
        Err(_) => err("invalid_input"),
    }
}

/// `{rateCard, fields, availability, now}` -> `{kind:"quote"|"refusal",...}`.
/// Never panics; failures are typed `{ok:false,error}` values.
pub fn evaluate(input: &str) -> String {
    let Ok(raw) = serde_json::from_str::<serde_json::Value>(input) else {
        return err("invalid_input");
    };
    let Some(card_value) = raw.get("rateCard") else {
        return err("invalid_input");
    };
    let Ok(hash) = rate_card_hash(&card_value.to_string()) else {
        return err("invalid_input");
    };
    let Ok(parsed) = serde_json::from_value::<eval::Input>(raw) else {
        return err("invalid_input");
    };
    match eval::evaluate(parsed, hash) {
        Ok(outcome) => serde_json::to_string(&outcome).unwrap_or_else(|_| err("invalid_input")),
        Err(eval::KernelError::Overflow) => err("overflow"),
        Err(eval::KernelError::Invalid) => err("invalid_input"),
    }
}

// ---- WASM ABI: (ptr,len) UTF-8 JSON protocol -------------------------------
// Host calls `alloc(len)`, writes the input, calls `evaluate_json(ptr,len)`,
// which returns a pointer to a result buffer; the length is read via
// `result_len()`. Host frees both buffers with `dealloc(ptr,len)`.

use std::cell::Cell;

thread_local! { static RESULT_LEN: Cell<usize> = const { Cell::new(0) }; }

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr`/`len` must come from `alloc(len)` (or a result buffer of that length).
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// # Safety
/// `ptr..ptr+len` must be a valid buffer previously obtained from `alloc`.
#[no_mangle]
pub unsafe extern "C" fn evaluate_json(ptr: *const u8, len: usize) -> *mut u8 {
    export(ptr, len, evaluate)
}

/// # Safety
/// Same contract as `evaluate_json`. Returns the hash hex, or a typed error JSON.
#[no_mangle]
pub unsafe extern "C" fn rate_card_hash_json(ptr: *const u8, len: usize) -> *mut u8 {
    export(ptr, len, |s| rate_card_hash(s).unwrap_or_else(|e| e))
}

/// # Safety
/// Same contract as `evaluate_json`.
#[no_mangle]
pub unsafe extern "C" fn chain_hash_json(ptr: *const u8, len: usize) -> *mut u8 {
    export(ptr, len, chain_hash)
}

/// # Safety
/// Same contract as `evaluate_json`.
#[no_mangle]
pub unsafe extern "C" fn verify_chain_json(ptr: *const u8, len: usize) -> *mut u8 {
    export(ptr, len, verify_chain)
}

unsafe fn export(ptr: *const u8, len: usize, f: impl Fn(&str) -> String) -> *mut u8 {
    let bytes = std::slice::from_raw_parts(ptr, len);
    let out = match std::str::from_utf8(bytes) {
        Ok(s) => f(s),
        Err(_) => err("invalid_input"),
    };
    let mut boxed = out.into_bytes();
    boxed.shrink_to_fit();
    RESULT_LEN.with(|c| c.set(boxed.len()));
    let p = boxed.as_mut_ptr();
    std::mem::forget(boxed);
    p
}

#[no_mangle]
pub extern "C" fn result_len() -> usize {
    RESULT_LEN.with(|c| c.get())
}
