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

// Variants not yet produced (low_confidence is gated in the agent, calendar_mismatch is T10) exist now so
// the reason set is closed and exhaustively matched.
#[allow(dead_code)]
pub enum RefusalReason {
    NoCoveringRule,
    MissingRequiredField,
    DateUnavailable,
    DiscountRequest,
    LowConfidence,
    OutOfPolicy,
    CalendarMismatch,
}

impl RefusalReason {
    /// Wire code. Exhaustive match with no wildcard: adding a reason breaks the build
    /// here until it is handled. This match IS the serialisation.
    pub fn code(&self) -> &'static str {
        match self {
            RefusalReason::NoCoveringRule => "no_covering_rule",
            RefusalReason::MissingRequiredField => "missing_required_field",
            RefusalReason::DateUnavailable => "date_unavailable",
            RefusalReason::DiscountRequest => "discount_request",
            RefusalReason::LowConfidence => "low_confidence",
            RefusalReason::OutOfPolicy => "out_of_policy",
            RefusalReason::CalendarMismatch => "calendar_mismatch",
        }
    }
}

impl Serialize for RefusalReason {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.code())
    }
}

/// Fields of the closest-matching core rule that fail to hold (sorted, comma-joined).
/// Field names only, never customer values.
fn rule_gap(card: &RateCard, f: &Fields) -> Option<String> {
    let mut best: Option<(usize, std::collections::BTreeSet<&str>)> = None;
    for rule in card.rules.iter().filter(|r| r.core) {
        let failing: Vec<&Cond> = rule.when.iter().filter(|c| !holds(c, f)).collect();
        if best.as_ref().is_none_or(|(n, _)| failing.len() < *n) {
            best = Some((failing.len(), failing.iter().map(|c| c.field()).collect()));
        }
    }
    best.map(|(_, set)| set.into_iter().collect::<Vec<_>>().join(","))
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
        Charge::PerUnit { field, unit_amount, included } => {
            let billable = int_field(f, field)?.saturating_sub(*included).max(0);
            unit_amount.checked_mul(billable).ok_or(KernelError::Overflow)
        }
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

    // Negotiation is never the model's or the kernel's to do: a discount, price-match or package-deal
    // request is handed to the owner whatever else the message contained (intent is a typed enum value).
    if let Some(Val::Str(i)) = fields.get("intent") {
        if matches!(i.as_str(), "discount_request" | "negotiation" | "package_deal") {
            return Ok(refuse(RefusalReason::DiscountRequest, None));
        }
    }

    let now_s = date::parse_instant(&now).ok_or(KernelError::Invalid)?;

    for r in &card.required_fields {
        if !fields.contains_key(&r.field) {
            return Ok(refuse(RefusalReason::MissingRequiredField, Some(r.field.clone())));
        }
    }
    if let Some(Val::Str(d)) = fields.get("date") {
        // A date before today (UTC day of `now`) is never quoted; today itself is allowed.
        if let Some((days, _)) = date::parse_date(d) {
            if days < now_s.div_euclid(86_400) {
                return Ok(refuse(RefusalReason::OutOfPolicy, Some("date_in_past".to_string())));
            }
        }
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
        return Ok(refuse(RefusalReason::NoCoveringRule, rule_gap(&card, &fields)));
    }

    let mut total = subtotal;
    for t in &card.tax_lines {
        let amount = tax(subtotal, t.rate_bps)?;
        total = total.checked_add(amount).ok_or(KernelError::Overflow)?;
        lines.push(Line { label: t.label.clone(), amount, rule_id: t.rule_id.clone() });
    }

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
