//! Verified per-request user attribution on hosted `rgw_` traffic (contract C3).
//!
//! An `rgw_` bearer proves which ORG a request belongs to, not which person.
//! A trusted Core node therefore forwards the caller's Better Auth JWT as
//! `x-ryu-user-jwt`; this module verifies it offline against the control
//! plane's JWKS (`{control_plane}/api/auth/jwks`) and, only when the token's
//! `orgs` include the resolved org, yields the user id and that org's team ids.
//! The unverified `x-ryu-user-id` header is never trusted on this path.
//!
//! Verification mirrors Core's `identity_verify` (fail-closed throughout):
//! EdDSA (Ed25519) only, a non-empty `kid` selecting a cached JWKS key (an
//! unknown `kid` forces at most one refresh per throttle window), and `exp`,
//! `iss`, and `aud` all checked. `iss`/`aud` must equal the Better Auth base
//! URL: `RYU_AUTH_BASE_URL`, else `CONTROL_PLANE_URL`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use tokio::sync::RwLock;

/// Trust a fetched key set this long before refreshing.
const JWKS_TTL: Duration = Duration::from_secs(60 * 60);
/// Minimum spacing between network refreshes on the slow path, so a flood of
/// unknown `kid`s (attacker-controlled before verification) costs one fetch.
const MIN_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
/// Clock skew tolerated on `exp` / `nbf`, matching `jsonwebtoken`'s default.
const LEEWAY_SECS: i64 = 60;
/// A Better Auth JWT is well under this; anything larger is not one.
const MAX_TOKEN_BYTES: usize = 8 * 1024;
const MAX_JWKS_BYTES: usize = 256 * 1024;

/// The verified caller, narrowed to the resolved org.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedUser {
    pub user_id: String,
    /// Teams the user belongs to inside the resolved org only.
    pub team_ids: Vec<String>,
}

/// Why a token was not accepted. Every variant means "no verified user".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JwtError {
    Malformed,
    UnsupportedAlg,
    MissingKid,
    UnknownKid,
    JwksUnavailable,
    InsecureJwksUrl,
    InvalidSignature,
    Expired,
    NotYetValid,
    InvalidIssuer,
    InvalidAudience,
    MissingSubject,
    /// Valid token, but the user is not a member of the resolved org.
    NotInOrg,
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    #[serde(default)]
    kid: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Audience {
    One(String),
    Many(Vec<String>),
}

#[derive(Deserialize)]
struct Claims {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    sub: Option<String>,
    #[serde(default)]
    iss: Option<String>,
    #[serde(default)]
    aud: Option<Audience>,
    #[serde(default)]
    exp: Option<i64>,
    #[serde(default)]
    nbf: Option<i64>,
    #[serde(default)]
    orgs: Vec<ClaimOrg>,
    #[serde(default)]
    teams: Vec<ClaimTeam>,
}

#[derive(Deserialize)]
struct ClaimOrg {
    id: String,
}

#[derive(Deserialize)]
struct ClaimTeam {
    id: String,
    #[serde(default)]
    org: String,
}

#[derive(Deserialize)]
struct JwkSet {
    #[serde(default)]
    keys: Vec<Jwk>,
}

#[derive(Deserialize)]
struct Jwk {
    #[serde(default)]
    kty: String,
    #[serde(default)]
    crv: String,
    #[serde(default)]
    x: String,
    #[serde(default)]
    kid: Option<String>,
}

#[derive(Default)]
struct KeyCache {
    keys: HashMap<String, Arc<VerifyingKey>>,
    fetched_at: Option<Instant>,
    last_attempt: Option<Instant>,
}

/// Verifies forwarded user JWTs against the control plane's JWKS.
pub struct UserJwtVerifier {
    jwks_url: String,
    issuer: String,
    http: reqwest::Client,
    cache: RwLock<KeyCache>,
    refresh: tokio::sync::Mutex<()>,
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_owned())
        .filter(|value| !value.is_empty())
}

impl UserJwtVerifier {
    /// Build from environment. `None` without a control plane — the dynamic
    /// `rgw_` path is inert then anyway.
    pub fn from_env() -> Option<Self> {
        let control_plane = non_empty_env("CONTROL_PLANE_URL")?;
        let issuer = non_empty_env("RYU_AUTH_BASE_URL").unwrap_or_else(|| control_plane.clone());
        Some(Self::new(format!("{control_plane}/api/auth/jwks"), issuer))
    }

    fn new(jwks_url: String, issuer: String) -> Self {
        // No redirects: a redirect could divert the key fetch to another host.
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            jwks_url,
            issuer,
            http,
            cache: RwLock::new(KeyCache::default()),
            refresh: tokio::sync::Mutex::new(()),
        }
    }

    /// Verify `token` and require membership of `org_id`.
    pub async fn verify_for_org(
        &self,
        token: &str,
        org_id: &str,
    ) -> Result<VerifiedUser, JwtError> {
        self.verify_at(token, org_id, chrono::Utc::now().timestamp())
            .await
    }

    async fn verify_at(
        &self,
        token: &str,
        org_id: &str,
        now: i64,
    ) -> Result<VerifiedUser, JwtError> {
        let token = token.trim();
        if token.is_empty() || token.len() > MAX_TOKEN_BYTES {
            return Err(JwtError::Malformed);
        }
        let mut parts = token.split('.');
        let (Some(header_b64), Some(payload_b64), Some(signature_b64), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(JwtError::Malformed);
        };
        let header: Header = decode_json(header_b64)?;
        if header.alg != "EdDSA" {
            return Err(JwtError::UnsupportedAlg);
        }
        let kid = header
            .kid
            .filter(|kid| !kid.is_empty())
            .ok_or(JwtError::MissingKid)?;
        let key = self.key(&kid).await?;
        let signature_bytes = URL_SAFE_NO_PAD
            .decode(signature_b64)
            .map_err(|_| JwtError::Malformed)?;
        let signature =
            Signature::from_slice(&signature_bytes).map_err(|_| JwtError::InvalidSignature)?;
        let signing_input = &token[..header_b64.len() + 1 + payload_b64.len()];
        key.verify_strict(signing_input.as_bytes(), &signature)
            .map_err(|_| JwtError::InvalidSignature)?;

        let claims: Claims = decode_json(payload_b64)?;
        let exp = claims.exp.ok_or(JwtError::Expired)?;
        if exp + LEEWAY_SECS < now {
            return Err(JwtError::Expired);
        }
        if claims.nbf.is_some_and(|nbf| nbf - LEEWAY_SECS > now) {
            return Err(JwtError::NotYetValid);
        }
        if claims.iss.as_deref() != Some(self.issuer.as_str()) {
            return Err(JwtError::InvalidIssuer);
        }
        let audience_ok = match &claims.aud {
            Some(Audience::One(aud)) => aud == &self.issuer,
            Some(Audience::Many(auds)) => auds.iter().any(|aud| aud == &self.issuer),
            None => false,
        };
        if !audience_ok {
            return Err(JwtError::InvalidAudience);
        }
        let user_id = claims
            .id
            .or(claims.sub)
            .filter(|id| !id.is_empty())
            .ok_or(JwtError::MissingSubject)?;
        if !claims.orgs.iter().any(|org| org.id == org_id) {
            return Err(JwtError::NotInOrg);
        }
        let mut team_ids: Vec<String> = claims
            .teams
            .into_iter()
            .filter(|team| team.org == org_id && !team.id.is_empty())
            .map(|team| team.id)
            .collect();
        team_ids.sort();
        team_ids.dedup();
        Ok(VerifiedUser { user_id, team_ids })
    }

    async fn key(&self, kid: &str) -> Result<Arc<VerifyingKey>, JwtError> {
        {
            let cache = self.cache.read().await;
            if cache.fetched_at.is_some_and(|at| at.elapsed() < JWKS_TTL) {
                if let Some(key) = cache.keys.get(kid) {
                    return Ok(Arc::clone(key));
                }
            }
        }
        let _single_flight = self.refresh.lock().await;
        {
            let cache = self.cache.read().await;
            let fresh = cache.fetched_at.is_some_and(|at| at.elapsed() < JWKS_TTL);
            if fresh {
                if let Some(key) = cache.keys.get(kid) {
                    return Ok(Arc::clone(key));
                }
            }
            if cache
                .last_attempt
                .is_some_and(|at| at.elapsed() < MIN_REFRESH_INTERVAL)
            {
                // Serve a known key from a stale set rather than failing while
                // throttled; an unknown kid stays unknown.
                return cache
                    .keys
                    .get(kid)
                    .map(Arc::clone)
                    .ok_or(JwtError::UnknownKid);
            }
        }
        self.cache.write().await.last_attempt = Some(Instant::now());
        let keys = self.fetch_keys().await?;
        let mut cache = self.cache.write().await;
        cache.keys = keys;
        cache.fetched_at = Some(Instant::now());
        cache
            .keys
            .get(kid)
            .map(Arc::clone)
            .ok_or(JwtError::UnknownKid)
    }

    async fn fetch_keys(&self) -> Result<HashMap<String, Arc<VerifyingKey>>, JwtError> {
        let url = reqwest::Url::parse(&self.jwks_url).map_err(|_| JwtError::JwksUnavailable)?;
        // Plain HTTP to a routable host would let an on-path attacker serve a
        // key set and mint valid identities.
        if url.scheme() != "https" && !url.host_str().is_some_and(is_loopback_host) {
            return Err(JwtError::InsecureJwksUrl);
        }
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|_| JwtError::JwksUnavailable)?;
        if !response.status().is_success() {
            return Err(JwtError::JwksUnavailable);
        }
        let body = response
            .bytes()
            .await
            .map_err(|_| JwtError::JwksUnavailable)?;
        if body.len() > MAX_JWKS_BYTES {
            return Err(JwtError::JwksUnavailable);
        }
        let set: JwkSet = serde_json::from_slice(&body).map_err(|_| JwtError::JwksUnavailable)?;
        Ok(parse_keys(set))
    }

    /// A verifier for `issuer` whose JWKS URL is never reachable; tests pin
    /// keys with [`Self::install_key`].
    #[cfg(test)]
    pub(crate) fn for_test(issuer: &str) -> Self {
        Self::new(format!("{issuer}/api/auth/jwks"), issuer.to_owned())
    }

    #[cfg(test)]
    pub(crate) async fn install_key(&self, kid: &str, key: VerifyingKey) {
        let mut cache = self.cache.write().await;
        cache.keys.insert(kid.to_owned(), Arc::new(key));
        cache.fetched_at = Some(Instant::now());
        cache.last_attempt = Some(Instant::now());
    }
}

/// Keep only Ed25519 OKP keys with a `kid`; skip anything else rather than
/// failing the whole set.
fn parse_keys(set: JwkSet) -> HashMap<String, Arc<VerifyingKey>> {
    let mut keys = HashMap::new();
    for jwk in set.keys {
        if jwk.kty != "OKP" || jwk.crv != "Ed25519" {
            continue;
        }
        let Some(kid) = jwk.kid.filter(|kid| !kid.is_empty()) else {
            continue;
        };
        let Ok(raw) = URL_SAFE_NO_PAD.decode(jwk.x.as_bytes()) else {
            continue;
        };
        let Ok(bytes) = <[u8; 32]>::try_from(raw.as_slice()) else {
            continue;
        };
        if let Ok(key) = VerifyingKey::from_bytes(&bytes) {
            keys.insert(kid, Arc::new(key));
        }
    }
    keys
}

fn decode_json<T: for<'de> Deserialize<'de>>(segment: &str) -> Result<T, JwtError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(segment)
        .map_err(|_| JwtError::Malformed)?;
    serde_json::from_slice(&bytes).map_err(|_| JwtError::Malformed)
}

#[cfg(test)]
#[path = "user_jwt_tests.rs"]
mod tests;
