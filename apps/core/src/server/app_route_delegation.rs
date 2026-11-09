//! Short-lived, path-scoped delegations to one app's routes.
//!
//! A client that holds a member session can mint a bearer for a narrow slice of
//! one app's ext-proxy surface (`POST /api/app-delegations`), for a background
//! worker that must keep calling those routes while the session itself is not
//! at hand: a phone uploading recorded chunks from a background `URLSession`,
//! for example. The token names:
//!
//! - the app (`plugin`) and a literal sub-path `prefix` under its ext mount;
//! - the HTTP methods it may use;
//! - the member it acts for (`user`, absent for the owner of an unbound node);
//! - this node and its organization binding, and an expiry of at most
//!   [`MAX_TTL_SECONDS`].
//!
//! The ext-proxy admits it only on a route that declares a permission level
//! (see `sidecar::ext_proxy::member_admission`) and then runs the ordinary
//! per-route permission check for that member on every request, so the token
//! never carries more than the member's current permission level on that
//! route.
//!
//! # Revocation
//!
//! A delegation is not revoked one by one. Membership itself is not re-checked
//! here: the token's `org` claim stands for the member's organization until it
//! expires, so a removed member keeps whatever the per-route check (with its
//! cached or fallback permissions while the control plane is unreachable)
//! still grants them, for at most [`MAX_TTL_SECONDS`]. Rotating the node token
//! revokes every outstanding delegation at once, and also signs every device
//! out. Clients should therefore mint delegations as short as their work
//! allows.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

/// Every delegation token starts with this, so the proxy can tell it from a
/// node token or a JWT without trying to verify either.
pub(crate) const TOKEN_PREFIX: &str = "rad1.";
const DOMAIN: &[u8] = b"ryu-app-route-delegation-v1\0";
/// The default lifetime.
pub(crate) const DEFAULT_TTL_SECONDS: u64 = 60 * 60;
/// The longest lifetime a delegation may have.
pub(crate) const MAX_TTL_SECONDS: u64 = 4 * 60 * 60;
/// The shortest lifetime a delegation may have.
pub(crate) const MIN_TTL_SECONDS: u64 = 60;
const MAX_TOKEN_BYTES: usize = 4096;
const MAX_PREFIX_BYTES: usize = 512;
const CLOCK_SKEW_SECONDS: u64 = 5;
const METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

/// The signed facts of one delegation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Claims {
    pub(crate) plugin: String,
    pub(crate) prefix: String,
    pub(crate) methods: Vec<String>,
    pub(crate) user: Option<String>,
    pub(crate) org: Option<String>,
    pub(crate) node: String,
    pub(crate) iat: u64,
    pub(crate) exp: u64,
    pub(crate) jti: String,
}

/// Why a delegation was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DelegationRefusal {
    Malformed,
    BadSignature,
    WrongApp,
    WrongNode,
    Expired,
    OutsidePrefix,
    MethodNotAllowed,
}

/// This node, as delegations bind it.
pub(crate) fn node_binding() -> String {
    crate::sidecar::control_plane::registered_node()
        .map(|node| node.node_id)
        .unwrap_or_else(|| format!("local:{}", crate::paths::ryu_dir().display()))
}

/// A literal sub-path prefix: starts with `/`, at most [`MAX_PREFIX_BYTES`],
/// no empty, `.` or `..` segments, no route syntax (`:`, `*`), no query,
/// fragment, backslash, percent-escape or whitespace.
pub(crate) fn prefix_is_valid(prefix: &str) -> bool {
    if prefix.len() > MAX_PREFIX_BYTES || prefix == "/" {
        return false;
    }
    let Some(segments) = prefix.strip_prefix('/') else {
        return false;
    };
    segments.split('/').all(|segment| {
        !matches!(segment, "" | "." | "..")
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-._~@".contains(&byte))
    })
}

/// Uppercase, deduplicated, known methods, or `None` when any is unknown.
pub(crate) fn normalize_methods(methods: &[String]) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for method in methods {
        let method = method.trim().to_ascii_uppercase();
        if !METHODS.contains(&method.as_str()) {
            return None;
        }
        if !out.contains(&method) {
            out.push(method);
        }
    }
    (!out.is_empty()).then_some(out)
}

/// Whether `sub_path` is `prefix` or lies below it on a segment boundary.
pub(crate) fn path_within_prefix(sub_path: &str, prefix: &str) -> bool {
    sub_path == prefix
        || sub_path
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Whether a declared route `pattern` can match some path at or below
/// `prefix`: each prefix segment must equal the pattern's literal segment or
/// fall on a `:param`, or the pattern ends in `*rest` before the prefix does.
pub(crate) fn pattern_reaches_prefix(pattern: &str, prefix: &str) -> bool {
    let mut pattern_segments = pattern.trim_start_matches('/').split('/');
    for segment in prefix.trim_start_matches('/').split('/') {
        match pattern_segments.next() {
            Some(rest) if rest.starts_with('*') => return true,
            Some(param) if param.starts_with(':') => {}
            Some(literal) if literal == segment => {}
            _ => return false,
        }
    }
    true
}

fn mac_for(key: &str, claims_segment: &str) -> Option<Hmac<Sha256>> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.trim().as_bytes()).ok()?;
    mac.update(DOMAIN);
    mac.update(claims_segment.as_bytes());
    Some(mac)
}

/// Sign `claims` with `key` (the node token).
pub(crate) fn sign_with(claims: &Claims, key: &str) -> Option<String> {
    let segment = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).ok()?);
    let signature = mac_for(key, &segment)?.finalize().into_bytes();
    Some(format!(
        "{TOKEN_PREFIX}{segment}.{}",
        URL_SAFE_NO_PAD.encode(signature)
    ))
}

/// Verify `token` for one request: `plugin`, the request's `sub_path` and
/// `method`, against this node's `node` and `org` binding, at `now`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn verify_with(
    token: &str,
    key: &str,
    plugin: &str,
    sub_path: &str,
    method: &str,
    node: &str,
    org: Option<&str>,
    now: u64,
) -> Result<Claims, DelegationRefusal> {
    if token.len() > MAX_TOKEN_BYTES {
        return Err(DelegationRefusal::Malformed);
    }
    let body = token
        .strip_prefix(TOKEN_PREFIX)
        .ok_or(DelegationRefusal::Malformed)?;
    let (segment, signature) = body.split_once('.').ok_or(DelegationRefusal::Malformed)?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| DelegationRefusal::Malformed)?;
    mac_for(key, segment)
        .ok_or(DelegationRefusal::BadSignature)?
        .verify_slice(&signature)
        .map_err(|_| DelegationRefusal::BadSignature)?;
    let bytes = URL_SAFE_NO_PAD
        .decode(segment)
        .map_err(|_| DelegationRefusal::Malformed)?;
    let claims: Claims =
        serde_json::from_slice(&bytes).map_err(|_| DelegationRefusal::Malformed)?;
    if claims.plugin != plugin {
        return Err(DelegationRefusal::WrongApp);
    }
    if claims.node != node || claims.org.as_deref() != org {
        return Err(DelegationRefusal::WrongNode);
    }
    if now >= claims.exp
        || claims.iat > now.saturating_add(CLOCK_SKEW_SECONDS)
        || claims.exp.saturating_sub(claims.iat) > MAX_TTL_SECONDS
    {
        return Err(DelegationRefusal::Expired);
    }
    if !prefix_is_valid(&claims.prefix) || !path_within_prefix(sub_path, &claims.prefix) {
        return Err(DelegationRefusal::OutsidePrefix);
    }
    if !claims
        .methods
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(method))
    {
        return Err(DelegationRefusal::MethodNotAllowed);
    }
    Ok(claims)
}

/// Verify `token` for a request to `plugin` with this node's live key and
/// binding. `Ok` holds the member it acts for (`None`: the unbound owner).
pub(crate) fn verify_request(
    token: &str,
    plugin: &str,
    sub_path: &str,
    method: &str,
) -> Result<Option<crate::identity_verify::VerifiedCaller>, DelegationRefusal> {
    let key = crate::node_token::active_token().ok_or(DelegationRefusal::BadSignature)?;
    let org = crate::sidecar::control_plane::registered_org().map(|org| org.id);
    let claims = verify_with(
        token,
        &key,
        plugin,
        sub_path,
        method,
        &node_binding(),
        org.as_deref(),
        crate::pairing::now_secs(),
    )?;
    Ok(claims
        .user
        .map(|user_id| crate::identity_verify::VerifiedCaller {
            user_id,
            email: None,
            email_verified: false,
            org_id: claims.org,
            role: crate::identity_verify::OrgRole::Viewer,
            teams: Vec::new(),
        }))
}

#[cfg(test)]
#[path = "app_route_delegation_tests.rs"]
mod tests;
