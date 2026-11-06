//! The fictional B2B supplier card through the generic kernel (T12). Seam: `evaluate` JSON in / JSON out.
//!
//! Documented card semantics under test:
//! - volume tiers are all-units pricing: the band the ordered quantity falls in sets the unit price for the whole order;
//!   a band's `upTo` is INCLUSIVE (500 units is in the 500-1999 band; 499 is in the one below);
//! - MOQ is per product: one product refuses below its minimum, the other re-quotes at the minimum and says so;
//! - GST is a tax line: round_half_up(subtotal * bps / 10_000).

use kernel::evaluate;
use serde_json::{json, Value};

const CARD: &str = include_str!("../../rate-cards/fictional-b2b-supplier.json");

fn run(fields: Value) -> Value {
    let card: Value = serde_json::from_str(CARD).unwrap();
    let input = json!({"rateCard": card, "fields": fields, "availability": {"blockedDates": []}, "now": "2026-11-07T10:00:00Z"});
    serde_json::from_str(&evaluate(&input.to_string())).unwrap()
}

fn order(product: &str, quantity: i64) -> Value {
    json!({"service": product, "quantity": quantity, "language": "en", "confidenceBps": 9000})
}

fn lines(out: &Value) -> Vec<(String, i64)> {
    out["lines"].as_array().unwrap().iter().map(|l| (l["ruleId"].as_str().unwrap().to_string(), l["amount"].as_i64().unwrap())).collect()
}

fn s(id: &str, amount: i64) -> (String, i64) {
    (id.to_string(), amount)
}

#[test]
fn card_is_labelled_fictional() {
    let card: Value = serde_json::from_str(CARD).unwrap();
    assert_eq!(card["fictional"], true);
    assert!(card["label"].as_str().unwrap().starts_with("FICTIONAL:"));
}

#[test]
fn a_small_order_pays_unit_price_handling_and_gst_as_separate_lines() {
    let out = run(order("steel-bolts", 100));
    assert_eq!(out["kind"], "quote");
    assert_eq!(lines(&out), vec![s("bolts-unit-price", 120_000), s("small-order-handling", 50_000), s("gst-18", 30_600)]);
    assert_eq!(out["total"], 200_600);
}

#[test]
fn tier_boundaries_are_inclusive_and_the_next_unit_moves_to_the_next_price() {
    let unit_line = |q: i64| lines(&run(order("steel-bolts", q))).remove(0).1;
    assert_eq!(unit_line(499), 499 * 1200);
    assert_eq!(unit_line(500), 500 * 1050);
    assert_eq!(unit_line(1999), 1999 * 1050);
    assert_eq!(unit_line(2000), 2000 * 900);
    assert_eq!(unit_line(50_000), 50_000 * 900);
}

#[test]
fn handling_applies_up_to_999_units_and_not_from_1000() {
    let has_handling = |q: i64| lines(&run(order("steel-bolts", q))).iter().any(|(id, _)| id == "small-order-handling");
    assert!(has_handling(999));
    assert!(!has_handling(1000));
}

#[test]
fn an_order_just_over_a_tier_boundary_can_cost_less_in_total_than_one_just_under_it() {
    // All-units pricing, documented: 500 units (1,050 each) is cheaper than 499 units (1,200 each).
    let total = |q: i64| run(order("steel-bolts", q))["total"].as_i64().unwrap();
    assert_eq!(total(499), 648_800 + 116_784);
    assert_eq!(total(500), 575_000 + 103_500);
    assert!(total(500) < total(499));
}

#[test]
fn gst_is_rounded_half_up_in_integer_paise() {
    // 1999 ties: 1999 * 180 = 359_820; 18% = 64_767.6 -> 64_768
    let out = run(order("nylon-ties", 1999));
    assert_eq!(lines(&out), vec![s("ties-unit-price", 359_820), s("gst-18", 64_768)]);
    assert_eq!(out["total"], 424_588);
}

#[test]
fn below_a_refuse_moq_the_order_is_refused_with_the_field_named_and_no_number() {
    let out = run(order("steel-bolts", 99));
    assert_eq!(out["kind"], "refusal");
    assert_eq!(out["reason"], "out_of_policy");
    assert_eq!(out["ruleGap"], "below_minimum:quantity");
    assert!(out.get("total").is_none());
}

#[test]
fn at_the_moq_exactly_the_order_quotes() {
    assert_eq!(run(order("steel-bolts", 100))["kind"], "quote");
}

#[test]
fn below_a_raise_moq_the_quote_is_at_the_minimum_with_an_adjustment_the_customer_is_told() {
    let out = run(order("nylon-ties", 100));
    assert_eq!(out["kind"], "quote");
    assert_eq!(lines(&out), vec![s("ties-unit-price", 90_000), s("small-order-handling", 50_000), s("gst-18", 25_200)]);
    assert_eq!(
        out["adjustments"],
        json!([{"ruleId": "moq-ties", "label": "Minimum order quantity (nylon-ties: 500)", "field": "quantity", "from": 100, "to": 500}])
    );
}

#[test]
fn the_other_products_band_table_is_its_own() {
    let unit = |q: i64| lines(&run(order("nylon-ties", q))).remove(0).1 / q;
    assert_eq!(unit(1999), 180);
    assert_eq!(unit(2000), 150);
    assert_eq!(unit(9999), 150);
    assert_eq!(unit(10_000), 120);
}

#[test]
fn volume_beyond_the_card_and_unknown_products_are_not_covered() {
    assert_eq!(run(order("steel-bolts", 50_001))["reason"], "no_covering_rule");
    assert_eq!(run(order("nylon-ties", 200_001))["reason"], "no_covering_rule");
    assert_eq!(run(order("hydraulic-pumps", 1000))["reason"], "no_covering_rule");
}

#[test]
fn a_missing_quantity_asks_for_it() {
    let out = run(json!({"service": "steel-bolts", "language": "en", "confidenceBps": 9000}));
    assert_eq!(out["reason"], "missing_required_field");
    assert_eq!(out["ruleGap"], "quantity");
}

#[test]
fn total_is_the_sum_of_the_lines() {
    for (p, q) in [("steel-bolts", 100), ("steel-bolts", 750), ("steel-bolts", 12_345), ("nylon-ties", 1), ("nylon-ties", 77_777)] {
        let out = run(order(p, q));
        assert_eq!(out["kind"], "quote", "{p} {q}");
        let sum: i64 = lines(&out).iter().map(|(_, a)| a).sum();
        assert_eq!(sum, out["total"].as_i64().unwrap(), "{p} {q}");
    }
}
