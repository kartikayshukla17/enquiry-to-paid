//! Generic rate-card language. Vertical-agnostic: rules are data, never code.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A typed field value. Floats are rejected at parse time (no float anywhere).
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum Val {
    Int(i64),
    Str(String),
}

/// ExtractedFields: typed, validated upstream, never free text from the customer.
pub type Fields = BTreeMap<String, Val>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Availability {
    #[serde(default)]
    pub blocked_dates: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequiredField {
    pub field: String,
    #[allow(dead_code)]
    pub question: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaxLine {
    pub rule_id: String,
    pub label: String,
    pub rate_bps: i64,
}

/// A condition on a typed field. All conditions of a rule must hold (AND).
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Cond {
    Eq { field: String, value: Val },
    In { field: String, values: Vec<Val> },
    Range { field: String, min: Option<i64>, max: Option<i64> },
    /// Date class derived from a `YYYY-MM-DD` field: weekday names mon..sun.
    WeekdayIn { field: String, days: Vec<String> },
    /// Date class derived from a `YYYY-MM-DD` field: months 1..12.
    MonthIn { field: String, months: Vec<i64> },
}

impl Cond {
    pub fn field(&self) -> &str {
        match self {
            Cond::Eq { field, .. }
            | Cond::In { field, .. }
            | Cond::Range { field, .. }
            | Cond::WeekdayIn { field, .. }
            | Cond::MonthIn { field, .. } => field,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tier {
    /// Inclusive upper bound; `null` = unbounded last tier.
    pub up_to: Option<i64>,
    pub amount: i64,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Charge {
    Flat { amount: i64 },
    #[serde(rename_all = "camelCase")]
    /// `unit_amount * max(0, value - included)`. `included` (default 0) is a quantity already covered by
    /// another charge, so only units beyond it are billed (e.g. extra hours past those a package includes).
    PerUnit {
        field: String,
        unit_amount: i64,
        #[serde(default)]
        included: i64,
    },
    /// A flat amount picked by the band `field` falls in (`up_to` inclusive).
    Tiered { field: String, tiers: Vec<Tier> },
    /// All-units pricing: the band `field` falls in (`up_to` inclusive) picks the unit price for the WHOLE quantity,
    /// so the charge is `tier.amount * value`.
    TieredPerUnit { field: String, tiers: Vec<Tier> },
}

/// What happens when a typed field is under a card's floor (e.g. a minimum order quantity).
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum BelowMinimum {
    /// Refuse (`out_of_policy`): the owner decides.
    Refuse,
    /// Quote at the minimum instead, and say so in the quote's `adjustments`.
    RaiseToMin,
}

/// A floor on an integer field, with the card's own policy for what to do below it.
/// Applies only when every condition in `when` holds (none = always).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Minimum {
    pub rule_id: String,
    pub label: String,
    pub field: String,
    pub min: i64,
    pub below: BelowMinimum,
    #[serde(default)]
    pub when: Vec<Cond>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub rule_id: String,
    /// A quote needs at least one matching `core` rule; add-ons alone never cover an enquiry.
    #[serde(default)]
    pub core: bool,
    pub label: String,
    pub when: Vec<Cond>,
    pub charge: Charge,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RateCard {
    #[allow(dead_code)]
    pub id: String,
    #[allow(dead_code)]
    pub version: i64,
    pub currency: String,
    #[allow(dead_code)]
    pub timezone: String,
    pub valid_days: i64,
    #[allow(dead_code)]
    pub hold_hours: i64,
    /// When true, the agent may suggest nearby free dates after a `date_unavailable` refusal. Absent means off.
    /// Read by the agent (TS), not by pricing; declared here because the card format denies unknown fields.
    #[allow(dead_code)]
    #[serde(default)]
    pub offer_alternatives: Option<bool>,
    pub required_fields: Vec<RequiredField>,
    #[serde(default)]
    pub minimums: Vec<Minimum>,
    pub tax_lines: Vec<TaxLine>,
    pub rules: Vec<Rule>,
    // Provenance labels, ignored by pricing but part of the hashed card.
    #[allow(dead_code)]
    pub fictional: Option<bool>,
    #[allow(dead_code)]
    pub label: Option<String>,
    #[allow(dead_code)]
    pub comment: Option<String>,
}
