//! Money kernel. Pure functions, JSON in / JSON out, integer minor units only.
//! No clocks, no I/O, no free text.

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Line {
    unit_minor: i64,
    qty: i64,
}

#[derive(Deserialize)]
struct Input {
    lines: Vec<Line>,
}

fn err(code: &str) -> String {
    format!(r#"{{"ok":false,"error":"{code}"}}"#)
}

/// Trivial spike evaluator: totals `lines` in integer minor units.
/// Never panics; failures are typed `{ok:false,error}` values.
pub fn evaluate(input: &str) -> String {
    let Ok(parsed) = serde_json::from_str::<Input>(input) else {
        return err("invalid_input");
    };
    let mut total: i64 = 0;
    for l in &parsed.lines {
        let Some(line) = l.unit_minor.checked_mul(l.qty) else {
            return err("overflow");
        };
        let Some(next) = total.checked_add(line) else {
            return err("overflow");
        };
        total = next;
    }
    format!(r#"{{"ok":true,"totalMinor":{total}}}"#)
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
    let bytes = std::slice::from_raw_parts(ptr, len);
    let out = match std::str::from_utf8(bytes) {
        Ok(s) => evaluate(s),
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
