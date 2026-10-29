//! Team and organization values from the control plane.
//!
//! On a registered managed node the control plane (`packages/api`
//! `/api/control-plane/.../vault`) is the source of truth for team- and
//! organization-scoped values, so one value reaches every eligible node. Core
//! reads them on demand at dispatch time:
//!
//! * `POST /api/control-plane/gateway/vault/resolve` with the node's gateway
//!   key and the server-derived user id. The control plane re-checks org/team
//!   membership, policies, expiry, and its own folder imports, audits the read,
//!   and returns one value or `found: false`.
//! * Results are cached in memory only (never on disk) for
//!   `RYU_VAULT_SHARED_CACHE_SECS` (default 60). When the control plane is
//!   unreachable, a cached value up to `RYU_VAULT_SHARED_STALE_SECS` (default
//!   900) old is used, so a short control-plane outage does not take every
//!   governed tool down; a definitive "not found"/"denied" is never cached
//!   beyond the fresh window.
//!
//! Human management of shared values is proxied: Core forwards the caller's
//! verified Better Auth JWT with this node's gateway key, so the control plane
//! applies its own RBAC instead of trusting the node. The control plane binds
//! the JWT to the live sign-in session it was minted from and the key to this
//! node, then treats the request exactly as that session (org access policy,
//! required two-factor, that session's `ryu secrets confirm` step-up). It
//! accepts a forwarded JWT only on [`PROXIED_SUBPATHS`] (its
//! `CORE_FORWARDED_JWT_ROUTES`, `packages/api/src/lib/forwarded-user-jwt.ts`).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::plugin_secrets::{SecretResolutionContext, SecretScope};

const ENV_SHARED: &str = "RYU_VAULT_SHARED";
const ENV_CACHE_SECS: &str = "RYU_VAULT_SHARED_CACHE_SECS";
const ENV_STALE_SECS: &str = "RYU_VAULT_SHARED_STALE_SECS";
const DEFAULT_CACHE_SECS: u64 = 60;
const DEFAULT_STALE_SECS: u64 = 900;
const MAX_CACHE_ENTRIES: usize = 2048;

/// One value returned by the control plane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedValue {
    pub value: String,
    pub environment: String,
    pub path: String,
    pub version: i64,
    pub expand_references: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveResponse {
    found: bool,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    version: Option<i64>,
    #[serde(default)]
    expand_references: bool,
}

struct CacheEntry {
    value: Option<SharedValue>,
    fetched: Instant,
}

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn env_secs(name: &str, default: u64) -> Duration {
    Duration::from_secs(
        std::env::var(name)
            .ok()
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(default),
    )
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default()
    })
}

/// Whether shared values come from the control plane: a registered managed
/// node with a gateway key, unless `RYU_VAULT_SHARED=off`.
pub fn is_enabled() -> bool {
    if std::env::var(ENV_SHARED)
        .map(|value| value.trim().eq_ignore_ascii_case("off"))
        .unwrap_or(false)
    {
        return false;
    }
    crate::sidecar::control_plane::registered_node().is_some()
        && crate::sidecar::control_plane::gateway_key().is_some()
}

fn base_url() -> String {
    crate::sidecar::control_plane::control_plane_url()
        .trim_end_matches('/')
        .to_owned()
}

/// Drop every cached shared value (after a proxied write, or on demand).
pub fn invalidate() {
    if let Ok(mut guard) = cache().lock() {
        guard.clear();
    }
}

/// Resolve one shared value for `context`. `None` means not found, denied, or
/// unavailable; the caller falls through to the next candidate.
pub async fn resolve(
    context: &SecretResolutionContext,
    scope: SecretScope,
    scope_id: &str,
    environment: &str,
    path: &str,
    name: &str,
) -> Option<SharedValue> {
    let user_id = context.user_id.as_deref()?;
    let key = gateway_key_or_none()?;
    // The MCP ids are JSON-encoded: scope ids may contain commas, so a plain
    // join would let `["a,b"]` and `["a", "b"]` share an entry.
    let cache_key = format!(
        "{user_id}\u{1f}{}\u{1f}{scope_id}\u{1f}{environment}\u{1f}{path}\u{1f}{name}\u{1f}{}",
        scope.as_str(),
        serde_json::to_string(&context.mcp_ids).unwrap_or_default()
    );
    let fresh = env_secs(ENV_CACHE_SECS, DEFAULT_CACHE_SECS);
    if let Some(hit) = cache().lock().ok().and_then(|guard| {
        guard
            .get(&cache_key)
            .filter(|entry| entry.fetched.elapsed() <= fresh)
            .map(|entry| entry.value.clone())
    }) {
        return hit;
    }
    let body = json!({
        "userId": user_id,
        "scope": scope.as_str(),
        "scopeId": scope_id,
        "environment": environment,
        "path": path,
        "name": name,
        "mcpIds": context.mcp_ids,
        "conversationId": context.conversation_id,
        "nodeId": context.node_id,
    });
    let response = http()
        .post(format!(
            "{}/api/control-plane/gateway/vault/resolve",
            base_url()
        ))
        .header("x-gateway-key", key)
        .json(&body)
        .send()
        .await;
    let parsed = match response {
        Ok(response) if response.status().is_success() => {
            response.json::<ResolveResponse>().await.ok()
        }
        Ok(response)
            if !(response.status().is_server_error()
                || response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS) =>
        {
            // A definite refusal (revoked gateway key, lost access): fail
            // closed and drop any cached value rather than serve it stale.
            tracing::debug!("shared vault resolve refused: {}", response.status());
            if let Ok(mut guard) = cache().lock() {
                guard.remove(&cache_key);
            }
            return None;
        }
        Ok(response) => {
            tracing::debug!("shared vault resolve returned {}", response.status());
            None
        }
        Err(error) => {
            tracing::debug!("shared vault resolve failed: {error}");
            None
        }
    };
    let Some(parsed) = parsed else {
        // Unreachable, a retryable 5xx/429, or malformed: serve a stale
        // positive value if recent.
        let stale = env_secs(ENV_STALE_SECS, DEFAULT_STALE_SECS);
        return cache().lock().ok().and_then(|guard| {
            guard
                .get(&cache_key)
                .filter(|entry| entry.fetched.elapsed() <= stale)
                .and_then(|entry| entry.value.clone())
        });
    };
    let value = match (parsed.found, parsed.value) {
        (true, Some(value)) => Some(SharedValue {
            value,
            environment: parsed.environment.unwrap_or_else(|| environment.to_owned()),
            path: parsed.path.unwrap_or_else(|| path.to_owned()),
            version: parsed.version.unwrap_or(0),
            expand_references: parsed.expand_references,
        }),
        _ => None,
    };
    if let Ok(mut guard) = cache().lock() {
        if guard.len() >= MAX_CACHE_ENTRIES {
            guard.retain(|_, entry| entry.fetched.elapsed() <= fresh);
            if guard.len() >= MAX_CACHE_ENTRIES {
                guard.clear();
            }
        }
        guard.insert(
            cache_key,
            CacheEntry {
                value: value.clone(),
                fetched: Instant::now(),
            },
        );
    }
    value
}

fn gateway_key_or_none() -> Option<String> {
    if !is_enabled() {
        return None;
    }
    crate::sidecar::control_plane::gateway_key()
}

/// Best-effort Gateway `credential_read` row for a runtime resolution. Carries
/// the `ENV/folder/NAME` key only, never the value.
pub fn forward_gateway_audit(key: &str, user_id: Option<String>, conversation_id: Option<String>) {
    if cfg!(test) {
        return;
    }
    let key = key.to_owned();
    tokio::spawn(async move {
        crate::sidecar::gateway::report_credential_read_audit_with_attribution(
            "secret_vault",
            &key,
            conversation_id,
            None,
            crate::sidecar::gateway::ExecAuditAttribution {
                user_id,
                feature: Some("vault".to_owned()),
                ..Default::default()
            },
        )
        .await;
    });
}

/// Every management request Core proxies to
/// `/api/control-plane/orgs/{org}/vault`, as `(method, subpath pattern)`.
/// A `:name` segment matches one non-empty path segment. The control plane
/// takes a forwarded user JWT on exactly these routes
/// (`CORE_FORWARDED_JWT_ROUTES` in `packages/api/src/lib/forwarded-user-jwt.ts`,
/// whose guard test reads this list), so a new proxied route must be added to
/// both.
pub const PROXIED_SUBPATHS: &[(&str, &str)] = &[
    ("GET", "/secrets"),
    ("PUT", "/secrets/:name"),
    ("DELETE", "/secrets/:name"),
    ("GET", "/secrets/:name/versions"),
    ("POST", "/secrets/:name/reveal"),
    ("POST", "/secrets/:name/rollback"),
    ("POST", "/secrets/:name/restore"),
    ("POST", "/secrets/:name/destroy"),
    ("POST", "/export"),
    ("POST", "/import"),
    ("GET", "/change-requests"),
    ("POST", "/change-requests/:id/:decision"),
];

/// Whether `method` `subpath` (no query) is one of [`PROXIED_SUBPATHS`].
pub fn is_proxied_subpath(method: &reqwest::Method, subpath: &str) -> bool {
    let segments: Vec<&str> = subpath.split('/').collect();
    PROXIED_SUBPATHS.iter().any(|(allowed_method, pattern)| {
        let pattern: Vec<&str> = pattern.split('/').collect();
        method.as_str() == *allowed_method
            && pattern.len() == segments.len()
            && pattern.iter().zip(&segments).all(|(want, have)| {
                if want.starts_with(':') {
                    !have.is_empty()
                } else {
                    want == have
                }
            })
    })
}

/// The header that marks a plaintext read this node vouches for.
pub const NODE_VOUCH_HEADER: &str = "x-ryu-node-vouch";

/// Errors from a proxied management call.
#[derive(Debug)]
pub enum ProxyError {
    /// Shared values are not available on this node.
    Unavailable,
    /// The request reached the control plane, which answered with this status.
    Status(u16, Value),
    /// The control plane could not be reached.
    Transport(String),
}

/// The control plane's machine code on a refusal body (`{ "code": ... }`).
pub fn refusal_code(value: &Value) -> Option<&str> {
    value.get("code").and_then(Value::as_str)
}

/// How long a token that drew `user_jwt_org_not_admitted` or
/// `user_jwt_invalid` is kept before a refusal drops it. The organization's
/// policy is checked again on every mint, so dropping it on each refusal would
/// re-mint (and re-run that check) on every request while the refusal
/// persists; `ryu secrets confirm` asks for a fresh token itself.
const REFUSAL_REMINT_SECS: i64 = 60;

/// What a refusal says about the cached minted JWT.
#[derive(Debug, PartialEq, Eq)]
enum MintedJwtOnRefusal {
    Keep,
    /// Its session ended: drop it now.
    Drop,
    /// An organization was left out of it at mint time: drop it once it is
    /// at least [`REFUSAL_REMINT_SECS`] old.
    DropIfOlderThan(i64),
    /// The control plane did not accept it: drop it now when it names no
    /// session (minted before the control plane bound tokens to sessions, so
    /// a re-mint fixes it), otherwise once it is at least that old.
    DropIfUnboundOrOlderThan(i64),
}

fn minted_jwt_on_refusal(status: u16, value: &Value) -> MintedJwtOnRefusal {
    if status != 401 {
        return MintedJwtOnRefusal::Keep;
    }
    match refusal_code(value) {
        Some("user_jwt_session_ended") => MintedJwtOnRefusal::Drop,
        Some("user_jwt_org_not_admitted") => {
            MintedJwtOnRefusal::DropIfOlderThan(REFUSAL_REMINT_SECS)
        }
        Some("user_jwt_invalid") => {
            MintedJwtOnRefusal::DropIfUnboundOrOlderThan(REFUSAL_REMINT_SECS)
        }
        _ => MintedJwtOnRefusal::Keep,
    }
}

/// Build a proxied management request. The gateway key always rides along:
/// it is what tells the control plane the request comes through this node.
/// `node_proof` adds the vouch header, which the control plane honours only
/// on `reveal` and `export`.
#[allow(clippy::too_many_arguments)]
fn build_proxy_request(
    client: &reqwest::Client,
    url: String,
    method: reqwest::Method,
    query: &[(String, String)],
    user_jwt: &str,
    gateway_key: &str,
    body: Option<Value>,
    node_proof: bool,
) -> reqwest::RequestBuilder {
    let mut request = client
        .request(method, url)
        .bearer_auth(user_jwt)
        .header("x-gateway-key", gateway_key)
        .query(query);
    if node_proof {
        request = request.header(NODE_VOUCH_HEADER, "1");
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    request
}

/// Forward a management request for shared values to the control plane with
/// the caller's verified user JWT and this node's gateway key. `subpath` is
/// relative to `/api/control-plane/orgs/{org}/vault`, must start with `/`, and
/// must be one of [`PROXIED_SUBPATHS`].
///
/// With `node_proof`, this node vouches for the read (`x-ryu-node-vouch: 1`).
/// The control plane uses it on `reveal` and `export`, the two routes that
/// return plaintext: there it is the proof that the request comes through this
/// enrolled org or team node rather than from a session alone. Without it
/// those routes ask for an `org.credentials` step-up on the session the JWT
/// was minted from (`ryu secrets confirm`). RBAC still comes from the JWT's
/// session, never from the node. Callers pass `node_proof` only for a
/// plaintext read made at this machine with the node's owner token and whose
/// JWT is the verified caller's (`vault_api::Ctx::node_vouches`).
pub async fn proxy(
    method: reqwest::Method,
    subpath: &str,
    query: &[(String, String)],
    user_jwt: &str,
    body: Option<Value>,
    node_proof: bool,
) -> Result<Value, ProxyError> {
    if !is_enabled() {
        return Err(ProxyError::Unavailable);
    }
    let Some(node) = crate::sidecar::control_plane::registered_node() else {
        return Err(ProxyError::Unavailable);
    };
    let Some(gateway_key) = crate::sidecar::control_plane::gateway_key() else {
        return Err(ProxyError::Unavailable);
    };
    debug_assert!(subpath.starts_with('/'));
    debug_assert!(
        is_proxied_subpath(&method, subpath),
        "{method} {subpath} is not in PROXIED_SUBPATHS"
    );
    let url = format!(
        "{}/api/control-plane/orgs/{}/vault{subpath}",
        base_url(),
        urlencoding::encode(&node.org.id)
    );
    let response = build_proxy_request(
        http(),
        url,
        method.clone(),
        query,
        user_jwt,
        &gateway_key,
        body,
        node_proof,
    )
    .send()
    .await
    .map_err(|error| ProxyError::Transport(error.to_string()))?;
    let status = response.status();
    let value: Value = response.json().await.unwrap_or(Value::Null);
    if method != reqwest::Method::GET {
        invalidate();
    }
    if status.is_success() {
        Ok(value)
    } else {
        match minted_jwt_on_refusal(status.as_u16(), &value) {
            MintedJwtOnRefusal::Keep => {}
            MintedJwtOnRefusal::Drop => crate::identity_verify::forget_minted_user_jwt().await,
            MintedJwtOnRefusal::DropIfOlderThan(secs) => {
                crate::identity_verify::forget_minted_user_jwt_older_than(secs).await;
            }
            MintedJwtOnRefusal::DropIfUnboundOrOlderThan(secs) => {
                crate::identity_verify::forget_minted_user_jwt_if_unbound_or_older_than(secs).await;
            }
        }
        Err(ProxyError::Status(status.as_u16(), value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn disabled_without_a_registered_node() {
        assert!(!is_enabled());
        let context = SecretResolutionContext {
            user_id: Some("u1".into()),
            node_id: "node-1".into(),
            ..Default::default()
        };
        assert_eq!(
            resolve(&context, SecretScope::Org, "org-1", "default", "/", "TOKEN").await,
            None
        );
        assert!(matches!(
            proxy(reqwest::Method::GET, "/secrets", &[], "jwt", None, false).await,
            Err(ProxyError::Unavailable)
        ));
    }

    fn header<'a>(request: &'a reqwest::Request, name: &str) -> Option<&'a str> {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    }

    #[test]
    fn every_proxied_request_carries_the_node_key_and_only_a_vouch_asks_for_one() {
        let client = reqwest::Client::new();
        let build = |node_proof: bool| {
            build_proxy_request(
                &client,
                "http://control-plane.test/api/control-plane/orgs/o/vault/export".to_owned(),
                reqwest::Method::POST,
                &[],
                "user.jwt.token",
                "rgw_node_key",
                Some(json!({ "environment": "default" })),
                node_proof,
            )
            .build()
            .expect("request builds")
        };
        let plain = build(false);
        assert_eq!(header(&plain, "x-gateway-key"), Some("rgw_node_key"));
        assert_eq!(
            header(&plain, "authorization"),
            Some("Bearer user.jwt.token")
        );
        assert_eq!(header(&plain, NODE_VOUCH_HEADER), None);
        assert_eq!(header(&plain, "x-ryu-user-jwt"), None);
        assert_eq!(header(&plain, "cookie"), None);
        let vouched = build(true);
        assert_eq!(header(&vouched, "x-gateway-key"), Some("rgw_node_key"));
        assert_eq!(header(&vouched, NODE_VOUCH_HEADER), Some("1"));
    }

    #[test]
    fn the_proxied_subpaths_are_exactly_the_control_plane_allowlist() {
        // Paired with `CORE_FORWARDED_JWT_ROUTES` in
        // packages/api/src/lib/forwarded-user-jwt.ts (its guard test reads this
        // list): the control plane takes a forwarded JWT on these and no other.
        let get = reqwest::Method::GET;
        let post = reqwest::Method::POST;
        let put = reqwest::Method::PUT;
        let delete = reqwest::Method::DELETE;
        for (method, subpath) in [
            (&get, "/secrets"),
            (&put, "/secrets/API_KEY"),
            (&delete, "/secrets/API%20KEY"),
            (&get, "/secrets/API_KEY/versions"),
            (&post, "/secrets/API_KEY/reveal"),
            (&post, "/secrets/API_KEY/rollback"),
            (&post, "/secrets/API_KEY/restore"),
            (&post, "/secrets/API_KEY/destroy"),
            (&post, "/export"),
            (&post, "/import"),
            (&get, "/change-requests"),
            (&post, "/change-requests/cr_1/approve"),
        ] {
            assert!(is_proxied_subpath(method, subpath), "{method} {subpath}");
        }
        for (method, subpath) in [
            (&get, "/policies"),
            (&get, "/audit"),
            (&put, "/environments/staging"),
            (&get, "/export"),
            (&post, "/secrets"),
            (&post, "/secrets//reveal"),
            (&post, "/secrets/API_KEY/share"),
            (&post, "/export/"),
        ] {
            assert!(!is_proxied_subpath(method, subpath), "{method} {subpath}");
        }
        assert_eq!(PROXIED_SUBPATHS.len(), 12);
    }

    #[test]
    fn only_a_stale_or_unaccepted_jwt_refusal_drops_the_minted_token() {
        let on = |status: u16, code: &str| minted_jwt_on_refusal(status, &json!({ "code": code }));
        assert_eq!(on(401, "user_jwt_session_ended"), MintedJwtOnRefusal::Drop);
        // A policy that keeps refusing re-mints at most once a minute.
        assert_eq!(
            on(401, "user_jwt_org_not_admitted"),
            MintedJwtOnRefusal::DropIfOlderThan(REFUSAL_REMINT_SECS)
        );
        // A token minted before the control plane bound tokens to sessions is
        // re-minted at once; any other refused token at most once a minute.
        assert_eq!(
            on(401, "user_jwt_invalid"),
            MintedJwtOnRefusal::DropIfUnboundOrOlderThan(REFUSAL_REMINT_SECS)
        );
        for code in [
            "user_jwt_session_ended",
            "user_jwt_org_not_admitted",
            "user_jwt_invalid",
        ] {
            assert_eq!(on(403, code), MintedJwtOnRefusal::Keep);
        }
        for code in [
            "personal_node_required",
            "node_proxy_required",
            "not_an_org_member",
            "org_session_expired",
            "user_jwt_lookup_unavailable",
        ] {
            assert_eq!(on(401, code), MintedJwtOnRefusal::Keep);
        }
        assert_eq!(
            minted_jwt_on_refusal(401, &Value::Null),
            MintedJwtOnRefusal::Keep
        );
    }
}
