//! Minting the short-lived user JWT from a Better Auth session token.

use super::*;

/// Seconds of validity a cached minted JWT must still have to be reused.
pub(super) const MINT_REUSE_MARGIN_SECS: i64 = 60;

/// The most recent JWT minted by [`mint_user_jwt`], keyed by the session it was
/// exchanged from so a sign-out or account switch never reuses another identity.
pub(super) struct MintedJwt {
    pub(super) session_token: String,
    pub(super) token: String,
    pub(super) expires_at: i64,
    /// When this token was minted (unix seconds).
    pub(super) minted_at: i64,
    /// Whether the token names the session it was minted from (`ryu_sid`).
    /// The control plane binds a forwarded token to that session, so a token
    /// minted before it stamped the claim is refused (`user_jwt_invalid`)
    /// however young it is.
    pub(super) session_bound: bool,
}

pub(super) fn minted_jwt_cache() -> &'static tokio::sync::Mutex<Option<MintedJwt>> {
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

pub(super) fn unbound_or_old_enough(
    session_bound: bool,
    minted_at: i64,
    now: i64,
    min_age_secs: i64,
) -> bool {
    !session_bound || minted_long_enough_ago(minted_at, now, min_age_secs)
}

pub(super) async fn forget_minted_user_jwt_when(should_drop: impl Fn(&MintedJwt, i64) -> bool) {
    let mut cached = minted_jwt_cache().lock().await;
    let now = chrono::Utc::now().timestamp();
    if cached.as_ref().is_some_and(|entry| should_drop(entry, now)) {
        *cached = None;
    }
}

/// Whether a (verified) token carries a non-empty `ryu_sid` claim. Reads the
/// payload only; the signature was checked when the token was minted.
pub(super) fn token_names_session(token: &str) -> bool {
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

pub(super) fn minted_long_enough_ago(minted_at: i64, now: i64, min_age_secs: i64) -> bool {
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

    let raw_url = format!("{}/api/auth/token", trusted_issuer()?);
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
