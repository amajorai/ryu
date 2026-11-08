//! Access-request routes (roadmap P1-9), merged into the policy-extension
//! router.
//!
//! * `GET    /api/vault/access-policies`: every access policy (any signed-in
//!   caller, so requesters can see who approves what).
//! * `PUT    /api/vault/access-policies/{name}` and `DELETE`: write or remove
//!   one (`admin` on `sys/access-requests`).
//! * `GET    /api/vault/access-requests`: requests the caller opened or may
//!   approve (`admin` on `sys/access-requests` sees all).
//! * `POST   /api/vault/access-requests`: open one (`path`, `capabilities`,
//!   `durationSecs`, `reason`).
//! * `GET    /api/vault/access-requests/{id}`: one request.
//! * `POST   /api/vault/access-requests/{id}/approve|deny`: decide the open
//!   step as one of its approvers.
//! * `POST   /api/vault/access-requests/{id}/cancel`: the requester withdraws.
//! * `POST   /api/vault/access-requests/{id}/revoke`: the requester or an
//!   admin ends an active grant early.
//!
//! See [`crate::vault::access_requests`] for the model. Audit rows carry ids,
//! paths and capabilities, never reasons or values.

use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{get, post, put};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::identity_verify::VerifiedCaller;
use crate::server::vault_api::{
    ctx, invalid_request, respond, vault_error, Ctx, MAX_REQUEST_BODY_BYTES,
};
use crate::server::{json_error, ServerState};
use crate::vault::access_requests::{self as access, AccessPolicy, AccessRequest};
use crate::vault::audit::AuditEntry;
use crate::vault::policy::Capability;

const ADMIN_KEY: &str = "sys/access-requests";

/// Access-request routes (node bearer).
pub fn routes() -> Router<ServerState> {
    let body = || DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES);
    Router::new()
        .route("/api/vault/access-policies", get(list_policies))
        .route(
            "/api/vault/access-policies/:name",
            put(put_policy).delete(delete_policy).layer(body()),
        )
        .route(
            "/api/vault/access-requests",
            get(list_requests).post(create_request).layer(body()),
        )
        .route("/api/vault/access-requests/:id", get(get_request))
        .route(
            "/api/vault/access-requests/:id/:action",
            post(decide_request).layer(body()),
        )
}

fn principal(ctx: &Ctx) -> Result<String, Response> {
    ctx.caller
        .as_ref()
        .map(|caller| format!("user:{}", caller.user_id))
        .ok_or_else(|| {
            json_error(
                StatusCode::UNAUTHORIZED,
                "vault_user_required: access requests need a signed-in user".to_owned(),
            )
        })
}

fn is_admin(ctx: &Ctx) -> bool {
    ctx.sys_caps(ADMIN_KEY).contains(&Capability::Admin)
}

fn not_found() -> Response {
    json_error(
        StatusCode::NOT_FOUND,
        "vault_not_found: access request not found".to_owned(),
    )
}

fn visible(ctx: &Ctx, request: &AccessRequest) -> bool {
    let subjects = ctx.subjects();
    subjects.contains(&request.requester) || request.is_approver(&subjects) || is_admin(ctx)
}

fn audit(ctx: &Ctx, conn: &rusqlite::Connection, action: &str, outcome: &str, details: Value) {
    ctx.store.audit_locked(
        conn,
        &AuditEntry::new(&ctx.actor(), action, outcome).details(details),
    );
}

/// GET /api/vault/access-policies.
#[utoipa::path(get, path = "/api/vault/access-policies", tag = "Vault",
    operation_id = "list_access_policies",
    summary = "Access policies: who approves requests under which paths",
    responses((status = 200, description = "Access policies", body = serde_json::Value)))]
pub async fn list_policies(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    list_policies_for(&ctx).await
}

pub(super) async fn list_policies_for(ctx: &Ctx) -> Response {
    if ctx.caller.is_none() && ctx.node.is_some() {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "vault_user_required: access requests need a signed-in user".to_owned(),
        );
    }
    let conn = ctx.store.conn.lock().await;
    match access::list_policies(&conn) {
        Ok(policies) => respond(json!({ "accessPolicies": policies })),
        Err(error) => vault_error(error),
    }
}

/// PUT /api/vault/access-policies/{name}.
#[utoipa::path(put, path = "/api/vault/access-policies/{name}", tag = "Vault",
    operation_id = "put_access_policy",
    summary = "Write an access policy",
    params(("name" = String, Path, description = "Policy name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Stored policy", body = serde_json::Value)))]
pub async fn put_policy(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    put_policy_for(&ctx, &name, body).await
}

pub(super) async fn put_policy_for(ctx: &Ctx, name: &str, mut body: Value) -> Response {
    if let Err(response) = ctx.require_sys(ADMIN_KEY, Capability::Admin) {
        return response;
    }
    if let Value::Object(map) = &mut body {
        map.insert("name".to_owned(), Value::String(name.to_owned()));
    }
    let policy: AccessPolicy = match serde_json::from_value(body) {
        Ok(policy) => policy,
        Err(error) => return invalid_request(&error.to_string()),
    };
    let conn = ctx.store.conn.lock().await;
    let result = access::put_policy(&conn, &policy);
    let outcome = if result.is_ok() { "ok" } else { "error" };
    audit(
        ctx,
        &conn,
        "access_policy.put",
        outcome,
        json!({ "policy": policy.name, "path": policy.path, "steps": policy.steps.len() }),
    );
    match result {
        Ok(()) => respond(json!({ "ok": true, "accessPolicy": policy })),
        Err(error) => vault_error(error),
    }
}

/// DELETE /api/vault/access-policies/{name}.
#[utoipa::path(delete, path = "/api/vault/access-policies/{name}", tag = "Vault",
    operation_id = "delete_access_policy",
    summary = "Delete an access policy",
    params(("name" = String, Path, description = "Policy name")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn delete_policy(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    if let Err(response) = ctx.require_sys(ADMIN_KEY, Capability::Admin) {
        return response;
    }
    let conn = ctx.store.conn.lock().await;
    let result = access::delete_policy(&conn, &name);
    audit(
        &ctx,
        &conn,
        "access_policy.delete",
        if result.is_ok() { "ok" } else { "error" },
        json!({ "policy": name }),
    );
    match result {
        Ok(deleted) => respond(json!({ "ok": true, "deleted": deleted })),
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/access-requests.
#[utoipa::path(get, path = "/api/vault/access-requests", tag = "Vault",
    operation_id = "list_access_requests",
    summary = "Access requests the caller opened or may approve",
    responses((status = 200, description = "Requests", body = serde_json::Value)))]
pub async fn list_requests(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    list_requests_for(&ctx).await
}

pub(super) async fn list_requests_for(ctx: &Ctx) -> Response {
    let now = crate::vault::now_millis();
    let conn = ctx.store.conn.lock().await;
    if let Err(error) = access::prune(&conn, now) {
        tracing::warn!("pruning access requests failed: {error:#}");
    }
    match access::list_requests(&conn, &ctx.subjects(), is_admin(ctx), now) {
        Ok(requests) => respond(json!({ "accessRequests": requests })),
        Err(error) => vault_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateBody {
    path: String,
    capabilities: Vec<Capability>,
    duration_secs: i64,
    reason: String,
}

/// POST /api/vault/access-requests.
#[utoipa::path(post, path = "/api/vault/access-requests", tag = "Vault",
    operation_id = "create_access_request",
    summary = "Request time-bound access to a path",
    request_body = serde_json::Value,
    responses((status = 201, description = "Pending request", body = serde_json::Value)))]
pub async fn create_request(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    create_request_for(&ctx, body).await
}

pub(super) async fn create_request_for(ctx: &Ctx, body: Value) -> Response {
    let requester = match principal(ctx) {
        Ok(requester) => requester,
        Err(response) => return response,
    };
    let body: CreateBody = match serde_json::from_value(body) {
        Ok(body) => body,
        Err(error) => return invalid_request(&error.to_string()),
    };
    let input = access::NewAccessRequest {
        path: body.path,
        capabilities: body.capabilities,
        duration_secs: body.duration_secs,
        reason: body.reason,
    };
    let now = crate::vault::now_millis();
    let conn = ctx.store.conn.lock().await;
    if let Err(error) = access::prune(&conn, now) {
        tracing::warn!("pruning access requests failed: {error:#}");
    }
    let result = access::create_request(&conn, &requester, &input, now);
    let details = match &result {
        Ok(request) => json!({ "id": request.id, "path": request.path,
            "capabilities": request.capabilities, "durationSecs": request.duration_secs }),
        Err(_) => json!({ "path": input.path, "capabilities": input.capabilities }),
    };
    audit(
        ctx,
        &conn,
        "access_request.open",
        if result.is_ok() { "pending" } else { "denied" },
        details,
    );
    match result {
        Ok(request) => {
            let mut response = respond(json!({ "ok": true, "accessRequest": request }));
            *response.status_mut() = StatusCode::CREATED;
            response
        }
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/access-requests/{id}.
#[utoipa::path(get, path = "/api/vault/access-requests/{id}", tag = "Vault",
    operation_id = "get_access_request",
    summary = "One access request",
    params(("id" = String, Path, description = "Request id")),
    responses((status = 200, description = "Request", body = serde_json::Value)))]
pub async fn get_request(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    let conn = ctx.store.conn.lock().await;
    match access::get_request(&conn, &id, crate::vault::now_millis()) {
        Ok(Some(request)) if visible(&ctx, &request) => {
            respond(json!({ "accessRequest": request }))
        }
        Ok(_) => not_found(),
        Err(error) => vault_error(error),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecideBody {
    #[serde(default)]
    reason: Option<String>,
}

/// POST /api/vault/access-requests/{id}/{action}.
#[utoipa::path(post, path = "/api/vault/access-requests/{id}/{action}", tag = "Vault",
    operation_id = "decide_access_request",
    summary = "Approve, deny, cancel, or revoke an access request",
    params(("id" = String, Path, description = "Request id"),
        ("action" = String, Path, description = "approve, deny, cancel, or revoke")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Updated request", body = serde_json::Value)))]
pub async fn decide_request(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path((id, action)): Path<(String, String)>,
    body: Option<Json<Value>>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    let body = body.map(|Json(body)| body).unwrap_or(Value::Null);
    decide_for(&ctx, &id, &action, body).await
}

pub(super) async fn decide_for(ctx: &Ctx, id: &str, action: &str, body: Value) -> Response {
    let body: DecideBody = match body {
        Value::Null => DecideBody::default(),
        other => match serde_json::from_value(other) {
            Ok(body) => body,
            Err(error) => return invalid_request(&error.to_string()),
        },
    };
    let now = crate::vault::now_millis();
    let subjects = ctx.subjects();
    let conn = ctx.store.conn.lock().await;
    let request = match access::get_request(&conn, id, now) {
        Ok(Some(request)) if visible(ctx, &request) => request,
        Ok(_) => return not_found(),
        Err(error) => return vault_error(error),
    };
    let result = match action {
        "approve" | "deny" | "cancel" => {
            let actor = match principal(ctx) {
                Ok(actor) => actor,
                Err(response) => return response,
            };
            match action {
                "approve" => access::approve(&conn, id, &actor, &subjects, now),
                "deny" => access::deny(&conn, id, &actor, &subjects, body.reason.as_deref(), now),
                _ => access::cancel(&conn, id, &actor, now),
            }
        }
        "revoke" => {
            let own = subjects.contains(&request.requester);
            if !own && !is_admin(ctx) {
                return json_error(
                    StatusCode::FORBIDDEN,
                    "vault_denied: only the requester or an admin can revoke a grant".to_owned(),
                );
            }
            let by = principal(ctx).unwrap_or_else(|_| "operator".to_owned());
            access::revoke(&conn, id, &by, now)
        }
        _ => return not_found(),
    };
    let outcome = match &result {
        Ok(updated) => updated.status.as_str(),
        Err(_) => "denied",
    };
    audit(
        ctx,
        &conn,
        &format!("access_request.{action}"),
        outcome,
        json!({ "id": id, "path": request.path }),
    );
    match result {
        Ok(request) => respond(json!({ "ok": true, "accessRequest": request })),
        Err(error) => vault_error(error),
    }
}

#[cfg(test)]
mod tests;
