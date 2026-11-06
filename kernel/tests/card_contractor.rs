//! The fictional contractor card through the generic kernel (T13): narrow coverage, everything else refuses.
//! Seam: `evaluate` JSON in / JSON out.

use kernel::evaluate;
use serde_json::{json, Value};

const CARD: &str = include_str!("../../rate-cards/fictional-contractor.json");

fn run(fields: Value) -> Value {
    let card: Value = serde_json::from_str(CARD).unwrap();
    let input = json!({"rateCard": card, "fields": fields, "availability": {"blockedDates": []}, "now": "2026-11-07T10:00:00Z"});
    serde_json::from_str(&evaluate(&input.to_string())).unwrap()
}

fn job(service: &str, locality: &str, quantity: i64) -> Value {
    json!({"service": service, "locality": locality, "quantity": quantity, "language": "en", "confidenceBps": 9000})
}

#[test]
fn card_is_labelled_fictional_and_names_its_suggestion() {
    let card: Value = serde_json::from_str(CARD).unwrap();
    assert_eq!(card["fictional"], true);
    assert!(card["label"].as_str().unwrap().starts_with("FICTIONAL:"));
    assert_eq!(card["refusalSuggestion"], "book_site_visit");
    // the customer-facing template is card text with no digits, so it can never state a number
    assert!(!card["refusalSuggestionReply"].as_str().unwrap().chars().any(|c| c.is_ascii_digit()));
}

#[test]
fn a_narrow_fixed_price_repair_in_a_listed_locality_is_quoted_with_gst() {
    let out = run(job("tap-repair", "greater-noida-west", 1));
    assert_eq!(out["kind"], "quote");
    assert_eq!(out["total"], 94_400); // 80_000 + 18%
    assert!(out.get("suggestion").is_none());
}

#[test]
fn extra_items_up_to_the_size_cap_are_billed_each() {
    let out = run(job("switch-replacement", "gaur-city", 3)); // 60_000 + 2 * 40_000 = 140_000
    assert_eq!(out["kind"], "quote");
    assert_eq!(out["total"], 165_200);
}

#[test]
fn every_other_job_refuses_with_no_covering_rule_the_site_visit_suggestion_and_no_number() {
    let cases = [
        ("a job the card does not offer", job("bathroom-remodel", "greater-noida-west", 1)),
        ("a job the card does not offer, in a covered locality", job("waterproofing", "gaur-city", 2)),
        ("a covered job in a locality not on the list", job("tap-repair", "noida-sector-62", 1)),
        ("a covered job over the size cap", job("tap-repair", "greater-noida-west", 6)),
        ("a covered job at one past the size cap", job("door-lock-fit", "gaur-city", 4)),
    ];
    for (why, fields) in cases {
        let out = run(fields);
        assert_eq!(out["kind"], "refusal", "{why}");
        assert_eq!(out["reason"], "no_covering_rule", "{why}");
        assert_eq!(out["suggestion"], "book_site_visit", "{why}");
        assert!(out.get("total").is_none(), "{why}");
    }
}

#[test]
fn the_size_cap_is_inclusive_at_three() {
    assert_eq!(run(job("tap-repair", "gaur-city", 3))["kind"], "quote");
    assert_eq!(run(job("tap-repair", "gaur-city", 4))["kind"], "refusal");
}

#[test]
fn the_rule_gap_names_the_field_that_kept_it_out_not_the_customers_value() {
    assert_eq!(run(job("tap-repair", "noida-sector-62", 1))["ruleGap"], "locality");
    assert_eq!(run(job("tap-repair", "gaur-city", 9))["ruleGap"], "quantity");
    assert_eq!(run(job("waterproofing", "gaur-city", 1))["ruleGap"], "service");
}

#[test]
fn a_missing_detail_is_a_question_not_a_refusal_and_carries_no_suggestion() {
    let out = run(json!({"service": "tap-repair", "locality": "gaur-city", "language": "en", "confidenceBps": 9000}));
    assert_eq!(out["reason"], "missing_required_field");
    assert_eq!(out["ruleGap"], "quantity");
    assert!(out.get("suggestion").is_none());
}
