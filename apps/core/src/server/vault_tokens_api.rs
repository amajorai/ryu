//! Secret Vault token lifecycle, response wrapping, cubbyhole, lease
//! administration, and quota routes.
//!
//! Human routes (node bearer, optional user JWT) manage tokens by accessor,
//! token roles, identity token settings, quotas, and leases; they authorize on
//! `sys/machines`, `sys/token-roles/<name>`, `sys/quotas`, `sys/leases`, and
//! `sys/wrapping`. Machine routes under `/api/vault/agent/*` take
//! `x-ryu-vault-token`; the `sys/wrapping/{unwrap,lookup,rewrap}` routes are
//! authenticated by the wrapping token itself.
//!
//! [`request_layer`] wraps every vault route: it resolves the client address
//! for CIDR-bound tokens, enforces rate-limit and lease-count quotas (`429`),
//! and turns a successful response into a wrapping token when the request
//! carries `X-Ryu-Wrap-TTL` (or the `X-Vault-Wrap-TTL` alias).

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::vault_api::{invalid_request, respond, store, vault_error};
use super::vault_engines_api::{human, machine, Who, VAULT_TOKEN_HEADER};
use super::{json_error, ServerState};
use crate::identity_verify::VerifiedCaller;
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::policy::Capability;
use crate::vault::quotas::{self, LeaseFilter, QuotaRule};
use crate::vault::tokens::{self, RequestContext, TokenConfig, TokenRequest, TokenRole};
use crate::vault::wrapping;

/// Request header asking for a wrapped response.
pub const WRAP_TTL_HEADER: &str = "x-ryu-wrap-ttl";
/// HashiCorp-compatible alias of [`WRAP_TTL_HEADER`].
pub const VAULT_WRAP_TTL_HEADER: &str = "x-vault-wrap-ttl";
/// Header carrying a wrapping token (in addition to `x-ryu-vault-token`).
pub const WRAP_TOKEN_HEADER: &str = "x-ryu-wrap-token";

macro_rules! who {
    ($expr:expr) => {
        match $expr {
            Ok(who) => who,
            Err(response) => return response,
        }
    };
}

macro_rules! check {
    ($expr:expr) => {
        if let Err(response) = $expr {
            return response;
        }
    };
}

fn ok_or<T: serde::Serialize>(result: anyhow::Result<T>, key: &str) -> Response {
    match result {
        Ok(value) => respond(json!({ key: value })),
        Err(error) => vault_error(error),
    }
}

fn machine_parts(
    who: &Who,
) -> (
    &'static PluginSecretStore,
    &crate::vault::machine::TokenPrincipal,
) {
    match who {
        Who::Machine {
            store, principal, ..
        } => (*store, principal),
        Who::Human(_) => unreachable!("machine() only returns machines"),
    }
}

// ── Request layer ─────────────────────────────────────────────────────────

fn wrap_ttl(headers: &HeaderMap) -> Result<Option<i64>, Response> {
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

fn client_ip(request: &Request) -> Option<std::net::IpAddr> {
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
fn lease_rejection_due(quota: &str) -> bool {
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

fn too_many(
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
fn dynamic_issue_role(method: &Method, path: &str) -> Option<Result<String, ()>> {
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

fn is_wrapping_route(path: &str) -> bool {
    path.starts_with("/api/vault/sys/wrapping/") || path.starts_with("/api/vault/agent/wrapping/")
}

/// Server-sent event routes (`/api/vault/events`, `/api/vault/agent/events`,
/// `/api/vault/items/:key/events`). Their body never ends, so it cannot be
/// buffered into a wrapped response.
fn is_streaming_route(path: &str) -> bool {
    path.starts_with("/api/vault/") && path.ends_with("/events")
}

fn is_event_stream(response: &Response) -> bool {
    response
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"))
}

fn stream_wrap_unsupported() -> Response {
    invalid_request("response wrapping is not supported on streaming routes")
}

async fn wrap_body(
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
    let response = tokens::with_request_context(context.clone(), next.run(request)).await;
    match wrap_ttl {
        Some(ttl) => wrap_body(store, response, ttl, &path, &context).await,
        None => response,
    }
}

/// Vault-style refusal of response wrapping on the `/v1` compatibility API.
fn compat_wrap_unsupported() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({
            "errors": ["response wrapping is not supported on the Vault-compatible API; use X-Ryu-Wrap-TTL on /api/vault routes"]
        })),
    )
        .into_response()
}

// ── Tokens (human) ────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenListQuery {
    #[serde(default)]
    identity: Option<String>,
}

/// GET /api/vault/tokens lists live machine tokens (metadata only).
#[utoipa::path(get, path = "/api/vault/tokens", tag = "Vault",
    summary = "List live machine tokens (metadata only, admin)",
    params(("identity" = Option<String>, Query, description = "Identity id or name")),
    responses((status = 200, description = "Tokens", body = serde_json::Value)))]
pub async fn token_list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<TokenListQuery>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/machines", Capability::Admin));
    ok_or(
        who.store().token_list(query.identity.as_deref()).await,
        "tokens",
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCreateBody {
    identity: String,
    #[serde(flatten)]
    request: TokenRequest,
}

/// POST /api/vault/tokens mints a root (orphan) token for an identity.
#[utoipa::path(post, path = "/api/vault/tokens", tag = "Vault",
    summary = "Mint a token for a machine identity (admin); the token is returned once",
    request_body = serde_json::Value,
    responses((status = 200, description = "Token", body = serde_json::Value)))]
pub async fn token_create(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<TokenCreateBody>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/machines", Capability::Admin));
    ok_or(
        who.store()
            .token_create_for_identity(&body.identity, body.request, &who.actor())
            .await,
        "token",
    )
}

/// GET /api/vault/tokens/{accessor} looks a token up by accessor.
#[utoipa::path(get, path = "/api/vault/tokens/{accessor}", tag = "Vault",
    summary = "Look up a machine token by accessor (admin)",
    params(("accessor" = String, Path, description = "Token accessor")),
    responses((status = 200, description = "Token metadata", body = serde_json::Value)))]
pub async fn token_lookup_accessor(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(accessor): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/machines", Capability::Admin));
    ok_or(who.store().token_info(&accessor).await, "token")
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenewBody {
    #[serde(default)]
    increment_secs: Option<i64>,
}

/// POST /api/vault/tokens/{accessor}/renew.
#[utoipa::path(post, path = "/api/vault/tokens/{accessor}/renew", tag = "Vault",
    summary = "Renew a machine token by accessor, up to its max TTL (admin)",
    params(("accessor" = String, Path, description = "Token accessor")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Token metadata", body = serde_json::Value)))]
pub async fn token_renew_accessor(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(accessor): Path<String>,
    body: Option<Json<RenewBody>>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/machines", Capability::Admin));
    let increment = body.and_then(|Json(body)| body.increment_secs);
    ok_or(
        who.store()
            .token_renew(&accessor, increment, &who.actor())
            .await,
        "token",
    )
}

/// POST /api/vault/tokens/{accessor}/revoke-orphan.
#[utoipa::path(post, path = "/api/vault/tokens/{accessor}/revoke-orphan", tag = "Vault",
    summary = "Revoke a token but keep its children as orphans (admin)",
    params(("accessor" = String, Path, description = "Token accessor")),
    responses((status = 200, description = "Revocation report", body = serde_json::Value)))]
pub async fn token_revoke_orphan(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(accessor): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/machines", Capability::Admin));
    ok_or(
        who.store()
            .token_revoke_tree(&accessor, true, &who.actor())
            .await,
        "revoked",
    )
}

/// PUT /api/vault/machines/{id}/token-config.
#[utoipa::path(put, path = "/api/vault/machines/{id}/token-config", tag = "Vault",
    summary = "Set a machine identity's token TTLs, period, use limit, and CIDRs (admin)",
    params(("id" = String, Path, description = "Identity id or name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Identity", body = serde_json::Value)))]
pub async fn machine_token_config(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(config): Json<TokenConfig>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/machines", Capability::Admin));
    ok_or(
        who.store()
            .machine_set_token_config(&id, config, &who.actor())
            .await,
        "machine",
    )
}

// ── Token roles ───────────────────────────────────────────────────────────

/// GET /api/vault/token-roles.
#[utoipa::path(get, path = "/api/vault/token-roles", tag = "Vault",
    summary = "List token roles the caller may see",
    responses((status = 200, description = "Token roles", body = serde_json::Value)))]
pub async fn token_roles(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    match who.store().token_role_list().await {
        Ok(roles) => {
            let visible: Vec<_> = roles
                .into_iter()
                .filter(|role| {
                    !who.sys_caps(&format!("sys/token-roles/{}", role.name))
                        .is_empty()
                })
                .collect();
            respond(json!({ "roles": visible }))
        }
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/token-roles/{name}.
#[utoipa::path(get, path = "/api/vault/token-roles/{name}", tag = "Vault",
    summary = "Read a token role (admin)",
    params(("name" = String, Path, description = "Role name")),
    responses((status = 200, description = "Token role", body = serde_json::Value)))]
pub async fn token_role_get(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require(&format!("sys/token-roles/{name}"), Capability::Admin));
    ok_or(who.store().token_role_get(&name).await, "role")
}

/// PUT /api/vault/token-roles/{name}.
#[utoipa::path(put, path = "/api/vault/token-roles/{name}", tag = "Vault",
    summary = "Create or replace a token role (admin)",
    params(("name" = String, Path, description = "Role name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Token role", body = serde_json::Value)))]
pub async fn token_role_put(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(role): Json<TokenRole>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require(&format!("sys/token-roles/{name}"), Capability::Admin));
    ok_or(
        who.store()
            .token_role_put(TokenRole { name, ..role }, &who.actor())
            .await,
        "role",
    )
}

/// DELETE /api/vault/token-roles/{name}.
#[utoipa::path(delete, path = "/api/vault/token-roles/{name}", tag = "Vault",
    summary = "Delete a token role (admin)",
    params(("name" = String, Path, description = "Role name")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn token_role_delete(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require(&format!("sys/token-roles/{name}"), Capability::Admin));
    ok_or(
        who.store().token_role_delete(&name, &who.actor()).await,
        "deleted",
    )
}

// ── Leases and quotas ─────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseSearchQuery {
    #[serde(default)]
    prefix: Option<String>,
    #[serde(default)]
    issued_to: Option<String>,
    #[serde(default)]
    include_revoked: Option<bool>,
}

impl LeaseSearchQuery {
    fn filter(&self) -> LeaseFilter<'_> {
        LeaseFilter {
            prefix: self.prefix.as_deref().filter(|prefix| !prefix.is_empty()),
            issued_to: self.issued_to.as_deref(),
            include_revoked: self.include_revoked.unwrap_or(false),
        }
    }
}

/// GET /api/vault/sys/leases lists leases by prefix and holder.
#[utoipa::path(get, path = "/api/vault/sys/leases", tag = "Vault",
    summary = "List leases by `<role>/<id>` prefix and holder (admin)",
    params(
        ("prefix" = Option<String>, Query, description = "Prefix of `<role>/<lease id>`"),
        ("issuedTo" = Option<String>, Query, description = "Holder, e.g. `machine:<id>`"),
        ("includeRevoked" = Option<bool>, Query, description = "Include revoked and expired leases"),
    ),
    responses((status = 200, description = "Leases", body = serde_json::Value)))]
pub async fn sys_leases(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<LeaseSearchQuery>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/leases", Capability::Admin));
    ok_or(who.store().lease_search(&query.filter()).await, "leases")
}

/// GET /api/vault/sys/leases/count.
#[utoipa::path(get, path = "/api/vault/sys/leases/count", tag = "Vault",
    summary = "Count live leases by role (admin)",
    params(
        ("prefix" = Option<String>, Query, description = "Prefix of `<role>/<lease id>`"),
        ("issuedTo" = Option<String>, Query, description = "Holder"),
    ),
    responses((status = 200, description = "Counts", body = serde_json::Value)))]
pub async fn sys_lease_count(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<LeaseSearchQuery>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/leases", Capability::Admin));
    ok_or(who.store().lease_counts(&query.filter()).await, "counts")
}

/// GET /api/vault/sys/leases/lookup/{id}.
#[utoipa::path(get, path = "/api/vault/sys/leases/lookup/{id}", tag = "Vault",
    summary = "Look up one lease (holder or admin on the role)",
    params(("id" = String, Path, description = "Lease id")),
    responses((status = 200, description = "Lease", body = serde_json::Value)))]
pub async fn sys_lease_lookup(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    // Unknown leases and leases the caller may not see answer alike, so a
    // caller without `sys/leases` admin cannot probe which ids exist.
    let leases_admin = who.require("sys/leases", Capability::Admin).is_ok();
    let hidden = || {
        json_error(
            StatusCode::NOT_FOUND,
            "vault_not_found: lease not found".to_owned(),
        )
    };
    let lease = match who.store().lease_get(&id).await {
        Ok(lease) => lease,
        Err(error) if leases_admin => return vault_error(error),
        Err(_) => return hidden(),
    };
    let holder = lease.issued_to.as_deref() == Some(who.issued_to().as_str());
    if !holder && !leases_admin {
        let role_key = format!("sys/dynamic/{}", lease.role);
        if who.require(&role_key, Capability::Admin).is_err() {
            return hidden();
        }
    }
    respond(json!({ "lease": lease, "ttlSecs": lease.ttl_secs(crate::vault::now_millis()) }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokePrefixBody {
    prefix: String,
}

/// POST /api/vault/sys/leases/revoke-prefix.
#[utoipa::path(post, path = "/api/vault/sys/leases/revoke-prefix", tag = "Vault",
    summary = "Revoke every live lease under a `<role>/<id>` prefix (admin)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Revocation report", body = serde_json::Value)))]
pub async fn sys_lease_revoke_prefix(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<RevokePrefixBody>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/leases", Capability::Admin));
    ok_or(
        who.store()
            .lease_revoke_prefix(&body.prefix, &who.actor())
            .await,
        "report",
    )
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TidyBody {
    #[serde(default)]
    older_than_secs: Option<i64>,
}

/// POST /api/vault/sys/leases/tidy.
#[utoipa::path(post, path = "/api/vault/sys/leases/tidy", tag = "Vault",
    summary = "Delete old revoked leases and close leases of deleted roles (admin)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Tidy report", body = serde_json::Value)))]
pub async fn sys_lease_tidy(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    body: Option<Json<TidyBody>>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/leases", Capability::Admin));
    let older_than = body.and_then(|Json(body)| body.older_than_secs);
    ok_or(
        who.store().lease_tidy(older_than, &who.actor()).await,
        "report",
    )
}

/// GET /api/vault/sys/quotas.
#[utoipa::path(get, path = "/api/vault/sys/quotas", tag = "Vault",
    summary = "List rate-limit and lease-count quotas with live lease counts (admin)",
    responses((status = 200, description = "Quotas", body = serde_json::Value)))]
pub async fn sys_quotas(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/quotas", Capability::Admin));
    let quotas = match who.store().quota_list().await {
        Ok(quotas) => quotas,
        Err(error) => return vault_error(error),
    };
    match who.store().lease_counts(&LeaseFilter::default()).await {
        Ok(leases) => respond(json!({ "quotas": quotas, "leases": leases })),
        Err(error) => vault_error(error),
    }
}

/// PUT /api/vault/sys/quotas/{name}.
#[utoipa::path(put, path = "/api/vault/sys/quotas/{name}", tag = "Vault",
    summary = "Create or replace a quota (admin)",
    params(("name" = String, Path, description = "Quota name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Quota", body = serde_json::Value)))]
pub async fn sys_quota_put(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(rule): Json<QuotaRule>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/quotas", Capability::Admin));
    ok_or(
        who.store().quota_put(&name, rule, &who.actor()).await,
        "quota",
    )
}

/// DELETE /api/vault/sys/quotas/{name}.
#[utoipa::path(delete, path = "/api/vault/sys/quotas/{name}", tag = "Vault",
    summary = "Delete a quota (admin)",
    params(("name" = String, Path, description = "Quota name")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn sys_quota_delete(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/quotas", Capability::Admin));
    ok_or(
        who.store().quota_delete(&name, &who.actor()).await,
        "deleted",
    )
}

// ── Wrapping ──────────────────────────────────────────────────────────────

fn wrap_ttl_or_default(headers: &HeaderMap) -> Result<i64, Response> {
    wrap_ttl(headers).map(|ttl| ttl.unwrap_or(wrapping::DEFAULT_WRAP_TTL_SECS))
}

async fn wrap_data(who: &Who, headers: &HeaderMap, data: Value) -> Response {
    check!(who.require("sys/wrapping", Capability::Use));
    if !data.is_object() {
        return invalid_request("the body must be a JSON object");
    }
    let ttl = match wrap_ttl_or_default(headers) {
        Ok(ttl) => ttl,
        Err(response) => return response,
    };
    let payload = match serde_json::to_vec(&data) {
        Ok(payload) => payload,
        Err(error) => return vault_error(error.into()),
    };
    ok_or(
        who.store()
            .wrap_response(&payload, ttl, "sys/wrapping/wrap", &who.actor())
            .await,
        "wrapInfo",
    )
}

/// POST /api/vault/sys/wrapping/wrap wraps caller-supplied data.
#[utoipa::path(post, path = "/api/vault/sys/wrapping/wrap", tag = "Vault",
    summary = "Wrap a JSON object behind a single-use wrapping token (use on sys/wrapping)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Wrap info", body = serde_json::Value)))]
pub async fn sys_wrap(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(data): Json<Value>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    wrap_data(&who, &headers, data).await
}

/// POST /api/vault/agent/wrapping/wrap wraps data with a machine token.
#[utoipa::path(post, path = "/api/vault/agent/wrapping/wrap", tag = "Vault",
    summary = "Wrap a JSON object with a machine token (use on sys/wrapping)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Wrap info", body = serde_json::Value)))]
pub async fn agent_wrap(headers: HeaderMap, Json(data): Json<Value>) -> Response {
    let who = who!(machine(&headers).await);
    wrap_data(&who, &headers, data).await
}

#[derive(Debug, Default, Deserialize)]
pub struct WrapTokenBody {
    #[serde(default)]
    token: Option<String>,
}

fn presented_wrap_token(
    headers: &HeaderMap,
    body: Option<Json<WrapTokenBody>>,
) -> Result<String, Response> {
    body.and_then(|Json(body)| body.token)
        .or_else(|| {
            [WRAP_TOKEN_HEADER, VAULT_TOKEN_HEADER]
                .iter()
                .find_map(|name| headers.get(*name)?.to_str().ok().map(str::to_owned))
        })
        .map(|token| token.trim().to_owned())
        .filter(|token| !token.is_empty())
        .ok_or_else(|| invalid_request("a wrapping token is required"))
}

/// POST /api/vault/sys/wrapping/unwrap (public; single use).
#[utoipa::path(post, path = "/api/vault/sys/wrapping/unwrap", tag = "Vault",
    summary = "Unwrap a wrapping token once and return the original response",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "The wrapped response body", body = serde_json::Value),
        (status = 403, description = "Unknown, expired, or already-used wrapping token", body = serde_json::Value),
    ))]
pub async fn sys_unwrap(headers: HeaderMap, body: Option<Json<WrapTokenBody>>) -> Response {
    let store = match store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    let token = match presented_wrap_token(&headers, body) {
        Ok(token) => token,
        Err(response) => return response,
    };
    match store.wrap_unwrap(&token).await {
        // The stored body is the original rendered response; return it as-is.
        Ok(payload) => {
            let mut response = (
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                payload,
            )
                .into_response();
            response.headers_mut().insert(
                axum::http::header::CACHE_CONTROL,
                HeaderValue::from_static("no-store"),
            );
            response
        }
        Err(error) => vault_error(error),
    }
}

/// POST /api/vault/sys/wrapping/lookup (public; does not consume).
#[utoipa::path(post, path = "/api/vault/sys/wrapping/lookup", tag = "Vault",
    summary = "Describe a wrapping token without unwrapping it",
    request_body = serde_json::Value,
    responses((status = 200, description = "Wrap info", body = serde_json::Value)))]
pub async fn sys_wrap_lookup(headers: HeaderMap, body: Option<Json<WrapTokenBody>>) -> Response {
    let store = match store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    match presented_wrap_token(&headers, body) {
        Ok(token) => ok_or(store.wrap_lookup(&token).await, "wrapInfo"),
        Err(response) => response,
    }
}

/// POST /api/vault/sys/wrapping/rewrap (public; consumes the old token).
#[utoipa::path(post, path = "/api/vault/sys/wrapping/rewrap", tag = "Vault",
    summary = "Move a wrapped response to a new wrapping token with the same TTL",
    request_body = serde_json::Value,
    responses((status = 200, description = "New wrap info", body = serde_json::Value)))]
pub async fn sys_rewrap(headers: HeaderMap, body: Option<Json<WrapTokenBody>>) -> Response {
    let store = match store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    match presented_wrap_token(&headers, body) {
        Ok(token) => ok_or(store.wrap_rewrap(&token).await, "wrapInfo"),
        Err(response) => response,
    }
}

// ── Agent token routes ────────────────────────────────────────────────────

/// GET /api/vault/agent/self/lookup.
#[utoipa::path(get, path = "/api/vault/agent/self/lookup", tag = "Vault",
    summary = "Full lifecycle metadata of the presented machine token",
    responses((status = 200, description = "Token metadata", body = serde_json::Value)))]
pub async fn agent_lookup_self(headers: HeaderMap) -> Response {
    let who = who!(machine(&headers).await);
    let (store, principal) = machine_parts(&who);
    match store.token_info(&principal.accessor).await {
        Ok(info) => respond(json!({ "token": info, "effectivePolicies": principal.policies })),
        Err(error) => vault_error(error),
    }
}

/// POST /api/vault/agent/self/renew.
#[utoipa::path(post, path = "/api/vault/agent/self/renew", tag = "Vault",
    summary = "Renew the presented machine token (up to its max TTL, or by one period)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Token metadata", body = serde_json::Value)))]
pub async fn agent_renew_self(headers: HeaderMap, body: Option<Json<RenewBody>>) -> Response {
    let who = who!(machine(&headers).await);
    let (store, principal) = machine_parts(&who);
    let increment = body.and_then(|Json(body)| body.increment_secs);
    ok_or(
        store
            .token_renew(&principal.accessor, increment, &principal.actor())
            .await,
        "token",
    )
}

/// POST /api/vault/agent/self/child mints a narrower child token.
#[utoipa::path(post, path = "/api/vault/agent/self/child", tag = "Vault",
    summary = "Mint a child token (policy subset, TTL capped by the parent); returned once",
    request_body = serde_json::Value,
    responses((status = 200, description = "Child token", body = serde_json::Value)))]
pub async fn agent_create_child(headers: HeaderMap, body: Option<Json<TokenRequest>>) -> Response {
    let who = who!(machine(&headers).await);
    let (store, principal) = machine_parts(&who);
    let request = body.map(|Json(body)| body).unwrap_or_default();
    ok_or(
        store
            .token_create_child(
                &principal.accessor,
                &principal.policies,
                &principal.identity_id,
                request,
                &principal.actor(),
            )
            .await,
        "token",
    )
}

// ── Cubbyhole ─────────────────────────────────────────────────────────────

/// GET /api/vault/agent/cubbyhole lists the token's cubbyhole keys.
#[utoipa::path(get, path = "/api/vault/agent/cubbyhole", tag = "Vault",
    summary = "List the presented token's cubbyhole keys",
    responses((status = 200, description = "Keys", body = serde_json::Value)))]
pub async fn cubbyhole_list(headers: HeaderMap) -> Response {
    let who = who!(machine(&headers).await);
    let (store, principal) = machine_parts(&who);
    ok_or(store.cubbyhole_list(&principal.accessor).await, "keys")
}

/// GET /api/vault/agent/cubbyhole/{key}.
#[utoipa::path(get, path = "/api/vault/agent/cubbyhole/{key}", tag = "Vault",
    summary = "Read one key of the presented token's cubbyhole",
    params(("key" = String, Path, description = "Key")),
    responses((status = 200, description = "Value", body = serde_json::Value)))]
pub async fn cubbyhole_get(headers: HeaderMap, Path(key): Path<String>) -> Response {
    let who = who!(machine(&headers).await);
    let (store, principal) = machine_parts(&who);
    ok_or(
        store
            .cubbyhole_get(&principal.accessor, &key, &principal.actor())
            .await,
        "value",
    )
}

/// PUT /api/vault/agent/cubbyhole/{key}.
#[utoipa::path(put, path = "/api/vault/agent/cubbyhole/{key}", tag = "Vault",
    summary = "Write one key of the presented token's cubbyhole (any JSON value)",
    params(("key" = String, Path, description = "Key")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Written", body = serde_json::Value)))]
pub async fn cubbyhole_put(
    headers: HeaderMap,
    Path(key): Path<String>,
    Json(value): Json<Value>,
) -> Response {
    let who = who!(machine(&headers).await);
    let (store, principal) = machine_parts(&who);
    ok_or(
        store
            .cubbyhole_put(&principal.accessor, &key, &value, &principal.actor())
            .await
            .map(|()| true),
        "written",
    )
}

/// DELETE /api/vault/agent/cubbyhole/{key}.
#[utoipa::path(delete, path = "/api/vault/agent/cubbyhole/{key}", tag = "Vault",
    summary = "Delete one key of the presented token's cubbyhole",
    params(("key" = String, Path, description = "Key")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn cubbyhole_delete(headers: HeaderMap, Path(key): Path<String>) -> Response {
    let who = who!(machine(&headers).await);
    let (store, principal) = machine_parts(&who);
    ok_or(
        store
            .cubbyhole_delete(&principal.accessor, &key, &principal.actor())
            .await,
        "deleted",
    )
}

// ── Routers ───────────────────────────────────────────────────────────────

/// Protected routes (node bearer), merged into the vault router.
pub fn routes() -> axum::Router<ServerState> {
    use axum::routing::{get, post, put};
    let limit = || axum::extract::DefaultBodyLimit::max(super::vault_api::MAX_REQUEST_BODY_BYTES);
    axum::Router::new()
        .route(
            "/api/vault/tokens",
            get(token_list).post(token_create).layer(limit()),
        )
        .route("/api/vault/tokens/:accessor", get(token_lookup_accessor))
        .route(
            "/api/vault/tokens/:accessor/renew",
            post(token_renew_accessor).layer(limit()),
        )
        .route(
            "/api/vault/tokens/:accessor/revoke-orphan",
            post(token_revoke_orphan),
        )
        .route(
            "/api/vault/machines/:id/token-config",
            put(machine_token_config).layer(limit()),
        )
        .route("/api/vault/token-roles", get(token_roles))
        .route(
            "/api/vault/token-roles/:name",
            get(token_role_get)
                .put(token_role_put)
                .delete(token_role_delete)
                .layer(limit()),
        )
        .route("/api/vault/sys/leases", get(sys_leases))
        .route("/api/vault/sys/leases/count", get(sys_lease_count))
        .route("/api/vault/sys/leases/lookup/:id", get(sys_lease_lookup))
        .route(
            "/api/vault/sys/leases/revoke-prefix",
            post(sys_lease_revoke_prefix).layer(limit()),
        )
        .route(
            "/api/vault/sys/leases/tidy",
            post(sys_lease_tidy).layer(limit()),
        )
        .route("/api/vault/sys/quotas", get(sys_quotas))
        .route(
            "/api/vault/sys/quotas/:name",
            put(sys_quota_put).delete(sys_quota_delete).layer(limit()),
        )
        .route(
            "/api/vault/sys/wrapping/wrap",
            post(sys_wrap).layer(limit()),
        )
}

/// Public routes: machine-token agent routes and wrapping-token routes.
pub fn public_routes() -> axum::Router<ServerState> {
    use axum::routing::{get, post};
    let limit = axum::extract::DefaultBodyLimit::max(super::vault_api::MAX_REQUEST_BODY_BYTES);
    axum::Router::new()
        .route("/api/vault/agent/self/lookup", get(agent_lookup_self))
        .route("/api/vault/agent/self/renew", post(agent_renew_self))
        .route("/api/vault/agent/self/child", post(agent_create_child))
        .route("/api/vault/agent/wrapping/wrap", post(agent_wrap))
        .route("/api/vault/agent/cubbyhole", get(cubbyhole_list))
        .route(
            "/api/vault/agent/cubbyhole/:key",
            get(cubbyhole_get)
                .put(cubbyhole_put)
                .delete(cubbyhole_delete),
        )
        .route("/api/vault/sys/wrapping/unwrap", post(sys_unwrap))
        .route("/api/vault/sys/wrapping/lookup", post(sys_wrap_lookup))
        .route("/api/vault/sys/wrapping/rewrap", post(sys_rewrap))
        .layer(limit)
        .layer(axum::middleware::from_fn(request_layer))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_routers_merge_without_route_conflicts() {
        // Mirrors the registration in `server::create_router`: axum panics on
        // overlapping routes, so building the merged router is the check.
        let _router: axum::Router<ServerState> = axum::Router::new()
            .merge(super::super::vault_public_routes())
            .merge(super::super::vault_routes());
    }

    #[tokio::test]
    async fn every_public_vault_route_rides_the_request_layer() {
        use tower::ServiceExt;
        // `request_layer` rejects a malformed wrap TTL before any handler
        // runs, so a 400 here proves the route gets the client address,
        // login quotas, and wrapping that the layer provides.
        let directory = tempfile::tempdir().unwrap();
        let router = super::super::vault_public_routes().with_state(
            super::super::isolated_plugin_hook_test_state(directory.path()),
        );
        for (method, uri) in [
            ("POST", "/api/vault/auth/approle/login"),
            ("POST", "/api/vault/auth/cert/login"),
            ("POST", "/api/vault/auth/aws/login"),
            ("POST", "/api/vault/auth/kubernetes/login"),
            ("POST", "/v1/auth/approle/login"),
            ("POST", "/v1/auth/jwt/login"),
            ("GET", "/v1/secret/data/app/db"),
            ("POST", "/api/vault/agent/broker/sessions"),
            ("GET", "/api/vault/agent/broker/discover"),
            ("GET", "/api/vault/agent/totp/code/github"),
            ("POST", "/api/vault/agent/identity/token/ci"),
            ("GET", "/api/vault/agent/self/lookup"),
        ] {
            let request = axum::http::Request::builder()
                .method(method)
                .uri(uri)
                .header(WRAP_TTL_HEADER, HeaderValue::from_bytes(b"\xff").unwrap())
                .header("content-type", "application/json")
                .body(axum::body::Body::from("{}"))
                .unwrap();
            let response = router.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{method} {uri}");
            let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
                .await
                .unwrap();
            assert!(
                String::from_utf8_lossy(&body).contains("invalid wrap TTL header"),
                "{method} {uri}"
            );
        }
    }

    #[test]
    fn wrap_ttl_headers_and_alias_parse() {
        let mut headers = HeaderMap::new();
        assert_eq!(wrap_ttl(&headers).unwrap(), None);
        headers.insert(VAULT_WRAP_TTL_HEADER, HeaderValue::from_static("5m"));
        assert_eq!(wrap_ttl(&headers).unwrap(), Some(300));
        headers.insert(WRAP_TTL_HEADER, HeaderValue::from_static("30"));
        assert_eq!(wrap_ttl(&headers).unwrap(), Some(30));
        headers.insert(WRAP_TTL_HEADER, HeaderValue::from_static("2d"));
        assert_eq!(
            wrap_ttl(&headers).unwrap_err().status(),
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn dynamic_issue_routes_are_recognized_for_lease_quotas() {
        assert_eq!(
            dynamic_issue_role(&Method::POST, "/api/vault/dynamic/issue/db"),
            Some(Ok("db".to_owned()))
        );
        assert_eq!(
            dynamic_issue_role(&Method::POST, "/api/vault/agent/dynamic/db"),
            Some(Ok("db".to_owned()))
        );
        // Percent-encoding cannot hide the role from lease-count quotas.
        assert_eq!(
            dynamic_issue_role(&Method::POST, "/api/vault/dynamic/issue/%64b"),
            Some(Ok("db".to_owned()))
        );
        assert_eq!(
            dynamic_issue_role(&Method::POST, "/api/vault/agent/dynamic/%64b"),
            Some(Ok("db".to_owned()))
        );
        assert_eq!(
            dynamic_issue_role(&Method::POST, "/api/vault/dynamic/issue/a%2Fb"),
            Some(Err(()))
        );
        assert_eq!(
            dynamic_issue_role(&Method::GET, "/api/vault/dynamic/issue/db"),
            None
        );
        assert_eq!(
            dynamic_issue_role(&Method::POST, "/api/vault/dynamic/roles/db"),
            None
        );
        assert!(is_wrapping_route("/api/vault/sys/wrapping/unwrap"));
        assert!(!is_wrapping_route("/api/vault/agent/secrets/X"));
    }

    #[test]
    fn wrap_tokens_come_from_the_body_or_headers() {
        let mut headers = HeaderMap::new();
        assert!(presented_wrap_token(&headers, None).is_err());
        headers.insert(VAULT_TOKEN_HEADER, HeaderValue::from_static("rvw_header"));
        assert_eq!(presented_wrap_token(&headers, None).unwrap(), "rvw_header");
        let body = Json(WrapTokenBody {
            token: Some(" rvw_body ".into()),
        });
        assert_eq!(
            presented_wrap_token(&headers, Some(body)).unwrap(),
            "rvw_body"
        );
    }

    #[tokio::test]
    async fn wrapping_replaces_a_success_body_and_passes_errors_through() {
        let store = PluginSecretStore::in_memory().unwrap();
        let context = RequestContext::new(None);
        let secret = respond(json!({ "secretId": "sid_plain" }));
        let wrapped = wrap_body(
            &store,
            secret,
            60,
            "/api/vault/machines/x/secret-ids",
            &context,
        )
        .await;
        assert_eq!(wrapped.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(wrapped.into_body(), 1 << 20)
            .await
            .unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(!text.contains("sid_plain"), "{text}");
        let body: Value = serde_json::from_str(&text).unwrap();
        let token = body["wrapInfo"]["token"].as_str().unwrap();
        let payload = store.wrap_unwrap(token).await.unwrap();
        assert!(String::from_utf8(payload).unwrap().contains("sid_plain"));
        let error = invalid_request("nope");
        let passed = wrap_body(&store, error, 60, "/x", &context).await;
        assert_eq!(passed.status(), StatusCode::BAD_REQUEST);
    }

    /// A wrap header on an event stream is refused instead of buffering a
    /// body that never ends.
    #[tokio::test]
    async fn streaming_routes_refuse_wrapping() {
        use axum::body::Body;
        use axum::response::sse::{Event, KeepAlive, Sse};
        use axum::routing::get;
        use tower::ServiceExt as _;

        let endless = || async {
            let stream = futures_util::stream::pending::<Result<Event, std::convert::Infallible>>();
            Sse::new(stream).keep_alive(KeepAlive::default())
        };
        assert!(is_streaming_route("/api/vault/events"));
        assert!(is_streaming_route("/api/vault/agent/events"));
        assert!(is_streaming_route("/api/vault/items/abc/events"));
        assert!(!is_streaming_route("/api/vault/items/abc"));

        let router = axum::Router::new()
            .route("/api/vault/events", get(endless))
            .layer(axum::middleware::from_fn(request_layer));
        let request = axum::http::Request::builder()
            .uri("/api/vault/events")
            .header(WRAP_TTL_HEADER, "60")
            .body(Body::empty())
            .unwrap();
        let refused =
            tokio::time::timeout(std::time::Duration::from_secs(5), router.oneshot(request))
                .await
                .expect("the wrap refusal returns at once")
                .unwrap();
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);

        // Defense in depth: `wrap_body` never buffers an event stream.
        let store = PluginSecretStore::in_memory().unwrap();
        let context = RequestContext::new(None);
        let stream = endless().await.into_response();
        let dropped = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            wrap_body(&store, stream, 60, "/api/vault/other", &context),
        )
        .await
        .expect("an event stream is not buffered");
        assert_eq!(dropped.status(), StatusCode::BAD_REQUEST);
    }

    /// `X-Vault-Wrap-TTL` on `/v1` is refused before any store lookup.
    #[tokio::test]
    async fn compat_routes_refuse_vault_wrap_ttl() {
        use axum::body::Body;
        use axum::routing::get;
        use tower::ServiceExt as _;

        let router = axum::Router::new()
            .route("/v1/secret/data/app", get(|| async { "value" }))
            .layer(axum::middleware::from_fn(request_layer));
        let request = |wrap: Option<&str>| {
            let mut request = axum::http::Request::builder().uri("/v1/secret/data/app");
            if let Some(ttl) = wrap {
                request = request.header(VAULT_WRAP_TTL_HEADER, ttl);
            }
            request.body(Body::empty()).unwrap()
        };
        let refused = router.clone().oneshot(request(Some("5m"))).await.unwrap();
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(refused.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert!(body["errors"][0].as_str().unwrap().contains("wrapping"));
        let plain = router.oneshot(request(None)).await.unwrap();
        assert_ne!(plain.status(), StatusCode::BAD_REQUEST);
    }

    /// Router-level checks of [`request_layer`] against stub vault routes.
    /// The layer reads the process-global store; publishing an in-memory one
    /// is safe because every publisher in the test binary publishes one
    /// (first set wins) and the names used here are unique to this test.
    #[tokio::test]
    async fn request_layer_enforces_quotas_and_wraps_on_real_routes() {
        use crate::vault::leases::NewLease;
        use axum::body::Body;
        use axum::routing::post;
        use tower::ServiceExt as _;

        crate::plugin_secrets::set_global(PluginSecretStore::in_memory().unwrap());
        let store = crate::plugin_secrets::global().unwrap();
        let router = axum::Router::new()
            .route("/api/vault/auth/approle/login", post(|| async { "ok" }))
            .route(
                "/api/vault/dynamic/issue/:role",
                post(|Path(role): Path<String>| async move { respond(json!({ "role": role })) }),
            )
            .route(
                "/api/vault/machines/:name/secret-ids",
                post(|| async { respond(json!({ "secretId": "sid_layer_plain" })) }),
            )
            .layer(axum::middleware::from_fn(request_layer));
        let call = |uri: &str, peer: Option<&str>, wrap: Option<&str>| {
            let mut request = axum::http::Request::builder().method(Method::POST).uri(uri);
            if let Some(ttl) = wrap {
                request = request.header(WRAP_TTL_HEADER, ttl);
            }
            let mut request = request.body(Body::empty()).unwrap();
            if let Some(peer) = peer {
                let addr: SocketAddr = format!("{peer}:4000").parse().unwrap();
                request.extensions_mut().insert(ConnectInfo(addr));
            }
            router.clone().oneshot(request)
        };

        // The built-in login quota (60/min) limits one known client...
        let login = "/api/vault/auth/approle/login";
        for _ in 0..quotas::DEFAULT_LOGIN_RATE_PER_MIN {
            assert_eq!(
                call(login, Some("192.0.2.211"), None)
                    .await
                    .unwrap()
                    .status(),
                StatusCode::OK
            );
        }
        let limited = call(login, Some("192.0.2.211"), None).await.unwrap();
        assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(limited
            .headers()
            .contains_key(axum::http::header::RETRY_AFTER));
        // ...without touching another client's bucket.
        assert_eq!(
            call(login, Some("192.0.2.212"), None)
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        // An unknown address never shares one drainable built-in bucket.
        for _ in 0..=quotas::DEFAULT_LOGIN_RATE_PER_MIN {
            assert_eq!(
                call(login, None, None).await.unwrap().status(),
                StatusCode::OK
            );
        }

        // A lease-count quota cannot be bypassed by percent-encoding the role.
        store
            .lease_create(
                NewLease {
                    role: "layerq",
                    provider: "random",
                    issued_to: Some("machine:layer"),
                    ttl_secs: 600,
                    max_ttl_secs: 600,
                    renewable: true,
                    revoke_data: &Value::Null,
                },
                &AuditActor::system(),
            )
            .await
            .unwrap();
        store
            .quota_put(
                "layerq-cap",
                QuotaRule::LeaseCount {
                    role: "layerq".into(),
                    max_leases: 1,
                },
                &AuditActor::system(),
            )
            .await
            .unwrap();
        for uri in [
            "/api/vault/dynamic/issue/layerq",
            "/api/vault/dynamic/issue/%6Cayerq",
        ] {
            let response = call(uri, Some("192.0.2.213"), None).await.unwrap();
            assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS, "{uri}");
        }
        let invalid = call("/api/vault/dynamic/issue/a%2Fb", Some("192.0.2.213"), None)
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);

        // A wrap header turns a secret-id response into a wrapping token, and
        // a bad TTL is refused before the handler can run.
        let secret_ids = "/api/vault/machines/layer/secret-ids";
        let wrapped = call(secret_ids, Some("192.0.2.214"), Some("60"))
            .await
            .unwrap();
        assert_eq!(wrapped.status(), StatusCode::OK);
        assert!(wrapped.headers().contains_key("x-ryu-wrapped"));
        let bytes = axum::body::to_bytes(wrapped.into_body(), 1 << 20)
            .await
            .unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(!text.contains("sid_layer_plain"), "{text}");
        let bad = call(secret_ids, Some("192.0.2.214"), Some("2d"))
            .await
            .unwrap();
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
    }
}

#[cfg(test)]
#[path = "vault_tokens_routes_test.rs"]
mod routes_test;
