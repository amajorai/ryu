//! Ryu's tool catalog (curated and generated tiers) and its verification rules
//! (Treg parity B3 and C1).
//!
//! A catalog entry is one callable vendor endpoint, keyed by the same endpoint
//! id as its price record ([`crate::tool_price`]) and typed by one capability on
//! one platform ([`crate::capability_taxonomy`]). It carries the vendor's own
//! reference URL, the probes the verifier runs against the vendor, and a
//! verification state:
//!
//! * `unverified`: no verification run has passed yet.
//! * `verified`: the latest run that reached a verdict passed every probe it
//!   could run; `method` names the strongest (`docs_page`, `live_free`,
//!   `live_paid`) and `verified_on` the date.
//! * `drifted`: a run found the vendor no longer matches the record. It needs a
//!   curator.
//! * `retired`: withdrawn by a curator, with a reason and an optional
//!   successor. Never probed again.
//!
//! Money rule: only a `verified` entry whose price may route paid calls
//! ([`catalog_paid_routing_allowed`]) can route a paid call.
//!
//! A probe may name a credential only from [`VERIFIER_CREDENTIAL_HOSTS`], and
//! only for that credential's own host, so an edited row cannot send a verifier
//! secret anywhere else. Treg stays a first-class catalog lane: every entry
//! carries its `source`, and [`select_catalog_entry`] merges a Ryu entry with a
//! Treg one under the same [`PricePrecedence`] switch as prices.
//!
//! Two tiers share this shape. `curated` rows are written and reviewed by hand,
//! typed by the taxonomy and joined to a reviewed price. `generated` rows come
//! from a vendor's own published OpenAPI spec (`tools/tool-catalog-generate.ts`
//! writes `fixtures/tool-catalog-generated-v1.json`): each records its spec
//! ([`CatalogSpec`]) and operation ([`CatalogOperation`]), needs no taxonomy
//! reference or price, and so can never route a paid call until a curator gives
//! it a reviewed price. Curated rows win on collision: a live generated row may
//! not repeat another live row's provider operation (`duplicate_operation`).
//!
//! The seed is `fixtures/tool-catalog-v1.json`; the golden cases are
//! `fixtures/tool-catalog-cases-v1.json`, asserted here and by the TypeScript
//! twin `@ryuhq/protocol/tool-catalog`, which also holds the verifier's
//! planner and example scrubber.

use std::collections::{BTreeSet, HashMap};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::capability_taxonomy::{
    is_valid_capability_id, is_valid_iso_date, is_valid_model_id, is_valid_platform_id,
    ComparisonRule, Taxonomy,
};
use crate::tool_price::{
    is_valid_endpoint_id, is_valid_provider_id, paid_routing_allowed, quote_price, PriceCatalog,
    PricePrecedence, PriceRecord, PriceRule, PriceSource, PriceUsage,
};

/// Version of this contract and of `tool-catalog-v1.json`.
pub const TOOL_CATALOG_VERSION: u32 = 1;

/// Ryu's catalog seed, embedded at compile time.
pub const TOOL_CATALOG_JSON: &str = include_str!("../fixtures/tool-catalog-v1.json");

/// Ryu's generated tier, embedded at compile time.
pub const TOOL_CATALOG_GENERATED_JSON: &str =
    include_str!("../fixtures/tool-catalog-generated-v1.json");

/// Longest operation path template kept.
pub const MAX_OPERATION_PATH_LEN: usize = 512;

/// At most this many probes per entry.
pub const MAX_PROBES_PER_ENTRY: usize = 4;

/// At most this many markers per docs-page probe.
pub const MAX_PROBE_MARKERS: usize = 8;

/// Longest drift or retirement reason kept, in characters.
pub const MAX_REASON_LEN: usize = 300;

/// The only credentials a probe may name, each bound to the one host it may
/// be sent to.
pub const VERIFIER_CREDENTIAL_HOSTS: &[(&str, &str)] = &[
    ("RYU_VERIFY_BRAVE_KEY", "api.search.brave.com"),
    ("RYU_VERIFY_EXA_KEY", "api.exa.ai"),
    ("RYU_VERIFY_GITHUB_TOKEN", "api.github.com"),
    ("RYU_VERIFY_TAVILY_KEY", "api.tavily.com"),
];

const MAX_TITLE_LEN: usize = 120;
const MIN_MARKER_LEN: usize = 3;
const MAX_MARKER_LEN: usize = 200;
const MAX_EXPECT_KEYS: usize = 16;
const MAX_ESTIMATE_MICRO_USD: u64 = 10_000_000;

/// Where an entry stands with the vendor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationState {
    Unverified,
    Verified,
    Drifted,
    Retired,
}

/// What a passing probe proved, weakest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationMethod {
    /// The vendor's own reference or pricing page still states the record.
    DocsPage,
    /// A live call that costs nothing behaved as documented.
    LiveFree,
    /// A paid live call behaved as documented.
    LivePaid,
}

/// The latest verdict on an entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Verification {
    pub state: VerificationState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_on: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_on: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<VerificationMethod>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub successor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialScheme {
    Bearer,
    Raw,
}

/// A verifier credential a live probe sends, by environment variable name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProbeCredential {
    pub env: String,
    pub header: String,
    pub scheme: CredentialScheme,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum ProbeHttpMethod {
    Get,
    Post,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExpectJson {
    Object,
    Array,
}

/// One check the verifier runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CatalogProbe {
    /// Fetch a vendor page and find every marker in its visible text.
    DocsPage { url: String, expect: Vec<String> },
    /// Call the endpoint and check the status, JSON shape and fields.
    Http {
        method: ProbeHttpMethod,
        url: String,
        expect_status: u16,
        expect_json: ExpectJson,
        expect_keys: Vec<String>,
        estimated_micro_usd: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        credential: Option<ProbeCredential>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        body: Option<Map<String, Value>>,
    },
}

impl CatalogProbe {
    /// What the probe proves when it passes.
    pub fn method(&self) -> VerificationMethod {
        match self {
            Self::DocsPage { .. } => VerificationMethod::DocsPage,
            Self::Http {
                estimated_micro_usd: 0,
                ..
            } => VerificationMethod::LiveFree,
            Self::Http { .. } => VerificationMethod::LivePaid,
        }
    }

    /// What the probe is expected to cost, in micro-USD.
    pub fn cost(&self) -> u64 {
        match self {
            Self::DocsPage { .. } => 0,
            Self::Http {
                estimated_micro_usd,
                ..
            } => *estimated_micro_usd,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogTier {
    Curated,
    Generated,
}

/// The HTTP method of a vendor operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum OperationMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

/// The vendor operation an entry describes: method plus the spec's path
/// template (`/repos/{owner}/{repo}/issues`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogOperation {
    pub method: OperationMethod,
    pub path: String,
}

/// The vendor-published spec a generated entry came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogSpec {
    pub url: String,
    pub checked_on: String,
    pub sha256: String,
}

/// An anonymous free route (Treg parity C6): the vendor serves this GET
/// without a credential and for free, so Connect may relay it with no key and
/// no balance entry. `base_url` is the vendor origin (and base path) the
/// operation's path is joined to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogFreeRoute {
    pub base_url: String,
}

/// One curated endpoint.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogEntry {
    pub endpoint: String,
    pub provider: String,
    pub source: PriceSource,
    pub tier: CatalogTier,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toolkit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub title: String,
    pub docs_url: String,
    pub docs_checked_on: String,
    pub verification: Verification,
    pub probes: Vec<CatalogProbe>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<CatalogOperation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<CatalogSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub free_route: Option<CatalogFreeRoute>,
}

/// Ryu's catalog seed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolCatalog {
    pub version: u32,
    pub description: String,
    pub entries: Vec<CatalogEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunOutcome {
    Pass,
    Mismatch,
    Error,
    Skipped,
}

/// One entry's result from a verification run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerificationResult {
    pub endpoint: String,
    pub outcome: RunOutcome,
    pub ran_on: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<VerificationMethod>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// A catalog-level finding.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct CatalogIssue {
    pub code: String,
    pub subject: String,
}

fn https_url(value: &str) -> Option<url::Url> {
    url::Url::parse(value).ok().filter(|parsed| {
        parsed.scheme() == "https"
            && parsed.host_str().is_some_and(|host| !host.is_empty())
            && parsed.username().is_empty()
            && parsed.password().is_none()
    })
}

fn blank(value: Option<&String>) -> bool {
    value.is_none_or(|text| text.trim().is_empty())
}

fn credential_host(env: &str) -> Option<&'static str> {
    VERIFIER_CREDENTIAL_HOSTS
        .iter()
        .find(|(name, _)| *name == env)
        .map(|(_, host)| *host)
}

fn is_toolkit_id(value: &str) -> bool {
    let mut chars = value.chars();
    value.len() <= 64
        && chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn is_header_name(value: &str) -> bool {
    let mut chars = value.chars();
    value.len() <= 64
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn check_verification(verification: &Verification, codes: &mut BTreeSet<&'static str>) {
    let checked = verification.checked_on.as_deref();
    let verified = verification.verified_on.as_deref();
    if checked.is_some_and(|date| !is_valid_iso_date(date)) {
        codes.insert("invalid_checked_on");
    }
    if verified.is_some_and(|date| !is_valid_iso_date(date)) {
        codes.insert("invalid_verified_on");
    }
    if let (Some(checked), Some(verified)) = (checked, verified) {
        if verified > checked {
            codes.insert("verified_after_checked");
        }
    }
    if verified.is_some() && verification.method.is_none() {
        codes.insert("verified_without_method");
    }
    if verification
        .reason
        .as_ref()
        .is_some_and(|reason| reason.chars().count() > MAX_REASON_LEN)
    {
        codes.insert("reason_too_long");
    }
    match verification.state {
        VerificationState::Verified => {
            if verified.is_none() || checked.is_none() {
                codes.insert("verified_without_date");
            }
            if verification.reason.is_some() {
                codes.insert("reason_not_allowed");
            }
        }
        VerificationState::Drifted => {
            if checked.is_none() {
                codes.insert("drifted_without_date");
            }
            if blank(verification.reason.as_ref()) {
                codes.insert("drifted_without_reason");
            }
        }
        VerificationState::Retired => {
            if blank(verification.reason.as_ref()) {
                codes.insert("retired_without_reason");
            }
        }
        VerificationState::Unverified => {
            if verification.reason.is_some() {
                codes.insert("reason_not_allowed");
            }
        }
    }
    if let Some(successor) = &verification.successor {
        if verification.state != VerificationState::Retired {
            codes.insert("successor_not_retired");
        }
        if !is_valid_endpoint_id(successor) {
            codes.insert("invalid_successor");
        }
    }
}

fn check_probe(probe: &CatalogProbe, codes: &mut BTreeSet<&'static str>) {
    match probe {
        CatalogProbe::DocsPage { url, expect } => {
            if https_url(url).is_none() {
                codes.insert("invalid_probe_url");
            }
            if expect.is_empty()
                || expect.len() > MAX_PROBE_MARKERS
                || expect.iter().any(|marker| {
                    marker.trim().chars().count() < MIN_MARKER_LEN
                        || marker.chars().count() > MAX_MARKER_LEN
                        || marker.trim() != marker
                })
            {
                codes.insert("invalid_expect");
            }
        }
        CatalogProbe::Http {
            method,
            url,
            expect_status,
            expect_keys,
            estimated_micro_usd,
            credential,
            body,
            ..
        } => {
            let parsed = https_url(url);
            if parsed.is_none() {
                codes.insert("invalid_probe_url");
            }
            if !(200..=299).contains(expect_status) {
                codes.insert("invalid_expect_status");
            }
            if expect_keys.len() > MAX_EXPECT_KEYS
                || expect_keys
                    .iter()
                    .any(|key| key.is_empty() || key.len() > 64)
            {
                codes.insert("invalid_expect");
            }
            if *estimated_micro_usd > MAX_ESTIMATE_MICRO_USD {
                codes.insert("invalid_estimate");
            }
            if *method == ProbeHttpMethod::Get && body.is_some() {
                codes.insert("body_on_get");
            }
            let Some(credential) = credential else {
                if *estimated_micro_usd > 0 {
                    codes.insert("paid_probe_without_credential");
                }
                return;
            };
            match credential_host(&credential.env) {
                None => {
                    codes.insert("unknown_credential");
                }
                Some(host) => {
                    if parsed
                        .as_ref()
                        .is_some_and(|parsed| parsed.host_str() != Some(host))
                    {
                        codes.insert("credential_host_mismatch");
                    }
                }
            }
            if !is_header_name(&credential.header) {
                codes.insert("invalid_credential_header");
            }
        }
    }
}

/// Whether an operation path is a spec path template (`/a/{b}`), not a URL.
pub fn is_valid_operation_path(path: &str) -> bool {
    path.len() <= MAX_OPERATION_PATH_LEN
        && path.starts_with('/')
        && path
            .bytes()
            .all(|b| (0x21..=0x7e).contains(&b) && b != b'?' && b != b'#')
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn check_tier_fields(entry: &CatalogEntry, codes: &mut BTreeSet<&'static str>) {
    match entry.tier {
        CatalogTier::Generated => {
            if entry.spec.is_none() {
                codes.insert("generated_without_spec");
            }
            if entry.operation.is_none() {
                codes.insert("generated_without_operation");
            }
        }
        CatalogTier::Curated => {
            if entry.spec.is_some() {
                codes.insert("spec_not_allowed");
            }
        }
    }
    if entry
        .operation
        .as_ref()
        .is_some_and(|operation| !is_valid_operation_path(&operation.path))
    {
        codes.insert("invalid_operation");
    }
    if let Some(spec) = &entry.spec {
        if https_url(&spec.url).is_none() {
            codes.insert("invalid_spec_url");
        }
        if !is_valid_iso_date(&spec.checked_on) {
            codes.insert("invalid_spec_checked_on");
        }
        if !is_sha256_hex(&spec.sha256) {
            codes.insert("invalid_spec_sha256");
        }
    }
}

/// A free route's base URL: HTTPS, no credentials, query, fragment or
/// trailing slash.
fn is_valid_free_route_base(value: &str) -> bool {
    https_url(value).is_some_and(|url| url.query().is_none() && url.fragment().is_none())
        && !value.contains('?')
        && !value.contains('#')
        && !value.ends_with('/')
}

/// Rules a free route keeps on its own: a curated GET operation under an
/// HTTPS base, verified only by credential-free probes, one of them a free
/// live GET.
fn check_free_route(entry: &CatalogEntry, codes: &mut BTreeSet<&'static str>) {
    let Some(route) = &entry.free_route else {
        return;
    };
    if entry.tier != CatalogTier::Curated {
        codes.insert("free_route_not_curated");
    }
    if entry
        .operation
        .as_ref()
        .is_none_or(|operation| operation.method != OperationMethod::Get)
    {
        codes.insert("free_route_not_get");
    }
    if !is_valid_free_route_base(&route.base_url) {
        codes.insert("invalid_free_route_url");
    }
    let mut credentialed = false;
    let mut free_get = false;
    for probe in &entry.probes {
        if let CatalogProbe::Http {
            method,
            estimated_micro_usd,
            credential,
            ..
        } = probe
        {
            credentialed |= credential.is_some();
            free_get |= *method == ProbeHttpMethod::Get
                && *estimated_micro_usd == 0
                && credential.is_none();
        }
    }
    if credentialed {
        codes.insert("free_route_credentialed_probe");
    }
    if !free_get {
        codes.insert("free_route_without_free_probe");
    }
}

/// Every rule an entry breaks on its own, as sorted codes. Empty means valid.
pub fn validate_catalog_entry(entry: &CatalogEntry) -> Vec<&'static str> {
    let mut codes = BTreeSet::new();
    check_tier_fields(entry, &mut codes);
    check_free_route(entry, &mut codes);
    if !is_valid_endpoint_id(&entry.endpoint) {
        codes.insert("invalid_endpoint");
    }
    if !is_valid_provider_id(&entry.provider) {
        codes.insert("invalid_provider");
    } else if !entry.endpoint.starts_with(&format!("{}.", entry.provider)) {
        codes.insert("endpoint_provider_mismatch");
    }
    if entry
        .toolkit
        .as_deref()
        .is_some_and(|toolkit| !is_toolkit_id(toolkit))
    {
        codes.insert("invalid_toolkit");
    }
    match (&entry.platform, &entry.capability) {
        (Some(platform), Some(capability)) => {
            if !is_valid_platform_id(platform) || !is_valid_capability_id(capability) {
                codes.insert("invalid_taxonomy_ref");
            }
        }
        // A generated row may carry no taxonomy reference at all, never half of one.
        (None, None) if entry.tier == CatalogTier::Generated => {}
        _ => {
            codes.insert("missing_taxonomy_ref");
        }
    }
    if entry
        .model
        .as_deref()
        .is_some_and(|model| !is_valid_model_id(model))
    {
        codes.insert("invalid_model");
    }
    if entry.title.trim().is_empty() || entry.title.chars().count() > MAX_TITLE_LEN {
        codes.insert("invalid_title");
    }
    if https_url(&entry.docs_url).is_none() {
        codes.insert("invalid_docs_url");
    }
    if !is_valid_iso_date(&entry.docs_checked_on) {
        codes.insert("invalid_docs_checked_on");
    }
    check_verification(&entry.verification, &mut codes);
    if entry.probes.len() > MAX_PROBES_PER_ENTRY {
        codes.insert("too_many_probes");
    }
    if entry.probes.is_empty() && entry.verification.state != VerificationState::Retired {
        codes.insert("no_probes");
    }
    for probe in &entry.probes {
        check_probe(probe, &mut codes);
    }
    if let Some(method) = entry.verification.method {
        if !entry.probes.is_empty() && !entry.probes.iter().any(|probe| probe.method() >= method) {
            codes.insert("method_without_probe");
        }
    }
    codes.into_iter().collect()
}

fn check_against_price(
    entry: &CatalogEntry,
    price: Option<&PriceRecord>,
    prices: &PriceCatalog,
    push: &mut dyn FnMut(&str),
) {
    if entry.free_route.is_some() && price.is_none_or(|price| price.price != PriceRule::Free) {
        push("free_route_not_free");
    }
    let Some(price) = price else {
        // A generated row has no reviewed price yet, so it cannot route paid calls.
        if entry.tier == CatalogTier::Curated {
            push("missing_price");
        }
        return;
    };
    if entry.tier == CatalogTier::Generated {
        // A price is reviewed for a curated entry only: a generated row is
        // promoted by adding a curated entry, never by pricing it in place.
        push("generated_priced");
        return;
    }
    if price.platform.is_some()
        && (price.platform != entry.platform
            || price.capability != entry.capability
            || price.model != entry.model)
    {
        push("price_taxonomy_mismatch");
    }
    if price.provider != entry.provider {
        push("price_provider_mismatch");
    }
    let one_call = PriceUsage {
        calls: 1,
        ..PriceUsage::default()
    };
    for probe in &entry.probes {
        let CatalogProbe::Http {
            estimated_micro_usd,
            ..
        } = probe
        else {
            continue;
        };
        if price.price == PriceRule::Free {
            if *estimated_micro_usd > 0 {
                push("estimate_on_free");
            }
            continue;
        }
        if let Ok(quote) = quote_price(price, &one_call, &prices.usd_rates) {
            if *estimated_micro_usd < quote.micro_usd {
                push("estimate_below_quote");
            }
        }
        if *estimated_micro_usd == 0 {
            push("free_estimate_on_metered");
        }
    }
}

fn check_against_taxonomy(entry: &CatalogEntry, taxonomy: &Taxonomy, push: &mut dyn FnMut(&str)) {
    let (Some(platform), Some(capability)) = (&entry.platform, &entry.capability) else {
        return;
    };
    let Some(found) = taxonomy.resolve(capability) else {
        push("unknown_capability");
        return;
    };
    if &found.id != capability {
        push("alias_reference");
    }
    if !found.platforms.iter().any(|allowed| allowed == platform) {
        push("platform_not_allowed");
    }
    match (found.comparison, &entry.model) {
        (ComparisonRule::PerModel, None) => push("model_required"),
        (ComparisonRule::Capability, Some(_)) => push("model_not_allowed"),
        _ => {}
    }
}

/// The key two entries collide on when they describe one vendor operation.
pub fn operation_key(entry: &CatalogEntry) -> Option<String> {
    entry.operation.as_ref().map(|operation| {
        let method = match operation.method {
            OperationMethod::Get => "GET",
            OperationMethod::Post => "POST",
            OperationMethod::Put => "PUT",
            OperationMethod::Patch => "PATCH",
            OperationMethod::Delete => "DELETE",
        };
        format!("{} {} {}", entry.provider, method, operation.path)
    })
}

/// Live generated entries that repeat an operation another live entry
/// describes. Curated entries may share one (body variants); a generated one
/// may not. In catalog order.
fn duplicate_operations(entries: &[CatalogEntry]) -> Vec<String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for entry in entries {
        if entry.verification.state == VerificationState::Retired {
            continue;
        }
        if let Some(key) = operation_key(entry) {
            *counts.entry(key).or_default() += 1;
        }
    }
    entries
        .iter()
        .filter(|entry| {
            entry.tier == CatalogTier::Generated
                && entry.verification.state != VerificationState::Retired
                && operation_key(entry).is_some_and(|key| counts.get(&key) > Some(&1))
        })
        .map(|entry| entry.endpoint.clone())
        .collect()
}

/// Every issue in a Ryu catalog, checked against `taxonomy` and `prices`.
pub fn validate_tool_catalog(
    catalog: &ToolCatalog,
    taxonomy: &Taxonomy,
    prices: &PriceCatalog,
) -> Vec<CatalogIssue> {
    let mut issues = Vec::new();
    if catalog.version != TOOL_CATALOG_VERSION {
        issues.push(CatalogIssue {
            code: "unsupported_version".to_owned(),
            subject: catalog.version.to_string(),
        });
        return issues;
    }
    let mut by_endpoint: HashMap<&str, &CatalogEntry> = HashMap::new();
    for entry in &catalog.entries {
        let subject = entry.endpoint.as_str();
        let mut push = |code: &str| {
            issues.push(CatalogIssue {
                code: code.to_owned(),
                subject: subject.to_owned(),
            });
        };
        for code in validate_catalog_entry(entry) {
            push(code);
        }
        if by_endpoint.insert(subject, entry).is_some() {
            push("duplicate_endpoint");
        }
        if entry.source != PriceSource::Ryu {
            push("foreign_source");
        }
        check_against_taxonomy(entry, taxonomy, &mut push);
        check_against_price(entry, prices.row(subject), prices, &mut push);
    }
    for subject in duplicate_operations(&catalog.entries) {
        issues.push(CatalogIssue {
            code: "duplicate_operation".to_owned(),
            subject,
        });
    }
    for entry in &catalog.entries {
        let Some(successor) = &entry.verification.successor else {
            continue;
        };
        let live = by_endpoint
            .get(successor.as_str())
            .is_some_and(|next| next.verification.state != VerificationState::Retired);
        if !live {
            issues.push(CatalogIssue {
                code: "unknown_successor".to_owned(),
                subject: entry.endpoint.clone(),
            });
        }
    }
    issues
}

/// Every rule a verification result breaks, as sorted codes.
pub fn validate_verification_result(result: &VerificationResult) -> Vec<&'static str> {
    let mut codes = BTreeSet::new();
    if !is_valid_endpoint_id(&result.endpoint) {
        codes.insert("invalid_endpoint");
    }
    if !is_valid_iso_date(&result.ran_on) {
        codes.insert("invalid_ran_on");
    }
    if result.outcome == RunOutcome::Pass {
        if result.method.is_none() {
            codes.insert("pass_without_method");
        }
    } else if blank(result.reason.as_ref()) {
        codes.insert("missing_reason");
    }
    if result
        .reason
        .as_ref()
        .is_some_and(|reason| reason.chars().count() > MAX_REASON_LEN)
    {
        codes.insert("reason_too_long");
    }
    codes.into_iter().collect()
}

/// The verification an entry has after one run result, and whether it
/// changed. A retired entry and a stale or invalid result change nothing;
/// `pass` verifies, `mismatch` drifts (keeping the last pass), and `error` or
/// `skipped` are not verdicts.
pub fn apply_verification_result(
    current: &Verification,
    result: &VerificationResult,
) -> (Verification, bool) {
    let stale = current
        .checked_on
        .as_deref()
        .is_some_and(|checked| result.ran_on.as_str() < checked);
    if current.state == VerificationState::Retired
        || stale
        || !validate_verification_result(result).is_empty()
    {
        return (current.clone(), false);
    }
    let next = match (result.outcome, result.method) {
        (RunOutcome::Pass, Some(method)) => Verification {
            state: VerificationState::Verified,
            checked_on: Some(result.ran_on.clone()),
            verified_on: Some(result.ran_on.clone()),
            method: Some(method),
            reason: None,
            successor: None,
        },
        (RunOutcome::Mismatch, _) => Verification {
            state: VerificationState::Drifted,
            checked_on: Some(result.ran_on.clone()),
            verified_on: current.verified_on.clone(),
            method: current.method,
            reason: Some(
                result
                    .reason
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or_default()
                    .to_owned(),
            ),
            successor: None,
        },
        _ => return (current.clone(), false),
    };
    let changed = &next != current;
    (next, changed)
}

/// Whether an entry may route a call someone pays for: it is curated and
/// verified, and its price may route paid calls. A generated row never does,
/// even one a docs check verified.
pub fn catalog_paid_routing_allowed(entry: &CatalogEntry, price: Option<&PriceRecord>) -> bool {
    entry.tier == CatalogTier::Curated
        && entry.verification.state == VerificationState::Verified
        && price
            .is_some_and(|price| price.endpoint == entry.endpoint && paid_routing_allowed(price))
}

/// Whether Connect may relay an entry as an anonymous free route: it declares
/// one and breaks no rule, Ryu's reviewed price for it is free, and a live
/// call verified it. Anything else is never served without a key.
pub fn catalog_free_route_allowed(entry: &CatalogEntry, price: Option<&PriceRecord>) -> bool {
    entry.free_route.is_some()
        && entry.source == PriceSource::Ryu
        && validate_catalog_entry(entry).is_empty()
        && entry.verification.state == VerificationState::Verified
        && entry
            .verification
            .method
            .is_some_and(|method| method >= VerificationMethod::LiveFree)
        && price
            .is_some_and(|price| price.endpoint == entry.endpoint && price.price == PriceRule::Free)
}

/// Merge one endpoint's Ryu and Treg entries under `precedence`. The winner
/// keeps its `source` label, which every surface that serves it must show.
pub fn select_catalog_entry<'a>(
    ryu: Option<&'a CatalogEntry>,
    treg: Option<&'a CatalogEntry>,
    precedence: PricePrecedence,
) -> Option<&'a CatalogEntry> {
    match precedence {
        PricePrecedence::RyuVerifiedFirst => {
            match ryu.filter(|entry| entry.verification.state == VerificationState::Verified) {
                Some(verified) => Some(verified),
                None => treg.or(ryu),
            }
        }
        PricePrecedence::TregFirst => treg.or(ryu),
        PricePrecedence::RyuOnly => ryu,
        PricePrecedence::TregOnly => treg,
    }
}

impl ToolCatalog {
    /// Parse a catalog and validate it against `taxonomy` and `prices`.
    pub fn parse(json: &str, taxonomy: &Taxonomy, prices: &PriceCatalog) -> Result<Self, String> {
        let catalog: Self =
            serde_json::from_str(json).map_err(|error| format!("tool catalog JSON: {error}"))?;
        let issues = validate_tool_catalog(&catalog, taxonomy, prices);
        if let Some(first) = issues.first() {
            return Err(format!(
                "tool catalog invalid: {} ({}), {} issue(s)",
                first.code,
                first.subject,
                issues.len()
            ));
        }
        Ok(catalog)
    }

    pub fn entry(&self, endpoint: &str) -> Option<&CatalogEntry> {
        self.entries.iter().find(|entry| entry.endpoint == endpoint)
    }
}

/// Ryu's built-in catalog seed, parsed and validated once against the
/// built-in taxonomy and price catalog.
pub fn builtin_tool_catalog() -> Result<&'static ToolCatalog, &'static str> {
    static CATALOG: OnceLock<Result<ToolCatalog, String>> = OnceLock::new();
    CATALOG
        .get_or_init(|| {
            let taxonomy = crate::capability_taxonomy::builtin_taxonomy()?;
            let prices = crate::tool_price::builtin_price_catalog()?;
            ToolCatalog::parse(TOOL_CATALOG_JSON, taxonomy, prices)
        })
        .as_ref()
        .map_err(String::as_str)
}

/// The generated entries that may sit beside `curated` ones: curated wins on
/// collision, so a generated entry is left out when a curated entry has its
/// endpoint id or a live curated entry describes the same provider operation.
pub fn generated_entries_beside<'a>(
    curated: &[CatalogEntry],
    generated: &'a [CatalogEntry],
) -> Vec<&'a CatalogEntry> {
    let endpoints: BTreeSet<&str> = curated
        .iter()
        .map(|entry| entry.endpoint.as_str())
        .collect();
    let operations: BTreeSet<String> = curated
        .iter()
        .filter(|entry| entry.verification.state != VerificationState::Retired)
        .filter_map(operation_key)
        .collect();
    generated
        .iter()
        .filter(|entry| {
            !endpoints.contains(entry.endpoint.as_str())
                && !operation_key(entry).is_some_and(|key| operations.contains(&key))
        })
        .collect()
}

/// Every issue in a generated catalog file checked beside the curated seed:
/// each entry `generated` and `unverified`, and the two valid as one catalog.
pub fn validate_generated_catalog(
    generated: &ToolCatalog,
    curated: &ToolCatalog,
    taxonomy: &Taxonomy,
    prices: &PriceCatalog,
) -> Vec<CatalogIssue> {
    let mut issues = Vec::new();
    for entry in &generated.entries {
        if entry.tier != CatalogTier::Generated {
            issues.push(CatalogIssue {
                code: "not_generated".to_owned(),
                subject: entry.endpoint.clone(),
            });
        }
        if entry.verification.state != VerificationState::Unverified {
            issues.push(CatalogIssue {
                code: "generated_not_unverified".to_owned(),
                subject: entry.endpoint.clone(),
            });
        }
    }
    if generated.version != TOOL_CATALOG_VERSION {
        issues.push(CatalogIssue {
            code: "unsupported_version".to_owned(),
            subject: generated.version.to_string(),
        });
        return issues;
    }
    let merged = ToolCatalog {
        version: TOOL_CATALOG_VERSION,
        description: curated.description.clone(),
        entries: curated
            .entries
            .iter()
            .chain(&generated.entries)
            .cloned()
            .collect(),
    };
    issues.extend(validate_tool_catalog(&merged, taxonomy, prices));
    issues
}

/// Ryu's built-in generated tier, parsed and validated once beside the
/// built-in curated seed.
pub fn builtin_generated_tool_catalog() -> Result<&'static ToolCatalog, &'static str> {
    static CATALOG: OnceLock<Result<ToolCatalog, String>> = OnceLock::new();
    CATALOG
        .get_or_init(|| {
            let taxonomy = crate::capability_taxonomy::builtin_taxonomy()?;
            let prices = crate::tool_price::builtin_price_catalog()?;
            let curated = builtin_tool_catalog().map_err(str::to_owned)?;
            let generated: ToolCatalog = serde_json::from_str(TOOL_CATALOG_GENERATED_JSON)
                .map_err(|error| format!("generated tool catalog JSON: {error}"))?;
            let issues = validate_generated_catalog(&generated, curated, taxonomy, prices);
            if let Some(first) = issues.first() {
                return Err(format!(
                    "generated tool catalog invalid: {} ({}), {} issue(s)",
                    first.code,
                    first.subject,
                    issues.len()
                ));
            }
            Ok(generated)
        })
        .as_ref()
        .map_err(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_builtin_seed_parses_and_validates() {
        let catalog = builtin_tool_catalog().unwrap();
        assert_eq!(catalog.version, TOOL_CATALOG_VERSION);
        assert!(catalog.entry("github.GITHUB_CREATE_AN_ISSUE").is_some());
        assert!(catalog.entry("nope.endpoint").is_none());
    }

    #[test]
    fn methods_rank_docs_below_live() {
        assert!(VerificationMethod::DocsPage < VerificationMethod::LiveFree);
        assert!(VerificationMethod::LiveFree < VerificationMethod::LivePaid);
    }

    #[test]
    fn credentials_are_bound_to_their_hosts() {
        assert_eq!(credential_host("RYU_VERIFY_EXA_KEY"), Some("api.exa.ai"));
        assert_eq!(credential_host("RYU_DB_MASTER_KEY"), None);
    }
}
