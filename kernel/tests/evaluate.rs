use kernel::{evaluate, rate_card_hash};
use serde_json::{json, Value};

const CARD: &str = include_str!("../../rate-cards/fictional-banquet.json");

fn run(fields: Value, availability: Value) -> Value {
    let card: Value = serde_json::from_str(CARD).unwrap();
    let input = json!({
        "rateCard": card,
        "fields": fields,
        "availability": availability,
        "now": "2026-11-07T10:00:00Z"
    });
    serde_json::from_str(&evaluate(&input.to_string())).unwrap()
}

fn saturday_120() -> Value {
    json!({"service":"banquet","date":"2026-12-12","guestCount":120,"language":"en","confidenceBps":9200})
}

fn no_blocks() -> Value {
    json!({"blockedDates": []})
}

#[test]
fn prices_weekend_banquet_with_tax_as_its_own_line() {
    let out = run(saturday_120(), no_blocks());
    assert_eq!(out["kind"], "quote");
    let lines: Vec<(String, i64)> = out["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| (l["ruleId"].as_str().unwrap().to_string(), l["amount"].as_i64().unwrap()))
        .collect();
    assert_eq!(
        lines,
        vec![
            ("hall-weekend".to_string(), 25_000_000),
            ("catering-per-plate".to_string(), 15_000_000),
            ("decor-by-size".to_string(), 6_000_000),
            ("peak-season".to_string(), 2_000_000),
            ("gst-18".to_string(), 8_640_000),
        ]
    );
    assert_eq!(out["total"], 56_640_000);
    assert_eq!(out["currency"], "INR");
    assert_eq!(out["validUntil"], "2026-11-14T10:00:00Z");
}

#[test]
fn weekday_outside_peak_uses_weekday_hall_and_no_surcharge() {
    // 2027-06-02 is a Wednesday; 40 guests -> decor tier 1
    let out = run(
        json!({"service":"banquet","date":"2027-06-02","guestCount":40,"language":"en","confidenceBps":9000}),
        no_blocks(),
    );
    let ids: Vec<&str> = out["lines"].as_array().unwrap().iter().map(|l| l["ruleId"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["hall-weekday", "catering-per-plate", "decor-by-size", "gst-18"]);
    // 15_000_000 + 5_000_000 + 4_000_000 = 24_000_000; gst 4_320_000
    assert_eq!(out["total"], 28_320_000);
}

#[test]
fn tax_rounds_half_up_in_integer_arithmetic() {
    let mut card: Value = serde_json::from_str(CARD).unwrap();
    // subtotal 1 minor unit at 50% = 0.5 -> rounds half up to 1
    card["rules"] = json!([{"ruleId":"r","core":true,"label":"R","when":[],"charge":{"kind":"flat","amount":1}}]);
    card["taxLines"] = json!([{"ruleId":"t","label":"T","rateBps":5000}]);
    let input = json!({"rateCard":card,"fields":saturday_120(),"availability":no_blocks(),"now":"2026-11-07T10:00:00Z"});
    let out: Value = serde_json::from_str(&evaluate(&input.to_string())).unwrap();
    assert_eq!(out["lines"][1]["amount"], 1);
    assert_eq!(out["total"], 2);
}

#[test]
fn no_matching_rule_is_a_typed_refusal() {
    let out = run(
        json!({"service":"banquet","date":"2026-12-12","guestCount":900,"language":"en","confidenceBps":9000}),
        no_blocks(),
    );
    assert_eq!(out, json!({"kind":"refusal","reason":"no_covering_rule","ruleGap":"guestCount"}));
}

#[test]
fn identical_input_gives_byte_identical_output() {
    let card: Value = serde_json::from_str(CARD).unwrap();
    let input = json!({"rateCard":card,"fields":saturday_120(),"availability":no_blocks(),"now":"2026-11-07T10:00:00Z"}).to_string();
    let first = evaluate(&input);
    for _ in 0..100 {
        assert_eq!(evaluate(&input), first);
    }
}

#[test]
fn quote_pins_the_card_hash_and_hash_ignores_key_order() {
    let out = run(saturday_120(), no_blocks());
    let card: Value = serde_json::from_str(CARD).unwrap();
    let h = rate_card_hash(&card.to_string()).unwrap();
    assert_eq!(out["rateCardHash"], h);
    assert_eq!(h.len(), 64);
    let reordered = r#"{"version":1,"id":"x","a":{"z":1,"b":2}}"#;
    let reordered2 = r#"{"a":{"b":2,"z":1},"id":"x","version":1}"#;
    assert_eq!(rate_card_hash(reordered).unwrap(), rate_card_hash(reordered2).unwrap());
}

#[test]
fn missing_required_field_is_refused_not_guessed() {
    let out = run(json!({"service":"banquet","language":"en","confidenceBps":9000}), no_blocks());
    assert_eq!(out["kind"], "refusal");
    assert_eq!(out["reason"], "missing_required_field");
}

#[test]
fn blocked_date_is_refused() {
    let out = run(saturday_120(), json!({"blockedDates":["2026-12-12"]}));
    assert_eq!(out["reason"], "date_unavailable");
}

#[test]
fn floats_and_malformed_input_are_typed_errors() {
    assert_eq!(evaluate("not json"), r#"{"ok":false,"error":"invalid_input"}"#);
    let card: Value = serde_json::from_str(CARD).unwrap();
    let input = json!({"rateCard":card,"fields":{"guestCount":1.5},"availability":no_blocks(),"now":"2026-11-07T10:00:00Z"});
    assert_eq!(evaluate(&input.to_string()), r#"{"ok":false,"error":"invalid_input"}"#);
}

#[test]
fn overflow_is_a_typed_error() {
    let mut card: Value = serde_json::from_str(CARD).unwrap();
    card["rules"] = json!([{"ruleId":"r","core":true,"label":"R","when":[],"charge":{"kind":"per_unit","field":"guestCount","unitAmount":9223372036854775807i64}}]);
    let input = json!({"rateCard":card,"fields":saturday_120(),"availability":no_blocks(),"now":"2026-11-07T10:00:00Z"});
    assert_eq!(evaluate(&input.to_string()), r#"{"ok":false,"error":"overflow"}"#);
}

const SEASONAL: &str = include_str!("../../rate-cards/fictional-banquet-seasonal.json");

fn run_card(card: &str, fields: Value) -> Value {
    let card: Value = serde_json::from_str(card).unwrap();
    let input = json!({"rateCard": card, "fields": fields, "availability": {"blockedDates": []}, "now": "2026-11-07T10:00:00Z"});
    serde_json::from_str(&evaluate(&input.to_string())).unwrap()
}

#[test]
fn out_of_coverage_refusal_names_the_rule_gap() {
    let out = run_card(SEASONAL, json!({"service":"banquet","date":"2027-06-12","guestCount":300,"language":"en","confidenceBps":9000}));
    assert_eq!(out["kind"], "refusal");
    assert_eq!(out["reason"], "no_covering_rule");
    assert_eq!(out["ruleGap"], "date,guestCount");
}

#[test]
fn closest_rule_gap_is_a_single_field_when_only_one_condition_fails() {
    let out = run_card(SEASONAL, json!({"service":"banquet","date":"2027-06-12","guestCount":120,"language":"en","confidenceBps":9000}));
    assert_eq!(out["reason"], "no_covering_rule");
    assert_eq!(out["ruleGap"], "date");
}

#[test]
fn seasonal_card_still_quotes_inside_coverage() {
    let out = run_card(SEASONAL, json!({"service":"banquet","date":"2026-12-12","guestCount":120,"language":"en","confidenceBps":9000}));
    assert_eq!(out["kind"], "quote");
}

#[test]
fn date_in_the_past_is_refused_never_quoted() {
    // now is 2026-11-07; 2026-01-03 is a Saturday that already happened.
    let out = run(
        json!({"service":"banquet","date":"2026-01-03","guestCount":150,"language":"en","confidenceBps":8000}),
        no_blocks(),
    );
    assert_eq!(out["kind"], "refusal");
    assert_eq!(out["reason"], "out_of_policy");
    assert_eq!(out["ruleGap"], "date_in_past");
}

#[test]
fn today_is_not_in_the_past() {
    // 2026-11-07 is a Saturday, equal to the date part of now.
    let out = run(
        json!({"service":"banquet","date":"2026-11-07","guestCount":100,"language":"en","confidenceBps":9000}),
        no_blocks(),
    );
    assert_eq!(out["kind"], "quote");
}

#[test]
fn discount_negotiation_and_package_intents_are_refused_whatever_else_is_present() {
    for intent in ["discount_request", "negotiation", "package_deal"] {
        let out = run(
            json!({"service":"banquet","date":"2026-12-12","guestCount":120,"language":"en","confidenceBps":9200,"intent":intent}),
            no_blocks(),
        );
        assert_eq!(out["kind"], "refusal", "{intent}");
        assert_eq!(out["reason"], "discount_request", "{intent}");
    }
    // Even with nothing else known: a discount request is not a "missing field" question.
    let out = run(json!({"language":"en","confidenceBps":9000,"intent":"negotiation"}), no_blocks());
    assert_eq!(out["reason"], "discount_request");
}

#[test]
fn ordinary_intents_do_not_block_a_quote() {
    for intent in ["enquiry", "other"] {
        let out = run(
            json!({"service":"banquet","date":"2026-12-12","guestCount":120,"language":"en","confidenceBps":9200,"intent":intent}),
            no_blocks(),
        );
        assert_eq!(out["kind"], "quote", "{intent}");
    }
}
