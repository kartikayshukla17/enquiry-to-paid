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

// ---- tiered_per_unit: the band picks the unit price for the WHOLE quantity (all-units pricing) ----

fn volume_card() -> Value {
    card(json!([
        {"ruleId": "units", "core": true, "label": "Units", "when": [{"field": "quantity", "op": "range", "min": 1, "max": 10000}],
         "charge": {"kind": "tiered_per_unit", "field": "quantity", "tiers": [
             {"upTo": 99, "amount": 100}, {"upTo": 999, "amount": 80}, {"upTo": 10000, "amount": 60}]}}
    ]))
}

#[test]
fn tiered_per_unit_prices_the_whole_quantity_at_the_band_unit_price() {
    let out = run(volume_card(), base(json!({"quantity": 150})));
    assert_eq!(line_amount(&out, "units"), Some(150 * 80));
    assert_eq!(out["total"], 12_000);
}

#[test]
fn tier_upper_bounds_are_inclusive_and_the_next_quantity_moves_to_the_next_band() {
    let unit = |q: i64| line_amount(&run(volume_card(), base(json!({"quantity": q}))), "units").unwrap() / q;
    assert_eq!(unit(99), 100);
    assert_eq!(unit(100), 80);
    assert_eq!(unit(999), 80);
    assert_eq!(unit(1000), 60);
    assert_eq!(unit(10000), 60);
}

#[test]
fn tiered_per_unit_overflow_is_a_typed_error() {
    let c = card(json!([
        {"ruleId": "units", "core": true, "label": "Units", "when": [],
         "charge": {"kind": "tiered_per_unit", "field": "quantity", "tiers": [{"upTo": null, "amount": i64::MAX}]}}
    ]));
    let out = run(c, base(json!({"quantity": 2})));
    assert_eq!(out["error"], "overflow");
}

// ---- minimums: a floor on a typed field, refused or raised per the card's own flag ----

fn moq_card(below: &str) -> Value {
    let mut c = volume_card();
    c["minimums"] = json!([
        {"ruleId": "moq", "label": "Minimum order quantity", "field": "quantity", "min": 50, "below": below}
    ]);
    c
}

#[test]
fn below_a_refuse_minimum_is_an_out_of_policy_refusal_naming_the_field_not_the_value() {
    let out = run(moq_card("refuse"), base(json!({"quantity": 49})));
    assert_eq!(out["kind"], "refusal");
    assert_eq!(out["reason"], "out_of_policy");
    assert_eq!(out["ruleGap"], "below_minimum:quantity");
}

#[test]
fn at_the_minimum_exactly_quotes_normally_with_no_adjustment() {
    for below in ["refuse", "raise_to_min"] {
        let out = run(moq_card(below), base(json!({"quantity": 50})));
        assert_eq!(out["kind"], "quote", "{below}");
        assert!(out.get("adjustments").is_none(), "{below}");
        assert_eq!(line_amount(&out, "units"), Some(50 * 100));
    }
}

#[test]
fn below_a_raise_minimum_the_quote_is_for_the_minimum_and_says_so() {
    let out = run(moq_card("raise_to_min"), base(json!({"quantity": 10})));
    assert_eq!(out["kind"], "quote");
    assert_eq!(line_amount(&out, "units"), Some(50 * 100)); // priced at 50, not 10
    assert_eq!(
        out["adjustments"],
        json!([{"ruleId": "moq", "label": "Minimum order quantity", "field": "quantity", "from": 10, "to": 50}])
    );
}

#[test]
fn a_minimum_with_conditions_only_applies_when_they_hold() {
    let mut c = volume_card();
    c["minimums"] = json!([
        {"ruleId": "moq-a", "label": "Minimum", "field": "quantity", "min": 50, "below": "refuse",
         "when": [{"field": "service", "op": "eq", "value": "alpha"}]}
    ]);
    let alpha = run(c.clone(), base(json!({"service": "alpha", "quantity": 10})));
    assert_eq!(alpha["reason"], "out_of_policy");
    let beta = run(c, base(json!({"service": "beta", "quantity": 10})));
    assert_eq!(beta["kind"], "quote");
}

#[test]
fn a_minimum_on_a_field_the_customer_did_not_give_is_skipped_not_invented() {
    let out = run(moq_card("raise_to_min"), base(json!({})));
    // No quantity: the covering rule's own condition fails, so the kernel refuses; it never makes one up.
    assert_eq!(out["kind"], "refusal");
    assert_eq!(out["reason"], "no_covering_rule");
}
