//! Environments, folders, and folder imports.

use super::*;

/// GET /api/vault/environments.
#[utoipa::path(get, path = "/api/vault/environments", tag = "Vault",
    summary = "List environments",
    responses((status = 200, description = "Environments", body = serde_json::Value)))]
pub async fn list_environments(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    match ctx.store.list_environments().await {
        Ok(environments) => respond(json!({
            "environments": environments,
            "active": crate::vault::active_environment(),
        })),
        Err(error) => vault_error(error),
    }
}

/// PUT /api/vault/environments/{slug} creates or updates an environment.
#[utoipa::path(put, path = "/api/vault/environments/{slug}", tag = "Vault",
    summary = "Create or update an environment (admin)",
    params(("slug" = String, Path, description = "Environment slug")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Saved", body = serde_json::Value)))]
pub async fn put_environment(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Json(mut body): Json<Value>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys(&format!("sys/environments/{slug}"), Capability::Admin) {
        return response;
    }
    if let Some(object) = body.as_object_mut() {
        object.insert("slug".into(), json!(slug));
        object.entry("name").or_insert_with(|| json!(slug));
    }
    let environment: Environment = match parse_body(body) {
        Ok(environment) => environment,
        Err(response) => return response,
    };
    match ctx.store.put_environment(&environment, &ctx.actor()).await {
        Ok(()) => respond(json!({ "ok": true, "environment": environment })),
        Err(error) => vault_error(error),
    }
}

/// DELETE /api/vault/environments/{slug} removes an empty environment.
#[utoipa::path(delete, path = "/api/vault/environments/{slug}", tag = "Vault",
    summary = "Delete an empty environment (admin)",
    params(("slug" = String, Path, description = "Environment slug")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn delete_environment(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys(&format!("sys/environments/{slug}"), Capability::Admin) {
        return response;
    }
    match ctx.store.delete_environment(&slug, &ctx.actor()).await {
        Ok(deleted) => respond(json!({ "ok": true, "deleted": deleted })),
        Err(error) => vault_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderQuery {
    pub(crate) environment: String,
    #[serde(default)]
    pub(crate) path: Option<String>,
}

/// GET /api/vault/folders?environment=.
#[utoipa::path(get, path = "/api/vault/folders", tag = "Vault",
    summary = "List folders in an environment",
    params(("environment" = String, Query, description = "Environment slug")),
    responses((status = 200, description = "Folder paths", body = serde_json::Value)))]
pub async fn list_folders(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<FolderQuery>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    match ctx.store.list_folders(&query.environment).await {
        Ok(folders) => respond(json!({ "folders": folders })),
        Err(error) => vault_error(error),
    }
}

/// Validate a folder target and build its policy key from the canonical path,
/// so `a/b`, `/a/b/`, and `/a/b` all evaluate as `sys/folders/<env>/a/b` (the
/// root folder is `sys/folders/<env>`, like secret keys omit the root slash).
/// Returns `(normalized_path, policy_key)`.
pub(super) fn folder_policy_key(
    environment: &str,
    path: &str,
) -> Result<(String, String), Response> {
    if !crate::vault::is_valid_environment(environment) {
        return Err(invalid_request("invalid environment"));
    }
    let path =
        crate::vault::normalize_path(path).ok_or_else(|| invalid_request("invalid folder path"))?;
    let key = if path == ROOT_PATH {
        format!("sys/folders/{environment}")
    } else {
        format!("sys/folders/{environment}{path}")
    };
    Ok((path, key))
}

/// POST /api/vault/folders creates a folder; DELETE removes an empty one.
#[utoipa::path(post, path = "/api/vault/folders", tag = "Vault",
    summary = "Create a folder",
    request_body = serde_json::Value,
    responses((status = 200, description = "Created", body = serde_json::Value)))]
pub async fn create_folder(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<FolderQuery>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let (path, key) =
        match folder_policy_key(&body.environment, body.path.as_deref().unwrap_or_default()) {
            Ok(target) => target,
            Err(response) => return response,
        };
    // Creating a folder is a write in the environment, not an admin action.
    // Managers (and the unbound local operator) hold every capability as the
    // `sys_caps` baseline, so a deny bound to them still applies.
    if let Err(response) = ctx.require_sys(&key, Capability::Write) {
        return response;
    }
    match ctx.store.create_folder(&body.environment, &path).await {
        Ok(path) => respond(json!({ "ok": true, "path": path })),
        Err(error) => vault_error(error),
    }
}

/// DELETE /api/vault/folders?environment=&path=.
#[utoipa::path(delete, path = "/api/vault/folders", tag = "Vault",
    summary = "Delete an empty folder",
    params(
        ("environment" = String, Query, description = "Environment slug"),
        ("path" = String, Query, description = "Folder path"),
    ),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn delete_folder(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<FolderQuery>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let (path, key) = match folder_policy_key(
        &query.environment,
        query.path.as_deref().unwrap_or_default(),
    ) {
        Ok(target) => target,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys(&key, Capability::Admin) {
        return response;
    }
    match ctx.store.delete_folder(&query.environment, &path).await {
        Ok(deleted) => respond(json!({ "ok": true, "deleted": deleted })),
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/imports.
#[utoipa::path(get, path = "/api/vault/imports", tag = "Vault",
    summary = "List folder imports",
    responses((status = 200, description = "Imports", body = serde_json::Value)))]
pub async fn list_imports(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    match ctx.store.list_imports().await {
        Ok(imports) => respond(json!({ "imports": imports })),
        Err(error) => vault_error(error),
    }
}

/// POST /api/vault/imports adds a folder import.
#[utoipa::path(post, path = "/api/vault/imports", tag = "Vault",
    summary = "Import another folder as a fallback (admin)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Created", body = serde_json::Value)))]
pub async fn add_import(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(import): Json<FolderImport>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys("sys/imports", Capability::Admin) {
        return response;
    }
    match ctx.store.add_import(&import, &ctx.actor()).await {
        Ok(import) => respond(json!({ "ok": true, "import": import })),
        Err(error) => vault_error(error),
    }
}

/// DELETE /api/vault/imports/{id}.
#[utoipa::path(delete, path = "/api/vault/imports/{id}", tag = "Vault",
    summary = "Remove a folder import (admin)",
    params(("id" = String, Path, description = "Import id")),
    responses((status = 200, description = "Removed", body = serde_json::Value)))]
pub async fn remove_import(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require_sys("sys/imports", Capability::Admin) {
        return response;
    }
    match ctx.store.remove_import(&id, &ctx.actor()).await {
        Ok(removed) => respond(json!({ "ok": true, "removed": removed })),
        Err(error) => vault_error(error),
    }
}
