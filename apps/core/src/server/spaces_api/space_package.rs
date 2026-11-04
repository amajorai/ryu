//! Spaces and RAG handlers: spaces, documents, files, graphs and embeddings: `import_space_package` through `SetRetrievalModeBody`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// POST /api/spaces/import — import a Markdown-only portable Space package.
#[utoipa::path(
    post,
    path = "/api/spaces/import",
    tag = "Spaces",
    summary = "Import a portable Markdown Space package",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn import_space_package(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<SpacePackageImportBody>,
) -> axum::response::Response {
    use base64::Engine as _;

    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_WRITE,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: space.write".to_owned(),
        );
    }
    if body.archive_base64.trim().is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "archive_base64 is required".to_owned(),
        );
    }
    if body.archive_base64.len() > space_portable::MAX_SPACE_PACKAGE_BODY_BYTES {
        return json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Space package exceeds the archive limit".to_owned(),
        );
    }
    let archive =
        match base64::engine::general_purpose::STANDARD.decode(body.archive_base64.as_bytes()) {
            Ok(bytes) if bytes.len() <= space_portable::MAX_SPACE_PACKAGE_ARCHIVE_BYTES => bytes,
            Ok(_) => {
                return json_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Space package exceeds the archive limit".to_owned(),
                );
            }
            Err(error) => {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    format!("archive_base64 is invalid: {error}"),
                );
            }
        };
    let extracted = match crate::portable_packages::extract_archive(&archive) {
        Ok(package) => package,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error.to_string()),
    };
    let parsed = match space_portable::parse_package(&extracted.manifest, &extracted.files) {
        Ok(package) => package,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error.to_string()),
    };
    match space_portable::import_package(
        &state.spaces,
        &parsed,
        &spaces::owner_of(&caller_tenancy(&caller)),
        body.name.as_deref(),
    )
    .await
    {
        Ok(summary) => Json(json!({ "success": true, "space": summary })).into_response(),
        Err(error) => json_error(StatusCode::UNPROCESSABLE_ENTITY, error.to_string()),
    }
}

/// POST /api/spaces/:id/export — export source Markdown without vector data.
#[utoipa::path(
    post,
    path = "/api/spaces/{id}/export",
    tag = "Spaces",
    summary = "Export a Space as a portable Markdown package",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn export_space_package(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    _body: Option<Json<serde_json::Value>>,
) -> axum::response::Response {
    use base64::Engine as _;

    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_READ,
        crate::acl::KIND_SPACE,
        &id,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: space.read".to_owned(),
        );
    }
    if let Err(response) = require_resource_read(
        spaces::space_access_meta(&state.spaces, &id).await,
        caller.as_ref(),
        "space not found",
    ) {
        return response;
    }
    let filter = caller_doc_filter(&caller);
    let space = match state
        .spaces
        .list_spaces(filter.clone())
        .await
        .ok()
        .and_then(|spaces| spaces.into_iter().find(|space| space.id == id))
    {
        Some(space) => space,
        None => return json_error(StatusCode::NOT_FOUND, "space not found".to_owned()),
    };
    let documents = match state
        .spaces
        .list_document_contents_for_export(&id, filter)
        .await
    {
        Ok(documents) => documents,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let package = match space_portable::export_space(&space, &documents) {
        Ok(package) => package,
        Err(error) => return json_error(StatusCode::UNPROCESSABLE_ENTITY, error.to_string()),
    };
    let filename = format!("{}.ryupack", space_package_filename(&space.name));
    no_store_response(
        Json(json!({
            "success": true,
            "filename": filename,
            "content_type": "application/zip",
            "archive_base64": base64::engine::general_purpose::STANDARD.encode(&package.archive),
            "package": {
                "kind": "space",
                "name": space.name,
                "version": space_portable::SPACE_PACKAGE_VERSION,
                "files": package.file_paths,
                "pages": package.page_count,
                "databases": package.database_count,
                "rows": package.row_count,
                "excluded": package.excluded_count,
                "embeddings": false
            }
        }))
        .into_response(),
    )
}

#[utoipa::path(
    delete,
    path = "/api/spaces/{id}",
    tag = "Spaces",
    summary = "Delete a space",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn delete_space(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    // Per-resource: an overwrite on THIS space can deny `space.delete` to someone
    // whose org role grants it, or grant it to someone whose role does not. The
    // org-wide `enforce_permission` cannot express either, so this supersedes it.
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_DELETE,
        crate::acl::KIND_SPACE,
        &id,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: space.delete".to_owned(),
        );
    }
    // Per-resource ACL: deleting is a write on THIS space (and cascades to every
    // document in it). Without it, any org member holding `space.delete` could
    // delete another member's PRIVATE space. A system space (NULL owner) fails
    // closed on a bound node — it is a node singleton, not user-deletable here.
    if let Err(resp) = require_resource_write(
        spaces::space_access_meta(&state.spaces, &id).await,
        caller.as_ref(),
        "space not found",
    ) {
        return resp;
    }
    match state.spaces.delete_space(&id).await {
        Ok(removed) => Json(json!({ "success": true, "removed": removed })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SetEntityIconBody {
    /// Notion-style glyph JSON from the shared GlyphPicker, or `null` to clear.
    pub(in crate::server) icon: Option<serde_json::Value>,
}

/// `POST /api/spaces/:id/icon` — set or clear a Space's glyph (no document touch).
#[utoipa::path(
    post,
    path = "/api/spaces/{id}/icon",
    tag = "Spaces",
    summary = "Set or clear a space glyph",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_space_icon(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SetEntityIconBody>,
) -> axum::response::Response {
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_WRITE,
        crate::acl::KIND_SPACE,
        &id,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: space.write".to_owned(),
        );
    }
    if let Err(resp) = require_resource_write(
        spaces::space_access_meta(&state.spaces, &id).await,
        caller.as_ref(),
        "space not found",
    ) {
        return resp;
    }
    match state.spaces.set_space_icon(&id, body.icon.as_ref()).await {
        Ok(true) => Json(json!({ "success": true })).into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "space not found".to_owned()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `POST /api/spaces/:id/visibility` — share a Space with the organization or
/// return it to the owner-only private scope. Pages inherit this setting.
#[utoipa::path(
    post,
    path = "/api/spaces/{id}/visibility",
    tag = "Spaces",
    summary = "Set a space's sharing visibility",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_space_visibility(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SetVisibilityBody>,
) -> axum::response::Response {
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_WRITE,
        crate::acl::KIND_SPACE,
        &id,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: space.write".to_owned(),
        );
    }
    if let Err(resp) = require_resource_write(
        spaces::space_access_meta(&state.spaces, &id).await,
        caller.as_ref(),
        "space not found",
    ) {
        return resp;
    }
    let (visibility, team_id) =
        match validate_visibility(body.visibility.as_deref(), body.team_id.as_deref()) {
            Ok(value) => value,
            Err(message) => return json_error(StatusCode::BAD_REQUEST, message),
        };
    match state
        .spaces
        .set_visibility(
            &id,
            visibility,
            team_id,
            visibility_admin_authorized(caller.as_ref()),
        )
        .await
    {
        Ok(true) => Json(json!({
            "ok": true,
            "visibility": visibility,
            "team_id": team_id,
        }))
        .into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "space not found".to_owned()),
        Err(e) => {
            let message = e.to_string();
            let status = if message.contains("system spaces") {
                StatusCode::BAD_REQUEST
            } else if message.contains("only organization admins") {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(status, message)
        }
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SetRetrievalModeBody {
    /// The retrieval algorithm to switch to: `"vector"` or `"graph"`. Required —
    /// this route exists only to change the mode, so an absent field is a 400
    /// rather than a silent no-op success.
    pub(in crate::server) retrieval_mode: Option<String>,
}
