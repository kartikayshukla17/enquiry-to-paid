use kernel::evaluate;

#[test]
fn sums_lines_in_integer_minor_units() {
    let out = evaluate(r#"{"lines":[{"unitMinor":150000,"qty":3},{"unitMinor":2500,"qty":2}]}"#);
    assert_eq!(out, r#"{"ok":true,"totalMinor":455000}"#);
}

#[test]
fn malformed_input_returns_typed_error_not_panic() {
    let out = evaluate("not json");
    assert_eq!(out, r#"{"ok":false,"error":"invalid_input"}"#);
}

#[test]
fn overflow_returns_typed_error() {
    let out = evaluate(r#"{"lines":[{"unitMinor":9223372036854775807,"qty":2}]}"#);
    assert_eq!(out, r#"{"ok":false,"error":"overflow"}"#);
}
