//! Request layer for every vault route: client address, quotas, response
//! wrapping, and policy-required wrapping.

use super::wrap_policy::explain_wrapping_refusal;
use super::*;
use crate::vault::policy::wrap_requirement;

pub(super) fn wrap_ttl(headers: &HeaderMap) -> Result<Option<i64>, Response> {
    let Some(value) = headers
        .get(WRAP_TTL_HEADER)
        .or_else(|| headers.get(VAULT_WRAP_TTL_HEADER))
    else {
        return Ok(None);
    };
    let text = value
        .to_str()
        .map_err(|_| invalid_request("invalid wrap TTL header"))?;
    wrapping::parse_wrap_ttl(text)
        .map(Some)
        .map_err(vault_error)
}

pub(super) fn client_ip(request: &Request) -> Option<std::net::IpAddr> {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip());
    let forwarded = request
        .headers()
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok());
    tokens::resolve_client_ip(
        peer,
        forwarded,
        &tokens::trusted_proxies(),
        crate::sidecar::forwarding_tunnel_active(),
    )
}

/// Whether a lease-count rejection for `quota` should be audited: at most
/// once a minute per quota, so a flood of refused issues cannot grow the
/// audit log or contend on the store lock.
pub(super) fn lease_rejection_due(quota: &str) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    static LAST: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    let Ok(mut last) = LAST.get_or_init(|| Mutex::new(HashMap::new())).lock() else {
        return false;
    };
    let now = Instant::now();
    match last.get(quota) {
        Some(at) if now.duration_since(*at) < Duration::from_secs(60) => false,
        _ => {
            last.insert(quota.to_owned(), now);
            true
        }
    }
}

pub(super) fn too_many(
    store: &'static PluginSecretStore,
    exceeded: &quotas::QuotaExceeded,
    path: &str,
    audit: bool,
) -> Response {
    if audit {
        let entry = AuditEntry::new(&AuditActor::new("client", None), "quota.exceeded", "denied")
            .details(json!({ "quota": exceeded.quota, "path": path }));
        // Audit off the request path; the rejection itself never waits on it.
        tokio::spawn(async move { store.audit(&entry).await });
    }
    let mut response = json_error(
        StatusCode::TOO_MANY_REQUESTS,
        format!("vault_quota_exceeded: {}", exceeded.message),
    );
    if let Ok(value) = HeaderValue::from_str(&exceeded.retry_after_secs.to_string()) {
        response
            .headers_mut()
            .insert(axum::http::header::RETRY_AFTER, value);
    }
    response
}

/// The role of a dynamic-issue route, if `path` is one: `Some(Ok(role))`
/// percent-decoded exactly as the handler's `Path` extractor sees it, or
/// `Some(Err(()))` when the decoded segment is not a valid role name.
pub(super) fn dynamic_issue_role(method: &Method, path: &str) -> Option<Result<String, ()>> {
    if method != Method::POST {
        return None;
    }
    let raw = path
        .strip_prefix("/api/vault/dynamic/issue/")
        .or_else(|| path.strip_prefix("/api/vault/agent/dynamic/"))
        .filter(|role| !role.is_empty() && !role.contains('/'))?;
    Some(
        urlencoding::decode(raw)
            .ok()
            .map(std::borrow::Cow::into_owned)
            .filter(|role| crate::vault::dynamic::is_valid_role_name(role))
            .ok_or(()),
    )
}

pub(super) fn is_wrapping_route(path: &str) -> bool {
    path.starts_with("/api/vault/sys/wrapping/") || path.starts_with("/api/vault/agent/wrapping/")
}

/// Server-sent event routes (`/api/vault/events`, `/api/vault/agent/events`,
/// `/api/vault/items/:key/events`). Their body never ends, so it cannot be
/// buffered into a wrapped response.
pub(super) fn is_streaming_route(path: &str) -> bool {
    path.starts_with("/api/vault/") && path.ends_with("/events")
}

pub(super) fn is_event_stream(response: &Response) -> bool {
    response
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"))
}

pub(super) fn stream_wrap_unsupported() -> Response {
    invalid_request("response wrapping is not supported on streaming routes")
}

pub(super) async fn wrap_body(
    store: &PluginSecretStore,
    response: Response,
    ttl_secs: i64,
    path: &str,
    context: &RequestContext,
) -> Response {
    if !response.status().is_success() {
        return response;
    }
    // A stream is dropped, not buffered: its body may never end.
    if is_event_stream(&response) {
        return stream_wrap_unsupported();
    }
    let bytes = match axum::body::to_bytes(response.into_body(), wrapping::MAX_WRAPPED_BYTES).await
    {
        Ok(bytes) => bytes,
        // The secret is dropped rather than returned unwrapped.
        Err(_) => {
            return json_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "vault_invalid_request: the response is too large to wrap".to_owned(),
            )
        }
    };
    let actor = match context.token_accessor() {
        Some(accessor) => AuditActor::new("token", Some(&accessor)),
        None => AuditActor::new("request", None),
    };
    match store.wrap_response(&bytes, ttl_secs, path, &actor).await {
        Ok(info) => {
            let mut response = respond(json!({ "wrapInfo": info }));
            response
                .headers_mut()
                .insert("x-ryu-wrapped", HeaderValue::from_static("true"));
            response
        }
        Err(error) => vault_error(error),
    }
}

/// Middleware for every vault route: client address, quotas, and response
/// wrapping. A wrap TTL is validated before the handler runs, so a bad
/// header cannot cost a single-use secret.
pub async fn request_layer(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    let wrap_ttl = match wrap_ttl(request.headers()) {
        Ok(ttl) => ttl.filter(|_| !is_wrapping_route(&path)),
        Err(response) => return response,
    };
    // Vault clients expect Vault's `wrap_info` envelope, which the `/v1`
    // surface does not produce; refuse instead of handing back an unwrapped
    // value the caller meant to send on wrapped.
    if wrap_ttl.is_some() && path.starts_with("/v1/") {
        return compat_wrap_unsupported();
    }
    if wrap_ttl.is_some() && is_streaming_route(&path) {
        return stream_wrap_unsupported();
    }
    let client = client_ip(&request);
    let Some(store) = crate::plugin_secrets::global() else {
        if wrap_ttl.is_some() {
            return store()
                .err()
                .unwrap_or_else(|| StatusCode::SERVICE_UNAVAILABLE.into_response());
        }
        return next.run(request).await;
    };
    let active = match store.quota_active().await {
        Ok(active) => active,
        Err(error) => return vault_error(error),
    };
    let client_key = client.map_or_else(|| "unknown".to_owned(), |ip| ip.to_string());
    for quota in quotas::rate_quotas_for(&active, &path) {
        // An unknown address would put every tunneled and local caller in one
        // bucket a single client could drain, so the built-in per-client
        // login quota skips it.
        if client.is_none() && quota.builtin {
            continue;
        }
        if let Err(denied) = quotas::limiter().check(
            &quota.name,
            &quota.rule,
            &client_key,
            std::time::Instant::now(),
        ) {
            let exceeded = quotas::QuotaExceeded {
                quota: quota.name.clone(),
                retry_after_secs: denied.retry_after.as_secs().max(1),
                message: format!("rate-limit quota `{}` exceeded", quota.name),
            };
            return too_many(store, &exceeded, &path, denied.first);
        }
    }
    let issue_role = match dynamic_issue_role(&method, &path) {
        Some(Ok(role)) => Some(role),
        Some(Err(())) => return invalid_request("invalid dynamic role name"),
        None => None,
    };
    let _issuance = match issue_role.as_deref() {
        Some(role) if !quotas::lease_quotas_for(&active, role).is_empty() => {
            let guard = quotas::issuance_lock().lock().await;
            match store.quota_check_leases(&active, role).await {
                Ok(None) => Some(guard),
                Ok(Some(exceeded)) => {
                    let audit = lease_rejection_due(&exceeded.quota);
                    return too_many(store, &exceeded, &path, audit);
                }
                Err(error) => return vault_error(error),
            }
        }
        _ => None,
    };
    let context = RequestContext::new(client);
    let (response, violations) = wrap_requirement::scope(
        wrap_ttl,
        tokens::with_request_context(context.clone(), next.run(request)),
    )
    .await;
    let response = explain_wrapping_refusal(store, response, &violations, &path, &context).await;
    match wrap_ttl {
        Some(ttl) => wrap_body(store, response, ttl, &path, &context).await,
        None => response,
    }
}

/// Vault-style refusal of response wrapping on the `/v1` compatibility API.
pub(super) fn compat_wrap_unsupported() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({
            "errors": ["response wrapping is not supported on the Vault-compatible API; use X-Ryu-Wrap-TTL on /api/vault routes"]
        })),
    )
        .into_response()
}
