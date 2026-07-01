//! User identity verification (Phase 0 of the multi-user collaboration epic).
//!
//! This module is the USER-identity layer. It is distinct from two existing
//! concerns that must not be conflated:
//!   - `crate::auth` — node-admittance via the shared `RYU_TOKEN` plus the
//!     device-authorization grant that fetches a control-plane bearer.
//!   - `crate::identity` — the Composio credential vault (a different concern).
//!
//! A remote client presents BOTH a node-admittance credential (`RYU_TOKEN`,
//! enforced in `server::require_auth`) AND a Better Auth JWT that carries the
//! verified user identity. This module verifies that JWT entirely OFFLINE:
//! Better Auth signs tokens with EdDSA/Ed25519 and publishes its public keys at
//! `{BASE_URL}/api/auth/jwks`; Core caches that key set and validates the
//! signature, expiry, issuer, and audience locally — no live round-trip per
//! request.
//!
//! Security posture (fail-closed throughout):
//!   - EdDSA only. `alg=none` and algorithm confusion are rejected both by an
//!     explicit header check and by `Validation::new(Algorithm::EdDSA)`.
//!   - `exp`, `iss` (== BASE_URL), and `aud` (== BASE_URL) are all validated.
//!   - The `kid` selects the JWKS key; an unknown `kid` triggers a single
//!     refresh, then denies if still unknown.
//!   - Any verification failure returns an error (the caller is anonymous,
//!     never spoofable-as-privileged).
//!
//! Staging note: stage 1 only makes this module compile. Wiring into middleware
//! and handlers happens in stage 3, so several items are intentionally unused
//! for now.
#![allow(dead_code)]

use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use jsonwebtoken::{
    decode, decode_header,
    jwk::{Jwk, JwkSet},
    Algorithm, DecodingKey, Validation,
};
use serde::Deserialize;
use tokio::sync::RwLock;

/// How long a fetched JWKS is trusted before a refresh is forced. Better Auth
/// rotates signing keys infrequently, so a 1h TTL bounds staleness without
/// hammering the endpoint; an unknown `kid` forces an out-of-band refresh
/// regardless of TTL (see [`JwksCache::decoding_key`]).
const JWKS_TTL: Duration = Duration::from_secs(60 * 60);

/// Minimum spacing between network JWKS refreshes triggered on the slow path
/// (stale cache OR unknown `kid`). The `kid` is attacker-controlled in an
/// as-yet-unverified token, so without this throttle a flood of distinct/unknown
/// kids would force one outbound fetch each. We collapse those into at most one
/// fetch per interval; `MIN_REFRESH_INTERVAL << JWKS_TTL`, so legitimate periodic
/// key rotation still refreshes promptly while an unknown-kid flood costs nothing.
const MIN_REFRESH_INTERVAL: Duration = Duration::from_secs(30);

/// Fallback Better Auth base URL when no env override is set. Matches the
/// `BETTER_AUTH_URL` default in `packages/auth` (`http://localhost:3000`). The
/// JWT `iss`/`aud` are this BASE_URL, so JWKS-fetch and claim-validation MUST
/// resolve to the same value — do NOT reuse the control-plane default
/// (`127.0.0.1:3000`), which would mismatch `iss`/`aud` and deny every token.
const DEFAULT_BASE_URL: &str = "http://localhost:3000";

// ── RBAC ladder (ported verbatim from packages/db control-plane.model.ts) ────

/// Organization roles, ordered most- to least-privileged. A higher role
/// inherits every capability of the roles below it. Ported from `ORG_ROLES` /
/// `ROLE_RANK` so Core and the control plane agree on the ladder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrgRole {
    Owner,
    Admin,
    Member,
    Viewer,
}

impl OrgRole {
    /// Privilege rank: owner=3 … viewer=0. Mirrors `ROLE_RANK`.
    pub fn rank(self) -> u8 {
        match self {
            OrgRole::Owner => 3,
            OrgRole::Admin => 2,
            OrgRole::Member => 1,
            OrgRole::Viewer => 0,
        }
    }

    /// Maps a Better Auth member-role string onto an [`OrgRole`]. Ports
    /// `mapBaRole`: a comma-separated multi-role takes the highest privilege
    /// present, and anything unrecognised (including the empty string) falls
    /// back to the least-privileged `Viewer` so an unknown role can never widen
    /// access (fail-closed).
    pub fn from_ba_str(ba_role: &str) -> OrgRole {
        let mut best = OrgRole::Viewer;
        for part in ba_role.split(',') {
            let normalized = part.trim().to_ascii_lowercase();
            let candidate = match normalized.as_str() {
                "owner" => Some(OrgRole::Owner),
                "admin" => Some(OrgRole::Admin),
                "member" => Some(OrgRole::Member),
                "viewer" => Some(OrgRole::Viewer),
                _ => None,
            };
            if let Some(candidate) = candidate {
                if candidate.rank() > best.rank() {
                    best = candidate;
                }
            }
        }
        best
    }

    /// Returns true when `self` is at least as privileged as `required`. Ports
    /// `roleSatisfies(role, required)`.
    pub fn satisfies(self, required: OrgRole) -> bool {
        self.rank() >= required.rank()
    }
}

// ── Verified identity types ──────────────────────────────────────────────────

/// One org membership embedded in the JWT payload (`orgs: [{ id, role }]`). The
/// `role` is the raw Better Auth role string; map it via [`OrgRole::from_ba_str`].
#[derive(Debug, Clone)]
pub struct OrgMembership {
    pub id: String,
    pub role: String,
}

/// The decoded, signature-verified claims of a Better Auth JWT. This is the raw
/// verified payload before it is narrowed to a single node's org context (see
/// [`to_caller_for_org`]).
#[derive(Debug, Clone)]
pub struct VerifiedClaims {
    /// Stable Better Auth user id (the JWT `id`/`sub`).
    pub user_id: String,
    pub email: Option<String>,
    /// Every org the user belongs to, as embedded by the `definePayload` hook.
    pub orgs: Vec<OrgMembership>,
}

/// A caller's verified identity narrowed to THIS node's org. `org_id`/`role`
/// reflect the membership matching the node's bound org: `org_id` is `None` (and
/// `role` is `Viewer`) when the user is not a member of the node's org, so an
/// org-scoped access check can never match a non-member.
#[derive(Debug, Clone)]
pub struct VerifiedCaller {
    pub user_id: String,
    pub email: Option<String>,
    pub org_id: Option<String>,
    pub role: OrgRole,
}

/// The access level [`can_access`] resolves for a resource.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    None,
    Read,
    Write,
}

/// The tenancy quartet of a shareable resource (conversation or document), loaded
/// from its row and fed verbatim into [`can_access`]. The fields mirror the
/// additive Phase 0 tenancy columns. EXISTING/legacy single-tenant rows carry
/// `owner_user_id = None` AND `org_id = None` (with `visibility = "private"`),
/// which the realtime WS gateway treats as a local-allow (full access) so the
/// single-user local-first flow is never locked out.
#[derive(Debug, Clone)]
pub struct ResourceTenancy {
    pub owner_user_id: Option<String>,
    pub org_id: Option<String>,
    pub visibility: String,
    pub team_id: Option<String>,
}

// ── Errors ───────────────────────────────────────────────────────────────────

/// Why a JWT failed verification. Every variant means DENY; callers must treat
/// any error as "no verified identity" (anonymous), never as privileged.
#[derive(Debug)]
pub enum AuthError {
    /// The token could not be parsed (bad structure / header).
    Malformed,
    /// The token header declares a non-EdDSA algorithm (incl. `none`).
    UnsupportedAlg,
    /// The token header has no `kid`, so no JWKS key can be selected.
    MissingKid,
    /// No JWKS key matches the token's `kid`, even after a refresh.
    UnknownKid,
    /// The JWKS endpoint could not be reached.
    JwksFetch(String),
    /// The resolved JWKS URL is non-loopback but not HTTPS, so fetching it would
    /// expose key material to on-path tampering (forged-token risk). Denied.
    InsecureJwksUrl(String),
    /// The JWKS response could not be parsed into a key set.
    JwksParse(String),
    /// The token is past its `exp`.
    Expired,
    /// The `iss` claim does not equal BASE_URL.
    InvalidIssuer,
    /// The `aud` claim does not equal BASE_URL.
    InvalidAudience,
    /// The signature did not verify, or the claims were otherwise invalid.
    InvalidSignature,
    /// The token carries no usable subject (`id`/`sub`).
    MissingSubject,
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::Malformed => write!(f, "malformed token"),
            AuthError::UnsupportedAlg => {
                write!(f, "unsupported signing algorithm (EdDSA required)")
            }
            AuthError::MissingKid => write!(f, "token header missing kid"),
            AuthError::UnknownKid => write!(f, "no JWKS key matches token kid"),
            AuthError::JwksFetch(e) => write!(f, "JWKS fetch failed: {e}"),
            AuthError::InsecureJwksUrl(u) => {
                write!(
                    f,
                    "refusing to fetch JWKS over insecure (non-HTTPS) URL: {u}"
                )
            }
            AuthError::JwksParse(e) => write!(f, "JWKS parse failed: {e}"),
            AuthError::Expired => write!(f, "token expired"),
            AuthError::InvalidIssuer => write!(f, "invalid issuer"),
            AuthError::InvalidAudience => write!(f, "invalid audience"),
            AuthError::InvalidSignature => write!(f, "invalid signature or claims"),
            AuthError::MissingSubject => write!(f, "token missing subject"),
        }
    }
}

impl std::error::Error for AuthError {}

// ── Base URL resolution ──────────────────────────────────────────────────────

/// The Better Auth BASE_URL used for the JWKS endpoint AND for `iss`/`aud`
/// validation. A single resolver keeps fetch and validation consistent. Honours
/// (in order) `RYU_AUTH_BASE_URL`, `BETTER_AUTH_URL`, then [`DEFAULT_BASE_URL`].
/// The trailing slash is trimmed so it matches Better Auth's issuer string.
fn base_url() -> String {
    let raw = std::env::var("RYU_AUTH_BASE_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::env::var("BETTER_AUTH_URL")
                .ok()
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());
    raw.trim_end_matches('/').to_owned()
}

/// True for hosts that resolve to the local machine, where plain HTTP is
/// acceptable (dev). Everything else must use HTTPS for the JWKS fetch.
fn is_loopback_host(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    if h.eq_ignore_ascii_case("localhost") {
        return true;
    }
    h.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

// ── JWKS cache ───────────────────────────────────────────────────────────────

/// A decoding key cached by `kid`. `DecodingKey` is not cheap to rebuild, so we
/// keep it behind an `Arc` for clone-on-read.
type CachedKey = Arc<DecodingKey>;

struct CacheInner {
    keys: HashMap<String, CachedKey>,
    fetched_at: Option<Instant>,
    /// When a network refresh was last *attempted* (success or failure), used to
    /// throttle slow-path refreshes regardless of outcome.
    last_attempt: Option<Instant>,
}

/// Caches the Better Auth JWKS with a TTL and a refresh-on-unknown-kid path. The
/// network fetch never happens while a data lock is held, and concurrent
/// refreshes are coalesced via `refresh_lock` (single-flight).
struct JwksCache {
    inner: RwLock<CacheInner>,
    /// Serializes the slow path so a burst of unknown-kid requests collapses into
    /// a single network fetch instead of one per request.
    refresh_lock: tokio::sync::Mutex<()>,
    http: reqwest::Client,
}

impl JwksCache {
    fn new() -> Self {
        // Disable redirect-following: the JWKS endpoint is a fixed control-plane
        // path, and a redirect could divert key material to an attacker-chosen
        // host. A 10s timeout bounds the slow path.
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            inner: RwLock::new(CacheInner {
                keys: HashMap::new(),
                fetched_at: None,
                last_attempt: None,
            }),
            refresh_lock: tokio::sync::Mutex::new(()),
            http,
        }
    }

    /// Fetch the JWKS from `{base}/api/auth/jwks`, parse it, and replace the
    /// cache. Performed entirely outside any held lock; the write lock is taken
    /// only to swap in the freshly-built map.
    async fn refresh(&self) -> Result<(), AuthError> {
        let raw_url = format!("{}/api/auth/jwks", base_url());
        // Enforce HTTPS for any non-loopback host: an http JWKS fetch on a
        // routable network lets an on-path attacker serve a malicious key set and
        // forge fully-valid tokens (complete identity bypass). Fail-closed.
        let url = reqwest::Url::parse(&raw_url)
            .map_err(|e| AuthError::JwksFetch(format!("invalid base URL: {e}")))?;
        let host_is_loopback = url.host_str().map(is_loopback_host).unwrap_or(false);
        if url.scheme() != "https" && !host_is_loopback {
            return Err(AuthError::InsecureJwksUrl(raw_url));
        }
        let resp = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| AuthError::JwksFetch(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(AuthError::JwksFetch(format!("status {}", resp.status())));
        }
        let set: JwkSet = resp
            .json()
            .await
            .map_err(|e| AuthError::JwksParse(e.to_string()))?;

        let mut keys: HashMap<String, CachedKey> = HashMap::new();
        for jwk in &set.keys {
            let Some(kid) = jwk_kid(jwk) else {
                continue;
            };
            let Ok(key) = DecodingKey::from_jwk(jwk) else {
                // Skip key types we cannot decode rather than failing the whole
                // refresh — a single bad/unsupported entry must not deny tokens
                // signed by the others.
                continue;
            };
            keys.insert(kid, Arc::new(key));
        }

        let mut inner = self.inner.write().await;
        inner.keys = keys;
        inner.fetched_at = Some(Instant::now());
        Ok(())
    }

    /// Resolve the decoding key for `kid`, refreshing when the cache is empty,
    /// past its TTL, or does not contain `kid`. Denies (`UnknownKid`) if the key
    /// is still absent after a refresh.
    async fn decoding_key(&self, kid: &str) -> Result<CachedKey, AuthError> {
        // Fast path: a fresh cache that already has the key, no lock contention.
        {
            let inner = self.inner.read().await;
            let fresh = inner.fetched_at.is_some_and(|at| at.elapsed() < JWKS_TTL);
            if fresh {
                if let Some(key) = inner.keys.get(kid) {
                    return Ok(Arc::clone(key));
                }
            }
        }

        // Slow path: stale cache OR unknown kid. Serialize so concurrent
        // unknown-kid requests collapse into one fetch (single-flight).
        let _guard = self.refresh_lock.lock().await;

        // Re-check under the guard: a peer may have just refreshed, and we also
        // re-evaluate the throttle so an unknown-kid flood cannot force a fetch
        // per request.
        {
            let inner = self.inner.read().await;
            let fresh = inner.fetched_at.is_some_and(|at| at.elapsed() < JWKS_TTL);
            if fresh {
                if let Some(key) = inner.keys.get(kid) {
                    return Ok(Arc::clone(key));
                }
            }
            let recently_attempted = inner
                .last_attempt
                .is_some_and(|at| at.elapsed() < MIN_REFRESH_INTERVAL);
            if recently_attempted {
                // We fetched within the throttle window and the kid is still
                // absent: treat as unknown without another network call.
                return Err(AuthError::UnknownKid);
            }
        }

        // Stamp the attempt time BEFORE the network call so a slow or failing
        // fetch still throttles subsequent callers.
        {
            let mut inner = self.inner.write().await;
            inner.last_attempt = Some(Instant::now());
        }
        self.refresh().await?;
        let inner = self.inner.read().await;
        inner
            .keys
            .get(kid)
            .map(Arc::clone)
            .ok_or(AuthError::UnknownKid)
    }
}

/// Process-wide JWKS cache, lazily initialised on first verification.
fn cache() -> &'static JwksCache {
    static CACHE: OnceLock<JwksCache> = OnceLock::new();
    CACHE.get_or_init(JwksCache::new)
}

/// Extract a JWK's `kid` from its common parameters.
fn jwk_kid(jwk: &Jwk) -> Option<String> {
    jwk.common.key_id.clone()
}

// ── JWT verification ─────────────────────────────────────────────────────────

/// Raw JWT payload shape. Better Auth's `definePayload` embeds `id`, `email`,
/// and `orgs: [{ id, role }]`; `sub` is the standard subject fallback.
#[derive(Debug, Deserialize)]
struct RawClaims {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    sub: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    orgs: Vec<RawOrg>,
}

#[derive(Debug, Deserialize)]
struct RawOrg {
    id: String,
    #[serde(default)]
    role: String,
}

/// Verify a Better Auth JWT offline and return its claims.
///
/// Steps (all fail-closed): decode the header and REJECT unless `alg == EdDSA`;
/// select the JWKS key by `kid` (refresh-on-unknown); then validate the
/// signature, `exp`, `iss` (== BASE_URL) and `aud` (== BASE_URL). On success the
/// `orgs` membership array is returned for org narrowing.
pub async fn verify_jwt(token: &str) -> Result<VerifiedClaims, AuthError> {
    let header = decode_header(token).map_err(|_| AuthError::Malformed)?;
    // Defense in depth: explicit alg check rejects `none`/confusion before we
    // ever touch a key; `Validation::new(EdDSA)` rejects them again at decode.
    if header.alg != Algorithm::EdDSA {
        return Err(AuthError::UnsupportedAlg);
    }
    // An empty-string kid is as useless as a missing one — reject it before it can
    // slip through to trigger a JWKS refresh.
    let kid = header
        .kid
        .filter(|k| !k.is_empty())
        .ok_or(AuthError::MissingKid)?;
    let key = cache().decoding_key(&kid).await?;

    let base = base_url();
    let mut validation = Validation::new(Algorithm::EdDSA);
    validation.set_issuer(&[&base]);
    // NOTE (stage 3 verify): Better Auth sets `aud == BASE_URL`. If a live token
    // is ever found to omit `aud`, this audience requirement would deny it — to
    // be confirmed against a real token when middleware wiring lands.
    validation.set_audience(&[&base]);

    let decoded = decode::<RawClaims>(token, &key, &validation).map_err(map_jwt_error)?;
    let claims = decoded.claims;

    let user_id = claims
        .id
        .or(claims.sub)
        .filter(|s| !s.is_empty())
        .ok_or(AuthError::MissingSubject)?;

    let orgs = claims
        .orgs
        .into_iter()
        .map(|o| OrgMembership {
            id: o.id,
            role: o.role,
        })
        .collect();

    Ok(VerifiedClaims {
        user_id,
        email: claims.email,
        orgs,
    })
}

/// Translate a `jsonwebtoken` error into an [`AuthError`], preserving the
/// specific failure where the underlying library distinguishes it.
fn map_jwt_error(err: jsonwebtoken::errors::Error) -> AuthError {
    use jsonwebtoken::errors::ErrorKind;
    match err.kind() {
        ErrorKind::ExpiredSignature => AuthError::Expired,
        ErrorKind::InvalidIssuer => AuthError::InvalidIssuer,
        ErrorKind::InvalidAudience => AuthError::InvalidAudience,
        ErrorKind::InvalidAlgorithm | ErrorKind::InvalidAlgorithmName => AuthError::UnsupportedAlg,
        _ => AuthError::InvalidSignature,
    }
}

/// Narrow verified claims to a single node's org. Selects the membership whose
/// org matches `node_org_id`: a member yields `org_id = Some(node)` with the
/// mapped role; a non-member yields `org_id = None` and `Viewer` so an org-scoped
/// check can never match. When the node is not org-bound (`None`), the caller has
/// no org context (`org_id = None`, `Viewer`).
pub fn to_caller_for_org(claims: &VerifiedClaims, node_org_id: Option<&str>) -> VerifiedCaller {
    let (org_id, role) = match node_org_id {
        Some(node) => match claims.orgs.iter().find(|m| m.id == node) {
            Some(membership) => (
                Some(node.to_owned()),
                OrgRole::from_ba_str(&membership.role),
            ),
            None => (None, OrgRole::Viewer),
        },
        None => (None, OrgRole::Viewer),
    };

    VerifiedCaller {
        user_id: claims.user_id.clone(),
        email: claims.email.clone(),
        org_id,
        role,
    }
}

// ── Access control ───────────────────────────────────────────────────────────

/// Resolve a caller's access to a resource. Fail-closed: any case not explicitly
/// granted returns [`Access::None`].
///
/// Rules:
///   - The resource owner always gets `Write`.
///   - `visibility == "org"`: a member of the SAME org gets `Write` (`Read` for
///     a `Viewer`); anyone else gets `None`.
///   - `visibility == "team"`: team membership is not yet in the JWT claims, so
///     for now this is treated identically to `org` (same-org member → Write,
///     viewer → Read). TODO: tighten to a real team-scoped check once team
///     memberships are available.
///   - `visibility == "private"`: only the owner (handled above) — everyone else
///     gets `None`.
///   - Any unknown visibility string → `None`.
pub fn can_access(
    caller: &VerifiedCaller,
    owner_user_id: Option<&str>,
    org_id: Option<&str>,
    visibility: &str,
    team_id: Option<&str>,
) -> Access {
    if let Some(owner) = owner_user_id {
        if owner == caller.user_id {
            return Access::Write;
        }
    }

    match visibility {
        "private" => Access::None,
        // TODO: team-scoped check — claims do not yet carry team membership, so
        // a team resource is gated like an org resource for now.
        "org" | "team" => {
            let _ = team_id;
            org_access(caller, org_id)
        }
        _ => Access::None,
    }
}

/// Shared org/team membership gate: same-org member → `Write`, same-org viewer →
/// `Read`, otherwise `None`.
fn org_access(caller: &VerifiedCaller, org_id: Option<&str>) -> Access {
    match (caller.org_id.as_deref(), org_id) {
        (Some(caller_org), Some(resource_org)) if caller_org == resource_org => {
            if caller.role.satisfies(OrgRole::Member) {
                Access::Write
            } else {
                Access::Read
            }
        }
        _ => Access::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_host_detection() {
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("LocalHost"));
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("127.5.5.5"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("[::1]"));
        assert!(!is_loopback_host("auth.example.com"));
        assert!(!is_loopback_host("10.0.0.5"));
        assert!(!is_loopback_host("0.0.0.0"));
    }

    #[test]
    fn role_rank_ladder() {
        assert!(OrgRole::Owner.rank() > OrgRole::Admin.rank());
        assert!(OrgRole::Admin.rank() > OrgRole::Member.rank());
        assert!(OrgRole::Member.rank() > OrgRole::Viewer.rank());
    }

    #[test]
    fn from_ba_str_takes_highest_and_fails_closed() {
        assert_eq!(OrgRole::from_ba_str("admin,member"), OrgRole::Admin);
        assert_eq!(OrgRole::from_ba_str("owner"), OrgRole::Owner);
        assert_eq!(OrgRole::from_ba_str(""), OrgRole::Viewer);
        assert_eq!(OrgRole::from_ba_str("nonsense"), OrgRole::Viewer);
        assert_eq!(OrgRole::from_ba_str(" Member "), OrgRole::Member);
    }

    #[test]
    fn satisfies_is_rank_ordered() {
        assert!(OrgRole::Admin.satisfies(OrgRole::Member));
        assert!(OrgRole::Member.satisfies(OrgRole::Member));
        assert!(!OrgRole::Viewer.satisfies(OrgRole::Member));
    }

    fn caller(user: &str, org: Option<&str>, role: OrgRole) -> VerifiedCaller {
        VerifiedCaller {
            user_id: user.to_owned(),
            email: None,
            org_id: org.map(str::to_owned),
            role,
        }
    }

    #[test]
    fn owner_always_writes() {
        let c = caller("u1", None, OrgRole::Viewer);
        assert_eq!(
            can_access(&c, Some("u1"), Some("o1"), "private", None),
            Access::Write
        );
    }

    #[test]
    fn private_denies_non_owner() {
        let c = caller("u2", Some("o1"), OrgRole::Owner);
        assert_eq!(
            can_access(&c, Some("u1"), Some("o1"), "private", None),
            Access::None
        );
    }

    #[test]
    fn org_member_writes_viewer_reads() {
        let member = caller("u2", Some("o1"), OrgRole::Member);
        assert_eq!(
            can_access(&member, Some("u1"), Some("o1"), "org", None),
            Access::Write
        );
        let viewer = caller("u3", Some("o1"), OrgRole::Viewer);
        assert_eq!(
            can_access(&viewer, Some("u1"), Some("o1"), "org", None),
            Access::Read
        );
    }

    #[test]
    fn org_non_member_denied() {
        // A non-member has org_id = None, so the same-org check cannot match.
        let outsider = caller("u4", None, OrgRole::Viewer);
        assert_eq!(
            can_access(&outsider, Some("u1"), Some("o1"), "org", None),
            Access::None
        );
        // Different org also denied.
        let other = caller("u5", Some("o2"), OrgRole::Owner);
        assert_eq!(
            can_access(&other, Some("u1"), Some("o1"), "org", None),
            Access::None
        );
    }

    #[test]
    fn unknown_visibility_denied() {
        let c = caller("u2", Some("o1"), OrgRole::Owner);
        assert_eq!(
            can_access(&c, Some("u1"), Some("o1"), "weird", None),
            Access::None
        );
    }

    #[test]
    fn to_caller_selects_node_org_membership() {
        let claims = VerifiedClaims {
            user_id: "u1".to_owned(),
            email: Some("a@b.c".to_owned()),
            orgs: vec![
                OrgMembership {
                    id: "o1".to_owned(),
                    role: "admin".to_owned(),
                },
                OrgMembership {
                    id: "o2".to_owned(),
                    role: "viewer".to_owned(),
                },
            ],
        };
        let c = to_caller_for_org(&claims, Some("o1"));
        assert_eq!(c.org_id.as_deref(), Some("o1"));
        assert_eq!(c.role, OrgRole::Admin);

        // Not a member of the node's org → no org context, viewer, fail-closed.
        let outsider = to_caller_for_org(&claims, Some("o3"));
        assert_eq!(outsider.org_id, None);
        assert_eq!(outsider.role, OrgRole::Viewer);

        // Node not org-bound → no org context.
        let unbound = to_caller_for_org(&claims, None);
        assert_eq!(unbound.org_id, None);
        assert_eq!(unbound.role, OrgRole::Viewer);
    }
}
