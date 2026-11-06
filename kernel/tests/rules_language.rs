//! Generic rules-language features, tested with tiny synthetic cards so no vertical is implied.
//! Seam: `evaluate` JSON in / JSON out.

use kernel::evaluate;
use serde_json::{json, Value};

fn card(rules: Value) -> Value {
    json!({
        "id": "synthetic", "version": 1, "currency": "INR", "timezone": "Asia/Kolkata",
        "validDays": 7, "holdHours": 48, "fictional": true, "label": "FICTIONAL: synthetic test card",
        "requiredFields": [], "taxLines": [], "rules": rules
    })
}

fn run(card: Value, fields: Value) -> Value {
    let input = json!({"rateCard": card, "fields": fields, "availability": {"blockedDates": []}, "now": "2026-11-07T10:00:00Z"});
    serde_json::from_str(&evaluate(&input.to_string())).unwrap()
}

fn base(extra: Value) -> Value {
    let mut f = json!({"language": "en", "confidenceBps": 9000});
    f.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    f
}

fn per_unit_over(included: i64) -> Value {
    card(json!([
        {"ruleId": "base", "core": true, "label": "Base", "when": [], "charge": {"kind": "flat", "amount": 1000}},
        {"ruleId": "extra", "label": "Extra units", "when": [{"field": "hours", "op": "range", "min": 1, "max": 24}],
         "charge": {"kind": "per_unit", "field": "hours", "unitAmount": 300, "included": included}}
    ]))
}

fn line_amount(out: &Value, rule: &str) -> Option<i64> {
    out["lines"].as_array()?.iter().find(|l| l["ruleId"] == rule).map(|l| l["amount"].as_i64().unwrap())
}

#[test]
fn per_unit_charges_only_units_beyond_the_included_quantity() {
    let out = run(per_unit_over(4), base(json!({"hours": 7})));
    assert_eq!(out["kind"], "quote");
    assert_eq!(line_amount(&out, "extra"), Some(900)); // (7 - 4) * 300
    assert_eq!(out["total"], 1900);
}

#[test]
fn per_unit_at_or_below_the_included_quantity_adds_nothing() {
    for hours in [1, 3, 4] {
        let out = run(per_unit_over(4), base(json!({"hours": hours})));
        assert_eq!(line_amount(&out, "extra"), Some(0), "hours {hours}");
        assert_eq!(out["total"], 1000);
    }
}

#[test]
fn per_unit_without_included_behaves_as_before() {
    let c = card(json!([
        {"ruleId": "base", "core": true, "label": "Base", "when": [], "charge": {"kind": "flat", "amount": 1000}},
        {"ruleId": "each", "label": "Each", "when": [], "charge": {"kind": "per_unit", "field": "hours", "unitAmount": 300}}
    ]));
    let out = run(c, base(json!({"hours": 7})));
    assert_eq!(line_amount(&out, "each"), Some(2100));
}

#[test]
fn per_unit_overflow_is_a_typed_error_not_a_panic() {
    let c = card(json!([
        {"ruleId": "base", "core": true, "label": "Base", "when": [], "charge": {"kind": "flat", "amount": 1}},
        {"ruleId": "each", "label": "Each", "when": [], "charge": {"kind": "per_unit", "field": "hours", "unitAmount": i64::MAX, "included": 0}}
    ]));
    let out = run(c, base(json!({"hours": 2})));
    assert_eq!(out["ok"], false);
    assert_eq!(out["error"], "overflow");
}
