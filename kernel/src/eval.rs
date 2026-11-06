//! Pure pricing. Deterministic: ordered structures, integer math only.

use crate::card::*;
use crate::date;
use serde::{Deserialize, Serialize};

pub enum KernelError {
    Invalid,
    Overflow,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub rate_card: RateCard,
    pub fields: Fields,
    pub availability: Availability,
    pub now: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub label: String,
    pub amount: i64,
    pub rule_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RefusalReason {
    NoCoveringRule,
    MissingRequiredField,
    DateUnavailable,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Outcome {
    #[serde(rename_all = "camelCase")]
    Quote {
        rate_card_hash: String,
        currency: String,
        total: i64,
        valid_until: String,
        lines: Vec<Line>,
    },
    #[serde(rename_all = "camelCase")]
    Refusal {
        reason: RefusalReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        rule_gap: Option<String>,
    },
}

fn refuse(reason: RefusalReason, gap: Option<String>) -> Outcome {
    Outcome::Refusal { reason, rule_gap: gap }
}

fn holds(c: &Cond, f: &Fields) -> bool {
    let get = |name: &String| f.get(name);
    match c {
        Cond::Eq { field, value } => get(field) == Some(value),
        Cond::In { field, values } => get(field).is_some_and(|v| values.contains(v)),
        Cond::Range { field, min, max } => match get(field) {
            Some(Val::Int(n)) => min.is_none_or(|m| *n >= m) && max.is_none_or(|m| *n <= m),
            _ => false,
        },
        Cond::WeekdayIn { field, days } => match get(field) {
            Some(Val::Str(s)) => date::parse_date(s).is_some_and(|(d, _)| {
                days.iter().any(|x| x == date::WEEKDAYS[date::weekday_index(d) as usize])
            }),
            _ => false,
        },
        Cond::MonthIn { field, months } => match get(field) {
            Some(Val::Str(s)) => date::parse_date(s).is_some_and(|(_, m)| months.contains(&m)),
            _ => false,
        },
    }
}

fn int_field(f: &Fields, name: &str) -> Result<i64, KernelError> {
    match f.get(name) {
        Some(Val::Int(n)) => Ok(*n),
        _ => Err(KernelError::Invalid),
    }
}

fn charge(c: &Charge, f: &Fields) -> Result<i64, KernelError> {
    match c {
        Charge::Flat { amount } => Ok(*amount),
        Charge::PerUnit { field, unit_amount } => unit_amount
            .checked_mul(int_field(f, field)?)
            .ok_or(KernelError::Overflow),
        Charge::Tiered { field, tiers } => {
            let v = int_field(f, field)?;
            tiers
                .iter()
                .find(|t| t.up_to.is_none_or(|u| v <= u))
                .map(|t| t.amount)
                .ok_or(KernelError::Invalid)
        }
    }
}

/// Tax rounding rule: `round_half_up(amount * bps / 10_000)` in exact integer
/// arithmetic, computed as `floor((2 * amount * bps + 10_000) / 20_000)`.
fn tax(amount: i64, bps: i64) -> Result<i64, KernelError> {
    let n = (amount as i128) * (bps as i128) * 2 + 10_000;
    i64::try_from(n.div_euclid(20_000)).map_err(|_| KernelError::Overflow)
}

pub fn evaluate(input: Input, rate_card_hash: String) -> Result<Outcome, KernelError> {
    let Input { rate_card: card, fields, availability, now } = input;

    for r in &card.required_fields {
        if !fields.contains_key(&r.field) {
            return Ok(refuse(RefusalReason::MissingRequiredField, Some(r.field.clone())));
        }
    }
    if let Some(Val::Str(d)) = fields.get("date") {
        if availability.blocked_dates.iter().any(|b| b == d) {
            return Ok(refuse(RefusalReason::DateUnavailable, None));
        }
    }

    let mut lines = Vec::new();
    let mut subtotal: i64 = 0;
    let mut covered = false;
    for rule in card.rules.iter().filter(|r| r.when.iter().all(|c| holds(c, &fields))) {
        covered |= rule.core;
        let amount = charge(&rule.charge, &fields)?;
        subtotal = subtotal.checked_add(amount).ok_or(KernelError::Overflow)?;
        lines.push(Line { label: rule.label.clone(), amount, rule_id: rule.rule_id.clone() });
    }
    if !covered {
        return Ok(refuse(RefusalReason::NoCoveringRule, None));
    }

    let mut total = subtotal;
    for t in &card.tax_lines {
        let amount = tax(subtotal, t.rate_bps)?;
        total = total.checked_add(amount).ok_or(KernelError::Overflow)?;
        lines.push(Line { label: t.label.clone(), amount, rule_id: t.rule_id.clone() });
    }

    let now_s = date::parse_instant(&now).ok_or(KernelError::Invalid)?;
    let valid_s = card
        .valid_days
        .checked_mul(86_400)
        .and_then(|d| now_s.checked_add(d))
        .ok_or(KernelError::Overflow)?;
    Ok(Outcome::Quote {
        rate_card_hash,
        currency: card.currency,
        total,
        valid_until: date::format_instant(valid_s),
        lines,
    })
}
