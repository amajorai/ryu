//! User identity verification (Phase 0 of the multi-user collaboration epic).
//!
//! This module is the USER-identity layer. It is distinct from two existing
//! concerns that must not be conflated:
//!   - `crate::auth` — node-admittance via the shared `RYU_TOKEN` plus the
//!     device-authorization grant that fetches a control-plane bearer.
//!   - `crate::identity` — the Composio credential vault (a different concern).
//!
//! A normal remote client presents BOTH a node-admittance credential (`RYU_TOKEN`,
//! enforced in `server::require_auth`) AND a Better Auth JWT that carries the
//! verified user identity. An organization-bound managed client may use that
//! verified JWT as its primary bearer because the control plane does not expose a
//! reusable node secret. This module verifies the JWT entirely OFFLINE:
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

pub mod permissions;

use std::{
    collections::{BTreeSet, HashMap},
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
    /// Lower-case name, as used in `role:<name>` policy subjects.
    pub fn label(self) -> &'static str {
        match self {
            OrgRole::Owner => "owner",
            OrgRole::Admin => "admin",
            OrgRole::Member => "member",
            OrgRole::Viewer => "viewer",
        }
    }

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

/// One team membership embedded in the JWT payload (`teams: [{ id, org, role }]`).
/// Better Auth's `teamMember` row carries no role of its own, so `role` is the
/// user's role in the team's owning org — the same raw Better Auth role string as
/// [`OrgMembership::role`], mapped via [`OrgRole::from_ba_str`].
#[derive(Debug, Clone)]
pub struct TeamMembership {
    pub id: String,
    /// The org that owns this team. A team is only ever meaningful inside its
    /// org, so this is what [`to_caller_for_org`] narrows on.
    pub org_id: String,
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
    /// Whether the issuer asserted `email_verified: true` for `email`. Anything
    /// else (an absent claim, `false`, or a non-boolean value) is `false`, so a
    /// token minted before the claim existed never counts as verified.
    pub email_verified: bool,
    /// Every org the user belongs to, as embedded by the `definePayload` hook.
    pub orgs: Vec<OrgMembership>,
    /// Every team the user belongs to, across all of their orgs. Empty for
    /// tokens minted before teams were embedded — absence means "no team
    /// memberships", never an error.
    pub teams: Vec<TeamMembership>,
    /// Rollout flags the control plane evaluated ON for this user when the token
    /// was minted (the `ryu_flags` claim: the catalog's `coreClaim` flags in
    /// `packages/auth/src/lib/feature-flags.ts`). Empty for tokens minted
    /// without it, so absence means "every flag off" — fail closed. Stale for at
    /// most the token lifetime (Better Auth's JWT default is 15 minutes).
    pub feature_flags: BTreeSet<String>,
    /// The organization `feature_flags` was evaluated for (the `ryu_flags_org`
    /// claim): the session's active org at mint, falling back to the user's
    /// earliest membership, exactly as `/subscription-status` resolves it.
    /// `None` when the evaluation had no org context (the user belongs to no
    /// org, or the token predates the claim), in which case only user-scoped
    /// audiences could have contributed to `feature_flags`.
    pub feature_flags_org: Option<String>,
    /// Plan limits the control plane signed for this user (the `ryu_limits`
    /// claim), evaluated for [`Self::feature_flags_org`]. `None` when the claim
    /// is missing or malformed: Core then falls back to the Box service's own
    /// limits, so a missing claim never refuses work by itself.
    pub limits: Option<VerifiedLimits>,
}

/// The signed `ryu_limits` claim: `{ "boxConcurrency": <u32> }`, the running
/// session-Box cap of the user's plan in the org it was evaluated for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedLimits {
    /// Most session Boxes the caller may have running at once.
    pub box_concurrency: u32,
}

/// [`VerifiedLimits`] of a verified token with the org they were evaluated for
/// (the same org as its rollout flags, `ryu_flags_org`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedPlanLimits {
    pub limits: VerifiedLimits,
    pub org: Option<String>,
}

/// The rollout flags of a verified token together with the org they were
/// evaluated for. See [`VerifiedClaims::feature_flags`] and
/// [`VerifiedClaims::feature_flags_org`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VerifiedFeatureFlags {
    pub keys: BTreeSet<String>,
    pub org: Option<String>,
}

/// A caller's verified identity narrowed to THIS node's org. `org_id`/`role`
/// reflect the membership matching the node's bound org: `org_id` is `None` (and
/// `role` is `Viewer`) when the user is not a member of the node's org, so an
/// org-scoped access check can never match a non-member.
#[derive(Debug, Clone)]
pub struct VerifiedCaller {
    pub user_id: String,
    /// The token's `email` claim. Fine for display and audit attribution; use
    /// [`VerifiedCaller::verified_email`] for anything that grants access by
    /// address, because an identity provider can sign in an unproven mailbox.
    pub email: Option<String>,
    /// Whether the issuer proved the caller owns `email` (see
    /// [`VerifiedClaims::email_verified`]).
    pub email_verified: bool,
    pub org_id: Option<String>,
    pub role: OrgRole,
    /// The caller's teams, narrowed to `org_id`. Teams owned by any other org are
    /// dropped, so a team id minted in a different org can never satisfy a
    /// team-scoped check on this node. Empty whenever `org_id` is `None`.
    pub teams: Vec<TeamMembership>,
}

impl VerifiedCaller {
    /// The caller's email only when the issuer marked it verified. This is the
    /// address to match against email-addressed grants (named editors, invited
    /// viewers): an unverified address is a claim, not proof of mailbox ownership.
    pub fn verified_email(&self) -> Option<&str> {
        if !self.email_verified {
            return None;
        }
        self.email
            .as_deref()
            .map(str::trim)
            .filter(|email| !email.is_empty())
    }
}

/// The access level [`can_access`] resolves for a resource.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    None,
    Read,
    Write,
}

impl Access {
    /// Return whether this grant satisfies `required`.
    ///
    /// Keeping the ordering here avoids repeating subtly different `match`
    /// ladders at each resource gate (and makes a read-only team/org grant
    /// impossible to accidentally treat as a write).
    pub fn at_least(self, required: Self) -> bool {
        fn rank(access: Access) -> u8 {
            match access {
                Access::None => 0,
                Access::Read => 1,
                Access::Write => 2,
            }
        }

        rank(self) >= rank(required)
    }
}

/// The tenancy metadata of a shareable resource (conversation or document), loaded
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
    pub collaborators: Vec<ResourceCollaborator>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceCollaborator {
    pub user_id: String,
    pub access: Access,
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

/// Pin a verification key in the process-wide JWKS cache, for tests that need a
/// real signed token to pass the full offline verification path (signature,
/// `iss`, `aud`, `exp`). Marks the cache freshly fetched so no test ever reaches
/// the network, and returns the issuer/audience the token must carry.
#[cfg(test)]
pub(crate) async fn install_test_verification_key(kid: &str, key: DecodingKey) -> String {
    let mut inner = cache().inner.write().await;
    inner.keys.insert(kid.to_owned(), Arc::new(key));
    inner.fetched_at = Some(Instant::now());
    inner.last_attempt = Some(Instant::now());
    base_url()
}

/// Seconds of validity a cached minted JWT must still have to be reused.
const MINT_REUSE_MARGIN_SECS: i64 = 60;

/// The most recent JWT minted by [`mint_user_jwt`], keyed by the session it was
/// exchanged from so a sign-out or account switch never reuses another identity.
struct MintedJwt {
    session_token: String,
    token: String,
    expires_at: i64,
    /// When this token was minted (unix seconds).
    minted_at: i64,
    /// Whether the token names the session it was minted from (`ryu_sid`).
    /// The control plane binds a forwarded token to that session, so a token
    /// minted before it stamped the claim is refused (`user_jwt_invalid`)
    /// however young it is.
    session_bound: bool,
}

fn minted_jwt_cache() -> &'static tokio::sync::Mutex<Option<MintedJwt>> {
    static CACHE: OnceLock<tokio::sync::Mutex<Option<MintedJwt>>> = OnceLock::new();
    CACHE.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// Drop the cached minted JWT so the next [`mint_user_jwt`] asks the control
/// plane again. The org claims are decided at mint time, so a session that
/// has just proved a second factor (`ryu secrets confirm`) needs a new token
/// before an organization that requires two-factor appears in it.
pub async fn forget_minted_user_jwt() {
    *minted_jwt_cache().lock().await = None;
}

/// [`forget_minted_user_jwt`], but only when the cached token is at least
/// `min_age_secs` old. A refusal the token keeps drawing (an organization
/// policy that keeps leaving the organization out) then re-mints at most once
/// per that interval instead of on every request.
pub async fn forget_minted_user_jwt_older_than(min_age_secs: i64) {
    forget_minted_user_jwt_when(|entry, now| {
        minted_long_enough_ago(entry.minted_at, now, min_age_secs)
    })
    .await;
}

/// [`forget_minted_user_jwt_older_than`], and also, whatever its age, a
/// cached token that names no session (`ryu_sid`). Such a token was minted
/// before the control plane started binding forwarded tokens to their
/// session, so it is refused on every request until a re-mint replaces it.
pub async fn forget_minted_user_jwt_if_unbound_or_older_than(min_age_secs: i64) {
    forget_minted_user_jwt_when(|entry, now| {
        unbound_or_old_enough(entry.session_bound, entry.minted_at, now, min_age_secs)
    })
    .await;
}

fn unbound_or_old_enough(session_bound: bool, minted_at: i64, now: i64, min_age_secs: i64) -> bool {
    !session_bound || minted_long_enough_ago(minted_at, now, min_age_secs)
}

async fn forget_minted_user_jwt_when(should_drop: impl Fn(&MintedJwt, i64) -> bool) {
    let mut cached = minted_jwt_cache().lock().await;
    let now = chrono::Utc::now().timestamp();
    if cached.as_ref().is_some_and(|entry| should_drop(entry, now)) {
        *cached = None;
    }
}

/// Whether a (verified) token carries a non-empty `ryu_sid` claim. Reads the
/// payload only; the signature was checked when the token was minted.
fn token_names_session(token: &str) -> bool {
    use base64::Engine as _;
    let Some(payload) = token.split('.').nth(1) else {
        return false;
    };
    let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload) else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|claims| {
            claims
                .get("ryu_sid")
                .and_then(|sid| sid.as_str())
                .map(str::to_owned)
        })
        .is_some_and(|sid| !sid.is_empty())
}

fn minted_long_enough_ago(minted_at: i64, now: i64, min_age_secs: i64) -> bool {
    now.saturating_sub(minted_at) >= min_age_secs
}

/// Exchange a Better Auth session token for the short-lived user JWT Core
/// verifies offline, returning the token and its validated `exp`.
///
/// This lets surfaces that hold no cloud session of their own (the CLI, Island,
/// browser extension and Raycast) prove WHO is calling a shared node: their local
/// Core already holds the signed-in account's session and brokers the exchange.
/// The token is verified with the same offline path every request uses before it
/// is handed out, so a misconfigured issuer fails here rather than as a silent
/// anonymous downgrade on the target node. The mutex also single-flights
/// concurrent refreshes.
pub async fn mint_user_jwt(session_token: &str) -> Result<(String, i64), AuthError> {
    let mut cached = minted_jwt_cache().lock().await;
    let now = chrono::Utc::now().timestamp();
    if let Some(entry) = cached.as_ref() {
        if entry.session_token == session_token && entry.expires_at - MINT_REUSE_MARGIN_SECS > now {
            return Ok((entry.token.clone(), entry.expires_at));
        }
    }

    let raw_url = format!("{}/api/auth/token", base_url());
    let url = reqwest::Url::parse(&raw_url)
        .map_err(|e| AuthError::JwksFetch(format!("invalid base URL: {e}")))?;
    let host_is_loopback = url.host_str().is_some_and(is_loopback_host);
    // The session token is a full credential; never send it over plain HTTP to a
    // routable host.
    if url.scheme() != "https" && !host_is_loopback {
        return Err(AuthError::InsecureJwksUrl(raw_url));
    }
    let resp = cache()
        .http
        .get(url)
        .bearer_auth(session_token)
        .send()
        .await
        .map_err(|e| AuthError::JwksFetch(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(AuthError::JwksFetch(format!(
            "token exchange status {}",
            resp.status()
        )));
    }
    #[derive(Deserialize)]
    struct TokenResponse {
        token: String,
    }
    let body: TokenResponse = resp
        .json()
        .await
        .map_err(|e| AuthError::JwksParse(e.to_string()))?;
    let (_, expires_at) = verify_jwt_with_expiry(&body.token).await?;
    *cached = Some(MintedJwt {
        session_token: session_token.to_owned(),
        token: body.token.clone(),
        expires_at,
        minted_at: chrono::Utc::now().timestamp(),
        session_bound: token_names_session(&body.token),
    });
    Ok((body.token, expires_at))
}

/// Extract a JWK's `kid` from its common parameters.
fn jwk_kid(jwk: &Jwk) -> Option<String> {
    jwk.common.key_id.clone()
}

// ── JWT verification ─────────────────────────────────────────────────────────

/// Raw JWT payload shape. Better Auth's `definePayload` embeds `id`, `email`,
/// `email_verified`, `orgs: [{ id, role }]` and `teams: [{ id, org, role }]`;
/// `sub` is the standard subject fallback.
#[derive(Debug, Deserialize)]
struct RawClaims {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    sub: Option<String>,
    #[serde(default)]
    email: Option<String>,
    /// OIDC-style mailbox proof for `email`. Only a JSON `true` counts; any other
    /// value decodes as unverified instead of rejecting the whole token, and an
    /// absent claim (tokens minted before it existed) is unverified too.
    #[serde(default, deserialize_with = "deserialize_strict_true")]
    email_verified: bool,
    #[serde(default)]
    orgs: Vec<RawOrg>,
    /// Defaulted so every token minted before teams were embedded still verifies.
    #[serde(default)]
    teams: Vec<RawTeam>,
    /// Enabled rollout flags. Lenient: a missing or malformed claim (or any
    /// non-string entry) contributes nothing instead of rejecting the token, so
    /// a minter bug can only close a flag, never sign a user out.
    #[serde(default, rename = "ryu_flags", deserialize_with = "lenient_flag_keys")]
    ryu_flags: BTreeSet<String>,
    /// The org `ryu_flags` was evaluated for. Lenient like `ryu_flags`: anything
    /// but a non-empty string reads as "no org context".
    #[serde(
        default,
        rename = "ryu_flags_org",
        deserialize_with = "lenient_flag_org"
    )]
    ryu_flags_org: Option<String>,
    /// Plan limits (`{ "boxConcurrency": n }`). Lenient: anything else reads as
    /// no claim, so a minter bug cannot sign a user out.
    #[serde(default, rename = "ryu_limits", deserialize_with = "lenient_limits")]
    ryu_limits: Option<VerifiedLimits>,
    /// Required by the live-session boundary as well as the handshake validator.
    #[serde(default)]
    exp: Option<i64>,
}

/// Decode a claim as `true` only when it is the JSON boolean `true`. A string
/// `"true"`, a number, or `null` is unverified (fail-closed) without failing the
/// token, so a malformed optional claim cannot lock a user out of Core.
fn deserialize_strict_true<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(matches!(
        serde_json::Value::deserialize(deserializer)?,
        serde_json::Value::Bool(true)
    ))
}

#[derive(Debug, Deserialize)]
struct RawOrg {
    id: String,
    #[serde(default)]
    role: String,
}

#[derive(Debug, Deserialize)]
struct RawTeam {
    /// Required, mirroring [`RawOrg::id`]: an entry with no id identifies no team
    /// and only the minter can produce one, so it is a payload bug, not input.
    id: String,
    /// Defaulted so an entry missing its org degrades to an unmatchable one
    /// (`""` matches no node org) rather than being silently treated as global.
    #[serde(default)]
    org: String,
    /// Defaulted to the empty string, which [`OrgRole::from_ba_str`] maps to
    /// `Viewer` — the least privilege, so a missing role can never widen access.
    #[serde(default)]
    role: String,
}

/// Keep only the non-empty string entries of a flag-claim array; anything else
/// (an object, a number, `null`) reads as no flags.
fn lenient_flag_keys<'de, D>(deserializer: D) -> Result<BTreeSet<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value {
        serde_json::Value::Array(entries) => entries
            .into_iter()
            .filter_map(|entry| match entry {
                serde_json::Value::String(key) if !key.is_empty() && key.len() <= 128 => Some(key),
                _ => None,
            })
            .collect(),
        _ => BTreeSet::new(),
    })
}

/// Keep a non-empty string org id; anything else (`null`, a number, an object,
/// an empty or oversized string) reads as no org context.
fn lenient_flag_org<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value {
        serde_json::Value::String(org) if !org.is_empty() && org.len() <= 128 => Some(org),
        _ => None,
    })
}

/// Keep a `ryu_limits` object whose `boxConcurrency` is a non-negative integer
/// that fits in `u32`; anything else (absent, `null`, a string, a negative or
/// fractional number) reads as no claim.
fn lenient_limits<'de, D>(deserializer: D) -> Result<Option<VerifiedLimits>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value
        .get("boxConcurrency")
        .and_then(serde_json::Value::as_u64)
        .and_then(|cap| u32::try_from(cap).ok())
        .map(|box_concurrency| VerifiedLimits { box_concurrency }))
}

/// Verify a Better Auth JWT offline and return its claims plus its validated
/// expiration timestamp (for transports that outlive the request that
/// authenticated them, such as WebSockets).
///
/// Steps (all fail-closed): decode the header and REJECT unless `alg == EdDSA`;
/// select the JWKS key by `kid` (refresh-on-unknown); then validate the
/// signature, `exp`, `iss` (== BASE_URL) and `aud` (== BASE_URL). On success the
/// `orgs` membership array is returned for org narrowing. The timestamp is taken
/// from the same validated decode, never from an untrusted payload parse.
pub async fn verify_jwt_with_expiry(token: &str) -> Result<(VerifiedClaims, i64), AuthError> {
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
    let expires_at = claims.exp.ok_or(AuthError::Expired)?;

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

    let teams = claims
        .teams
        .into_iter()
        .map(|t| TeamMembership {
            id: t.id,
            org_id: t.org,
            role: t.role,
        })
        .collect();

    Ok((
        VerifiedClaims {
            user_id,
            email: claims.email,
            email_verified: claims.email_verified,
            orgs,
            teams,
            feature_flags: claims.ryu_flags,
            feature_flags_org: claims.ryu_flags_org,
            limits: claims.ryu_limits,
        },
        expires_at,
    ))
}

/// The enabled rollout flags carried by a user JWT, with the org they were
/// evaluated for, or `None` when the token does not verify (fail closed). Used by gates that hold the request's already
/// verified raw token (`server::VerifiedUserJwt` / `ResolvedAuthorization`)
/// rather than widening [`VerifiedCaller`]; verification is offline against the
/// cached JWKS, so this re-check is cheap and also re-applies `exp`.
pub async fn verified_feature_flags(token: &str) -> Option<VerifiedFeatureFlags> {
    verify_jwt_with_expiry(token)
        .await
        .ok()
        .map(|(claims, _)| VerifiedFeatureFlags {
            keys: claims.feature_flags,
            org: claims.feature_flags_org,
        })
}

/// The signed plan limits carried by a user JWT, with the org they were
/// evaluated for. `None` when the token does not verify or carries no
/// `ryu_limits` claim. Offline against the cached JWKS, like
/// [`verified_feature_flags`].
pub async fn verified_limits(token: &str) -> Option<VerifiedPlanLimits> {
    let (claims, _) = verify_jwt_with_expiry(token).await.ok()?;
    Some(VerifiedPlanLimits {
        limits: claims.limits?,
        org: claims.feature_flags_org,
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
/// no org context (`org_id = None`, `Viewer`). `teams` is narrowed the same way:
/// only teams owned by the resolved org survive.
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

    // Narrow off the ALREADY-narrowed `org_id`, not `node_org_id`: a caller who is
    // not a member of the node's org resolves to `None` above and so carries no
    // teams here either, without a second membership check.
    let teams = match org_id.as_deref() {
        Some(org) => claims
            .teams
            .iter()
            .filter(|t| t.org_id == org)
            .cloned()
            .collect(),
        None => Vec::new(),
    };

    VerifiedCaller {
        user_id: claims.user_id.clone(),
        email: claims.email.clone(),
        email_verified: claims.email_verified,
        org_id,
        role,
        teams,
    }
}

// ── Access control ───────────────────────────────────────────────────────────

/// Resolve a caller's access to a resource. Fail-closed: any case not explicitly
/// granted returns [`Access::None`].
///
/// Rules:
///   - The resource owner always gets `Write`.
///   - A same-org direct collaborator gets the stored `Read` or `Write` grant.
///   - `visibility == "org"`: a member of the SAME org gets `Write` (`Read` for
///     a `Viewer`); anyone else gets `None`.
///   - `visibility == "team"`: the caller must have a verified membership in
///     `team_id`, and that team must be narrowed to the node's org. The team's
///     embedded role determines whether the grant is read-only or writable.
///   - `visibility == "private"`: the owner and direct collaborators handled above;
///     everyone else gets `None`.
///   - Any unknown visibility string → `None`.
pub fn can_access(
    caller: &VerifiedCaller,
    owner_user_id: Option<&str>,
    org_id: Option<&str>,
    visibility: &str,
    team_id: Option<&str>,
    collaborators: &[ResourceCollaborator],
) -> Access {
    if let Some(owner) = owner_user_id {
        if owner == caller.user_id {
            return Access::Write;
        }
    }

    let same_scope = org_id.is_none() || caller.org_id.as_deref() == org_id;
    if same_scope {
        if let Some(collaborator) = collaborators
            .iter()
            .find(|collaborator| collaborator.user_id == caller.user_id)
        {
            return collaborator.access;
        }
    }

    match visibility {
        "private" => Access::None,
        "org" => org_access(caller, org_id),
        "team" => team_access(caller, org_id, team_id),
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

/// Resolve a team-scoped grant. A team id alone is not sufficient: the resource
/// org and the caller's narrowed team membership must both agree, preventing a
/// team id from another organization from widening access.
fn team_access(caller: &VerifiedCaller, org_id: Option<&str>, team_id: Option<&str>) -> Access {
    let (Some(caller_org), Some(resource_org), Some(team_id)) =
        (caller.org_id.as_deref(), org_id, team_id)
    else {
        return Access::None;
    };
    if caller_org != resource_org {
        return Access::None;
    }

    caller
        .teams
        .iter()
        .find(|team| team.id == team_id && team.org_id == resource_org)
        .map(|team| {
            if OrgRole::from_ba_str(&team.role).satisfies(OrgRole::Member) {
                Access::Write
            } else {
                Access::Read
            }
        })
        .unwrap_or(Access::None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_names_its_session_only_with_a_non_empty_ryu_sid() {
        use base64::Engine as _;
        let token = |claims: serde_json::Value| {
            let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
            format!(
                "{}.{}.sig",
                engine.encode(br#"{"alg":"EdDSA"}"#),
                engine.encode(claims.to_string())
            )
        };
        assert!(token_names_session(&token(
            serde_json::json!({ "sub": "u", "ryu_sid": "s1" })
        )));
        assert!(!token_names_session(&token(
            serde_json::json!({ "sub": "u" })
        )));
        assert!(!token_names_session(&token(
            serde_json::json!({ "ryu_sid": "" })
        )));
        assert!(!token_names_session(&token(
            serde_json::json!({ "ryu_sid": 7 })
        )));
        assert!(!token_names_session("not-a-jwt"));
        assert!(!token_names_session("a.!!!.c"));
    }

    #[test]
    fn an_unbound_token_is_dropped_on_a_refusal_whatever_its_age() {
        // A token minted before the control plane bound tokens to sessions.
        assert!(unbound_or_old_enough(false, 1_000, 1_001, 60));
        // A bound token only once it is old enough.
        assert!(!unbound_or_old_enough(true, 1_000, 1_010, 60));
        assert!(unbound_or_old_enough(true, 1_000, 1_060, 60));
    }

    #[test]
    fn a_refused_token_is_dropped_only_once_it_is_old_enough() {
        assert!(!minted_long_enough_ago(1_000, 1_010, 60));
        assert!(minted_long_enough_ago(1_000, 1_060, 60));
        assert!(minted_long_enough_ago(1_000, 2_000, 60));
        // A clock that went backwards never counts as old enough.
        assert!(!minted_long_enough_ago(1_000, 900, 60));
    }

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
            email_verified: false,
            org_id: org.map(str::to_owned),
            role,
            teams: Vec::new(),
        }
    }

    #[test]
    fn owner_always_writes() {
        let c = caller("u1", None, OrgRole::Viewer);
        assert_eq!(
            can_access(&c, Some("u1"), Some("o1"), "private", None, &[]),
            Access::Write
        );
    }

    #[test]
    fn access_at_least_orders_none_read_write() {
        assert!(Access::Write.at_least(Access::Read));
        assert!(Access::Read.at_least(Access::Read));
        assert!(!Access::Read.at_least(Access::Write));
        assert!(!Access::None.at_least(Access::Read));
    }

    #[test]
    fn private_denies_non_owner() {
        let c = caller("u2", Some("o1"), OrgRole::Owner);
        assert_eq!(
            can_access(&c, Some("u1"), Some("o1"), "private", None, &[]),
            Access::None
        );
    }

    #[test]
    fn direct_collaborators_get_their_role_only_inside_the_resource_org() {
        let viewer = caller("u2", Some("o1"), OrgRole::Viewer);
        let collaborators = vec![ResourceCollaborator {
            user_id: "u2".to_owned(),
            access: Access::Read,
        }];
        assert_eq!(
            can_access(
                &viewer,
                Some("u1"),
                Some("o1"),
                "private",
                None,
                &collaborators,
            ),
            Access::Read
        );

        let outsider = caller("u2", Some("o2"), OrgRole::Owner);
        assert_eq!(
            can_access(
                &outsider,
                Some("u1"),
                Some("o1"),
                "private",
                None,
                &collaborators,
            ),
            Access::None
        );
    }

    #[test]
    fn org_member_writes_viewer_reads() {
        let member = caller("u2", Some("o1"), OrgRole::Member);
        assert_eq!(
            can_access(&member, Some("u1"), Some("o1"), "org", None, &[]),
            Access::Write
        );
        let viewer = caller("u3", Some("o1"), OrgRole::Viewer);
        assert_eq!(
            can_access(&viewer, Some("u1"), Some("o1"), "org", None, &[]),
            Access::Read
        );
    }

    #[test]
    fn team_visibility_requires_matching_membership_and_role() {
        let member = caller("u2", Some("o1"), OrgRole::Member);
        let mut member = member;
        member.teams.push(TeamMembership {
            id: "t1".to_owned(),
            org_id: "o1".to_owned(),
            role: "member".to_owned(),
        });
        assert_eq!(
            can_access(&member, Some("u1"), Some("o1"), "team", Some("t1"), &[]),
            Access::Write
        );
        assert_eq!(
            can_access(&member, Some("u1"), Some("o1"), "team", Some("t2"), &[]),
            Access::None
        );

        let mut viewer = caller("u3", Some("o1"), OrgRole::Viewer);
        viewer.teams.push(TeamMembership {
            id: "t1".to_owned(),
            org_id: "o1".to_owned(),
            role: "viewer".to_owned(),
        });
        assert_eq!(
            can_access(&viewer, Some("u1"), Some("o1"), "team", Some("t1"), &[]),
            Access::Read
        );
    }

    #[test]
    fn org_non_member_denied() {
        // A non-member has org_id = None, so the same-org check cannot match.
        let outsider = caller("u4", None, OrgRole::Viewer);
        assert_eq!(
            can_access(&outsider, Some("u1"), Some("o1"), "org", None, &[]),
            Access::None
        );
        // Different org also denied.
        let other = caller("u5", Some("o2"), OrgRole::Owner);
        assert_eq!(
            can_access(&other, Some("u1"), Some("o1"), "org", None, &[]),
            Access::None
        );
    }

    #[test]
    fn unknown_visibility_denied() {
        let c = caller("u2", Some("o1"), OrgRole::Owner);
        assert_eq!(
            can_access(&c, Some("u1"), Some("o1"), "weird", None, &[]),
            Access::None
        );
    }

    #[test]
    fn to_caller_selects_node_org_membership() {
        let claims = VerifiedClaims {
            user_id: "u1".to_owned(),
            email: Some("a@b.c".to_owned()),
            email_verified: true,
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
            teams: Vec::new(),
            feature_flags: BTreeSet::new(),
            feature_flags_org: None,
            limits: None,
        };
        let c = to_caller_for_org(&claims, Some("o1"));
        assert_eq!(c.org_id.as_deref(), Some("o1"));
        assert_eq!(c.role, OrgRole::Admin);
        assert!(c.email_verified, "the verification bit survives narrowing");
        assert_eq!(c.verified_email(), Some("a@b.c"));

        // Not a member of the node's org → no org context, viewer, fail-closed.
        let outsider = to_caller_for_org(&claims, Some("o3"));
        assert_eq!(outsider.org_id, None);
        assert_eq!(outsider.role, OrgRole::Viewer);

        // Node not org-bound → no org context.
        let unbound = to_caller_for_org(&claims, None);
        assert_eq!(unbound.org_id, None);
        assert_eq!(unbound.role, OrgRole::Viewer);
    }

    /// Pins the wire contract against the TypeScript minter: `definePayload`
    /// emits `teams: [{ id, org, role }]`. If either side renames a key the teams
    /// silently vanish (they would never match a node org), so this decodes the
    /// literal JSON shape rather than a struct literal.
    #[test]
    fn claims_decode_team_memberships_from_the_payload_shape() {
        let raw: RawClaims = serde_json::from_str(
            r#"{"id":"u1","email":"a@b.c",
                "orgs":[{"id":"o1","role":"admin"}],
                "teams":[{"id":"t1","org":"o1","role":"admin"}]}"#,
        )
        .expect("payload with teams must decode");
        assert_eq!(raw.teams.len(), 1);
        assert_eq!(raw.teams[0].id, "t1");
        assert_eq!(raw.teams[0].org, "o1");
        assert_eq!(raw.teams[0].role, "admin");
    }

    /// Back-compat: every token minted before teams were embedded carries no
    /// `teams` key at all. Absence means "no team memberships" — decoding must
    /// still succeed, or every live session breaks the moment this ships.
    #[test]
    fn claims_without_teams_still_decode_as_no_memberships() {
        let raw: RawClaims = serde_json::from_str(
            r#"{"id":"u1","email":"a@b.c","orgs":[{"id":"o1","role":"admin"}]}"#,
        )
        .expect("pre-teams token must still decode");
        assert!(raw.teams.is_empty());

        // A team entry missing `org` is kept but unmatchable rather than fatal:
        // one malformed row must not reject an otherwise valid token.
        let partial: RawClaims =
            serde_json::from_str(r#"{"id":"u1","teams":[{"id":"t1","role":"admin"}]}"#)
                .expect("team entry without org must not fail the token");
        assert_eq!(partial.teams[0].org, "");
    }

    /// `ryu_limits` is `{ "boxConcurrency": n }`, minted beside `ryu_flags`
    /// (`CORE_LIMITS_CLAIM` in `packages/auth/src/lib/plans.ts`). Absence and
    /// malformed shapes read as no claim without failing the token.
    #[test]
    fn identity_verify_limits_claim_parses_and_defaults_to_none() {
        let raw: RawClaims =
            serde_json::from_str(r#"{"id":"u1","ryu_limits":{"boxConcurrency":3}}"#)
                .expect("payload with limits must decode");
        assert_eq!(raw.ryu_limits, Some(VerifiedLimits { box_concurrency: 3 }));
        let zero: RawClaims =
            serde_json::from_str(r#"{"id":"u1","ryu_limits":{"boxConcurrency":0}}"#).unwrap();
        assert_eq!(zero.ryu_limits, Some(VerifiedLimits { box_concurrency: 0 }));
        let absent: RawClaims = serde_json::from_str(r#"{"id":"u1"}"#).unwrap();
        assert_eq!(absent.ryu_limits, None);
        for malformed in [
            r#"{"id":"u1","ryu_limits":null}"#,
            r#"{"id":"u1","ryu_limits":3}"#,
            r#"{"id":"u1","ryu_limits":{}}"#,
            r#"{"id":"u1","ryu_limits":{"boxConcurrency":"3"}}"#,
            r#"{"id":"u1","ryu_limits":{"boxConcurrency":-1}}"#,
            r#"{"id":"u1","ryu_limits":{"boxConcurrency":1.5}}"#,
            r#"{"id":"u1","ryu_limits":{"boxConcurrency":4294967296}}"#,
        ] {
            let raw: RawClaims =
                serde_json::from_str(malformed).expect("malformed limits never fail the token");
            assert_eq!(raw.ryu_limits, None, "{malformed}");
        }
    }

    /// The minter (`packages/auth/src/lib/core-flag-claim.ts`) emits
    /// `ryu_flags: ["key", ...]` only when a flag is on. Absence and malformed
    /// shapes must read as "no flags" without failing the token.
    #[test]
    fn flag_claim_parses_and_defaults_closed() {
        let raw: RawClaims = serde_json::from_str(
            r#"{"id":"u1","ryu_flags":["cloud_tasks.box_backend","other.flag"]}"#,
        )
        .expect("payload with flags must decode");
        assert!(raw.ryu_flags.contains("cloud_tasks.box_backend"));
        assert_eq!(raw.ryu_flags.len(), 2);

        let absent: RawClaims =
            serde_json::from_str(r#"{"id":"u1"}"#).expect("pre-flag token must decode");
        assert!(absent.ryu_flags.is_empty());

        for malformed in [
            r#"{"id":"u1","ryu_flags":null}"#,
            r#"{"id":"u1","ryu_flags":"cloud_tasks.box_backend"}"#,
            r#"{"id":"u1","ryu_flags":{"cloud_tasks.box_backend":true}}"#,
        ] {
            let raw: RawClaims =
                serde_json::from_str(malformed).expect("a malformed flag claim must not fail");
            assert!(raw.ryu_flags.is_empty(), "{malformed}");
        }

        let mixed: RawClaims =
            serde_json::from_str(r#"{"id":"u1","ryu_flags":["a.b",1,null,"",{"x":1}]}"#)
                .expect("mixed entries must decode");
        assert_eq!(
            mixed.ryu_flags.into_iter().collect::<Vec<_>>(),
            vec!["a.b".to_owned()]
        );
    }

    /// `ryu_flags_org` names the org the flags were evaluated for. A missing or
    /// malformed value reads as "no org context" without failing the token.
    #[test]
    fn flag_org_claim_parses_and_defaults_to_no_org() {
        let raw: RawClaims = serde_json::from_str(
            r#"{"id":"u1","ryu_flags":["cloud_tasks.box_backend"],"ryu_flags_org":"org_a"}"#,
        )
        .expect("payload with a flag org must decode");
        assert_eq!(raw.ryu_flags_org.as_deref(), Some("org_a"));

        let absent: RawClaims =
            serde_json::from_str(r#"{"id":"u1"}"#).expect("pre-org-claim token must decode");
        assert_eq!(absent.ryu_flags_org, None);

        let oversized = format!(r#"{{"id":"u1","ryu_flags_org":"{}"}}"#, "o".repeat(129));
        for malformed in [
            r#"{"id":"u1","ryu_flags_org":null}"#.to_owned(),
            r#"{"id":"u1","ryu_flags_org":""}"#.to_owned(),
            r#"{"id":"u1","ryu_flags_org":7}"#.to_owned(),
            r#"{"id":"u1","ryu_flags_org":{"id":"org_a"}}"#.to_owned(),
            oversized,
        ] {
            let raw: RawClaims =
                serde_json::from_str(&malformed).expect("a malformed flag org must not fail");
            assert_eq!(raw.ryu_flags_org, None, "{malformed}");
        }
    }

    /// The narrowing is what makes a team claim safe to trust: a team is only
    /// meaningful inside its own org, so anything from another org must be gone
    /// before a team-scoped check ever sees the caller.
    #[test]
    fn to_caller_narrows_teams_to_the_node_org() {
        let claims = VerifiedClaims {
            user_id: "u1".to_owned(),
            email: None,
            email_verified: false,
            orgs: vec![
                OrgMembership {
                    id: "o1".to_owned(),
                    role: "member".to_owned(),
                },
                OrgMembership {
                    id: "o2".to_owned(),
                    role: "owner".to_owned(),
                },
            ],
            teams: vec![
                TeamMembership {
                    id: "t1".to_owned(),
                    org_id: "o1".to_owned(),
                    role: "member".to_owned(),
                },
                TeamMembership {
                    id: "t2".to_owned(),
                    org_id: "o2".to_owned(),
                    role: "owner".to_owned(),
                },
            ],
            feature_flags: BTreeSet::new(),
            feature_flags_org: None,
            limits: None,
        };

        let c = to_caller_for_org(&claims, Some("o1"));
        let ids: Vec<&str> = c.teams.iter().map(|t| t.id.as_str()).collect();
        // t2 is a real membership of this user — but in a DIFFERENT org, so on an
        // o1-bound node it must not be reachable.
        assert_eq!(ids, vec!["t1"]);
        assert_eq!(c.teams[0].role, "member");

        // Non-member of the node's org: no org context and therefore no teams,
        // even though the user does hold team memberships elsewhere.
        let outsider = to_caller_for_org(&claims, Some("o3"));
        assert!(outsider.teams.is_empty());

        // Node not org-bound: no org to narrow against, so no team context.
        let unbound = to_caller_for_org(&claims, None);
        assert!(unbound.teams.is_empty());
    }

    /// Pins the `email_verified` wire contract against the TypeScript minter
    /// (`definePayload` emits `email_verified: user.emailVerified === true`).
    /// Only a JSON `true` proves mailbox ownership; an absent claim (every token
    /// minted before it existed), `false`, or a non-boolean is unverified, and a
    /// malformed value never rejects the token as a whole.
    #[test]
    fn claims_decode_email_verified_strictly() {
        let decode = |payload: &str| -> RawClaims {
            serde_json::from_str(payload).expect("payload must decode")
        };
        assert!(decode(r#"{"id":"u1","email":"a@b.c","email_verified":true}"#).email_verified);
        for payload in [
            r#"{"id":"u1","email":"a@b.c"}"#,
            r#"{"id":"u1","email":"a@b.c","email_verified":false}"#,
            r#"{"id":"u1","email":"a@b.c","email_verified":"true"}"#,
            r#"{"id":"u1","email":"a@b.c","email_verified":1}"#,
            r#"{"id":"u1","email":"a@b.c","email_verified":null}"#,
        ] {
            assert!(!decode(payload).email_verified, "{payload}");
        }
    }

    /// A caller carrying an unverified address keeps it for display, but it is
    /// never offered as the address to match email-addressed grants.
    #[test]
    fn verified_email_requires_the_verification_bit() {
        let claims = |email: Option<&str>, email_verified: bool| VerifiedClaims {
            user_id: "u1".to_owned(),
            email: email.map(str::to_owned),
            email_verified,
            orgs: Vec::new(),
            teams: Vec::new(),
            feature_flags: BTreeSet::new(),
            feature_flags_org: None,
            limits: None,
        };

        let unverified = to_caller_for_org(&claims(Some("victim@example.com"), false), None);
        assert_eq!(unverified.email.as_deref(), Some("victim@example.com"));
        assert_eq!(unverified.verified_email(), None);

        let verified = to_caller_for_org(&claims(Some(" owner@example.com "), true), None);
        assert_eq!(verified.verified_email(), Some("owner@example.com"));

        let blank = to_caller_for_org(&claims(Some("  "), true), None);
        assert_eq!(blank.verified_email(), None);
        let missing = to_caller_for_org(&claims(None, true), None);
        assert_eq!(missing.verified_email(), None);
    }
}
