//! Value routes: delete, versions, and version actions.

use super::*;

pub(super) async fn delete_coords(ctx: &Ctx, coords: SecretCoords, actor: &AuditActor) -> Response {
    if let Err(response) = ctx.require(&coords, Capability::Delete) {
        return response;
    }
    match protected_environment(ctx, &coords.environment).await {
        Ok(Some(required)) if !ctx.caps(&coords).contains(&Capability::Admin) => {
            let authority = ctx.requester_authority(&coords);
            return match ctx
                .store
                .create_change_request(
                    coords,
                    ChangeOperation::Delete,
                    None,
                    json!({}),
                    required,
                    actor,
                    &authority,
                )
                .await
            {
                Ok(request) => no_store_response(
                    (
                        StatusCode::ACCEPTED,
                        Json(rfc3339_fields(
                            json!({ "ok": true, "changeRequest": request }),
                        )),
                    )
                        .into_response(),
                ),
                Err(error) => vault_error(error),
            };
        }
        Ok(_) => {}
        Err(response) => return response,
    }
    match ctx.store.soft_delete(coords.clone(), actor).await {
        Ok(_) => respond(json!({
            "ok": true,
            "deleted": true,
            "name": coords.name,
            "scope": coords.scope,
            "scopeId": coords.scope_id,
            "binding": coords.binding,
            "environment": coords.environment,
            "path": coords.path,
        })),
        Err(error) => vault_error(error),
    }
}

/// DELETE /api/vault/secrets/{name} soft-deletes one value. Idempotent.
#[utoipa::path(
    delete,
    path = "/api/vault/secrets/{name}",
    tag = "Vault",
    summary = "Soft-delete a scoped vault secret (restorable)",
    params(("name" = String, Path, description = "Env-compatible secret name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Deleted", body = serde_json::Value))
)]
pub async fn delete_secret(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<CoordsQuery>,
    body: Option<Json<DeleteSecretBody>>,
) -> Response {
    // Some HTTP clients drop DELETE bodies, so query coordinates work too.
    let body = body.map_or_else(
        || DeleteSecretBody {
            coords: query.into(),
        },
        |Json(body)| body,
    );
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if ctx.shared_remote(body.coords.scope) {
        let target_id = ctx.shared_scope_id(&body.coords);
        return proxy(
            &ctx,
            reqwest::Method::DELETE,
            &format!("/secrets/{}", urlencoding::encode(&name)),
            &body.coords.query_pairs(&target_id),
            None,
        )
        .await;
    }
    let coords = match coords_for(&ctx, &name, body.coords) {
        Ok(coords) => coords,
        Err(response) => return response,
    };
    let actor = ctx.actor();
    delete_coords(&ctx, coords, &actor).await
}

/// GET /api/vault/secrets/{name}/versions lists version history.
#[utoipa::path(
    get,
    path = "/api/vault/secrets/{name}/versions",
    tag = "Vault",
    summary = "List a value's versions (never values)",
    params(("name" = String, Path, description = "Secret name")),
    responses((status = 200, description = "Versions, newest first", body = serde_json::Value))
)]
pub async fn list_versions(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<CoordsQuery>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let body: CoordsBody = query.into();
    if ctx.shared_remote(body.scope) {
        let target_id = ctx.shared_scope_id(&body);
        return proxy(
            &ctx,
            reqwest::Method::GET,
            &format!("/secrets/{}/versions", urlencoding::encode(&name)),
            &body.query_pairs(&target_id),
            None,
        )
        .await;
    }
    let coords = match coords_for(&ctx, &name, body) {
        Ok(coords) => coords,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require(&coords, Capability::List) {
        return response;
    }
    match ctx.store.list_versions(&coords).await {
        Ok(versions) => respond(json!({ "versions": versions })),
        Err(error) => vault_error(error),
    }
}

/// Body for version-targeted actions.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionActionBody {
    #[serde(flatten)]
    pub(crate) coords: CoordsBody,
    #[serde(default)]
    pub(crate) version: Option<i64>,
    #[serde(default)]
    pub(crate) versions: Option<Vec<i64>>,
}

/// POST /api/vault/secrets/{name}/{action} for `reveal`, `rollback`,
/// `restore`, and `destroy`.
#[utoipa::path(
    post,
    path = "/api/vault/secrets/{name}/{action}",
    tag = "Vault",
    summary = "Reveal (read), roll back (write), restore (write), or destroy (delete) a value",
    params(
        ("name" = String, Path, description = "Secret name"),
        ("action" = String, Path, description = "`reveal`, `rollback`, `restore`, or `destroy`"),
    ),
    request_body = serde_json::Value,
    responses((status = 200, description = "Result", body = serde_json::Value))
)]
pub async fn secret_action(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path((name, action)): Path<(String, String)>,
    Json(body): Json<VersionActionBody>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    secret_action_with(&ctx, &name, &action, body).await
}

pub(super) async fn secret_action_with(
    ctx: &Ctx,
    name: &str,
    action: &str,
    body: VersionActionBody,
) -> Response {
    if !matches!(action, "reveal" | "rollback" | "restore" | "destroy") {
        return json_error(
            StatusCode::NOT_FOUND,
            "vault_not_found: unknown action".to_owned(),
        );
    }
    if ctx.shared_remote(body.coords.scope) {
        let forwarded = json!({
            "scope": body.coords.scope,
            "scopeId": ctx.shared_scope_id(&body.coords),
            "binding": body.coords.binding,
            "environment": body.coords.environment,
            "path": body.coords.path,
            "version": body.version,
            "versions": body.versions,
        });
        // Only a reveal returns plaintext, so only a reveal carries the node
        // key as proof; the other actions never need it.
        let node_proof = action == "reveal" && ctx.node_vouches().await;
        return proxy_with_proof(
            &ctx,
            reqwest::Method::POST,
            &format!("/secrets/{}/{action}", urlencoding::encode(&name)),
            &[],
            Some(forwarded),
            node_proof,
        )
        .await;
    }
    let coords = match coords_for(&ctx, &name, body.coords) {
        Ok(coords) => coords,
        Err(response) => return response,
    };
    let actor = ctx.actor();
    let capability = match action {
        "reveal" => Capability::Read,
        "destroy" => Capability::Delete,
        _ => Capability::Write,
    };
    if let Err(response) = ctx.require(&coords, capability) {
        return response;
    }
    if action != "reveal" {
        match protected_environment(&ctx, &coords.environment).await {
            Ok(Some(_)) if !ctx.caps(&coords).contains(&Capability::Admin) => {
                return protected_denied(&coords.environment);
            }
            Ok(_) => {}
            Err(response) => return response,
        }
    }
    let result = match action {
        "reveal" => {
            if let Some(spec) = ctx.read_control_group(&coords) {
                return crate::server::vault_policy_ext_api::open_control_group(
                    &ctx,
                    &coords,
                    body.version,
                    &spec,
                )
                .await;
            }
            return match ctx.store.reveal(&coords, body.version, &actor).await {
                Ok(value) => respond(json!({ "value": value })),
                Err(error) => vault_error(error),
            };
        }
        "rollback" => {
            let Some(version) = body.version else {
                return invalid_request("version is required");
            };
            if let Err(response) = require_stored_parameters(&ctx, &coords, Some(version)).await {
                return response;
            }
            ctx.store.rollback(coords, version, &actor).await
        }
        "restore" => {
            if let Err(response) = require_stored_parameters(&ctx, &coords, None).await {
                return response;
            }
            ctx.store.restore(coords, &actor).await
        }
        _ => {
            return match ctx
                .store
                .destroy(coords, body.versions.as_deref(), &actor)
                .await
            {
                Ok(result) => respond(json!({ "ok": true, "destroyed": result })),
                Err(error) => vault_error(error),
            };
        }
    };
    match result {
        Ok(info) => respond(json!({ "ok": true, "secret": to_wire(&ctx, info) })),
        Err(error) => vault_error(error),
    }
}

/// 403 for a read gated by a control group on a path that cannot request one.
pub(crate) fn control_group_required(key: &str) -> Response {
    json_error(
        StatusCode::FORBIDDEN,
        format!(
            "vault_control_group_required: `{key}` needs control-group approval, which this route cannot request"
        ),
    )
}

/// Rollback and restore put a stored value back without a request body, so
/// check that value (one `version`, or the current one) against the caller's
/// write parameter constraints. Values are decrypted only when a constraint
/// applies.
pub(crate) async fn require_stored_parameters(
    ctx: &Ctx,
    coords: &SecretCoords,
    version: Option<i64>,
) -> Result<(), Response> {
    if !ctx.write_parameters_constrained(coords) {
        return Ok(());
    }
    let value = ctx
        .store
        .version_value_unaudited(coords, version)
        .await
        .map_err(vault_error)?;
    ctx.require_write_parameters(coords, Some(&value))
}
