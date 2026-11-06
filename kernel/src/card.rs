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
    PerUnit { field: String, unit_amount: i64 },
    Tiered { field: String, tiers: Vec<Tier> },
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
    pub required_fields: Vec<RequiredField>,
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
