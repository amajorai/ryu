//! Per-endpoint tool price records (Treg parity B2).
//!
//! A price is recorded in the vendor's **native unit** (USD, or a vendor credit
//! such as `tavily_credit`) with its **provenance** (`vendor_page`,
//! `vendor_api`, `ryu_measured`, `unverified`), a **confidence**, the date it was
//! **checked** and its source URL. It is a small rule table summed per call:
//! `per_call`, `per_unit` on a named meter, and graduated monthly `tiered`
//! rules. `free` is its own variant, an explicit vendor statement, so a missing
//! price can never read as zero.
//!
//! Native units convert to micro-USD at serve time through a USD rate table
//! (`usdRates` in the catalog, the single source of the rates). A quote sums
//! every component exactly and rounds up once.
//!
//! Money rules:
//!
//! * An `unverified` price, or a native unit whose USD rate is unverified or
//!   missing, never quotes, so it can never route a paid call.
//! * `free` cannot be `unverified`, and a zero amount must be written as `free`.
//! * Each record carries its catalog **source** (`ryu` or `treg`). Treg stays a
//!   first-class catalog lane: [`select_price`] merges the two under a
//!   [`PricePrecedence`] switch whose default is Ryu's own record where it is
//!   verified, else Treg's.
//!
//! The catalog is `fixtures/tool-price-v1.json`; the golden cases are
//! `fixtures/tool-price-cases-v1.json`, asserted here and by the TypeScript twin
//! `@ryuhq/protocol/tool-price`.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::capability_taxonomy::{
    is_valid_capability_id, is_valid_iso_date, is_valid_model_id, is_valid_platform_id,
    ComparisonRule, Taxonomy,
};

/// Version of this contract and of `tool-price-v1.json`.
pub const TOOL_PRICE_VERSION: u32 = 1;

/// Ryu's own price catalog, embedded at compile time.
pub const TOOL_PRICE_JSON: &str = include_str!("../fixtures/tool-price-v1.json");

/// The one unit that needs no rate: amounts are micro-USD.
pub const USD: &str = "USD";

/// The reserved meter that counts calls.
pub const CALLS_METER: &str = "calls";

/// Largest charge a quote returns; matches JavaScript's safe-integer range so
/// both implementations refuse the same inputs.
pub const MAX_QUOTE_MICRO_USD: u64 = (1 << 53) - 1;

const MICRO: u128 = 1_000_000;
const MAX_NAME_LEN: usize = 128;

/// Where a price figure came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PriceProvenance {
    /// Read from the vendor's published pricing page.
    VendorPage,
    /// Read from the vendor's own pricing or billing API.
    VendorApi,
    /// Measured by Ryu from billed calls.
    RyuMeasured,
    /// Not confirmed. Never quotes, so never routes a paid call.
    Unverified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PriceConfidence {
    High,
    Medium,
    Low,
}

/// Which catalog a record came from. Every served price carries this label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PriceSource {
    Ryu,
    Treg,
}

/// How to choose between a Ryu record and a Treg record for one endpoint.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PricePrecedence {
    /// Ryu's record when its provenance is verified, else Treg's, else Ryu's
    /// unverified record (which refuses paid routing).
    #[default]
    RyuVerifiedFirst,
    /// Treg's record when present, else Ryu's.
    TregFirst,
    /// Ryu's catalog only.
    RyuOnly,
    /// Treg's catalog only.
    TregOnly,
}

/// One band of a graduated monthly tier table. `up_to` is the inclusive upper
/// bound of the cumulative monthly quantity; the last band is open (`None`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PriceTier {
    pub up_to: Option<u64>,
    pub micro_amount: u64,
    pub per: u64,
}

/// One rule of a metered price. Amounts are millionths of the native unit for
/// every `per` units of the meter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "rule",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PriceComponent {
    PerCall {
        micro_amount: u64,
        per: u64,
    },
    PerUnit {
        meter: String,
        micro_amount: u64,
        per: u64,
    },
    Tiered {
        meter: String,
        tiers: Vec<PriceTier>,
    },
}

/// The price of one endpoint call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PriceRule {
    /// The vendor states the call costs nothing.
    Free,
    /// The sum of every component, in `unit`.
    Metered {
        unit: String,
        components: Vec<PriceComponent>,
    },
}

/// A price record for one endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PriceRecord {
    pub endpoint: String,
    pub provider: String,
    pub source: PriceSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub price: PriceRule,
    pub provenance: PriceProvenance,
    pub confidence: PriceConfidence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_on: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnitKind {
    Currency,
    VendorCredit,
}

/// The micro-USD price of `per` native units.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsdRate {
    pub unit: String,
    pub kind: UnitKind,
    pub micro_usd: u64,
    pub per: u64,
    pub provenance: PriceProvenance,
    pub confidence: PriceConfidence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_on: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Ryu's own price catalog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PriceCatalog {
    pub version: u32,
    pub description: String,
    /// Rows checked longer ago than this are flagged for a re-check.
    pub stale_after_days: u32,
    pub usd_rates: Vec<UsdRate>,
    pub rows: Vec<PriceRecord>,
}

/// What one call used: calls, named meters, and the month-to-date quantity
/// already counted before this call (for tiered rules).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PriceUsage {
    #[serde(default)]
    pub calls: u64,
    #[serde(default)]
    pub meters: BTreeMap<String, u64>,
    #[serde(default)]
    pub month_to_date: BTreeMap<String, u64>,
}

impl PriceUsage {
    fn quantity(&self, meter: &str) -> u64 {
        if meter == CALLS_METER {
            self.calls
        } else {
            self.meters.get(meter).copied().unwrap_or(0)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceQuote {
    pub micro_usd: u64,
    pub free: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuoteError {
    InvalidPrice,
    PriceUnverified,
    UnknownUnit,
    InvalidRate,
    RateUnverified,
    Overflow,
}

impl QuoteError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidPrice => "invalid_price",
            Self::PriceUnverified => "price_unverified",
            Self::UnknownUnit => "unknown_unit",
            Self::InvalidRate => "invalid_rate",
            Self::RateUnverified => "rate_unverified",
            Self::Overflow => "overflow",
        }
    }
}

/// A catalog-level finding.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct PriceIssue {
    pub code: String,
    pub subject: String,
}

/// `<provider>.<operation>…`: a lowercase first segment, then one or more
/// segments of `[A-Za-z0-9_-]`, at most 128 characters.
pub fn is_valid_endpoint_id(id: &str) -> bool {
    if id.is_empty() || id.len() > MAX_NAME_LEN {
        return false;
    }
    let mut segments = id.split('.');
    let head_ok = segments.next().is_some_and(is_valid_provider_id);
    let mut rest = 0;
    for segment in segments {
        rest += 1;
        if segment.is_empty()
            || !segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return false;
        }
    }
    head_ok && rest >= 1
}

/// `[a-z0-9][a-z0-9-]*`, at most 64 characters.
pub fn is_valid_provider_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    id.len() <= 64
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `[a-z][a-z0-9_]*`, at most 64 characters.
fn is_snake_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    value.len() <= 64
        && first.is_ascii_lowercase()
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// `USD` or a lowercase native unit name.
pub fn is_valid_unit(unit: &str) -> bool {
    unit == USD || is_snake_name(unit)
}

fn is_https_url(value: &str) -> bool {
    url::Url::parse(value)
        .is_ok_and(|parsed| parsed.scheme() == "https" && parsed.host_str().is_some())
}

fn is_safe_amount(value: u64) -> bool {
    value <= MAX_QUOTE_MICRO_USD
}

/// Provenance, confidence, date and URL rules shared by records and rates.
fn check_evidence(
    provenance: PriceProvenance,
    confidence: PriceConfidence,
    checked_on: Option<&str>,
    source_url: Option<&str>,
    codes: &mut BTreeSet<&'static str>,
) {
    match checked_on {
        Some(date) if !is_valid_iso_date(date) => {
            codes.insert("invalid_checked_on");
        }
        None if provenance != PriceProvenance::Unverified => {
            codes.insert("missing_checked_on");
        }
        _ => {}
    }
    match source_url {
        Some(url) if !is_https_url(url) => {
            codes.insert("invalid_source_url");
        }
        None if matches!(
            provenance,
            PriceProvenance::VendorPage | PriceProvenance::VendorApi
        ) =>
        {
            codes.insert("missing_source_url");
        }
        _ => {}
    }
    if provenance == PriceProvenance::Unverified && confidence != PriceConfidence::Low {
        codes.insert("unverified_confidence");
    }
}

fn check_component(component: &PriceComponent, codes: &mut BTreeSet<&'static str>) {
    let mut charges = false;
    let mut amount = |micro_amount: u64, per: u64, codes: &mut BTreeSet<&'static str>| {
        if per == 0 {
            codes.insert("zero_per");
        }
        if !is_safe_amount(micro_amount) || !is_safe_amount(per) {
            codes.insert("unsafe_amount");
        }
        charges |= micro_amount > 0;
    };
    match component {
        PriceComponent::PerCall { micro_amount, per } => {
            if *micro_amount == 0 {
                codes.insert("zero_amount");
            }
            amount(*micro_amount, *per, codes);
        }
        PriceComponent::PerUnit {
            meter,
            micro_amount,
            per,
        } => {
            if !is_snake_name(meter) || meter == CALLS_METER {
                codes.insert("invalid_meter");
            }
            if *micro_amount == 0 {
                codes.insert("zero_amount");
            }
            amount(*micro_amount, *per, codes);
        }
        PriceComponent::Tiered { meter, tiers } => {
            if !is_snake_name(meter) {
                codes.insert("invalid_meter");
            }
            if tiers.is_empty() {
                codes.insert("invalid_tiers");
            }
            let mut previous = 0_u64;
            for (index, tier) in tiers.iter().enumerate() {
                let last = index + 1 == tiers.len();
                match tier.up_to {
                    Some(up_to) if !last && up_to > previous => previous = up_to,
                    None if last => {}
                    _ => {
                        codes.insert("invalid_tiers");
                    }
                }
                if tier.up_to.is_some_and(|up_to| !is_safe_amount(up_to)) {
                    codes.insert("unsafe_amount");
                }
                amount(tier.micro_amount, tier.per, codes);
            }
            if !tiers.is_empty() && !charges {
                codes.insert("zero_amount");
            }
        }
    }
}

/// Every rule a record breaks, as sorted codes. Empty means valid.
pub fn validate_price_record(record: &PriceRecord) -> Vec<&'static str> {
    let mut codes = BTreeSet::new();
    if !is_valid_endpoint_id(&record.endpoint) {
        codes.insert("invalid_endpoint");
    }
    if !is_valid_provider_id(&record.provider) {
        codes.insert("invalid_provider");
    }
    match (&record.platform, &record.capability) {
        (Some(platform), Some(capability)) => {
            if !is_valid_platform_id(platform) || !is_valid_capability_id(capability) {
                codes.insert("invalid_taxonomy_ref");
            }
        }
        (None, None) => {}
        _ => {
            codes.insert("partial_taxonomy_ref");
        }
    }
    if let Some(model) = &record.model {
        if record.capability.is_none() {
            codes.insert("model_without_capability");
        }
        if !is_valid_model_id(model) {
            codes.insert("invalid_model");
        }
    }
    match &record.price {
        PriceRule::Free => {
            if record.provenance == PriceProvenance::Unverified {
                codes.insert("unverified_free");
            }
        }
        PriceRule::Metered { unit, components } => {
            if !is_valid_unit(unit) {
                codes.insert("invalid_unit");
            }
            if components.is_empty() {
                codes.insert("no_components");
            }
            for component in components {
                check_component(component, &mut codes);
            }
        }
    }
    check_evidence(
        record.provenance,
        record.confidence,
        record.checked_on.as_deref(),
        record.source_url.as_deref(),
        &mut codes,
    );
    codes.into_iter().collect()
}

/// Every rule a USD rate breaks, as sorted codes. Empty means valid.
pub fn validate_usd_rate(rate: &UsdRate) -> Vec<&'static str> {
    let mut codes = BTreeSet::new();
    if rate.unit == USD {
        codes.insert("usd_rate");
    } else if !is_valid_unit(&rate.unit) {
        codes.insert("invalid_unit");
    }
    if rate.micro_usd == 0 {
        codes.insert("zero_amount");
    }
    if rate.per == 0 {
        codes.insert("zero_per");
    }
    if !is_safe_amount(rate.micro_usd) || !is_safe_amount(rate.per) {
        codes.insert("unsafe_amount");
    }
    check_evidence(
        rate.provenance,
        rate.confidence,
        rate.checked_on.as_deref(),
        rate.source_url.as_deref(),
        &mut codes,
    );
    codes.into_iter().collect()
}

/// Whether a record may price a call that someone pays for.
pub fn paid_routing_allowed(record: &PriceRecord) -> bool {
    record.provenance != PriceProvenance::Unverified && validate_price_record(record).is_empty()
}

const fn gcd(mut a: u128, mut b: u128) -> u128 {
    while b != 0 {
        let next = a % b;
        a = b;
        b = next;
    }
    a
}

/// An exact non-negative fraction, reduced after every step.
struct Fraction {
    numerator: u128,
    denominator: u128,
}

impl Fraction {
    const fn zero() -> Self {
        Self {
            numerator: 0,
            denominator: 1,
        }
    }

    fn reduce(mut self) -> Self {
        let divisor = gcd(self.numerator, self.denominator);
        if divisor > 1 {
            self.numerator /= divisor;
            self.denominator /= divisor;
        }
        self
    }

    /// `self + quantity * amount / per`.
    fn add(self, quantity: u64, amount: u64, per: u64) -> Option<Self> {
        let per = u128::from(per);
        let term = u128::from(quantity).checked_mul(u128::from(amount))?;
        let numerator = self
            .numerator
            .checked_mul(per)?
            .checked_add(term.checked_mul(self.denominator)?)?;
        let denominator = self.denominator.checked_mul(per)?;
        Some(
            Self {
                numerator,
                denominator,
            }
            .reduce(),
        )
    }

    /// `self * multiplier / divisor`.
    fn scale(self, multiplier: u128, divisor: u128) -> Option<Self> {
        Some(
            Self {
                numerator: self.numerator.checked_mul(multiplier)?,
                denominator: self.denominator.checked_mul(divisor)?,
            }
            .reduce(),
        )
    }

    fn ceil(&self) -> u128 {
        self.numerator.div_ceil(self.denominator)
    }
}

/// Price `usage` under `record`, converting native units through `rates`.
pub fn quote_price(
    record: &PriceRecord,
    usage: &PriceUsage,
    rates: &[UsdRate],
) -> Result<PriceQuote, QuoteError> {
    if !validate_price_record(record).is_empty() {
        return Err(QuoteError::InvalidPrice);
    }
    let (unit, components) = match &record.price {
        PriceRule::Free => {
            return Ok(PriceQuote {
                micro_usd: 0,
                free: true,
            })
        }
        PriceRule::Metered { unit, components } => (unit, components),
    };
    if record.provenance == PriceProvenance::Unverified {
        return Err(QuoteError::PriceUnverified);
    }
    let (rate_micro_usd, rate_per) = if unit == USD {
        (MICRO, 1_u128)
    } else {
        let rate = rates
            .iter()
            .find(|rate| &rate.unit == unit)
            .ok_or(QuoteError::UnknownUnit)?;
        if !validate_usd_rate(rate).is_empty() {
            return Err(QuoteError::InvalidRate);
        }
        if rate.provenance == PriceProvenance::Unverified {
            return Err(QuoteError::RateUnverified);
        }
        (u128::from(rate.micro_usd), u128::from(rate.per))
    };

    let mut native = Fraction::zero();
    for component in components {
        native = match component {
            PriceComponent::PerCall { micro_amount, per } => {
                native.add(usage.calls, *micro_amount, *per)
            }
            PriceComponent::PerUnit {
                meter,
                micro_amount,
                per,
            } => native.add(usage.quantity(meter), *micro_amount, *per),
            PriceComponent::Tiered { meter, tiers } => {
                let before = usage.month_to_date.get(meter).copied().unwrap_or(0);
                let after = before
                    .checked_add(usage.quantity(meter))
                    .ok_or(QuoteError::Overflow)?;
                let mut sum = Some(native);
                let mut floor = 0_u64;
                for tier in tiers {
                    let ceiling = tier.up_to.unwrap_or(u64::MAX);
                    let start = before.max(floor);
                    let end = after.min(ceiling);
                    if end > start {
                        sum = sum
                            .and_then(|value| value.add(end - start, tier.micro_amount, tier.per));
                    }
                    floor = ceiling;
                }
                sum
            }
        }
        .ok_or(QuoteError::Overflow)?;
    }
    // Native micro-units to micro-USD: * rate.microUsd / (rate.per * 1e6).
    let micro_usd = native
        .scale(
            rate_micro_usd,
            rate_per.checked_mul(MICRO).ok_or(QuoteError::Overflow)?,
        )
        .ok_or(QuoteError::Overflow)?
        .ceil();
    if micro_usd > u128::from(MAX_QUOTE_MICRO_USD) {
        return Err(QuoteError::Overflow);
    }
    Ok(PriceQuote {
        micro_usd: u64::try_from(micro_usd).map_err(|_| QuoteError::Overflow)?,
        free: false,
    })
}

/// Merge one endpoint's Ryu and Treg records under `precedence`. The winner
/// keeps its own `source` label, which callers must show beside the price.
pub fn select_price<'a>(
    ryu: Option<&'a PriceRecord>,
    treg: Option<&'a PriceRecord>,
    precedence: PricePrecedence,
) -> Option<&'a PriceRecord> {
    match precedence {
        PricePrecedence::RyuVerifiedFirst => {
            match ryu.filter(|record| record.provenance != PriceProvenance::Unverified) {
                Some(verified) => Some(verified),
                None => treg.or(ryu),
            }
        }
        PricePrecedence::TregFirst => treg.or(ryu),
        PricePrecedence::RyuOnly => ryu,
        PricePrecedence::TregOnly => treg,
    }
}

/// Every issue in Ryu's own catalog, checked against `taxonomy`.
pub fn validate_catalog(catalog: &PriceCatalog, taxonomy: &Taxonomy) -> Vec<PriceIssue> {
    let mut issues = Vec::new();
    let mut push = |code: &str, subject: &str| {
        issues.push(PriceIssue {
            code: code.to_owned(),
            subject: subject.to_owned(),
        });
    };
    if catalog.version != TOOL_PRICE_VERSION {
        push("unsupported_version", &catalog.version.to_string());
        return issues;
    }
    if catalog.stale_after_days == 0 {
        push("invalid_stale_after", "staleAfterDays");
    }
    let mut units = HashSet::new();
    for rate in &catalog.usd_rates {
        for code in validate_usd_rate(rate) {
            push(code, &rate.unit);
        }
        if !units.insert(rate.unit.as_str()) {
            push("duplicate_unit", &rate.unit);
        }
    }
    let mut endpoints = HashSet::new();
    for row in &catalog.rows {
        let subject = row.endpoint.as_str();
        for code in validate_price_record(row) {
            push(code, subject);
        }
        if !endpoints.insert(subject) {
            push("duplicate_endpoint", subject);
        }
        if row.source != PriceSource::Ryu {
            push("foreign_source", subject);
        }
        if let PriceRule::Metered { unit, .. } = &row.price {
            if unit != USD && !units.contains(unit.as_str()) {
                push("unknown_unit", subject);
            }
        }
        let (Some(platform), Some(capability)) = (&row.platform, &row.capability) else {
            continue;
        };
        let Some(found) = taxonomy.resolve(capability) else {
            push("unknown_capability", subject);
            continue;
        };
        if &found.id != capability {
            push("alias_reference", subject);
        }
        if !found.platforms.iter().any(|allowed| allowed == platform) {
            push("platform_not_allowed", subject);
        }
        match (found.comparison, &row.model) {
            (ComparisonRule::PerModel, None) => push("model_required", subject),
            (ComparisonRule::Capability, Some(_)) => push("model_not_allowed", subject),
            _ => {}
        }
    }
    issues
}

impl PriceCatalog {
    /// Parse a catalog and validate it against `taxonomy`.
    pub fn parse(json: &str, taxonomy: &Taxonomy) -> Result<Self, String> {
        let catalog: Self =
            serde_json::from_str(json).map_err(|error| format!("price catalog JSON: {error}"))?;
        let issues = validate_catalog(&catalog, taxonomy);
        if let Some(first) = issues.first() {
            return Err(format!(
                "price catalog invalid: {} ({}), {} issue(s)",
                first.code,
                first.subject,
                issues.len()
            ));
        }
        Ok(catalog)
    }

    pub fn row(&self, endpoint: &str) -> Option<&PriceRecord> {
        self.rows.iter().find(|row| row.endpoint == endpoint)
    }

    /// Quote an endpoint from this catalog with its own rate table.
    pub fn quote(
        &self,
        endpoint: &str,
        usage: &PriceUsage,
    ) -> Option<Result<PriceQuote, QuoteError>> {
        self.row(endpoint)
            .map(|row| quote_price(row, usage, &self.usd_rates))
    }
}

/// Ryu's built-in price catalog, parsed and validated once against the
/// built-in taxonomy.
pub fn builtin_price_catalog() -> Result<&'static PriceCatalog, &'static str> {
    static CATALOG: OnceLock<Result<PriceCatalog, String>> = OnceLock::new();
    CATALOG
        .get_or_init(|| {
            let taxonomy = crate::capability_taxonomy::builtin_taxonomy()?;
            PriceCatalog::parse(TOOL_PRICE_JSON, taxonomy)
        })
        .as_ref()
        .map_err(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_builtin_catalog_parses_validates_and_quotes() {
        let catalog = builtin_price_catalog().unwrap();
        assert_eq!(catalog.version, TOOL_PRICE_VERSION);
        let one_call = PriceUsage {
            calls: 1,
            ..PriceUsage::default()
        };
        // Composio's managed-app rate agrees with composio-rates.json.
        assert_eq!(
            catalog
                .quote("composio.tool_call.managed_app", &one_call)
                .unwrap()
                .unwrap()
                .micro_usd,
            500
        );
        // One Tavily basic search is one credit at $0.008.
        assert_eq!(
            catalog
                .quote("tavily.search.basic", &one_call)
                .unwrap()
                .unwrap()
                .micro_usd,
            8_000
        );
        assert!(
            catalog
                .quote("github.GITHUB_CREATE_AN_ISSUE", &one_call)
                .unwrap()
                .unwrap()
                .free
        );
        assert!(catalog.quote("nope.endpoint", &one_call).is_none());
    }

    #[test]
    fn endpoint_ids() {
        assert!(is_valid_endpoint_id("github.GITHUB_CREATE_AN_ISSUE"));
        assert!(is_valid_endpoint_id("composio.tool_call.managed_app"));
        assert!(!is_valid_endpoint_id("github"));
        assert!(!is_valid_endpoint_id("GitHub.x"));
        assert!(!is_valid_endpoint_id("github..x"));
    }
}
