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

// Variants not yet produced (low_confidence and kill_switch are gated in the agent, calendar_mismatch is T10) exist now so
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
    /// The owner (or operator) switched the agent to refuse-everything; produced by the agent before the kernel is consulted.
    KillSwitch,
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
            RefusalReason::KillSwitch => "kill_switch",
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

/// A floor that raised a field before pricing; surfaced in the quote so the customer is told.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Adjustment {
    pub rule_id: String,
    pub label: String,
    pub field: String,
    pub from: i64,
    pub to: i64,
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
        #[serde(skip_serializing_if = "Vec::is_empty")]
        adjustments: Vec<Adjustment>,
    },
    #[serde(rename_all = "camelCase")]
    Refusal {
        reason: RefusalReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        rule_gap: Option<String>,
        /// The card's `refusalSuggestion` code, on `no_covering_rule` only.
        #[serde(skip_serializing_if = "Option::is_none")]
        suggestion: Option<String>,
    },
}

fn refuse(reason: RefusalReason, gap: Option<String>) -> Outcome {
    Outcome::Refusal { reason, rule_gap: gap, suggestion: None }
}

/// A suggestion is a short machine code, never prose: it ends up in escalation events and the ledger.
fn is_code(s: &str) -> bool {
    let mut chars = s.chars();
    s.len() <= 64
        && chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
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
        Charge::Tiered { field, tiers } => tier_amount(tiers, int_field(f, field)?),
        Charge::TieredPerUnit { field, tiers } => {
            let v = int_field(f, field)?;
            tier_amount(tiers, v)?.checked_mul(v).ok_or(KernelError::Overflow)
        }
    }
}

/// The amount of the first band whose inclusive upper bound is at or above `v`.
fn tier_amount(tiers: &[Tier], v: i64) -> Result<i64, KernelError> {
    tiers.iter().find(|t| t.up_to.is_none_or(|u| v <= u)).map(|t| t.amount).ok_or(KernelError::Invalid)
}

/// Tax rounding rule: `round_half_up(amount * bps / 10_000)` in exact integer
/// arithmetic, computed as `floor((2 * amount * bps + 10_000) / 20_000)`.
fn tax(amount: i64, bps: i64) -> Result<i64, KernelError> {
    let n = (amount as i128) * (bps as i128) * 2 + 10_000;
    i64::try_from(n.div_euclid(20_000)).map_err(|_| KernelError::Overflow)
}

pub fn evaluate(input: Input, rate_card_hash: String) -> Result<Outcome, KernelError> {
    let Input { rate_card: card, mut fields, availability, now } = input;

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

    // Floors (e.g. a minimum order quantity) run before pricing, so rules and tiers see the quantity actually quoted.
    let mut adjustments = Vec::new();
    for m in &card.minimums {
        if !m.when.iter().all(|c| holds(c, &fields)) {
            continue;
        }
        if let Some(Val::Int(n)) = fields.get(&m.field) {
            if *n < m.min {
                match m.below {
                    BelowMinimum::Refuse => {
                        return Ok(refuse(RefusalReason::OutOfPolicy, Some(format!("below_minimum:{}", m.field))));
                    }
                    BelowMinimum::RaiseToMin => {
                        adjustments.push(Adjustment {
                            rule_id: m.rule_id.clone(),
                            label: m.label.clone(),
                            field: m.field.clone(),
                            from: *n,
                            to: m.min,
                        });
                        fields.insert(m.field.clone(), Val::Int(m.min));
                    }
                }
            }
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
        let suggestion = match card.refusal_suggestion.as_deref() {
            Some(s) if is_code(s) => Some(s.to_string()),
            Some(_) => return Err(KernelError::Invalid),
            None => None,
        };
        return Ok(Outcome::Refusal { reason: RefusalReason::NoCoveringRule, rule_gap: rule_gap(&card, &fields), suggestion });
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
        adjustments,
    })
}
