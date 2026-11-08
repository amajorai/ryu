//! Policies, bindings, and change requests.
//!
//! test-exempt: policy, binding, and change-request routes moved unchanged out of the former single-file `vault_api`; covered end to end by the vault route and policy tests.

use super::*;

/// GET /api/vault/policies lists policies and bindings.
#[utoipa::path(get, path = "/api/vault/policies", tag = "Vault",
    summary = "List vault policies and bindings (admin)",
    responses((status = 200, description = "Policies", body = serde_json::Value)))]
pub async fn list_policies(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys("sys/policies", Capability::Admin) {
        return response;
    }
    let conn = ctx.store.conn.lock().await;
    let policies = crate::vault::policy::list_policies(&conn);
    let bindings = crate::vault::policy::list_bindings(&conn);
    drop(conn);
    match (policies, bindings) {
        (Ok(policies), Ok(bindings)) => {
            respond(json!({ "policies": policies, "bindings": bindings }))
        }
        (Err(error), _) | (_, Err(error)) => vault_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyBody {
    #[serde(default)]
    pub(crate) description: String,
    pub(crate) rules: Vec<PolicyRule>,
}

/// PUT /api/vault/policies/{name}.
#[utoipa::path(put, path = "/api/vault/policies/{name}", tag = "Vault",
    summary = "Create or replace a vault policy (admin)",
    params(("name" = String, Path, description = "Policy name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Saved", body = serde_json::Value)))]
pub async fn put_policy(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<PolicyBody>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys("sys/policies", Capability::Admin) {
        return response;
    }
    let policy = Policy {
        name,
        description: body.description,
        rules: body.rules,
    };
    if let Err(error) = crate::vault::policy::validate(&policy) {
        return invalid_request(&error.to_string());
    }
    let conn = ctx.store.conn.lock().await;
    if let Err(error) = crate::vault::policy::put_policy(&conn, &policy) {
        return vault_error(error);
    }
    ctx.store.audit_locked(
        &conn,
        &AuditEntry::new(&ctx.actor(), "policy.put", "ok")
            .details(json!({ "policy": policy.name })),
    );
    respond(json!({ "ok": true, "policy": policy }))
}

/// DELETE /api/vault/policies/{name}.
#[utoipa::path(delete, path = "/api/vault/policies/{name}", tag = "Vault",
    summary = "Delete a vault policy and its bindings (admin)",
    params(("name" = String, Path, description = "Policy name")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn delete_policy(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys("sys/policies", Capability::Admin) {
        return response;
    }
    let conn = ctx.store.conn.lock().await;
    match crate::vault::policy::delete_policy(&conn, &name) {
        Ok(deleted) => {
            ctx.store.audit_locked(
                &conn,
                &AuditEntry::new(&ctx.actor(), "policy.delete", "ok")
                    .details(json!({ "policy": name })),
            );
            respond(json!({ "ok": true, "deleted": deleted }))
        }
        Err(error) => vault_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingBody {
    pub(crate) policy: String,
    pub(crate) subject: String,
    #[serde(default)]
    pub(crate) expires_at: Option<i64>,
}

/// POST /api/vault/policy-bindings attaches a policy, optionally temporarily.
#[utoipa::path(post, path = "/api/vault/policy-bindings", tag = "Vault",
    summary = "Bind a policy to a user, team, role, or machine (admin; optional expiry)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Bound", body = serde_json::Value)))]
pub async fn add_binding(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let body: BindingBody = match parse_body(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys("sys/policies", Capability::Admin) {
        return response;
    }
    let actor = ctx.actor();
    let conn = ctx.store.conn.lock().await;
    match crate::vault::policy::bind(
        &conn,
        &body.policy,
        &body.subject,
        body.expires_at,
        actor.id.as_deref(),
    ) {
        Ok(binding) => {
            ctx.store.audit_locked(
                &conn,
                &AuditEntry::new(&actor, "policy.bind", "ok").details(json!({
                    "policy": binding.policy, "subject": binding.subject, "expiresAt": binding.expires_at,
                })),
            );
            respond(json!({ "ok": true, "binding": binding }))
        }
        Err(error) => invalid_request(&error.to_string()),
    }
}

/// DELETE /api/vault/policy-bindings/{id}.
#[utoipa::path(delete, path = "/api/vault/policy-bindings/{id}", tag = "Vault",
    summary = "Remove a policy binding (admin)",
    params(("id" = String, Path, description = "Binding id")),
    responses((status = 200, description = "Removed", body = serde_json::Value)))]
pub async fn remove_binding(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys("sys/policies", Capability::Admin) {
        return response;
    }
    let conn = ctx.store.conn.lock().await;
    match crate::vault::policy::unbind(&conn, &id) {
        Ok(removed) => {
            ctx.store.audit_locked(
                &conn,
                &AuditEntry::new(&ctx.actor(), "policy.unbind", "ok")
                    .details(json!({ "binding": id })),
            );
            respond(json!({ "ok": true, "removed": removed }))
        }
        Err(error) => vault_error(error),
    }
}

// ── Change requests ───────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeQuery {
    #[serde(default)]
    pub(crate) status: Option<ChangeStatus>,
}

/// GET /api/vault/change-requests lists requests the caller may see.
#[utoipa::path(get, path = "/api/vault/change-requests", tag = "Vault",
    summary = "List change requests for protected environments",
    params(("status" = Option<String>, Query, description = "pending, applied, rejected, canceled")),
    responses((status = 200, description = "Requests (never proposed values)", body = serde_json::Value)))]
pub async fn list_change_requests(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<ChangeQuery>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let me = ctx.actor();
    let mine = crate::vault::changes::subject_of(&me);
    match ctx.store.list_change_requests(query.status).await {
        Ok(requests) => {
            let mut visible: Vec<Value> = requests
                .into_iter()
                .filter(|request| {
                    let caps = ctx.approval_caps(&request.coords);
                    caps.contains(&Capability::Approve) || request.requested_by == mine
                })
                .map(|request| serde_json::to_value(request).unwrap_or(Value::Null))
                .collect();
            // Requests on shared values live in the control plane, which
            // applies its own visibility rules.
            let mut shared_error = None;
            if let (true, Some(jwt)) = (crate::vault::shared::is_enabled(), ctx.jwt.as_deref()) {
                let mut pairs = Vec::new();
                if let Some(status) = query.status {
                    if let Some(status) = serde_json::to_value(status)
                        .ok()
                        .and_then(|value| value.as_str().map(str::to_owned))
                    {
                        pairs.push(("status".to_owned(), status));
                    }
                }
                match crate::vault::shared::proxy(
                    reqwest::Method::GET,
                    "/change-requests",
                    &pairs,
                    jwt,
                    None,
                    false,
                )
                .await
                {
                    Ok(value) => {
                        let remote = value.get("changeRequests").and_then(Value::as_array);
                        for mut request in remote.into_iter().flatten().cloned() {
                            if let Some(object) = request.as_object_mut() {
                                object.insert("source".into(), json!("control-plane"));
                            }
                            visible.push(request);
                        }
                    }
                    Err(error) => shared_error = Some(format!("{error:?}")),
                }
            }
            respond(json!({ "changeRequests": visible, "sharedError": shared_error }))
        }
        Err(error) => vault_error(error),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionBody {
    #[serde(default)]
    pub(crate) reason: Option<String>,
}

/// POST /api/vault/change-requests/{id}/{decision} for `approve`, `reject`, `cancel`.
#[utoipa::path(post, path = "/api/vault/change-requests/{id}/{decision}", tag = "Vault",
    summary = "Approve, reject, or cancel a change request",
    params(
        ("id" = String, Path, description = "Change request id"),
        ("decision" = String, Path, description = "`approve`, `reject`, or `cancel`"),
    ),
    request_body = serde_json::Value,
    responses((status = 200, description = "Updated request", body = serde_json::Value)))]
pub async fn decide_change_request(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path((id, decision)): Path<(String, String)>,
    body: Option<Json<DecisionBody>>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let reason = body.and_then(|Json(body)| body.reason);
    let request = match ctx.store.change_request(&id).await {
        Ok(request) => request,
        Err(error) => {
            // Not a local request: it may be one on a shared value.
            let not_found = matches!(
                error.downcast_ref::<VaultError>(),
                Some(VaultError::NotFound(_))
            );
            if not_found && crate::vault::shared::is_enabled() && ctx.jwt.is_some() {
                return proxy(
                    &ctx,
                    reqwest::Method::POST,
                    &format!(
                        "/change-requests/{}/{}",
                        urlencoding::encode(&id),
                        urlencoding::encode(&decision)
                    ),
                    &[],
                    Some(json!({ "reason": reason })),
                )
                .await;
            }
            return vault_error(error);
        }
    };
    let actor = ctx.actor();
    let result = match decision.as_str() {
        "approve" | "reject" => {
            if !ctx
                .approval_caps(&request.coords)
                .contains(&Capability::Approve)
            {
                return denied(Capability::Approve, &request.coords.policy_key());
            }
            if decision == "approve" {
                // Re-read the environment so a raised threshold also covers
                // requests that were already pending.
                let current_required =
                    match protected_environment(&ctx, &request.coords.environment).await {
                        Ok(required) => required,
                        Err(response) => return response,
                    };
                ctx.store
                    .approve_change_request(&id, &actor, current_required)
                    .await
            } else {
                ctx.store
                    .close_change_request(&id, &actor, reason.as_deref(), false)
                    .await
            }
        }
        "cancel" => {
            ctx.store
                .close_change_request(&id, &actor, reason.as_deref(), true)
                .await
        }
        _ => {
            return json_error(
                StatusCode::NOT_FOUND,
                "vault_not_found: unknown decision".to_owned(),
            )
        }
    };
    match result {
        Ok(request) => respond(json!({ "ok": true, "changeRequest": request })),
        Err(error) => vault_error(error),
    }
}
