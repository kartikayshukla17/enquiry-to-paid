//! `validate_card`: the kernel decides whether a compiled card is well-formed. Seam: JSON in / JSON out.

use kernel::validate_card;
use serde_json::{json, Value};

fn card() -> Value {
    serde_json::from_str(include_str!("../../rate-cards/fictional-banquet.json")).unwrap()
}

fn check(c: &Value) -> Value {
    serde_json::from_str(&validate_card(&c.to_string())).unwrap()
}

#[test]
fn every_shipped_card_is_valid() {
    for src in [
        include_str!("../../rate-cards/fictional-banquet.json"),
        include_str!("../../rate-cards/fictional-banquet-seasonal.json"),
        include_str!("../../rate-cards/fictional-photographer.json"),
        include_str!("../../rate-cards/fictional-b2b-supplier.json"),
        include_str!("../../rate-cards/fictional-contractor.json"),
    ] {
        assert_eq!(serde_json::from_str::<Value>(&validate_card(src)).unwrap(), json!({"ok": true}));
    }
}

#[test]
fn duplicate_rule_ids_are_named_by_path() {
    let mut c = card();
    c["rules"][1]["ruleId"] = json!("hall-weekday");
    let r = check(&c);
    assert_eq!(r["ok"], false);
    assert_eq!(r["error"], "invalid_card");
    assert_eq!(r["path"], "rules[1].ruleId");
}

#[test]
fn negative_money_and_bad_date_classes_are_rejected_with_a_path() {
    let mut c = card();
    c["rules"][0]["charge"]["amount"] = json!(-5);
    assert_eq!(check(&c)["path"], "rules[0].charge.amount");

    let mut c = card();
    c["rules"][0]["when"][1]["days"] = json!(["mon", "funday"]);
    assert_eq!(check(&c)["path"], "rules[0].when[1].days[1]");

    let mut c = card();
    c["rules"][4]["when"][1]["months"] = json!([13]);
    assert_eq!(check(&c)["path"], "rules[4].when[1].months[0]");
}

#[test]
fn a_card_with_no_core_rule_or_a_float_is_rejected() {
    let mut c = card();
    for r in c["rules"].as_array_mut().unwrap() {
        r["core"] = json!(false);
    }
    assert_eq!(check(&c)["path"], "rules");

    let mut c = card();
    c["rules"][0]["charge"]["amount"] = json!(1.5);
    assert_eq!(check(&c)["ok"], false);
}

#[test]
fn unknown_keys_and_garbage_are_typed_errors() {
    let mut c = card();
    c["surprise"] = json!(1);
    assert_eq!(check(&c)["error"], "invalid_card");
    let r: Value = serde_json::from_str(&validate_card("not json")).unwrap();
    assert_eq!(r["error"], "invalid_input");
}
