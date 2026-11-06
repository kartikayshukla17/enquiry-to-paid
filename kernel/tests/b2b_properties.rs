//! Property tests for tax lines, volume-tier boundaries and minimums (T12). Seam: `evaluate` JSON in / JSON out.
//!
//! Documented rules checked here (independently re-derived, never by calling kernel internals):
//! - a tier's `upTo` is inclusive: quantity == upTo is in that band, upTo + 1 is in the next;
//! - tax line = round_half_up(subtotal * rateBps / 10_000), integer only;
//! - total = sum of every line, tax lines included;
//! - nothing panics at the i64 extremes: the answer is a quote, a refusal, or a typed `{ok:false,error}`.

use kernel::evaluate;
use proptest::prelude::*;
use serde_json::{json, Value};

const B2B: &str = include_str!("../../rate-cards/fictional-b2b-supplier.json");

fn run(card: Value, fields: Value) -> Value {
    let input = json!({"rateCard": card, "fields": fields, "availability": {"blockedDates": []}, "now": "2026-11-07T10:00:00Z"});
    serde_json::from_str(&evaluate(&input.to_string())).unwrap()
}

fn card(rules: Value, tax_bps: &[i64]) -> Value {
    let tax: Vec<Value> = tax_bps
        .iter()
        .enumerate()
        .map(|(i, b)| json!({"ruleId": format!("tax-{i}"), "label": format!("Tax {i}"), "rateBps": b}))
        .collect();
    json!({
        "id": "prop", "version": 1, "currency": "INR", "timezone": "Asia/Kolkata", "validDays": 7, "holdHours": 48,
        "fictional": true, "label": "FICTIONAL: property-test card",
        "requiredFields": [], "taxLines": tax, "rules": rules
    })
}

fn qty(q: i64) -> Value {
    json!({"quantity": q, "language": "en", "confidenceBps": 9000})
}

fn line(out: &Value, rule: &str) -> i64 {
    out["lines"].as_array().unwrap().iter().find(|l| l["ruleId"] == rule).unwrap()["amount"].as_i64().unwrap()
}

/// Strictly increasing band bounds b1 < b2 < b3 and non-increasing unit prices p1 >= p2 >= p3 >= p4.
fn bands() -> impl Strategy<Value = ([i64; 3], [i64; 4])> {
    (1i64..1_000, 1i64..1_000, 1i64..1_000, 0i64..100, 0i64..100, 0i64..100, 1i64..10_000).prop_map(|(a, b, c, d1, d2, d3, p4)| {
        let b1 = a;
        let b2 = b1 + b;
        let b3 = b2 + c;
        let p3 = p4 + d3;
        let p2 = p3 + d2;
        let p1 = p2 + d1;
        ([b1, b2, b3], [p1, p2, p3, p4])
    })
}

fn tier_card(bounds: [i64; 3], prices: [i64; 4], tax_bps: &[i64]) -> Value {
    card(
        json!([{"ruleId": "units", "core": true, "label": "Units", "when": [],
            "charge": {"kind": "tiered_per_unit", "field": "quantity", "tiers": [
                {"upTo": bounds[0], "amount": prices[0]},
                {"upTo": bounds[1], "amount": prices[1]},
                {"upTo": bounds[2], "amount": prices[2]},
                {"upTo": null, "amount": prices[3]}]}}]),
        tax_bps,
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1500))]

    /// Boundary exactness: upTo itself prices at the band's unit price, upTo + 1 at the next band's.
    #[test]
    fn tier_boundaries_are_exact_and_inclusive((bounds, prices) in bands()) {
        let c = tier_card(bounds, prices, &[]);
        for (i, b) in bounds.iter().enumerate() {
            let at = run(c.clone(), qty(*b));
            prop_assert_eq!(line(&at, "units"), prices[i] * b);
            let over = run(c.clone(), qty(b + 1));
            prop_assert_eq!(line(&over, "units"), prices[i + 1] * (b + 1));
        }
        // and the first unit is in the first band
        prop_assert_eq!(line(&run(c, qty(1)), "units"), prices[0]);
    }

    /// Monotonicity: with non-increasing band prices, the effective unit price never rises as the quantity grows.
    #[test]
    fn unit_price_never_rises_with_quantity((bounds, prices) in bands(), q1 in 1i64..4_000, extra in 0i64..4_000) {
        let c = tier_card(bounds, prices, &[]);
        let q2 = q1 + extra;
        let unit = |q: i64| line(&run(c.clone(), qty(q)), "units") / q;
        prop_assert!(unit(q1) >= unit(q2), "q1={} q2={}", q1, q2);
        // every effective unit price is one of the card's band prices
        prop_assert!(prices.contains(&unit(q1)));
    }

    /// Tax = round_half_up(subtotal * bps / 10_000), checked two independent ways.
    #[test]
    fn tax_is_the_documented_integer_rounding_of_the_subtotal(subtotal in 0i64..4_000_000_000_000, bps in 0i64..10_000) {
        let c = card(json!([{"ruleId": "base", "core": true, "label": "Base", "when": [], "charge": {"kind": "flat", "amount": subtotal}}]), &[bps]);
        let out = run(c, qty(1));
        prop_assert_eq!(out["kind"].as_str(), Some("quote"));
        let tax = line(&out, "tax-0");
        let (s, b) = (subtotal as i128, bps as i128);
        prop_assert_eq!(tax as i128, (s * b + 5_000).div_euclid(10_000));
        prop_assert_eq!(tax as i128, (2 * s * b + 10_000).div_euclid(20_000));
        // never off from the exact rational by more than half a paisa
        let exact_twice = 2 * s * b; // = 2 * tax_exact * 10_000
        prop_assert!((2 * tax as i128 * 10_000 - exact_twice).abs() <= 10_000);
    }

    /// Total is exactly the sum of all lines (unit lines, flat lines and every tax line).
    #[test]
    fn total_is_the_sum_of_all_lines(
        (bounds, prices) in bands(),
        q in 1i64..5_000,
        flat in 0i64..1_000_000,
        taxes in prop::collection::vec(0i64..5_000, 0..4),
    ) {
        let mut c = tier_card(bounds, prices, &taxes);
        c["rules"].as_array_mut().unwrap().push(json!({"ruleId": "fee", "label": "Fee", "when": [], "charge": {"kind": "flat", "amount": flat}}));
        let out = run(c, qty(q));
        prop_assert_eq!(out["kind"].as_str(), Some("quote"));
        let sum: i64 = out["lines"].as_array().unwrap().iter().map(|l| l["amount"].as_i64().unwrap()).sum();
        prop_assert_eq!(sum, out["total"].as_i64().unwrap());
        // tax lines are computed on the pre-tax subtotal only, not on each other
        let subtotal = line(&out, "units") + flat;
        for (i, bps) in taxes.iter().enumerate() {
            prop_assert_eq!(line(&out, &format!("tax-{i}")) as i128, (2 * subtotal as i128 * *bps as i128 + 10_000).div_euclid(20_000));
        }
    }

    /// No panic at the extremes: any i64 quantity against any amounts yields a quote, a refusal or a typed error.
    #[test]
    fn extreme_values_never_panic_and_are_never_untyped(
        q in prop_oneof![Just(i64::MAX), Just(i64::MIN), Just(0i64), any::<i64>()],
        unit in prop_oneof![Just(i64::MAX), any::<i64>()],
        flat in prop_oneof![Just(i64::MAX), any::<i64>()],
        bps in prop_oneof![Just(i64::MAX), any::<i64>(), 0i64..10_000],
    ) {
        let c = card(json!([
            {"ruleId": "u", "core": true, "label": "U", "when": [], "charge": {"kind": "tiered_per_unit", "field": "quantity", "tiers": [{"upTo": null, "amount": unit}]}},
            {"ruleId": "p", "label": "P", "when": [], "charge": {"kind": "per_unit", "field": "quantity", "unitAmount": unit, "included": 3}},
            {"ruleId": "f", "label": "F", "when": [], "charge": {"kind": "flat", "amount": flat}}
        ]), &[bps]);
        let out = run(c, qty(q));
        let ok = matches!(out["kind"].as_str(), Some("quote") | Some("refusal"));
        let typed = out["ok"] == json!(false) && matches!(out["error"].as_str(), Some("overflow") | Some("invalid_input"));
        prop_assert!(ok || typed, "{out}");
    }

    /// The real B2B card: any quantity, including absurd ones, gives a typed answer; quotes obey the line-sum rule.
    #[test]
    fn the_b2b_card_is_total_over_every_quantity(
        product in prop_oneof![Just("steel-bolts"), Just("nylon-ties"), Just("unknown-thing")],
        q in prop_oneof![Just(i64::MAX), Just(i64::MIN), Just(0i64), any::<i64>(), 1i64..300_000],
    ) {
        let card: Value = serde_json::from_str(B2B).unwrap();
        let out = run(card, json!({"service": product, "quantity": q, "language": "en", "confidenceBps": 9000}));
        match out["kind"].as_str() {
            Some("quote") => {
                let sum: i64 = out["lines"].as_array().unwrap().iter().map(|l| l["amount"].as_i64().unwrap()).sum();
                prop_assert_eq!(sum, out["total"].as_i64().unwrap());
                prop_assert!(out["lines"].as_array().unwrap().iter().any(|l| l["ruleId"] == "bolts-unit-price" || l["ruleId"] == "ties-unit-price"));
            }
            Some("refusal") => prop_assert!(out.get("total").is_none()),
            _ => prop_assert!(out["ok"] == json!(false), "{out}"),
        }
    }

    /// A raise-to-minimum floor prices exactly the minimum, whatever smaller quantity was asked for.
    #[test]
    fn raising_to_the_minimum_prices_exactly_the_minimum((min, below) in (2i64..2_000).prop_flat_map(|m| (Just(m), 1..m))) {
        let mut c = card(json!([{"ruleId": "units", "core": true, "label": "Units", "when": [],
            "charge": {"kind": "tiered_per_unit", "field": "quantity", "tiers": [{"upTo": 999, "amount": 7}, {"upTo": null, "amount": 5}]}}]), &[1800]);
        c["minimums"] = json!([{"ruleId": "moq", "label": "MOQ", "field": "quantity", "min": min, "below": "raise_to_min"}]);
        let out = run(c, qty(below));
        let unit = if min <= 999 { 7 } else { 5 };
        prop_assert_eq!(line(&out, "units"), unit * min);
        prop_assert_eq!(&out["adjustments"][0]["from"], &json!(below));
        prop_assert_eq!(&out["adjustments"][0]["to"], &json!(min));
    }
}
