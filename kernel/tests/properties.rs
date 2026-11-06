//! Property tests at the public seam (`evaluate` JSON in / JSON out).
//! Invariants: every quote line carries a ruleId that exists on the card, every
//! quote has at least one core rule line, and totals are exact integer sums.

use kernel::evaluate;
use proptest::prelude::*;
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn cond() -> impl Strategy<Value = Value> {
    prop_oneof![
        prop_oneof![Just("banquet"), Just("photo")]
            .prop_map(|v| json!({"field":"service","op":"eq","value":v})),
        (prop::option::of(0i64..200), prop::option::of(100i64..400))
            .prop_map(|(min, max)| json!({"field":"guestCount","op":"range","min":min,"max":max})),
        prop::sample::subsequence(vec!["mon", "tue", "wed", "thu", "fri", "sat", "sun"], 1..=7)
            .prop_map(|d| json!({"field":"date","op":"weekday_in","days":d})),
        prop::sample::subsequence((1..=12).collect::<Vec<i64>>(), 1..=12)
            .prop_map(|m| json!({"field":"date","op":"month_in","months":m})),
    ]
}

fn charge() -> impl Strategy<Value = Value> {
    prop_oneof![
        (-1_000_000i64..1_000_000_000).prop_map(|a| json!({"kind":"flat","amount":a})),
        (0i64..1_000_000).prop_map(|u| json!({"kind":"per_unit","field":"guestCount","unitAmount":u})),
        (0i64..1_000_000, 0i64..1_000_000).prop_map(|(a, b)| json!({
            "kind":"tiered","field":"guestCount",
            "tiers":[{"upTo":150,"amount":a},{"upTo":null,"amount":b}]
        })),
    ]
}

fn rule(i: usize) -> impl Strategy<Value = Value> {
    (any::<bool>(), prop::collection::vec(cond(), 0..3), charge()).prop_map(move |(core, when, charge)| {
        json!({"ruleId": format!("rule-{i}"), "core": core, "label": format!("Rule {i}"), "when": when, "charge": charge})
    })
}

fn card() -> impl Strategy<Value = Value> {
    (
        prop::collection::vec(0usize..1, 0..6).prop_flat_map(|v| {
            (0..v.len()).map(rule).collect::<Vec<_>>()
        }),
        prop::collection::vec(0i64..5_000, 0..3),
        prop::sample::subsequence(vec!["service", "date", "guestCount"], 0..=3),
    )
        .prop_map(|(rules, taxes, required)| {
            let tax_lines: Vec<Value> = taxes
                .iter()
                .enumerate()
                .map(|(i, bps)| json!({"ruleId": format!("tax-{i}"), "label": format!("Tax {i}"), "rateBps": bps}))
                .collect();
            let req: Vec<Value> = required.iter().map(|f| json!({"field": f, "question": "?"})).collect();
            json!({
                "id":"prop-card","version":1,"currency":"INR","timezone":"Asia/Kolkata",
                "validDays":7,"holdHours":48,"requiredFields":req,"taxLines":tax_lines,"rules":rules
            })
        })
}

fn fields() -> impl Strategy<Value = Value> {
    (
        prop_oneof![Just("banquet"), Just("photo")],
        prop::sample::select(vec!["2026-06-13", "2026-12-12", "2026-11-09", "2027-02-26", "2026-04-02"]),
        0i64..450,
        prop::sample::subsequence(vec!["service", "date", "guestCount"], 0..=3),
    )
        .prop_map(|(service, date, n, drop)| {
            let mut f = json!({"service":service,"date":date,"guestCount":n,"language":"en","confidenceBps":9000});
            for d in drop {
                f.as_object_mut().unwrap().remove(d);
            }
            f
        })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    #[test]
    fn every_quote_line_has_a_known_rule_id_a_core_line_and_integer_totals(card in card(), fields in fields()) {
        let core_ids: BTreeSet<String> = card["rules"].as_array().unwrap().iter()
            .filter(|r| r["core"] == true).map(|r| r["ruleId"].as_str().unwrap().to_string()).collect();
        let known_ids: BTreeSet<String> = card["rules"].as_array().unwrap().iter()
            .chain(card["taxLines"].as_array().unwrap().iter())
            .map(|r| r["ruleId"].as_str().unwrap().to_string()).collect();

        let input = json!({"rateCard":card,"fields":fields,"availability":{"blockedDates":[]},"now":"2026-11-07T10:00:00Z"});
        let out: Value = serde_json::from_str(&evaluate(&input.to_string())).unwrap();

        match out["kind"].as_str() {
            Some("quote") => {
                let lines = out["lines"].as_array().unwrap();
                let mut sum: i64 = 0;
                for l in lines {
                    let id = l["ruleId"].as_str().unwrap_or("");
                    prop_assert!(!id.is_empty(), "line without ruleId: {l}");
                    prop_assert!(known_ids.contains(id), "unknown ruleId {id}");
                    sum += l["amount"].as_i64().expect("integer amount");
                }
                prop_assert!(
                    lines.iter().any(|l| core_ids.contains(l["ruleId"].as_str().unwrap())),
                    "quote without a core rule line"
                );
                prop_assert_eq!(out["total"].as_i64().expect("integer total"), sum);
            }
            Some("refusal") => {
                prop_assert!(out["reason"].is_string());
                prop_assert!(out.get("lines").is_none() && out.get("total").is_none());
            }
            _ => prop_assert!(out["ok"] == false && out["error"].is_string(), "untyped output: {}", out),
        }
    }
}

#[test]
fn generator_reaches_quotes_and_refusals() {
    use proptest::strategy::ValueTree;
    use proptest::test_runner::TestRunner;
    let mut runner = TestRunner::deterministic();
    let (mut quotes, mut refusals) = (0, 0);
    for _ in 0..500 {
        let (c, f) = (card(), fields());
        let c = c.new_tree(&mut runner).unwrap().current();
        let f = f.new_tree(&mut runner).unwrap().current();
        let input = json!({"rateCard":c,"fields":f,"availability":{"blockedDates":[]},"now":"2026-11-07T10:00:00Z"});
        let out: Value = serde_json::from_str(&evaluate(&input.to_string())).unwrap();
        match out["kind"].as_str() {
            Some("quote") => quotes += 1,
            Some("refusal") => refusals += 1,
            _ => {}
        }
    }
    assert!(quotes >= 20, "only {quotes} quotes generated");
    assert!(refusals >= 20, "only {refusals} refusals generated");
}
