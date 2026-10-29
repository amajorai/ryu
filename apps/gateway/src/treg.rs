//! Treg's provider-neutral HTTP client for the Gateway tool plane.
//!
//! Discovery is public catalog metadata; execution is authenticated with the
//! fleet's vaulted Treg token. The client preserves the provider response cost
//! and transaction headers so the billing path can charge the exact call.
//!
//! Money rules this client enforces for the managed tier (see
//! `docs/treg-parity.md`, Phase A):
//!
//! - **Bounded reads.** Every Treg body is read through [`read_capped`], never
//!   `.bytes()` or `.json()`, so an oversized or endless upstream response fails
//!   with [`TregCallError::ResponseTooLarge`] instead of exhausting memory. Treg
//!   has already run and metered such a call, so the caller still charges the
//!   cost it reported; only the body is not delivered. A body cut mid-stream
//!   after the headers arrived ([`TregCallError::BodyUnreadable`]) is charged the
//!   same way.
//! - **Per-caller idempotency.** The fleet shares one Treg token, so a caller's
//!   `Idempotency-Key` is re-scoped per organization, calling app and endpoint
//!   ([`scoped_idempotency_key`]) before it reaches Treg. Two orgs, or two apps
//!   in one org, that pick the same key never replay each other's results.
//! - **Gateway-held price.** [`TregClient::price_estimate`] answers what a call
//!   will cost before it runs, from the operator's `[treg.prices]` table or
//!   Treg's catalog estimate, so an unpriced endpoint is refused rather than
//!   served free.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use reqwest::{Client, Method, Response, StatusCode};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::config::TregConfig;

const TOKEN_HEADER: &str = "X-Treg-Token";
const COST_HEADER: &str = "X-Treg-Cost-Micro";
const CALL_ID_HEADER: &str = "X-Treg-Call-Id";

/// How long a "this endpoint has no catalog price" answer is reused. Short, so
/// a newly priced endpoint becomes callable quickly, but long enough that a
/// burst of refused calls does not become a burst of catalog reads.
const UNPRICED_CACHE_TTL: Duration = Duration::from_secs(60);
/// Bound on cached price rows; the oldest half is dropped past this.
const PRICE_CACHE_MAX_ENTRIES: usize = 4096;

#[derive(Clone)]
pub struct TregClient {
    http: Client,
    token: String,
    base_url: String,
    max_response_bytes: usize,
    prices: Arc<std::collections::BTreeMap<String, u64>>,
    price_cache_ttl: Duration,
    price_cache: Arc<Mutex<HashMap<String, CachedPrice>>>,
}

#[derive(Clone, Copy)]
struct CachedPrice {
    micro_usd: Option<u64>,
    status: TregEndpointStatus,
    fetched_at: Instant,
}

/// Whether Treg can serve one endpoint, as its catalog describes it. The
/// connections layer reads this to fall back to Composio for a call Treg
/// cannot take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TregEndpointStatus {
    /// Listed and eligible for calls through the platform token.
    Servable,
    /// The catalog does not list the endpoint (`404`).
    Unknown,
    /// Listed, but marked `platform_eligible: false` (platform-blocked).
    Blocked,
    /// Listed, but scoped to the caller's own account (`scope: own_account`,
    /// such as a user's Slack workspace). The fleet token cannot act as the
    /// user, so the call belongs to a provider that holds the user's account.
    OwnAccount,
}

impl fmt::Debug for TregClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TregClient")
            .field("token", &"***")
            .field("base_url", &self.base_url)
            .field("max_response_bytes", &self.max_response_bytes)
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct TregCallResponse {
    pub status: StatusCode,
    pub body: Value,
    pub cost_micro_usd: Option<u64>,
    pub call_id: Option<String>,
}

/// Where a pre-call price came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TregPriceSource {
    /// The operator's `[treg.prices]` row.
    Operator,
    /// Treg's own catalog `cost.usd` for the endpoint.
    Catalog,
}

/// A failed Treg call. Kept typed so the overflow case reaches the caller with
/// the cost Treg reported rather than as a generic provider failure.
#[derive(Debug)]
pub enum TregCallError {
    /// The response body exceeded `max_response_bytes`. Treg has already run
    /// and metered the call, so its status, call id and reported cost are kept:
    /// the caller charges them even though the body is not delivered.
    ResponseTooLarge {
        limit_bytes: usize,
        status: StatusCode,
        call_id: Option<String>,
        cost_micro_usd: Option<u64>,
    },
    /// The response headers arrived (Treg ran and metered the call) but the body
    /// could not be read: the connection was cut mid-stream. The status, call id
    /// and reported cost are kept for the same reason as
    /// [`TregCallError::ResponseTooLarge`]: the caller still charges them, or a
    /// peer that cuts the body would get metered calls free.
    BodyUnreadable {
        status: StatusCode,
        call_id: Option<String>,
        cost_micro_usd: Option<u64>,
        source: anyhow::Error,
    },
    Request(anyhow::Error),
}

/// Why a pre-call price could not be answered.
#[derive(Debug)]
pub enum TregPriceError {
    /// The endpoint id is not a valid Treg path segment: a caller error.
    InvalidEndpoint,
    /// The catalog could not be read (transport, 5xx, unreadable body): an
    /// accounting outage, never a price.
    Unavailable(anyhow::Error),
}

impl fmt::Display for TregPriceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidEndpoint => write!(f, "Treg endpoint id is invalid"),
            Self::Unavailable(error) => write!(f, "{error:#}"),
        }
    }
}

impl std::error::Error for TregPriceError {}

/// Who one Treg call is made for. The Gateway reaches Treg through one fleet
/// token, so these together scope the vendor-facing idempotency key.
#[derive(Debug, Clone, Copy, Default)]
pub struct TregCallScope<'a> {
    /// The billed organization; also sent as Treg's customer tag.
    pub org_id: Option<&'a str>,
    /// The Core-authenticated app that made the call, set by Core and never by
    /// the app itself.
    pub caller_id: Option<&'a str>,
    /// The caller's idempotency key, before re-scoping.
    pub idempotency_key: Option<&'a str>,
}

impl fmt::Display for TregCallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ResponseTooLarge { limit_bytes, .. } => {
                write!(
                    f,
                    "Treg response exceeded the {limit_bytes}-byte read limit"
                )
            }
            Self::BodyUnreadable { source, .. } => write!(f, "{source:#}"),
            Self::Request(error) => write!(f, "{error:#}"),
        }
    }
}

impl std::error::Error for TregCallError {}

impl TregClient {
    pub fn from_config(config: &TregConfig, http: Client) -> Option<Self> {
        let token = config
            .token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())?;
        Some(Self {
            http,
            token: token.to_owned(),
            base_url: config.base_url.trim_end_matches('/').to_owned(),
            max_response_bytes: config.max_response_bytes.max(1),
            prices: Arc::new(config.prices.clone()),
            price_cache_ttl: Duration::from_secs(config.price_cache_secs),
            price_cache: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn is_configured(&self) -> bool {
        !self.token.is_empty() && !self.base_url.is_empty()
    }

    pub async fn discover(&self, _platform: &str) -> Result<Value> {
        // Treg exposes the public platform catalog as one collection. Callers may
        // filter the returned `platforms` array by slug; there is no per-platform
        // `/catalog/platforms/<slug>` route.
        self.get_json("/catalog/platforms").await
    }

    pub async fn describe(&self, endpoint_id: &str) -> Result<Value> {
        self.get_json(&format!("/catalog/endpoints/{}", segment(endpoint_id)?))
            .await
    }

    /// The raw per-call price (micro-USD, before Ryu markup) the Gateway holds
    /// for `endpoint_id`, and where it came from. `Ok(None)` means neither the
    /// operator table nor Treg's catalog prices the endpoint, including an
    /// endpoint the catalog does not know (`404`); the managed tier refuses such
    /// a call as unpriced. [`TregPriceError::InvalidEndpoint`] is a caller error;
    /// [`TregPriceError::Unavailable`] means the catalog could not be read, which
    /// is an accounting outage, not a free call.
    pub async fn price_estimate(
        &self,
        endpoint_id: &str,
    ) -> Result<Option<(u64, TregPriceSource)>, TregPriceError> {
        let endpoint_id = segment(endpoint_id).map_err(|_| TregPriceError::InvalidEndpoint)?;
        if let Some(price) = self.prices.get(endpoint_id) {
            return Ok(Some((*price, TregPriceSource::Operator)));
        }
        let facts = self.endpoint_facts(endpoint_id).await?;
        Ok(facts
            .micro_usd
            .map(|price| (price, TregPriceSource::Catalog)))
    }

    /// Whether Treg can serve `endpoint_id`. An operator `[treg.prices]` row
    /// vouches for its endpoint without a catalog read; otherwise the catalog
    /// decides (unlisted, platform-blocked or servable). Shares the price
    /// cache, so routing a call and pricing it cost one catalog read.
    pub async fn endpoint_status(
        &self,
        endpoint_id: &str,
    ) -> Result<TregEndpointStatus, TregPriceError> {
        let endpoint_id = segment(endpoint_id).map_err(|_| TregPriceError::InvalidEndpoint)?;
        if self.prices.contains_key(endpoint_id) {
            return Ok(TregEndpointStatus::Servable);
        }
        Ok(self.endpoint_facts(endpoint_id).await?.status)
    }

    /// What Treg's catalog says about `endpoint_id`, ignoring the operator's
    /// `[treg.prices]` table. A price row says what a call costs, never that the
    /// fleet token may run it: a platform-blocked or own-account endpoint stays
    /// that way however it is priced. The execution path uses this, so a named
    /// provider cannot reach an endpoint [`TregClient::endpoint_status`] would
    /// have routed away from. Shares the price cache.
    pub async fn catalog_status(
        &self,
        endpoint_id: &str,
    ) -> Result<TregEndpointStatus, TregPriceError> {
        let endpoint_id = segment(endpoint_id).map_err(|_| TregPriceError::InvalidEndpoint)?;
        Ok(self.endpoint_facts(endpoint_id).await?.status)
    }

    async fn endpoint_facts(&self, endpoint_id: &str) -> Result<CachedPrice, TregPriceError> {
        if let Some(cached) = self.cached_price(endpoint_id) {
            return Ok(cached);
        }
        let detail = self
            .get_json_unless_missing(&format!("/catalog/endpoints/{endpoint_id}"))
            .await
            .map_err(TregPriceError::Unavailable)?;
        let price = detail
            .as_ref()
            .and_then(|detail| catalog_price_micro_usd(detail, endpoint_id));
        let status = detail
            .as_ref()
            .map_or(TregEndpointStatus::Unknown, catalog_endpoint_status);
        Ok(self.store_price(endpoint_id, price, status))
    }

    fn cached_price(&self, endpoint_id: &str) -> Option<CachedPrice> {
        let cache = self.price_cache.lock().ok()?;
        let cached = cache.get(endpoint_id)?;
        let ttl = if cached.micro_usd.is_some() {
            self.price_cache_ttl
        } else {
            UNPRICED_CACHE_TTL.min(self.price_cache_ttl)
        };
        (cached.fetched_at.elapsed() < ttl).then_some(*cached)
    }

    fn store_price(
        &self,
        endpoint_id: &str,
        micro_usd: Option<u64>,
        status: TregEndpointStatus,
    ) -> CachedPrice {
        let entry = CachedPrice {
            micro_usd,
            status,
            fetched_at: Instant::now(),
        };
        let Ok(mut cache) = self.price_cache.lock() else {
            return entry;
        };
        if cache.len() >= PRICE_CACHE_MAX_ENTRIES {
            let mut ages: Vec<(String, Instant)> = cache
                .iter()
                .map(|(key, value)| (key.clone(), value.fetched_at))
                .collect();
            ages.sort_by_key(|(_, fetched_at)| *fetched_at);
            for (key, _) in ages.into_iter().take(PRICE_CACHE_MAX_ENTRIES / 2) {
                cache.remove(&key);
            }
        }
        cache.insert(endpoint_id.to_owned(), entry);
        entry
    }

    /// Execute one metered Treg endpoint call.
    ///
    /// The scope's idempotency key is re-scoped to the billed organization, the
    /// calling app and the endpoint before it is sent, so Treg never sees a raw
    /// caller key shared across the fleet token.
    pub async fn call(
        &self,
        endpoint_id: &str,
        method: Method,
        query: &[(String, String)],
        body: Option<&Value>,
        scope: TregCallScope<'_>,
    ) -> Result<TregCallResponse, TregCallError> {
        let endpoint_id = segment(endpoint_id).map_err(TregCallError::Request)?;
        let url = format!("{}/call/{endpoint_id}", self.base_url);
        let mut request = self
            .http
            .request(method, url)
            .header(TOKEN_HEADER, &self.token)
            .header("X-Treg-Client", "ryu-gateway")
            .query(query);
        if let Some(idempotency_key) = scope
            .idempotency_key
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            request = request.header(
                "Idempotency-Key",
                scoped_idempotency_key(scope.org_id, scope.caller_id, endpoint_id, idempotency_key),
            );
        }
        if let Some(customer_id) = scope.org_id.and_then(treg_customer_tag) {
            request = request.header("X-Treg-Meta", format!("customer={customer_id}"));
        }
        if let Some(body) = body {
            request = request.json(body);
        }

        let response = request
            .send()
            .await
            .context("Treg call request failed")
            .map_err(TregCallError::Request)?;
        let status = response.status();
        let cost_micro_usd = response
            .headers()
            .get(COST_HEADER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok());
        let call_id = response
            .headers()
            .get(CALL_ID_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let bytes = match read_capped(response, self.max_response_bytes).await {
            Ok(bytes) => bytes,
            Err(ReadError::TooLarge) => {
                return Err(TregCallError::ResponseTooLarge {
                    limit_bytes: self.max_response_bytes,
                    status,
                    call_id,
                    cost_micro_usd,
                })
            }
            Err(ReadError::Transport(error)) => {
                return Err(TregCallError::BodyUnreadable {
                    status,
                    call_id,
                    cost_micro_usd,
                    source: anyhow::Error::new(error)
                        .context("Treg call response could not be read"),
                })
            }
        };
        let body = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
        Ok(TregCallResponse {
            status,
            body,
            cost_micro_usd,
            call_id,
        })
    }

    async fn get_json(&self, path: &str) -> Result<Value> {
        self.get_json_unless_missing(path)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Treg catalog failed: HTTP {}", StatusCode::NOT_FOUND))
    }

    /// A catalog read where `404` is an answer (`Ok(None)`: Treg does not know
    /// the path), not an outage. Any other non-success status is an error.
    async fn get_json_unless_missing(&self, path: &str) -> Result<Option<Value>> {
        let url = format!("{}{}", self.base_url, path);
        let response = self
            .http
            .get(url)
            .header(TOKEN_HEADER, &self.token)
            .header("X-Treg-Client", "ryu-gateway")
            .send()
            .await
            .context("Treg catalog request failed")?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            anyhow::bail!("Treg catalog failed: HTTP {status}");
        }
        let bytes = match read_capped(response, self.max_response_bytes).await {
            Ok(bytes) => bytes,
            Err(ReadError::TooLarge) => anyhow::bail!(
                "Treg catalog response exceeded the {}-byte read limit",
                self.max_response_bytes
            ),
            Err(ReadError::Transport(error)) => {
                return Err(anyhow::Error::new(error).context("Treg catalog response failed"))
            }
        };
        serde_json::from_slice(&bytes)
            .map(Some)
            .context("Treg catalog response was not JSON")
    }
}

#[derive(Debug)]
enum ReadError {
    TooLarge,
    Transport(reqwest::Error),
}

/// Read a response body, refusing more than `limit` bytes. A declared
/// `Content-Length` above the limit is refused before any body byte is read;
/// an undeclared or chunked body is counted as it arrives and abandoned the
/// moment it crosses the limit.
async fn read_capped(mut response: Response, limit: usize) -> Result<Vec<u8>, ReadError> {
    if response
        .content_length()
        .is_some_and(|declared| declared > limit as u64)
    {
        return Err(ReadError::TooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(ReadError::Transport)? {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(ReadError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// The vendor-facing idempotency key for a caller's key.
///
/// The Gateway reaches Treg through one fleet token, so Treg's idempotency
/// scope is the fleet, not the customer. Sending the caller's key verbatim
/// would let org B replay (and read) org A's stored result by guessing A's key,
/// and one org's apps share that org. Hashing the org, the calling app (set by
/// Core from the authenticated sidecar), the endpoint and the key together,
/// length-prefixed so `("a", "bc")` and `("ab", "c")` differ, gives each
/// org/app/endpoint a disjoint key space while keeping a retry by the same
/// caller on the same key idempotent. A caller with no org (a standalone
/// Gateway on its own token) gets the `local` scope; no app id is `-`.
pub fn scoped_idempotency_key(
    org_id: Option<&str>,
    caller_id: Option<&str>,
    endpoint_id: &str,
    caller_key: &str,
) -> String {
    fn or_default<'a>(value: Option<&'a str>, default: &'a str) -> &'a str {
        value
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(default)
    }
    let mut hash = Sha256::new();
    for field in [
        "ryu-treg-idempotency-v1",
        or_default(org_id, "local"),
        or_default(caller_id, "-"),
        endpoint_id.trim(),
        caller_key.trim(),
    ] {
        hash.update((field.len() as u64).to_be_bytes());
        hash.update(field.as_bytes());
    }
    format!("ryu-{}", &hex::encode(hash.finalize())[..48])
}

/// Treg's catalog estimate for one endpoint, in raw micro-USD per call, from an
/// endpoint detail body (`{"endpoint": {"id": …, "cost": {"usd": …}}}`).
///
/// `None` for a body about a different endpoint, a missing, non-finite,
/// negative or non-USD cost, a cost billed per some unit other than the call,
/// or a cost quoted per a batch of calls (`per` other than 1): a per-unit or
/// per-batch price is not a per-call estimate, and reading `usd` as one would
/// misprice the call by the batch size. The operator prices such an endpoint
/// with a `[treg.prices]` row. A catalog price of exactly zero is `Some(0)`, an
/// explicit free endpoint, distinct from unknown.
pub fn catalog_price_micro_usd(detail: &Value, endpoint_id: &str) -> Option<u64> {
    let endpoint = detail.get("endpoint").unwrap_or(detail);
    if endpoint
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| id.trim() != endpoint_id)
    {
        return None;
    }
    let cost = endpoint.get("cost")?;
    if cost
        .get("currency")
        .and_then(Value::as_str)
        .is_some_and(|currency| !currency.trim().eq_ignore_ascii_case("usd"))
    {
        return None;
    }
    if cost
        .get("unit")
        .and_then(Value::as_str)
        .is_some_and(|unit| !unit.trim().eq_ignore_ascii_case("call"))
    {
        return None;
    }
    if let Some(per) = cost.get("per") {
        if per.as_f64() != Some(1.0) {
            return None;
        }
    }
    let usd = cost.get("usd").and_then(Value::as_f64)?;
    if !usd.is_finite() || !(0.0..=1_000_000.0).contains(&usd) {
        return None;
    }
    // Ceil: an estimate that rounds a fraction of a micro-dollar down would
    // reserve and charge less than the provider bills.
    Some((usd * 1_000_000.0).ceil() as u64)
}

/// Whether an endpoint detail body (`{"endpoint": {…}}`) describes a callable
/// endpoint. Treg marks a platform-blocked endpoint `platform_eligible: false`
/// (an absent flag means eligible) and a user-account endpoint
/// `scope: own_account`.
pub fn catalog_endpoint_status(detail: &Value) -> TregEndpointStatus {
    let endpoint = detail.get("endpoint").unwrap_or(detail);
    if endpoint.get("platform_eligible").and_then(Value::as_bool) == Some(false) {
        return TregEndpointStatus::Blocked;
    }
    if endpoint.get("scope").and_then(Value::as_str) == Some("own_account") {
        return TregEndpointStatus::OwnAccount;
    }
    TregEndpointStatus::Servable
}

fn treg_customer_tag(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':')))
    .then_some(value)
}

/// A Treg endpoint id as a URL path segment. Only `[A-Za-z0-9._:-]` passes, so
/// the id cannot carry a `%` escape the server would decode, a `?` query or a
/// `#` fragment, and a segment of dots alone cannot walk the path.
fn segment(value: &str) -> Result<&str> {
    let value = value.trim();
    if value.is_empty()
        || value.bytes().all(|byte| byte == b'.')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
    {
        anyhow::bail!("Treg path segment is invalid");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::{
        body::Body,
        extract::State,
        http::{HeaderMap, Response as HttpResponse},
        routing::{get, post},
        Router,
    };
    use serde_json::json;

    use super::*;
    use crate::config::TregConfig;

    fn client_for(base_url: &str, configure: impl FnOnce(&mut TregConfig)) -> TregClient {
        let mut config = TregConfig {
            enabled: true,
            base_url: base_url.to_owned(),
            token: Some("secret-treg-token".to_owned()),
            ..TregConfig::default()
        };
        configure(&mut config);
        TregClient::from_config(&config, Client::new()).expect("configured client")
    }

    async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (format!("http://{address}"), task)
    }

    #[test]
    fn client_debug_redacts_token() {
        let client = client_for("https://treg.to", |_| {});
        let debug = format!("{client:?}");
        assert!(!debug.contains("secret-treg-token"));
        assert!(debug.contains("***"));
    }

    #[test]
    fn path_segments_reject_traversal_and_control_characters() {
        assert!(segment("x.post.create").is_ok());
        assert!(segment("../private").is_err());
        assert!(segment("x\\npost").is_err());
        assert!(segment("..").is_err());
    }

    #[test]
    fn path_segments_reject_escapes_queries_and_fragments() {
        assert!(segment("vendor:tool_v2-beta").is_ok());
        for invalid in [
            "x.post.%41BC",
            "x.post.create?note=1",
            "x.post.create#frag",
            "x post",
            "x.post.cr\u{e9}ate",
        ] {
            assert!(segment(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn idempotency_keys_are_disjoint_per_org_app_and_endpoint_and_stable_per_retry() {
        let key = |org: Option<&str>, app: Option<&str>, endpoint: &str, caller_key: &str| {
            scoped_idempotency_key(org, app, endpoint, caller_key)
        };
        let alpha = key(
            Some("org-alpha"),
            Some("@ryu/social"),
            "x.post.create",
            "publish-1",
        );
        let beta = key(
            Some("org-beta"),
            Some("@ryu/social"),
            "x.post.create",
            "publish-1",
        );
        assert_ne!(alpha, beta, "two orgs on one key must not share a replay");
        assert_ne!(
            alpha,
            key(
                Some("org-alpha"),
                Some("@acme/other"),
                "x.post.create",
                "publish-1"
            ),
            "two apps in one org on one key must not share a replay"
        );
        assert_ne!(
            alpha,
            key(
                Some("org-alpha"),
                Some("@ryu/social"),
                "x.dm.send",
                "publish-1"
            ),
            "one key on two endpoints is two calls"
        );
        assert_eq!(
            alpha,
            key(
                Some(" org-alpha "),
                Some(" @ryu/social "),
                " x.post.create ",
                " publish-1 "
            ),
            "a retry by the same caller on the same key stays idempotent"
        );
        assert!(
            !alpha.contains("publish-1"),
            "the raw caller key never leaves"
        );
        assert!(!alpha.contains("org-alpha"), "the org id never leaves");
        // Length-prefixing keeps field boundaries: ("a","bc") != ("ab","c").
        assert_ne!(
            key(Some("a"), None, "e", "bc"),
            key(Some("ab"), None, "e", "c")
        );
        assert_eq!(
            key(None, None, "e", "k"),
            key(Some("  "), Some(" "), "e", "k")
        );
        assert!(alpha.starts_with("ryu-") && alpha.len() == 52);
    }

    #[test]
    fn catalog_price_reads_only_a_per_call_usd_estimate_for_the_named_endpoint() {
        let detail = |cost: Value| json!({"endpoint": {"id": "x.post.create", "cost": cost}});
        assert_eq!(
            catalog_price_micro_usd(&detail(json!({"usd": 0.015})), "x.post.create"),
            Some(15_000)
        );
        // Fractions of a micro-dollar round up, never down.
        assert_eq!(
            catalog_price_micro_usd(&detail(json!({"usd": 0.000_000_1})), "x.post.create"),
            Some(1)
        );
        assert_eq!(
            catalog_price_micro_usd(
                &detail(json!({"usd": 0.0, "unit": "call", "currency": "USD"})),
                "x.post.create"
            ),
            Some(0),
            "an explicit zero is a free endpoint, distinct from unknown"
        );
        assert_eq!(
            catalog_price_micro_usd(
                &detail(json!({"usd": 0.015, "per": 1, "unit": "call"})),
                "x.post.create"
            ),
            Some(15_000),
            "a price per one call is a per-call price"
        );
        for unpriced in [
            json!({}),
            json!({"usd": -1.0}),
            // A price per a batch of calls is not a per-call estimate: read as
            // one it would quote 1000x the real per-call price.
            json!({"usd": 0.5, "per": 1000, "unit": "call"}),
            json!({"usd": 0.5, "per": "1000", "unit": "call"}),
            json!({"usd": 0.5, "per": 0}),
            json!({"usd": "0.01"}),
            json!({"usd": 0.01, "unit": "1k tokens"}),
            json!({"usd": 0.01, "currency": "EUR"}),
        ] {
            assert_eq!(
                catalog_price_micro_usd(&detail(unpriced.clone()), "x.post.create"),
                None,
                "{unpriced}"
            );
        }
        assert_eq!(
            catalog_price_micro_usd(&detail(json!({"usd": 0.01})), "x.post.delete"),
            None,
            "a detail for another endpoint never prices this one"
        );
        assert_eq!(
            catalog_price_micro_usd(
                &json!({"endpoint": {"id": "x.post.create"}}),
                "x.post.create"
            ),
            None
        );
    }

    #[tokio::test]
    async fn oversized_and_chunked_responses_fail_with_a_typed_error() {
        let router = Router::new()
            .route(
                "/call/declared",
                post(|| async {
                    HttpResponse::builder()
                        .header(CALL_ID_HEADER, "treg-call-1")
                        .header(COST_HEADER, "1500")
                        .body(Body::from(vec![b'a'; 64]))
                        .unwrap()
                }),
            )
            .route(
                "/call/streamed",
                post(|| async {
                    let chunks = (0..8).map(|_| Ok::<_, std::io::Error>(vec![b'b'; 16]));
                    HttpResponse::builder()
                        .body(Body::from_stream(futures_util::stream::iter(chunks)))
                        .unwrap()
                }),
            )
            .route(
                "/call/fits",
                post(|| async { axum::Json(json!({"ok": true})) }),
            );
        let (base, server) = serve(router).await;
        let client = client_for(&base, |config| config.max_response_bytes = 32);

        let declared = client
            .call(
                "declared",
                Method::POST,
                &[],
                None,
                TregCallScope {
                    org_id: Some("org-a"),
                    ..TregCallScope::default()
                },
            )
            .await
            .expect_err("a declared body over the cap is refused");
        let TregCallError::ResponseTooLarge {
            limit_bytes,
            status,
            call_id,
            cost_micro_usd,
        } = declared
        else {
            panic!("expected ResponseTooLarge, got {declared:?}");
        };
        assert_eq!(limit_bytes, 32);
        assert_eq!(status, StatusCode::OK, "Treg's status is kept for charging");
        assert_eq!(call_id.as_deref(), Some("treg-call-1"));
        assert_eq!(cost_micro_usd, Some(1500));

        let streamed = client
            .call(
                "streamed",
                Method::POST,
                &[],
                None,
                TregCallScope::default(),
            )
            .await
            .expect_err("an undeclared body is cut off at the cap");
        assert!(matches!(streamed, TregCallError::ResponseTooLarge { .. }));
        assert!(streamed.to_string().contains("32-byte"));

        let fits = client
            .call("fits", Method::POST, &[], None, TregCallScope::default())
            .await
            .expect("a body under the cap is read");
        assert_eq!(fits.body, json!({"ok": true}));
        server.abort();
    }

    #[tokio::test]
    async fn a_body_cut_after_the_headers_keeps_the_cost_and_call_id_for_charging() {
        // Treg answers with its metering headers, then the connection drops
        // mid-body: the call ran and was metered, so the cost must survive.
        let router = Router::new().route(
            "/call/cut",
            post(|| async {
                let chunks = vec![
                    Ok::<_, std::io::Error>(b"{\"partial\":".to_vec()),
                    Err(std::io::Error::new(
                        std::io::ErrorKind::ConnectionReset,
                        "cut",
                    )),
                ];
                HttpResponse::builder()
                    .header(CALL_ID_HEADER, "treg-call-cut")
                    .header(COST_HEADER, "2500")
                    .body(Body::from_stream(futures_util::StreamExt::then(
                        futures_util::stream::iter(chunks),
                        |chunk| async move {
                            // Give the head and the first chunk time to reach the peer
                            // before the cut: an immediate error aborts the connection
                            // before anything is flushed.
                            if chunk.is_err() {
                                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                            }
                            chunk
                        },
                    )))
                    .unwrap()
            }),
        );
        let (base, server) = serve(router).await;
        let client = client_for(&base, |_| {});
        let error = client
            .call("cut", Method::POST, &[], None, TregCallScope::default())
            .await
            .expect_err("a body cut mid-stream is an error");
        let TregCallError::BodyUnreadable {
            status,
            call_id,
            cost_micro_usd,
            ..
        } = error
        else {
            panic!("expected BodyUnreadable, got {error:?}");
        };
        assert_eq!(status, StatusCode::OK);
        assert_eq!(call_id.as_deref(), Some("treg-call-cut"));
        assert_eq!(cost_micro_usd, Some(2500));
        server.abort();
    }

    #[tokio::test]
    async fn call_sends_the_caller_scoped_idempotency_key_not_the_raw_one() {
        let (seen_tx, mut seen_rx) = tokio::sync::mpsc::unbounded_channel::<Option<String>>();
        let router = Router::new()
            .route(
                "/call/:id",
                post(
                    |State(seen): State<tokio::sync::mpsc::UnboundedSender<Option<String>>>,
                     headers: HeaderMap| async move {
                        seen.send(
                            headers
                                .get("idempotency-key")
                                .and_then(|value| value.to_str().ok())
                                .map(str::to_owned),
                        )
                        .unwrap();
                        axum::Json(json!({}))
                    },
                ),
            )
            .with_state(seen_tx);
        let (base, server) = serve(router).await;
        let client = client_for(&base, |_| {});
        for org in ["org-alpha", "org-beta"] {
            client
                .call(
                    "x.post.create",
                    Method::POST,
                    &[],
                    None,
                    TregCallScope {
                        org_id: Some(org),
                        caller_id: Some("@ryu/social"),
                        idempotency_key: Some("k-1"),
                    },
                )
                .await
                .unwrap();
        }
        client
            .call(
                "x.post.create",
                Method::POST,
                &[],
                None,
                TregCallScope {
                    org_id: Some("org-alpha"),
                    caller_id: None,
                    idempotency_key: Some("  "),
                },
            )
            .await
            .unwrap();
        let alpha = seen_rx.recv().await.unwrap().unwrap();
        let beta = seen_rx.recv().await.unwrap().unwrap();
        assert_eq!(
            alpha,
            scoped_idempotency_key(
                Some("org-alpha"),
                Some("@ryu/social"),
                "x.post.create",
                "k-1"
            )
        );
        assert_eq!(
            beta,
            scoped_idempotency_key(
                Some("org-beta"),
                Some("@ryu/social"),
                "x.post.create",
                "k-1"
            )
        );
        assert_ne!(alpha, "k-1");
        assert_eq!(
            seen_rx.recv().await.unwrap(),
            None,
            "a blank key is not sent"
        );
        server.abort();
    }

    #[tokio::test]
    async fn price_estimate_prefers_the_operator_table_then_caches_the_catalog() {
        let reads = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&reads);
        let router = Router::new().route(
            "/catalog/endpoints/:id",
            get(
                move |axum::extract::Path(id): axum::extract::Path<String>| {
                    let counter = Arc::clone(&counter);
                    async move {
                        use axum::response::IntoResponse;
                        counter.fetch_add(1, Ordering::SeqCst);
                        match id.as_str() {
                            "retired" => axum::http::StatusCode::NOT_FOUND.into_response(),
                            "broken" => {
                                axum::http::StatusCode::INTERNAL_SERVER_ERROR.into_response()
                            }
                            "priced" => axum::Json(json!({"endpoint": {
                                "id": id, "cost": {"usd": 0.002, "unit": "call"}
                            }}))
                            .into_response(),
                            _ => axum::Json(json!({"endpoint": {"id": id, "cost": {}}}))
                                .into_response(),
                        }
                    }
                },
            ),
        );
        let (base, server) = serve(router).await;
        let client = client_for(&base, |config| {
            config.prices.insert("operator".to_owned(), 7_000);
        });
        assert_eq!(
            client.price_estimate("operator").await.unwrap(),
            Some((7_000, TregPriceSource::Operator))
        );
        assert_eq!(
            reads.load(Ordering::SeqCst),
            0,
            "operator rows need no read"
        );
        for _ in 0..3 {
            assert_eq!(
                client.price_estimate("priced").await.unwrap(),
                Some((2_000, TregPriceSource::Catalog))
            );
        }
        assert_eq!(
            reads.load(Ordering::SeqCst),
            1,
            "the catalog price is cached"
        );
        assert_eq!(client.price_estimate("unpriced").await.unwrap(), None);
        assert_eq!(client.price_estimate("unpriced").await.unwrap(), None);
        assert_eq!(
            reads.load(Ordering::SeqCst),
            2,
            "an unpriced answer is cached too"
        );
        // An endpoint the catalog does not know is unpriced (a 403 upstream of
        // here), not an accounting outage.
        assert_eq!(client.price_estimate("retired").await.unwrap(), None);
        // An invalid id is the caller's error, and never reaches the catalog.
        let reads_before = reads.load(Ordering::SeqCst);
        assert!(matches!(
            client.price_estimate("../escape").await,
            Err(TregPriceError::InvalidEndpoint)
        ));
        assert_eq!(reads.load(Ordering::SeqCst), reads_before);
        // A failing catalog is an outage, never a price.
        assert!(matches!(
            client.price_estimate("broken").await,
            Err(TregPriceError::Unavailable(_))
        ));
        server.abort();

        // An unreachable catalog is an outage, never a free call.
        let offline = client_for("http://127.0.0.1:1", |_| {});
        assert!(matches!(
            offline.price_estimate("priced").await,
            Err(TregPriceError::Unavailable(_))
        ));
    }

    #[tokio::test]
    async fn endpoint_status_reads_listing_and_platform_eligibility() {
        let reads = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&reads);
        let router = Router::new().route(
            "/catalog/endpoints/:id",
            get(
                move |axum::extract::Path(id): axum::extract::Path<String>| {
                    let counter = Arc::clone(&counter);
                    async move {
                        use axum::response::IntoResponse;
                        counter.fetch_add(1, Ordering::SeqCst);
                        match id.as_str() {
                            "missing" => axum::http::StatusCode::NOT_FOUND.into_response(),
                            "blocked" => axum::Json(json!({"endpoint": {
                                "id": id, "platform_eligible": false,
                                "cost": {"usd": 0.001, "unit": "call"}
                            }}))
                            .into_response(),
                            "own" => axum::Json(json!({"endpoint": {
                                "id": id, "platform_eligible": true, "scope": "own_account",
                                "cost": {"usd": 0.001, "unit": "call"}
                            }}))
                            .into_response(),
                            _ => axum::Json(json!({"endpoint": {
                                "id": id, "platform_eligible": true, "scope": "any_account",
                                "cost": {"usd": 0.001, "unit": "call"}
                            }}))
                            .into_response(),
                        }
                    }
                },
            ),
        );
        let (base, server) = serve(router).await;
        let client = client_for(&base, |config| {
            config.prices.insert("operator".to_owned(), 7_000);
        });
        assert_eq!(
            client.endpoint_status("operator").await.unwrap(),
            TregEndpointStatus::Servable
        );
        assert_eq!(
            reads.load(Ordering::SeqCst),
            0,
            "operator rows need no read"
        );
        assert_eq!(
            client.endpoint_status("listed").await.unwrap(),
            TregEndpointStatus::Servable
        );
        // Routing then pricing the same endpoint costs one catalog read.
        assert_eq!(
            client.price_estimate("listed").await.unwrap(),
            Some((1_000, TregPriceSource::Catalog))
        );
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert_eq!(
            client.endpoint_status("missing").await.unwrap(),
            TregEndpointStatus::Unknown
        );
        assert_eq!(
            client.endpoint_status("blocked").await.unwrap(),
            TregEndpointStatus::Blocked
        );
        assert_eq!(
            client.endpoint_status("own").await.unwrap(),
            TregEndpointStatus::OwnAccount
        );
        assert!(matches!(
            client.endpoint_status("../escape").await,
            Err(TregPriceError::InvalidEndpoint)
        ));
        server.abort();
    }
}
