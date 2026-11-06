//! The fictional photographer card through the generic kernel (T11). Seam: `evaluate` JSON in / JSON out.

use kernel::evaluate;
use serde_json::{json, Value};

const CARD: &str = include_str!("../../rate-cards/fictional-photographer.json");

fn run(fields: Value) -> Value {
    let card: Value = serde_json::from_str(CARD).unwrap();
    let input = json!({"rateCard": card, "fields": fields, "availability": {"blockedDates": []}, "now": "2026-11-07T10:00:00Z"});
    serde_json::from_str(&evaluate(&input.to_string())).unwrap()
}

fn shoot(package: &str, hours: i64, distance: i64, date: &str) -> Value {
    json!({"service": "wedding-shoot", "date": date, "package": package, "hours": hours,
           "distanceKm": distance, "language": "en", "confidenceBps": 9000})
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
fn package_hours_within_the_included_amount_and_near_venue_is_just_the_package_plus_tax() {
    // 2026-12-09 is a Wednesday
    let out = run(shoot("standard", 6, 10, "2026-12-09"));
    assert_eq!(out["kind"], "quote");
    assert_eq!(lines(&out), vec![s("pkg-standard", 4_500_000), s("gst-18", 810_000)]);
    assert_eq!(out["total"], 5_310_000);
}

#[test]
fn hours_beyond_the_package_are_billed_per_hour() {
    // Basic includes 4 h; 7 h = 3 extra at 400_000
    let out = run(shoot("basic", 7, 10, "2026-12-09"));
    assert_eq!(lines(&out), vec![s("pkg-basic", 2_500_000), s("extra-hours-basic", 1_200_000), s("gst-18", 666_000)]);
    assert_eq!(out["total"], 4_366_000);
}

#[test]
fn extra_hour_rate_depends_on_the_package() {
    let out = run(shoot("premium", 10, 10, "2026-12-09")); // 2 extra at 300_000
    assert_eq!(lines(&out)[1], s("extra-hours-premium", 600_000));
}

#[test]
fn travel_is_banded_by_distance_with_inclusive_upper_bounds() {
    let travel = |d: i64| -> Option<i64> {
        let out = run(shoot("basic", 4, d, "2026-12-09"));
        assert_eq!(out["kind"], "quote", "distance {d}");
        lines(&out).into_iter().find(|(id, _)| id == "travel").map(|(_, a)| a)
    };
    assert_eq!(travel(0), None);
    assert_eq!(travel(15), None); // 15 km is still in the free band
    assert_eq!(travel(16), Some(150_000));
    assert_eq!(travel(30), Some(150_000)); // upper bound inclusive
    assert_eq!(travel(31), Some(350_000));
    assert_eq!(travel(60), Some(350_000));
}

#[test]
fn weekend_dates_add_the_weekend_surcharge() {
    // 2026-12-12 is a Saturday
    let out = run(shoot("standard", 6, 10, "2026-12-12"));
    assert_eq!(lines(&out), vec![s("pkg-standard", 4_500_000), s("weekend-surcharge", 500_000), s("gst-18", 900_000)]);
}

#[test]
fn everything_in_one_quote_sums_to_the_total() {
    let out = run(shoot("premium", 11, 45, "2026-12-12"));
    let l = lines(&out);
    let sum: i64 = l.iter().map(|(_, a)| a).sum();
    assert_eq!(sum, out["total"].as_i64().unwrap());
    assert_eq!(
        l.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
        vec!["pkg-premium", "extra-hours-premium", "travel", "weekend-surcharge", "gst-18"]
    );
}

#[test]
fn out_of_coverage_requests_refuse_with_no_covering_rule_and_never_quote() {
    let cases = [
        ("distance over the coverage radius", shoot("basic", 4, 61, "2026-12-09")),
        ("more hours than the card covers", shoot("basic", 13, 10, "2026-12-09")),
        ("a package the card does not offer", shoot("platinum", 4, 10, "2026-12-09")),
        (
            "a service the card does not offer",
            json!({"service": "drone-survey", "date": "2026-12-09", "package": "basic", "hours": 4, "distanceKm": 10, "language": "en", "confidenceBps": 9000}),
        ),
    ];
    for (why, fields) in cases {
        let out = run(fields);
        assert_eq!(out["kind"], "refusal", "{why}");
        assert_eq!(out["reason"], "no_covering_rule", "{why}");
    }
}

#[test]
fn a_missing_field_asks_for_that_one_field() {
    let mut f = shoot("basic", 4, 10, "2026-12-09");
    f.as_object_mut().unwrap().remove("package");
    let out = run(f);
    assert_eq!(out["reason"], "missing_required_field");
    assert_eq!(out["ruleGap"], "package");
}
