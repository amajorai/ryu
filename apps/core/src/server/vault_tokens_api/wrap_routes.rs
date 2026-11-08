//! Response wrapping, agent self-token, and cubbyhole routes.

use super::*;

pub(super) fn wrap_ttl_or_default(headers: &HeaderMap) -> Result<i64, Response> {
    wrap_ttl(headers).map(|ttl| ttl.unwrap_or(wrapping::DEFAULT_WRAP_TTL_SECS))
}

pub(super) async fn wrap_data(who: &Who, headers: &HeaderMap, data: Value) -> Response {
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
    pub(super) token: Option<String>,
}

pub(super) fn presented_wrap_token(
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
