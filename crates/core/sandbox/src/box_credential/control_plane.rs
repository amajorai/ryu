//! [`ControlPlaneCredentialSource`]: the managed-node Box credential, minted
//! by the control plane for the org's tenant, cached, and refreshed at half
//! its lifetime.

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Result};
use reqwest::Url;
use serde::Deserialize;
use serde_json::Value;

use super::{BillingOwner, BoxCredential, BoxCredentialSource, CredentialFuture};
use crate::box_types::SecretString;

/// The control plane's base URL (`RYU_CONTROL_PLANE_URL`).
pub const ENV_CONTROL_PLANE_URL: &str = "RYU_CONTROL_PLANE_URL";
/// The node's durable control-plane key, the same credential Core sends as
/// `x-gateway-key` on every control-plane call.
pub const ENV_NODE_KEY: &str = "RYU_GATEWAY_KEY";
/// The control-plane route that mints a node's Box tenant credential.
pub const NODE_CREDENTIAL_PATH: &str = "/api/box/node-credential";
const NODE_CREDENTIAL_TIMEOUT: Duration = Duration::from_secs(10);
/// After a failed refresh, wait this long before asking again (never past
/// the cached credential's expiry).
const REFRESH_RETRY_SECS: u64 = 15;
/// Largest node-credential response read.
const MAX_NODE_CREDENTIAL_BYTES: usize = 64 * 1024;

/// Returns the node's control-plane key, or `None` when the node has none.
pub type NodeKeyProvider = Arc<dyn Fn() -> Option<String> + Send + Sync>;
/// Returns the current Unix time in seconds.
pub type UnixClock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// `POST /api/box/node-credential` (design §8.2).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NodeCredentialResponse {
    base_url: String,
    #[serde(default)]
    public_base: Option<String>,
    token: String,
    billing_owner: String,
    #[serde(default)]
    stream_ingress: Option<String>,
    expires_at: Value,
}

struct CachedCredential {
    credential: BoxCredential,
    /// Unix seconds at which the next call asks the control plane again.
    refresh_at: u64,
}

/// The managed-node credential source: the control plane mints a short-lived
/// `rbx1` tenant token for the node's org. The token is cached and refreshed
/// at 50% of its lifetime. When a refresh fails, the cached credential keeps
/// serving until it expires; after that the failure is returned.
pub struct ControlPlaneCredentialSource {
    control_plane_url: String,
    node_key: NodeKeyProvider,
    http: reqwest::Client,
    clock: UnixClock,
    cache: tokio::sync::Mutex<Option<CachedCredential>>,
}

impl fmt::Debug for ControlPlaneCredentialSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ControlPlaneCredentialSource")
            .field("control_plane_url", &self.control_plane_url)
            .finish_non_exhaustive()
    }
}

fn system_unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// `https://cp.example/api/` → `https://cp.example`: the route path carries
/// its own `/api`.
pub(super) fn normalize_control_plane_url(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    trimmed
        .strip_suffix("/api")
        .unwrap_or(trimmed)
        .trim_end_matches('/')
        .to_owned()
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

impl ControlPlaneCredentialSource {
    /// A source for `control_plane_url` (with or without a trailing `/api`)
    /// that authenticates with whatever `node_key` returns at fetch time.
    pub fn new(control_plane_url: impl AsRef<str>, node_key: NodeKeyProvider) -> Self {
        Self {
            control_plane_url: normalize_control_plane_url(control_plane_url.as_ref()),
            node_key,
            http: reqwest::Client::new(),
            clock: Arc::new(system_unix_now),
            cache: tokio::sync::Mutex::new(None),
        }
    }

    /// The source a managed node installs: `RYU_CONTROL_PLANE_URL`, keyed by
    /// `RYU_GATEWAY_KEY` (read at every fetch, so a rotated key applies).
    /// `None` when no control plane is configured.
    pub fn from_env() -> Option<Self> {
        let url = env_value(ENV_CONTROL_PLANE_URL)?;
        Some(Self::new(url, Arc::new(|| env_value(ENV_NODE_KEY))))
    }

    /// Replace the time source (tests).
    pub fn with_clock(mut self, clock: UnixClock) -> Self {
        self.clock = clock;
        self
    }

    /// Drop the cached credential so the next call asks the control plane.
    pub async fn invalidate(&self) {
        *self.cache.lock().await = None;
    }

    async fn fetch(&self, now: u64) -> Result<BoxCredential> {
        let key = (self.node_key)()
            .filter(|key| !key.trim().is_empty())
            .ok_or_else(|| {
                anyhow!("this node has no control-plane key ({ENV_NODE_KEY}) to request a Box credential with")
            })?;
        let mut header = reqwest::header::HeaderValue::from_str(key.trim())
            .map_err(|_| anyhow!("the node control-plane key is not a valid header value"))?;
        header.set_sensitive(true);
        let response = self
            .http
            .post(format!("{}{NODE_CREDENTIAL_PATH}", self.control_plane_url))
            .header("x-gateway-key", header)
            .timeout(NODE_CREDENTIAL_TIMEOUT)
            .send()
            .await
            .map_err(|error| {
                anyhow!(
                    "the Box node-credential request failed: {}",
                    error.without_url()
                )
            })?;
        let status = response.status().as_u16();
        if status != 200 && status != 201 {
            bail!("{}", node_credential_refusal(status));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_NODE_CREDENTIAL_BYTES as u64)
        {
            bail!("the Box node-credential response is too large");
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| anyhow!("the Box node-credential response could not be read"))?;
        if bytes.len() > MAX_NODE_CREDENTIAL_BYTES {
            bail!("the Box node-credential response is too large");
        }
        let parsed: NodeCredentialResponse = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow!("the Box node-credential response was invalid"))?;
        credential_from_response(parsed, now)
    }
}

/// What a non-success node-credential answer means (design §8.2).
fn node_credential_refusal(status: u16) -> String {
    match status {
        401 => "the control plane refused this node's key for a Box credential".to_owned(),
        402 => "the organization has no credit for Ryu Boxes".to_owned(),
        403 => "Ryu Boxes are not enabled for this organization's products".to_owned(),
        404 => "the Ryu Box service is not enabled for this organization".to_owned(),
        other => format!("the Box node-credential request returned HTTP {other}"),
    }
}

fn is_loopback_host(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    bare.eq_ignore_ascii_case("localhost")
        || bare
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

/// `https` (or plain `http` to a loopback host, for local development).
fn secure_or_loopback(url: &Url, secure: &str, plain: &str) -> bool {
    url.scheme() == secure || (url.scheme() == plain && is_loopback_host(url))
}

pub(super) fn credential_from_response(
    response: NodeCredentialResponse,
    now: u64,
) -> Result<BoxCredential> {
    let base_raw = response.base_url.trim().trim_end_matches('/');
    let base =
        Url::parse(base_raw).map_err(|_| anyhow!("the Box credential base URL is invalid"))?;
    if !secure_or_loopback(&base, "https", "http") || base.host_str().is_none() {
        bail!("the Box credential base URL must be https");
    }
    let direct = response
        .stream_ingress
        .as_deref()
        .is_none_or(|ingress| ingress.trim() == "direct");
    let public_base = match response.public_base.as_deref().map(str::trim) {
        Some(raw) if direct && !raw.is_empty() => {
            let url = Url::parse(raw)
                .map_err(|_| anyhow!("the Box credential public stream URL is invalid"))?;
            if !(secure_or_loopback(&url, "wss", "ws") || secure_or_loopback(&url, "https", "http"))
            {
                bail!("the Box credential public stream URL must be wss or https");
            }
            Some(url)
        }
        _ => None,
    };
    let token = response.token.trim();
    if token.is_empty()
        || token
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        bail!("the Box credential token is malformed");
    }
    let billing_owner = BillingOwner::from_wire(&response.billing_owner)?;
    let expires_at = match &response.expires_at {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => parse_rfc3339_unix(text),
        _ => None,
    }
    .ok_or_else(|| anyhow!("the Box credential expiry is invalid"))?;
    if expires_at <= now {
        bail!("the control plane returned an already expired Box credential");
    }
    Ok(BoxCredential {
        base,
        token: SecretString::new(token),
        public_base,
        billing_owner,
        expires_at: Some(expires_at),
    })
}

/// Parse an RFC 3339 UTC or offset timestamp (`2026-10-19T04:00:00.000Z`,
/// `2026-10-19T06:00:00+02:00`) into Unix seconds. Fractions are dropped.
pub fn parse_rfc3339_unix(raw: &str) -> Option<u64> {
    let raw = raw.trim();
    let bytes = raw.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't' | b' ')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = raw.get(range)?;
        if part.bytes().all(|byte| byte.is_ascii_digit()) {
            part.parse().ok()
        } else {
            None
        }
    };
    let year = number(0..4)?;
    let month = number(5..7)?;
    let day = number(8..10)?;
    let hour = number(11..13)?;
    let minute = number(14..16)?;
    let second = number(17..19)?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut rest = &raw[19..];
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        rest = &fraction[digits..];
    }
    let offset_seconds = match rest {
        "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes().first()? {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let offset = &rest[1..];
            if offset.len() != 5 || offset.as_bytes()[2] != b':' {
                return None;
            }
            let hours: i64 = offset[0..2].parse().ok()?;
            let minutes: i64 = offset[3..5].parse().ok()?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            sign * (hours * 3600 + minutes * 60)
        }
    };
    // Days from civil (Howard Hinnant's algorithm).
    let shifted_year = if month <= 2 { year - 1 } else { year };
    let era = shifted_year.div_euclid(400);
    let year_of_era = shifted_year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset_seconds;
    u64::try_from(seconds).ok()
}

impl BoxCredentialSource for ControlPlaneCredentialSource {
    fn current(&self) -> CredentialFuture<'_> {
        Box::pin(async move {
            let mut cache = self.cache.lock().await;
            let now = (self.clock)();
            if let Some(cached) = cache.as_ref() {
                if now < cached.refresh_at && !cached.credential.is_expired_at(now) {
                    return Ok(cached.credential.clone());
                }
            }
            match self.fetch(now).await {
                Ok(credential) => {
                    let expires_at = credential.expires_at.unwrap_or(now);
                    let refresh_at = now + expires_at.saturating_sub(now) / 2;
                    *cache = Some(CachedCredential {
                        credential: credential.clone(),
                        refresh_at,
                    });
                    Ok(credential)
                }
                Err(error) => match cache.as_mut() {
                    Some(cached) if !cached.credential.is_expired_at(now) => {
                        let expires_at = cached.credential.expires_at.unwrap_or(now);
                        cached.refresh_at = (now + REFRESH_RETRY_SECS).min(expires_at);
                        tracing::warn!(
                            error = %error,
                            expires_in_secs = expires_at.saturating_sub(now),
                            "Box credential refresh failed; keeping the cached credential until it expires"
                        );
                        Ok(cached.credential.clone())
                    }
                    _ => {
                        *cache = None;
                        Err(error)
                    }
                },
            }
        })
    }
}
