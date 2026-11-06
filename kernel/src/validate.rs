//! Card validation: the kernel is the judge of what a well-formed card is. Pure; never panics.
//! Errors name the JSON path so a compiler can map them back to the cell the owner typed.

use crate::card::*;
use std::collections::BTreeSet;

pub struct Invalid {
    pub path: String,
    pub message: String,
}

fn bad<T>(path: impl Into<String>, message: impl Into<String>) -> Result<T, Invalid> {
    Err(Invalid { path: path.into(), message: message.into() })
}

const DAYS: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

fn check_conds(conds: &[Cond], base: &str) -> Result<(), Invalid> {
    for (i, c) in conds.iter().enumerate() {
        let at = format!("{base}[{i}]");
        match c {
            Cond::Eq { .. } => {}
            Cond::In { values, .. } => {
                if values.is_empty() {
                    return bad(format!("{at}.values"), "must list at least one value");
                }
            }
            Cond::Range { min, max, .. } => {
                if let (Some(a), Some(b)) = (min, max) {
                    if a > b {
                        return bad(format!("{at}.min"), "min is above max");
                    }
                }
            }
            Cond::WeekdayIn { days, .. } => {
                if days.is_empty() {
                    return bad(format!("{at}.days"), "must list at least one day");
                }
                for (j, d) in days.iter().enumerate() {
                    if !DAYS.contains(&d.as_str()) {
                        return bad(format!("{at}.days[{j}]"), "not a weekday class (mon..sun)");
                    }
                }
            }
            Cond::MonthIn { months, .. } => {
                if months.is_empty() {
                    return bad(format!("{at}.months"), "must list at least one month");
                }
                for (j, m) in months.iter().enumerate() {
                    if !(1..=12).contains(m) {
                        return bad(format!("{at}.months[{j}]"), "not a month number (1..12)");
                    }
                }
            }
        }
    }
    Ok(())
}

fn check_tiers(tiers: &[Tier], base: &str) -> Result<(), Invalid> {
    if tiers.is_empty() {
        return bad(format!("{base}.tiers"), "needs at least one band");
    }
    let mut last: Option<i64> = None;
    for (i, t) in tiers.iter().enumerate() {
        if t.amount < 0 {
            return bad(format!("{base}.tiers[{i}].amount"), "must not be negative");
        }
        match (t.up_to, last) {
            (Some(u), _) if u < 0 => return bad(format!("{base}.tiers[{i}].upTo"), "must not be negative"),
            (Some(u), Some(l)) if u <= l => return bad(format!("{base}.tiers[{i}].upTo"), "bands must rise"),
            (Some(u), _) => last = Some(u),
            (None, _) if i + 1 != tiers.len() => {
                return bad(format!("{base}.tiers[{i}].upTo"), "only the last band may be open")
            }
            (None, _) => {}
        }
    }
    Ok(())
}

pub fn validate(card: &RateCard) -> Result<(), Invalid> {
    if card.currency.trim().is_empty() {
        return bad("currency", "must not be empty");
    }
    if card.valid_days < 1 {
        return bad("validDays", "must be at least 1");
    }
    if card.hold_hours < 0 {
        return bad("holdHours", "must not be negative");
    }
    if card.required_fields.is_empty() {
        return bad("requiredFields", "needs at least one required field");
    }
    let mut ids: BTreeSet<&str> = BTreeSet::new();
    for (i, r) in card.rules.iter().enumerate() {
        if r.rule_id.trim().is_empty() {
            return bad(format!("rules[{i}].ruleId"), "must not be empty");
        }
        if !ids.insert(r.rule_id.as_str()) {
            return bad(format!("rules[{i}].ruleId"), "duplicate ruleId");
        }
        check_conds(&r.when, &format!("rules[{i}].when"))?;
        let at = format!("rules[{i}].charge");
        match &r.charge {
            Charge::Flat { amount } if *amount < 0 => return bad(format!("{at}.amount"), "must not be negative"),
            Charge::PerUnit { unit_amount, included, .. } => {
                if *unit_amount < 0 {
                    return bad(format!("{at}.unitAmount"), "must not be negative");
                }
                if *included < 0 {
                    return bad(format!("{at}.included"), "must not be negative");
                }
            }
            Charge::Tiered { tiers, .. } | Charge::TieredPerUnit { tiers, .. } => check_tiers(tiers, &at)?,
            Charge::Flat { .. } => {}
        }
    }
    for (i, m) in card.minimums.iter().enumerate() {
        if !ids.insert(m.rule_id.as_str()) {
            return bad(format!("minimums[{i}].ruleId"), "duplicate ruleId");
        }
        if m.min < 0 {
            return bad(format!("minimums[{i}].min"), "must not be negative");
        }
        check_conds(&m.when, &format!("minimums[{i}].when"))?;
    }
    for (i, t) in card.tax_lines.iter().enumerate() {
        if !ids.insert(t.rule_id.as_str()) {
            return bad(format!("taxLines[{i}].ruleId"), "duplicate ruleId");
        }
        if !(0..=10_000).contains(&t.rate_bps) {
            return bad(format!("taxLines[{i}].rateBps"), "must be 0..10000 basis points");
        }
    }
    if !card.rules.iter().any(|r| r.core) {
        return bad("rules", "needs at least one core rule: add-ons alone never cover an enquiry");
    }
    Ok(())
}
