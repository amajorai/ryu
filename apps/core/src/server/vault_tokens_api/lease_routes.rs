//! Lease administration and quota routes.

use super::*;

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
    pub(super) fn filter(&self) -> LeaseFilter<'_> {
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
