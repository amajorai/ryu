//! The Better Auth JWKS cache: TTL, refresh on unknown `kid`, throttle.

use super::*;

/// How long a fetched JWKS is trusted before a refresh is forced. Better Auth
/// rotates signing keys infrequently, so a 1h TTL bounds staleness without
/// hammering the endpoint; an unknown `kid` forces an out-of-band refresh
/// regardless of TTL (see [`JwksCache::decoding_key`]).
pub(super) const JWKS_TTL: Duration = Duration::from_secs(60 * 60);

/// Minimum spacing between network JWKS refreshes triggered on the slow path
/// (stale cache OR unknown `kid`). The `kid` is attacker-controlled in an
/// as-yet-unverified token, so without this throttle a flood of distinct/unknown
/// kids would force one outbound fetch each. We collapse those into at most one
/// fetch per interval; `MIN_REFRESH_INTERVAL << JWKS_TTL`, so legitimate periodic
/// key rotation still refreshes promptly while an unknown-kid flood costs nothing.
pub(super) const MIN_REFRESH_INTERVAL: Duration = Duration::from_secs(30);

// ── JWKS cache ───────────────────────────────────────────────────────────────

/// A decoding key cached by `kid`. `DecodingKey` is not cheap to rebuild, so we
/// keep it behind an `Arc` for clone-on-read.
pub(super) type CachedKey = Arc<DecodingKey>;

pub(super) struct CacheInner {
    pub(super) keys: HashMap<String, CachedKey>,
    pub(super) fetched_at: Option<Instant>,
    /// When a network refresh was last *attempted* (success or failure), used to
    /// throttle slow-path refreshes regardless of outcome.
    pub(super) last_attempt: Option<Instant>,
}

/// Caches the Better Auth JWKS with a TTL and a refresh-on-unknown-kid path. The
/// network fetch never happens while a data lock is held, and concurrent
/// refreshes are coalesced via `refresh_lock` (single-flight).
pub(super) struct JwksCache {
    pub(super) inner: RwLock<CacheInner>,
    /// Serializes the slow path so a burst of unknown-kid requests collapses into
    /// a single network fetch instead of one per request.
    pub(super) refresh_lock: tokio::sync::Mutex<()>,
    pub(super) http: reqwest::Client,
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
        let raw_url = format!("{}/api/auth/jwks", trusted_issuer()?);
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
    pub(super) async fn decoding_key(&self, kid: &str) -> Result<CachedKey, AuthError> {
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
pub(super) fn cache() -> &'static JwksCache {
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
    pin_test_issuer()
}

/// Extract a JWK's `kid` from its common parameters.
pub(super) fn jwk_kid(jwk: &Jwk) -> Option<String> {
    jwk.common.key_id.clone()
}
