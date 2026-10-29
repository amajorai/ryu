//! Public tool catalog adapters for the unified Integrations Store: Treg's
//! catalog and Ryu's own (Treg parity B8).
//!
//! Both catalogs serve the same public `/catalog/*` shape, so one reader
//! handles them as two lanes:
//!
//! - **Treg** (`RYU_TREG_CATALOG_URL`, default `https://treg.to`) stays a
//!   first-class lane and the source of everything only Treg lists.
//! - **Ryu** (`RYU_TOOL_CATALOG_URL`, default the control plane's
//!   `/api/tool-catalog`; `off` disables it) is Ryu's curated, vendor-cited
//!   catalog with verification states and reliability evidence.
//!
//! Every row keeps its `source` label. Where both catalogs list the same
//! endpoint, `RYU_TOOL_CATALOG_PRECEDENCE` picks one with the contract's
//! `PricePrecedence` (`ryu_verified_first` by default: Ryu's row where Ryu
//! verified it, else Treg's; or `treg_first`, `ryu_only`, `treg_only`); see
//! `ryu_gw_contracts::tool_catalog_merge`.
//!
//! Catalog browsing is public and needs no provider key; executing a Treg call
//! still belongs to a Treg account and is not implied by a row in the store.
//! Keeping this adapter read-only lets a self-hosted catalog be selected with
//! one URL without moving provider credentials through Ryu Core.

use anyhow::{anyhow, Context, Result};
use ryu_channel_contracts::tool_catalog_merge::{
    merge_order, parse_precedence, same_endpoint_key, MergeCandidate,
};
use ryu_channel_contracts::tool_price::{PricePrecedence, PriceSource};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::catalog_source::{IntegrationOption, IntegrationPrice};

const DEFAULT_TREG_BASE_URL: &str = "https://treg.to";
const TREG_BASE_URL_ENV: &str = "RYU_TREG_CATALOG_URL";
const RYU_BASE_URL_ENV: &str = "RYU_TOOL_CATALOG_URL";
const DEFAULT_RYU_CONTROL_PLANE: &str = "https://api.ryuhq.com";
const RYU_CATALOG_PATH: &str = "/api/tool-catalog";
const PRECEDENCE_ENV: &str = "RYU_TOOL_CATALOG_PRECEDENCE";
const TTL_ENV: &str = "RYU_TREG_CATALOG_CACHE_TTL_SECS";
const DEFAULT_TTL_SECS: u64 = 24 * 60 * 60;
/// Why a Treg endpoint scoped to the caller's own account is not a managed option.
const OWN_ACCOUNT_NOTE: &str =
    "Runs on your own account, which Ryu's managed Treg access cannot use";

/// One public catalog the Integrations Store reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum CatalogLane {
    Treg,
    Ryu,
}

impl CatalogLane {
    /// Both lanes, Ryu's first.
    pub(crate) const ALL: [CatalogLane; 2] = [CatalogLane::Ryu, CatalogLane::Treg];

    /// The `source` label every row from this lane carries.
    pub(crate) fn source(self) -> &'static str {
        match self {
            Self::Treg => "treg",
            Self::Ryu => "ryu",
        }
    }

    /// The provider name shown on this lane's platform rows.
    pub(crate) fn provider_label(self) -> &'static str {
        match self {
            Self::Treg => "Treg",
            Self::Ryu => "Ryu",
        }
    }

    /// The name of this lane's platform rows.
    pub(crate) fn catalog_label(self) -> &'static str {
        match self {
            Self::Treg => "Treg catalog",
            Self::Ryu => "Ryu catalog",
        }
    }

    /// The `kind` of this lane's platform and endpoint rows.
    pub(crate) fn platform_kind(self) -> &'static str {
        match self {
            Self::Treg => "treg-platform",
            Self::Ryu => "ryu-platform",
        }
    }

    fn endpoint_kind(self) -> &'static str {
        match self {
            Self::Treg => "treg-endpoint",
            Self::Ryu => "ryu-endpoint",
        }
    }

    /// The id prefix of this lane's endpoint rows. Treg's ids stay raw, as
    /// they always were; Ryu's are prefixed so the two never collide.
    fn endpoint_id_prefix(self) -> &'static str {
        match self {
            Self::Treg => "",
            Self::Ryu => "ryu:",
        }
    }

    /// The lane's catalog base, or `None` when the lane is switched off.
    pub(crate) fn base_url(self) -> Option<String> {
        match self {
            Self::Treg => {
                Some(env_url(TREG_BASE_URL_ENV).unwrap_or_else(|| DEFAULT_TREG_BASE_URL.to_owned()))
            }
            Self::Ryu => match std::env::var(RYU_BASE_URL_ENV) {
                Ok(raw) if raw.trim().eq_ignore_ascii_case("off") => None,
                _ => env_url(RYU_BASE_URL_ENV).or_else(|| {
                    let origin = env_url("RYU_CONTROL_PLANE_URL")
                        .or_else(|| env_url("RYU_SERVER_URL"))
                        .unwrap_or_else(|| DEFAULT_RYU_CONTROL_PLANE.to_owned());
                    // Catalog reads are https-only, so a derived plain-http
                    // origin (a local dev control plane) would only fail on
                    // every request: leave the default lane off instead.
                    origin
                        .starts_with("https://")
                        .then(|| format!("{origin}{RYU_CATALOG_PATH}"))
                }),
            },
        }
    }
}

fn env_url(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_owned())
        .filter(|value| !value.is_empty())
}

/// The configured precedence between Ryu's and Treg's rows.
pub(crate) fn precedence() -> PricePrecedence {
    match std::env::var(PRECEDENCE_ENV) {
        Ok(raw) if !raw.trim().is_empty() => parse_precedence(&raw).unwrap_or_else(|| {
            static WARNED: OnceLock<()> = OnceLock::new();
            WARNED.get_or_init(|| {
                tracing::warn!(value = %raw, "unknown {PRECEDENCE_ENV}; using ryu_verified_first");
            });
            PricePrecedence::default()
        }),
        _ => PricePrecedence::default(),
    }
}

/// The lanes the Integrations Store reads under `precedence`.
pub(crate) fn active_lanes(precedence: PricePrecedence) -> Vec<CatalogLane> {
    CatalogLane::ALL
        .into_iter()
        .filter(|lane| match (precedence, lane) {
            (PricePrecedence::RyuOnly, CatalogLane::Treg) => false,
            (PricePrecedence::TregOnly, CatalogLane::Ryu) => false,
            _ => true,
        })
        .filter(|lane| lane.base_url().is_some())
        .collect()
}

static PLATFORMS_CACHE: OnceLock<tokio::sync::Mutex<HashMap<CatalogLane, PlatformsCache>>> =
    OnceLock::new();
/// Recent fetch failures by lane and path, so an unreachable lane costs one
/// request (and one warning) per cooldown instead of one per store request.
static FAILURES: OnceLock<std::sync::Mutex<HashMap<(CatalogLane, String), Instant>>> =
    OnceLock::new();
/// How long a failed lane fetch is remembered before it is retried.
const FAILURE_COOLDOWN: Duration = Duration::from_secs(5 * 60);
static DETAILS_CACHE: OnceLock<tokio::sync::Mutex<HashMap<(CatalogLane, String), DetailCache>>> =
    OnceLock::new();

#[derive(Clone)]
struct PlatformsCache {
    fetched_at: Instant,
    platforms: Vec<CatalogPlatformSummary>,
}

#[derive(Clone)]
struct DetailCache {
    fetched_at: Instant,
    options: Vec<CatalogOption>,
}

#[derive(Debug, Clone)]
pub(crate) struct CatalogPlatformSummary {
    pub slug: String,
    pub label: String,
    pub category: Option<String>,
    pub summary: Option<String>,
    pub capabilities: Option<u64>,
    pub endpoints: Option<u64>,
    pub price: Option<IntegrationPrice>,
}

/// One endpoint row with what the cross-catalog merge needs.
#[derive(Debug, Clone)]
pub(crate) struct CatalogOption {
    pub option: IntegrationOption,
    /// The cross-catalog identity (provider and endpoint id).
    pub same_as: String,
    /// Whether the row's own catalog verified it (`verification.state`).
    pub verified: bool,
}

fn cache_ttl() -> Duration {
    let seconds = std::env::var(TTL_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_TTL_SECS);
    Duration::from_secs(seconds)
}

/// Whether `lane`'s `path` failed within the cooldown.
fn recently_failed(lane: CatalogLane, path: &str, now: Instant) -> bool {
    let failures = FAILURES.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let mut guard = failures
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.retain(|_, at| now.duration_since(*at) < FAILURE_COOLDOWN);
    guard.contains_key(&(lane, path.to_owned()))
}

fn record_failure(lane: CatalogLane, path: &str, outcome: Option<Instant>) {
    let failures = FAILURES.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let mut guard = failures
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match outcome {
        Some(at) => {
            guard.insert((lane, path.to_owned()), at);
        }
        None => {
            guard.remove(&(lane, path.to_owned()));
        }
    }
}

/// Fetch one catalog document. A failure is logged once and remembered for
/// `FAILURE_COOLDOWN`; until then the lane answers the error without a request.
/// One Treg endpoint's public catalog detail (`/catalog/endpoints/{id}`), or
/// `None` when the catalog does not list it (HTTP 404). Any other failure is
/// an error, so a caller can tell "not listed" from "could not read".
pub(crate) async fn describe_endpoint(endpoint_id: &str) -> Result<Option<Value>> {
    let base = CatalogLane::Treg
        .base_url()
        .ok_or_else(|| anyhow!("the Treg catalog is switched off"))?;
    let url = format!(
        "{base}/catalog/endpoints/{}",
        urlencoding::encode(endpoint_id)
    );
    let response = crate::server::guarded_get(&url)
        .await
        .map_err(|error| anyhow!("reading the Treg catalog: {error}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let bytes = crate::server::read_capped_body(response, &url)
        .await
        .map_err(|error| anyhow!("reading the Treg catalog: {error}"))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| anyhow!("Treg catalog answer: {error}"))
}

async fn fetch_json(lane: CatalogLane, path: &str) -> Result<Value> {
    if recently_failed(lane, path, Instant::now()) {
        return Err(anyhow!(
            "{} catalog {path} failed recently; retrying after the cooldown",
            lane.provider_label()
        ));
    }
    let result = fetch_json_uncached(lane, path).await;
    match &result {
        Ok(_) => record_failure(lane, path, None),
        Err(error) => {
            tracing::warn!(
                error = %error,
                lane = lane.source(),
                "tool catalog unavailable; keeping the other sources"
            );
            record_failure(lane, path, Some(Instant::now()));
        }
    }
    result
}

async fn fetch_json_uncached(lane: CatalogLane, path: &str) -> Result<Value> {
    let base = lane
        .base_url()
        .ok_or_else(|| anyhow!("{} catalog is switched off", lane.provider_label()))?;
    let url = format!("{base}{path}");
    let bytes = crate::server::guarded_get_bytes(&url)
        .await
        .map_err(|error| anyhow!("fetching {} catalog {url}: {error}", lane.provider_label()))?;
    serde_json::from_slice(&bytes).with_context(|| {
        format!(
            "parsing {} catalog response from {url}",
            lane.provider_label()
        )
    })
}

/// The lane's platform index, cached for `RYU_TREG_CATALOG_CACHE_TTL_SECS`.
pub(crate) async fn platform_summaries(lane: CatalogLane) -> Result<Vec<CatalogPlatformSummary>> {
    let lock = PLATFORMS_CACHE.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));
    {
        let guard = lock.lock().await;
        if let Some(cache) = guard
            .get(&lane)
            .filter(|cache| cache.fetched_at.elapsed() < cache_ttl())
        {
            return Ok(cache.platforms.clone());
        }
    }

    let body = fetch_json(lane, "/catalog/platforms").await?;
    let platforms = body
        .get("platforms")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow!(
                "{} catalog response has no platforms array",
                lane.provider_label()
            )
        })?
        .iter()
        .filter_map(parse_platform_summary)
        .collect::<Vec<_>>();

    let mut guard = lock.lock().await;
    if let Some(cache) = guard
        .get(&lane)
        .filter(|cache| cache.fetched_at.elapsed() < cache_ttl())
    {
        return Ok(cache.platforms.clone());
    }
    guard.insert(
        lane,
        PlatformsCache {
            fetched_at: Instant::now(),
            platforms: platforms.clone(),
        },
    );
    Ok(platforms)
}

/// One platform's endpoint rows from the lane, cached like the index.
pub(crate) async fn platform_options(lane: CatalogLane, slug: &str) -> Result<Vec<CatalogOption>> {
    let slug = slug.trim();
    if slug.is_empty() {
        return Err(anyhow!("{} platform slug is empty", lane.provider_label()));
    }

    let lock = DETAILS_CACHE.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));
    let key = (lane, slug.to_owned());
    {
        let guard = lock.lock().await;
        if let Some(cache) = guard
            .get(&key)
            .filter(|cache| cache.fetched_at.elapsed() < cache_ttl())
        {
            return Ok(cache.options.clone());
        }
    }

    let body = fetch_json(
        lane,
        &format!("/catalog/platforms/{}", urlencoding::encode(slug)),
    )
    .await?;
    let base = lane.base_url().unwrap_or_default();
    let options = parse_platform_options(lane, &base, &body);
    let mut guard = lock.lock().await;
    if let Some(cache) = guard
        .get(&key)
        .filter(|cache| cache.fetched_at.elapsed() < cache_ttl())
    {
        return Ok(cache.options.clone());
    }
    guard.insert(
        key,
        DetailCache {
            fetched_at: Instant::now(),
            options: options.clone(),
        },
    );
    Ok(options)
}

/// Merge a brand's catalog rows from both lanes under `precedence`: rows from
/// other sources (directory, Composio) stay first in their order, then the
/// catalog rows the merge keeps, in its order.
pub(crate) fn merge_catalog_options(
    others: Vec<IntegrationOption>,
    catalog: Vec<CatalogOption>,
    precedence: PricePrecedence,
) -> Vec<IntegrationOption> {
    let candidates = catalog
        .iter()
        .map(|row| MergeCandidate {
            source: if row.option.source == "ryu" {
                PriceSource::Ryu
            } else {
                PriceSource::Treg
            },
            same_as: Some(row.same_as.as_str()),
            verified: row.verified,
        })
        .collect::<Vec<_>>();
    let order = merge_order(&candidates, precedence);
    let mut slots = catalog.into_iter().map(Some).collect::<Vec<_>>();
    let mut merged = others;
    for index in order {
        if let Some(row) = slots.get_mut(index).and_then(Option::take) {
            merged.push(row.option);
        }
    }
    merged
}

/// Order a brand's platform rows (one per lane) under `precedence`.
pub(crate) fn platform_lane_order(precedence: PricePrecedence) -> [CatalogLane; 2] {
    match precedence {
        PricePrecedence::TregFirst | PricePrecedence::TregOnly => {
            [CatalogLane::Treg, CatalogLane::Ryu]
        }
        _ => [CatalogLane::Ryu, CatalogLane::Treg],
    }
}

fn parse_platform_summary(value: &Value) -> Option<CatalogPlatformSummary> {
    let slug = string_field(value, &["slug"])?;
    let label = string_field(value, &["label", "name"]).unwrap_or_else(|| slug.clone());
    let capabilities = count_field(value.get("capabilities"));
    let endpoints = count_field(value.get("endpoints"));
    Some(CatalogPlatformSummary {
        slug,
        label,
        category: string_field(value, &["category"]),
        summary: string_field(value, &["summary", "description"]),
        capabilities,
        endpoints,
        price: value.get("price_from").and_then(parse_price),
    })
}

fn parse_platform_options(lane: CatalogLane, base: &str, body: &Value) -> Vec<CatalogOption> {
    let mut options = Vec::new();
    let mut seen = HashSet::new();

    if let Some(domains) = body.get("domains").and_then(Value::as_array) {
        for domain in domains {
            let Some(rows) = domain.get("rows").and_then(Value::as_array) else {
                continue;
            };
            for row in rows {
                let Some(endpoints) = row.get("endpoints").and_then(Value::as_array) else {
                    continue;
                };
                for endpoint in endpoints {
                    push_endpoint_option(lane, base, endpoint, &mut seen, &mut options);
                }
            }
        }
    }

    // Older/self-hosted catalog responses may omit the domain projection;
    // capabilities is the equivalent endpoint list, and the id set keeps this
    // fallback from duplicating rows when both projections are present.
    if let Some(capabilities) = body.get("capabilities").and_then(Value::as_array) {
        for capability in capabilities {
            let Some(endpoints) = capability.get("endpoints").and_then(Value::as_array) else {
                continue;
            };
            for endpoint in endpoints {
                push_endpoint_option(lane, base, endpoint, &mut seen, &mut options);
            }
        }
    }

    options
}

fn push_endpoint_option(
    lane: CatalogLane,
    base: &str,
    endpoint: &Value,
    seen: &mut HashSet<String>,
    options: &mut Vec<CatalogOption>,
) {
    let Some(id) = string_field(endpoint, &["id"]) else {
        return;
    };
    if !seen.insert(id.clone()) {
        return;
    }
    let summary = string_field(endpoint, &["summary", "description"]);
    let name = string_field(endpoint, &["name"])
        .or_else(|| summary.clone())
        .unwrap_or_else(|| id.clone());
    let capability = string_field(endpoint, &["capability"]);
    let provider = string_field(endpoint, &["provider_display", "provider"]);
    let provider_id = string_field(endpoint, &["provider", "provider_display"]).unwrap_or_default();
    let mut availability_note = string_field(endpoint, &["platform_blocked"]);
    let mut available = endpoint.get("platform_eligible").and_then(Value::as_bool);
    // A Treg endpoint scoped to the caller's own account (a user's Slack, say)
    // cannot run on Ryu's managed Treg access, so it is never a managed option;
    // the account is connected through Composio instead.
    if lane == CatalogLane::Treg
        && string_field(endpoint, &["scope"]).as_deref() == Some("own_account")
    {
        available = Some(false);
        availability_note.get_or_insert_with(|| OWN_ACCOUNT_NOTE.to_owned());
    }
    let verified = endpoint
        .get("verification")
        .and_then(|verification| verification.get("state"))
        .and_then(Value::as_str)
        == Some("verified");
    let url = Some(format!(
        "{base}/catalog/endpoints/{}",
        urlencoding::encode(&id)
    ));

    options.push(CatalogOption {
        same_as: same_endpoint_key(&provider_id, &id),
        verified,
        option: IntegrationOption {
            id: format!("{}{id}", lane.endpoint_id_prefix()),
            source: lane.source().to_owned(),
            kind: lane.endpoint_kind().to_owned(),
            action: "chat-setup".to_owned(),
            connection_id: None,
            name,
            description: summary,
            url,
            provider,
            capability: capability.clone(),
            comparison_key: capability,
            price: endpoint.get("cost").and_then(parse_price),
            is_cheapest: false,
            provider_role: None,
            available,
            availability_note,
        },
    });
}

fn parse_price(value: &Value) -> Option<IntegrationPrice> {
    let usd = number_field(value, &["usd"]);
    let currency = string_field(value, &["currency"]);
    let value_amount = number_field(value, &["value"]);
    let per = number_field(value, &["per"]);
    let unit = string_field(value, &["unit"]);
    let confidence = string_field(value, &["confidence"]);
    // Ryu's browse cost says what the figure covers; Treg rows carry neither.
    let basis = string_field(value, &["basis"]);
    let metered_by = value
        .get("metered_by")
        .and_then(Value::as_array)
        .map(|meters| {
            meters
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if usd.is_none()
        && currency.is_none()
        && value_amount.is_none()
        && per.is_none()
        && unit.is_none()
    {
        return None;
    }
    Some(IntegrationPrice {
        usd,
        currency,
        value: value_amount,
        per,
        unit,
        confidence,
        basis,
        metered_by,
    })
}

fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn number_field(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_f64))
}

fn count_field(value: Option<&Value>) -> Option<u64> {
    value.and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_array().map(|items| items.len() as u64))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const BROWSE_CASES: &str =
        include_str!("../../../packages/protocol/src/fixtures/tool-catalog-browse-cases-v1.json");

    #[test]
    fn parses_platform_summary_and_price() {
        let value = json!({
            "slug": "x",
            "label": "X (Twitter)",
            "category": "Social",
            "summary": "Profiles and posts",
            "capabilities": 96,
            "endpoints": 147,
            "price_from": {
                "value": 0.001,
                "currency": "USD",
                "per": 1,
                "unit": "call",
                "usd": 0.001,
                "confidence": "verified"
            }
        });
        let summary = parse_platform_summary(&value).expect("platform summary");
        assert_eq!(summary.slug, "x");
        assert_eq!(summary.capabilities, Some(96));
        assert_eq!(
            summary.price.as_ref().and_then(|price| price.usd),
            Some(0.001)
        );
    }

    #[test]
    fn flattens_and_deduplicates_treg_endpoint_projections() {
        let value = json!({
            "domains": [{
                "rows": [{
                    "endpoints": [{
                        "id": "x.user.profile",
                        "provider": "tikhub",
                        "provider_display": "TikHub",
                        "summary": "Profile",
                        "capability": "profile",
                        "platform_eligible": true,
                        "cost": {"usd": 0.001, "unit": "call", "currency": "USD"}
                    }]
                }]
            }],
            "capabilities": [{
                "endpoints": [{
                    "id": "x.user.profile",
                    "summary": "Profile"
                }]
            }]
        });
        let options = parse_platform_options(CatalogLane::Treg, "https://treg.to", &value);
        assert_eq!(options.len(), 1);
        let option = &options[0].option;
        assert_eq!(option.id, "x.user.profile");
        assert_eq!(option.source, "treg");
        assert_eq!(option.kind, "treg-endpoint");
        assert_eq!(option.provider.as_deref(), Some("TikHub"));
        assert_eq!(option.comparison_key.as_deref(), Some("profile"));
        assert_eq!(options[0].same_as, "tikhub:x.user.profile");
    }

    #[test]
    fn a_failed_lane_fetch_is_remembered_for_the_cooldown() {
        let path = "/catalog/platforms/cooldown-test";
        let start = Instant::now();
        assert!(!recently_failed(CatalogLane::Ryu, path, start));
        record_failure(CatalogLane::Ryu, path, Some(start));
        assert!(recently_failed(CatalogLane::Ryu, path, start));
        assert!(!recently_failed(CatalogLane::Treg, path, start));
        assert!(!recently_failed(
            CatalogLane::Ryu,
            path,
            start + FAILURE_COOLDOWN + Duration::from_secs(1)
        ));
        record_failure(CatalogLane::Ryu, path, Some(start));
        record_failure(CatalogLane::Ryu, path, None);
        assert!(!recently_failed(CatalogLane::Ryu, path, start));
    }

    /// Ryu's control plane serves the same `/catalog/*` shape; the shared
    /// browse cases are exactly what it answers for their input.
    #[test]
    fn reads_ryu_catalog_views_with_the_same_parser() {
        let cases: Value = serde_json::from_str(BROWSE_CASES).expect("browse cases");
        let platforms = cases["expected"]["platforms"]["platforms"]
            .as_array()
            .expect("platform index")
            .iter()
            .filter_map(parse_platform_summary)
            .collect::<Vec<_>>();
        let web = platforms
            .iter()
            .find(|platform| platform.slug == "web")
            .expect("web platform");
        assert_eq!(web.label, "Public web");
        assert_eq!(web.endpoints, Some(5));
        assert_eq!(web.price.as_ref().and_then(|price| price.usd), Some(0.005));

        let base = "https://api.example.test/api/tool-catalog";
        let options =
            parse_platform_options(CatalogLane::Ryu, base, &cases["expected"]["platformWeb"]);
        assert_eq!(options.len(), 5);
        let brave = options
            .iter()
            .find(|row| row.option.id == "ryu:brave.web_search")
            .expect("brave row");
        assert_eq!(brave.option.source, "ryu");
        assert_eq!(brave.option.kind, "ryu-endpoint");
        assert_eq!(brave.option.provider.as_deref(), Some("Brave"));
        assert_eq!(
            brave.option.comparison_key.as_deref(),
            Some("web/web.search")
        );
        assert_eq!(brave.option.available, Some(true));
        assert!(brave.verified);
        assert_eq!(brave.same_as, "brave:brave.web_search");
        // A base price keeps what it covers, so the store can say so.
        let exa = options
            .iter()
            .find(|row| row.option.id == "ryu:exa.search.auto")
            .and_then(|row| row.option.price.as_ref())
            .expect("exa price");
        assert_eq!(exa.basis.as_deref(), Some("base_call"));
        assert_eq!(exa.metered_by, vec!["results_over_10".to_owned()]);
        assert_eq!(
            brave
                .option
                .price
                .as_ref()
                .and_then(|price| price.basis.as_deref()),
            Some("one_call")
        );
        assert_eq!(
            brave.option.url.as_deref(),
            Some("https://api.example.test/api/tool-catalog/catalog/endpoints/brave.web_search")
        );
        let drifted = options
            .iter()
            .find(|row| row.option.id == "ryu:exa.search.fast")
            .expect("drifted row");
        assert_eq!(drifted.option.available, Some(false));
        assert!(drifted.option.availability_note.is_some());
        assert!(!drifted.verified);
    }

    fn row(source: &str, id: &str, provider: &str, verified: bool) -> CatalogOption {
        let lane = if source == "ryu" {
            CatalogLane::Ryu
        } else {
            CatalogLane::Treg
        };
        let options = parse_platform_options(
            lane,
            "https://catalog.test",
            &json!({"domains": [{"rows": [{"endpoints": [{
                "id": id,
                "provider": provider,
                "verification": {"state": if verified { "verified" } else { "unverified" }}
            }]}]}]}),
        );
        options.into_iter().next().expect("one row")
    }

    #[test]
    fn merges_both_catalogs_under_the_precedence_switch() {
        let rows = || {
            vec![
                row("treg", "brave.web_search", "brave", false),
                row("ryu", "brave.web_search", "brave", true),
                row("treg", "x.user.profile", "tikhub", false),
            ]
        };
        let ids = |options: Vec<IntegrationOption>| {
            options
                .into_iter()
                .map(|option| option.id)
                .collect::<Vec<_>>()
        };
        // Default: Ryu's verified Brave row wins; Treg's only row stays.
        assert_eq!(
            ids(merge_catalog_options(
                Vec::new(),
                rows(),
                PricePrecedence::RyuVerifiedFirst
            )),
            vec!["ryu:brave.web_search", "x.user.profile"]
        );
        assert_eq!(
            ids(merge_catalog_options(
                Vec::new(),
                rows(),
                PricePrecedence::TregFirst
            )),
            vec!["brave.web_search", "x.user.profile"]
        );
        assert_eq!(
            ids(merge_catalog_options(
                Vec::new(),
                rows(),
                PricePrecedence::RyuOnly
            )),
            vec!["ryu:brave.web_search"]
        );
        assert_eq!(
            ids(merge_catalog_options(
                Vec::new(),
                rows(),
                PricePrecedence::TregOnly
            )),
            vec!["brave.web_search", "x.user.profile"]
        );
    }

    #[test]
    fn lane_order_follows_precedence() {
        assert_eq!(
            platform_lane_order(PricePrecedence::TregFirst),
            [CatalogLane::Treg, CatalogLane::Ryu]
        );
        assert_eq!(
            platform_lane_order(PricePrecedence::default()),
            [CatalogLane::Ryu, CatalogLane::Treg]
        );
    }
}
