//! Spaces and RAG handlers: spaces, documents, files, graphs and embeddings: `set_document_icon` through `RestoreDocumentVersionBody`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/spaces/:id/documents/:doc_id/icon` — set/clear glyph without re-embed.
#[utoipa::path(
    post,
    path = "/api/spaces/{id}/documents/{doc_id}/icon",
    tag = "Spaces",
    summary = "Set or clear a document glyph",
    params(("id" = String, Path), ("doc_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_document_icon(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    // `_url_space_id` is deliberately unused: it is caller-supplied and the gate
    // below resolves the document's REAL parent instead.
    axum::extract::Path((_url_space_id, doc_id)): axum::extract::Path<(String, String)>,
    Json(body): Json<SetEntityIconBody>,
) -> axum::response::Response {
    // Resolve the TRUE parent space; the URL id is caller-supplied.
    let Some(owning_space) = document_parent_space(&state, &doc_id).await else {
        return json_error(StatusCode::NOT_FOUND, "document not found".to_owned());
    };
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_WRITE,
        crate::acl::KIND_SPACE,
        &owning_space,
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
        spaces::doc_access_meta(&state.spaces, &doc_id).await,
        caller.as_ref(),
        "document not found",
    ) {
        return resp;
    }
    match state
        .spaces
        .set_document_icon(&doc_id, body.icon.as_ref())
        .await
    {
        Ok(true) => Json(json!({ "success": true })).into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "document not found".to_owned()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `DELETE /api/spaces/:id/documents/:doc_id` — delete a single document.
#[utoipa::path(
    delete,
    path = "/api/spaces/{id}/documents/{doc_id}",
    tag = "Spaces",
    summary = "Delete a document",
    params(("id" = String, Path), ("doc_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn delete_document(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    // `_url_space_id` is deliberately unused: it is caller-supplied and the gate
    // below resolves the document's REAL parent instead.
    axum::extract::Path((_url_space_id, doc_id)): axum::extract::Path<(String, String)>,
) -> axum::response::Response {
    // Resolve the TRUE parent space; the URL id is caller-supplied.
    let Some(owning_space) = document_parent_space(&state, &doc_id).await else {
        return json_error(StatusCode::NOT_FOUND, "document not found".to_owned());
    };
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_DELETE,
        crate::acl::KIND_SPACE,
        &owning_space,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: space.delete".to_owned(),
        );
    }
    // Per-resource ACL: deleting is a write on THIS document.
    if let Err(resp) = require_resource_write(
        spaces::doc_access_meta(&state.spaces, &doc_id).await,
        caller.as_ref(),
        "document not found",
    ) {
        return resp;
    }
    let deleted = state.spaces.delete_document(&doc_id).await;
    crate::server::realtime_ws::notify_access_changed();
    match deleted {
        Ok(removed) => {
            // The content-index status lives Core-side (see
            // [`crate::space_file_index::FileIndexStore`]) and `delete_document` is in
            // the spaces crate, which cannot call back into Core. Clearing it here
            // covers the user-facing delete; best-effort, because a stranded status
            // row must never fail a delete that already succeeded.
            if removed {
                crate::space_file_index::forget(&doc_id).await;
            }
            Json(json!({ "success": true, "removed": removed })).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `GET /api/spaces/:id/documents/:doc_id/index` — did this file's CONTENTS get
/// indexed, and if not, why?
///
/// The client-visible half of the failure posture in [`crate::space_file_index`].
/// A file whose text could not be extracted is still stored and still findable by
/// its filename; without this route that degradation is invisible, and a user who
/// believes their PDF is searchable when it is not is exactly the defect this
/// program exists to remove. Gated on `space.read` + the per-document ACL, like
/// every other read of a document's substance.
///
/// `state` is one of `pending` / `indexed` / `skipped` / `failed`, plus
/// `unattempted` for a document stored before extraction existed — deliberately
/// distinct from `skipped`: nobody looked, as opposed to nobody could read it.
#[utoipa::path(
    get,
    path = "/api/spaces/{id}/documents/{doc_id}/index",
    tag = "Spaces",
    summary = "Content-extraction status for a file document",
    params(("id" = String, Path), ("doc_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_document_index_status(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    // `_url_space_id` is deliberately unused: it is caller-supplied and the gate
    // below resolves the document's REAL parent instead.
    axum::extract::Path((_url_space_id, doc_id)): axum::extract::Path<(String, String)>,
) -> axum::response::Response {
    // Resolve the TRUE parent space; the URL id is caller-supplied.
    let Some(owning_space) = document_parent_space(&state, &doc_id).await else {
        return json_error(StatusCode::NOT_FOUND, "document not found".to_owned());
    };
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_READ,
        crate::acl::KIND_SPACE,
        &owning_space,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: space.read".to_owned(),
        );
    }
    if let Err(resp) = require_resource_read(
        spaces::doc_access_meta(&state.spaces, &doc_id).await,
        caller.as_ref(),
        "document not found",
    ) {
        return resp;
    }
    Json(crate::space_file_index::status_json(&doc_id).await).into_response()
}

/// `GET /api/spaces/:id/documents/:doc_id/versions` — list saved versions
/// (newest first, metadata only).
#[utoipa::path(
    get,
    path = "/api/spaces/{id}/documents/{doc_id}/versions",
    tag = "Spaces",
    summary = "List document versions",
    params(("id" = String, Path), ("doc_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_document_versions(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path((_id, doc_id)): axum::extract::Path<(String, String)>,
) -> axum::response::Response {
    // A version list is document content (titles + timestamps of past states), so
    // it is gated exactly like reading the document.
    if let Err(resp) = require_resource_read(
        spaces::doc_access_meta(&state.spaces, &doc_id).await,
        caller.as_ref(),
        "document not found",
    ) {
        return resp;
    }
    match state.spaces.list_document_versions(&doc_id).await {
        Ok(versions) => Json(versions).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct CreateDocumentVersionBody {
    #[serde(default)]
    pub(in crate::server) label: Option<String>,
}

/// `POST /api/spaces/:id/documents/:doc_id/versions` — checkpoint the document's
/// current source in the local Git history. An explicit label is retained as a
/// named checkpoint even when the bytes are unchanged.
#[utoipa::path(
    post,
    path = "/api/spaces/{id}/documents/{doc_id}/versions",
    tag = "Spaces",
    summary = "Snapshot a document version",
    params(("id" = String, Path), ("doc_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn create_document_version(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path((_id, doc_id)): axum::extract::Path<(String, String)>,
    body: Option<Json<CreateDocumentVersionBody>>,
) -> axum::response::Response {
    // Snapshotting appends a row to the document's history — a write.
    if let Err(resp) = require_resource_write(
        spaces::doc_access_meta(&state.spaces, &doc_id).await,
        caller.as_ref(),
        "document not found",
    ) {
        return resp;
    }
    let label = body
        .and_then(|Json(b)| b.label)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    match state
        .spaces
        .snapshot_document_as(
            &doc_id,
            label.as_deref(),
            caller.as_ref().map(|value| value.user_id.as_str()),
        )
        .await
    {
        Ok(meta) => Json(meta).into_response(),
        Err(e) => {
            let msg = e.to_string();
            let status = if msg.contains("not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(status, msg)
        }
    }
}

/// `GET /api/spaces/:id/documents/:doc_id/versions/:version_id` — fetch one
/// version in full (including its captured source).
#[utoipa::path(
    get,
    path = "/api/spaces/{id}/documents/{doc_id}/versions/{version_id}",
    tag = "Spaces",
    summary = "Get a document version",
    params(
        ("id" = String, Path),
        ("doc_id" = String, Path),
        ("version_id" = String, Path)
    ),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_document_version(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path((_id, doc_id, version_id)): axum::extract::Path<(String, String, String)>,
) -> axum::response::Response {
    // A version carries the document's FULL source at snapshot time, so it is
    // gated exactly like reading the document.
    if let Err(resp) = require_resource_read(
        spaces::doc_access_meta(&state.spaces, &doc_id).await,
        caller.as_ref(),
        "document not found",
    ) {
        return resp;
    }
    let version = match state.spaces.get_document_version(&version_id).await {
        Ok(Some(version)) => Ok(Some(version)),
        Ok(None) => {
            state
                .spaces
                .get_source_history_version(&doc_id, &version_id)
                .await
        }
        Err(error) => Err(error),
    };
    match version {
        // The version is looked up by its own id, so the ACL above (keyed on the
        // PATH doc_id) would be a confused deputy if the two disagreed: a caller
        // could name a document they own plus a version id belonging to someone
        // else's document. Serve a version only when it really belongs to the
        // document that was authorized. `restore_document_version` already made
        // this check; it is required here for the same reason.
        Ok(Some(ver)) if ver.document_id == doc_id => Json(ver).into_response(),
        Ok(_) => json_error(StatusCode::NOT_FOUND, "version not found".to_owned()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(in crate::server) struct RestoreDocumentVersionBody {
    pub(in crate::server) expected_revision: i64,
    pub(in crate::server) operation_id: String,
}
