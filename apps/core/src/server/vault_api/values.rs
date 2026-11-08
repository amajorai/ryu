//! Value routes: list and write.

use super::*;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    #[serde(default)]
    pub(crate) environment: Option<String>,
    #[serde(default)]
    pub(crate) path: Option<String>,
    #[serde(default)]
    pub(crate) recursive: Option<bool>,
    #[serde(default)]
    pub(crate) include_deleted: Option<bool>,
    /// Keyset cursor (`nextAfter` of the previous page). Setting `after` or
    /// `limit` switches to stable `(environment, path, name)` order.
    #[serde(default)]
    pub(crate) after: Option<String>,
    #[serde(default)]
    pub(crate) limit: Option<usize>,
    /// Include each value's version summaries (KV v2 detailed metadata).
    #[serde(default)]
    pub(crate) detailed: Option<bool>,
}

/// GET /api/vault/secrets lists the caller's visible vault metadata.
#[utoipa::path(
    get,
    path = "/api/vault/secrets",
    tag = "Vault",
    summary = "List visible vault secret metadata (never values)",
    params(
        ("environment" = Option<String>, Query, description = "Environment slug filter"),
        ("path" = Option<String>, Query, description = "Folder filter"),
        ("recursive" = Option<bool>, Query, description = "Include sub-folders (default true)"),
        ("includeDeleted" = Option<bool>, Query, description = "Include soft-deleted values"),
        ("after" = Option<String>, Query, description = "Page cursor: `nextAfter` from the previous page"),
        ("limit" = Option<usize>, Query, description = "Page size (default 200, max 1000); enables paging"),
        ("detailed" = Option<bool>, Query, description = "Include per-version summaries (requires paging)"),
    ),
    responses((status = 200, description = "Metadata only", body = serde_json::Value))
)]
pub async fn list_secrets(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let filter = ListFilter {
        environment: query.environment.clone(),
        path: query.path.clone(),
        recursive: query.recursive.unwrap_or(true),
        include_deleted: query.include_deleted.unwrap_or(false),
    };
    let paged = query.after.is_some() || query.limit.is_some();
    let detailed = query.detailed.unwrap_or(false);
    // Version summaries are bounded by the page size: an unpaged listing has
    // no bound, so `detailed` requires paging.
    if detailed && !paged {
        return invalid_request("detailed=true requires paging: pass limit (or after)");
    }
    let can_list = |info: &VaultSecretInfo| ctx.caps(&info.coords()).contains(&Capability::List);
    let mut next_after = None;
    let mut page_ids = Vec::new();
    let local = if paged {
        match ctx
            .store
            .list_secrets_page(
                &filter,
                query.after.as_deref(),
                query
                    .limit
                    .unwrap_or(crate::plugin_secrets::kv_meta::DEFAULT_PAGE_LIMIT),
                can_list,
            )
            .await
        {
            Ok(page) => {
                next_after = page.next_after;
                page_ids = page.ids;
                page.secrets
            }
            Err(error) => return vault_error(error),
        }
    } else {
        match ctx.store.list_vault_secrets_filtered(&filter).await {
            Ok(secrets) => secrets.into_iter().filter(|info| can_list(info)).collect(),
            Err(error) => return vault_error(error),
        }
    };
    let mut versions = if detailed {
        match ctx.store.versions_for_page(&page_ids).await {
            Ok(versions) => Some(versions),
            Err(error) => return vault_error(error),
        }
    } else {
        None
    };
    let mut secrets: Vec<Value> = Vec::with_capacity(local.len());
    for (index, info) in local.into_iter().enumerate() {
        let mut wire = serde_json::to_value(to_wire(&ctx, info)).unwrap_or(Value::Null);
        if let (Some(versions), Some(id)) = (versions.as_mut(), page_ids.get(index)) {
            let summaries = versions.remove(id).unwrap_or_default();
            if let Some(object) = wire.as_object_mut() {
                object.insert("versions".into(), json!(summaries));
            }
        }
        secrets.push(wire);
    }
    // Shared values on a managed node come from the control plane; a
    // failure there degrades to local values with a flag, not an error.
    // Paging covers local values; shared values arrive on the first page.
    let mut shared_error = None;
    if crate::vault::shared::is_enabled() && query.after.is_none() {
        if let Some(jwt) = ctx.jwt.as_deref() {
            let mut pairs = Vec::new();
            if let Some(environment) = &query.environment {
                pairs.push(("environment".to_owned(), environment.clone()));
            }
            if let Some(path) = &query.path {
                pairs.push(("path".to_owned(), path.clone()));
            }
            pairs.push(("recursive".to_owned(), filter.recursive.to_string()));
            pairs.push((
                "includeDeleted".to_owned(),
                filter.include_deleted.to_string(),
            ));
            match crate::vault::shared::proxy(
                reqwest::Method::GET,
                "/secrets",
                &pairs,
                jwt,
                None,
                false,
            )
            .await
            {
                Ok(value) => {
                    if let Some(remote) = value.get("secrets").and_then(Value::as_array) {
                        for mut secret in remote.iter().cloned() {
                            if let Some(object) = secret.as_object_mut() {
                                object.insert("source".into(), json!("control-plane"));
                            }
                            secrets.push(secret);
                        }
                    }
                }
                Err(error) => shared_error = Some(format!("{error:?}")),
            }
        }
    }
    let node = ctx.node.as_ref();
    respond(json!({
        "secrets": secrets,
        "nextAfter": next_after,
        "node": {
            "id": ctx.node_id,
            "scope": node_scope_label(node),
            "orgId": node.map(|registered| registered.org.id.clone()),
            "teamId": node.and_then(|registered| registered.team_id.clone()),
            "ownerUserId": node.and_then(|registered| registered.owner_user_id.clone()),
        },
        "caller": ctx.caller.as_ref().map(|caller| json!({
            "userId": caller.user_id,
            "orgId": caller.org_id,
            "role": role_label(caller.role),
            "teamIds": caller.teams.iter().map(|team| team.id.clone()).collect::<Vec<_>>(),
        })),
        "canManageShared": ctx.node.is_some() && ctx.manager,
        "sharedRemote": crate::vault::shared::is_enabled(),
        "sharedError": shared_error,
        "activeEnvironment": crate::vault::active_environment(),
        "seal": ctx.store.keyring.status(),
    }))
}

/// Body of `PUT /api/vault/secrets/{name}`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutSecretBody {
    #[serde(flatten)]
    pub(crate) coords: CoordsBody,
    /// New value. Omit for a metadata-only update; an empty string clears the
    /// value (legacy behavior).
    #[serde(default)]
    pub(crate) value: Option<String>,
    #[serde(default)]
    pub(crate) metadata: Option<Value>,
    #[serde(default)]
    pub(crate) expected_version: Option<i64>,
    /// Metadata check-and-set: the `metadataVersion` the caller last saw.
    #[serde(default)]
    pub(crate) expected_metadata_version: Option<i64>,
}

/// Body of `DELETE /api/vault/secrets/{name}`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSecretBody {
    #[serde(flatten)]
    pub(crate) coords: CoordsBody,
}

/// Refusal for a version or bulk operation on a protected environment by a
/// caller without `admin` there. Change requests cover writes and deletes
/// only, so these operations are reserved to admins rather than bypassing
/// the configured approvals.
pub(crate) fn protected_denied(environment: &str) -> Response {
    json_error(
        StatusCode::FORBIDDEN,
        format!(
            "vault_denied: `{environment}` is a protected environment; this operation needs \
             the `admin` capability (a plain write opens a change request instead)"
        ),
    )
}

pub(crate) async fn protected_environment(
    ctx: &Ctx,
    environment: &str,
) -> Result<Option<u8>, Response> {
    match ctx.store.environment(environment).await {
        Ok(Some(env)) if env.protected => Ok(Some(env.required_approvals.max(1))),
        Ok(_) => Ok(None),
        Err(error) => Err(vault_error(error)),
    }
}

/// PUT /api/vault/secrets/{name} writes a value and/or metadata.
#[utoipa::path(
    put,
    path = "/api/vault/secrets/{name}",
    tag = "Vault",
    summary = "Set a write-only scoped vault secret, its metadata, or both",
    params(("name" = String, Path, description = "Env-compatible secret name")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Stored metadata only", body = serde_json::Value),
        (status = 202, description = "Change request created for a protected environment", body = serde_json::Value),
        (status = 409, description = "expectedVersion or expectedMetadataVersion is stale", body = serde_json::Value),
    )
)]
pub async fn put_secret(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(mut body): Json<Value>,
) -> Response {
    // `customMetadata` keys are user-defined; keep them out of the RFC 3339
    // `…At` conversion.
    let custom_metadata = crate::server::vault_kv_api::take_custom_metadata(&mut body);
    let mut body: PutSecretBody = match parse_body(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    crate::server::vault_kv_api::restore_custom_metadata(&mut body.metadata, custom_metadata);
    if body
        .value
        .as_ref()
        .is_some_and(|value| value.len() > MAX_VAULT_SECRET_VALUE_LEN)
    {
        return invalid_request("value exceeds the maximum allowed size");
    }
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if ctx.shared_remote(body.coords.scope) {
        let mut forwarded = json!({
            "scope": body.coords.scope,
            "scopeId": ctx.shared_scope_id(&body.coords),
            "binding": body.coords.binding,
            "environment": body.coords.environment,
            "path": body.coords.path,
            "value": body.value,
            "metadata": body.metadata,
            "expectedVersion": body.expected_version,
            "expectedMetadataVersion": body.expected_metadata_version,
        });
        if let Some(object) = forwarded.as_object_mut() {
            object.retain(|_, value| !value.is_null());
        }
        // The control-plane contract uses RFC 3339, like this API's own wire.
        let forwarded = rfc3339_fields(forwarded);
        return proxy(
            &ctx,
            reqwest::Method::PUT,
            &format!("/secrets/{}", urlencoding::encode(&name)),
            &[],
            Some(forwarded),
        )
        .await;
    }
    let coords = match coords_for(&ctx, &name, body.coords) {
        Ok(coords) => coords,
        Err(response) => return response,
    };
    let actor = ctx.actor();
    // Legacy clear: an empty value deletes.
    if body.value.as_deref() == Some("") {
        return delete_coords(&ctx, coords, &actor).await;
    }
    if let Err(response) = ctx.require(&coords, Capability::Write) {
        return response;
    }
    if let Err(response) = ctx.require_write_parameters(&coords, body.value.as_deref()) {
        return response;
    }
    let patch_value = body.metadata.clone().unwrap_or_else(|| json!({}));
    let patch: SecretMetadataPatch = match serde_json::from_value(patch_value.clone()) {
        Ok(patch) => patch,
        Err(error) => return invalid_request(&format!("metadata: {error}")),
    };
    match protected_environment(&ctx, &coords.environment).await {
        Ok(Some(required)) if !ctx.caps(&coords).contains(&Capability::Admin) => {
            let authority = ctx.requester_authority(&coords);
            return match ctx
                .store
                .create_change_request_from(
                    // A stale edit is refused now, like a direct write, not
                    // pinned to a version the requester never saw.
                    ChangeBase {
                        version: body.expected_version,
                        metadata_version: body.expected_metadata_version,
                    },
                    coords,
                    ChangeOperation::Write,
                    body.value.as_deref(),
                    patch_value,
                    required,
                    &actor,
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
    match ctx
        .store
        .write_secret_with(
            WriteRequest {
                coords,
                value: body.value.as_deref(),
                patch,
                actor: &actor,
                source: VersionSource::Write,
                expected_version: body.expected_version,
            },
            crate::plugin_secrets::WriteOptions {
                expected_metadata_version: body.expected_metadata_version,
            },
        )
        .await
    {
        Ok(info) => respond(json!({ "ok": true, "secret": to_wire(&ctx, info) })),
        Err(error) => vault_error(error),
    }
}
