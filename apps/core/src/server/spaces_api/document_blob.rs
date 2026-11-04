//! Spaces and RAG handlers: spaces, documents, files, graphs and embeddings: `get_file_blob` through `set_document_access`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `GET /api/spaces/:id/documents/:doc_id/blob` — stream a file document's bytes
/// with its stored MIME type. Reading requires `space.read`.
#[utoipa::path(
    get,
    path = "/api/spaces/{id}/documents/{doc_id}/blob",
    tag = "Spaces",
    summary = "Download a file document's bytes",
    params(("id" = String, Path), ("doc_id" = String, Path)),
    responses((status = 200, description = "OK"))
)]
pub(in crate::server) async fn get_file_blob(
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
    // Per-resource ACL: a file document's BYTES are its content — gate on the row,
    // not just on the coarse `space.read` permission.
    if let Err(resp) = require_resource_read(
        spaces::doc_access_meta(&state.spaces, &doc_id).await,
        caller.as_ref(),
        "file not found",
    ) {
        return resp;
    }
    match state.spaces.read_file_blob(&doc_id).await {
        Ok(Some((mime, bytes))) => {
            use axum::http::header;
            // Stored-XSS defense: a blob's stored Content-Type is caller-controlled,
            // so an uploaded `text/html` / `image/svg+xml` would otherwise render
            // in-origin. Force safe delivery — normalize risky renderable MIME types
            // to octet-stream, force download (`Content-Disposition: attachment`),
            // forbid MIME sniffing, and sandbox via CSP so even a mis-typed blob
            // cannot execute script in the app origin.
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, normalize_blob_mime(&mime)),
                    (header::CONTENT_DISPOSITION, "attachment".to_owned()),
                    (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
                    (
                        header::CONTENT_SECURITY_POLICY,
                        "sandbox; default-src 'none'".to_owned(),
                    ),
                ],
                bytes,
            )
                .into_response()
        }
        Ok(None) => json_error(StatusCode::NOT_FOUND, "file not found".to_owned()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// Normalize a stored blob's caller-controlled MIME type for safe HTTP delivery.
///
/// Renderable, script-capable types (HTML, XHTML, SVG, any `*+xml`, bare XML) and
/// an empty/absent type are collapsed to `application/octet-stream` so the browser
/// never parses them as active content in the app origin. Everything else (images,
/// audio, PDF, plain data) passes through unchanged — the `Content-Disposition:
/// attachment` + `nosniff` + CSP `sandbox` headers on the response are the primary
/// guarantee; this normalization is defense in depth.
pub(in crate::server) fn normalize_blob_mime(mime: &str) -> String {
    let base = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let risky = matches!(
        base.as_str(),
        "text/html" | "application/xhtml+xml" | "image/svg+xml" | "application/xml" | "text/xml"
    ) || base.ends_with("+xml")
        || base.is_empty();
    if risky {
        "application/octet-stream".to_owned()
    } else {
        mime.to_owned()
    }
}

/// `GET /api/spaces/:id/documents/:doc_id` — fetch a document's markdown source.
#[utoipa::path(
    get,
    path = "/api/spaces/{id}/documents/{doc_id}",
    tag = "Spaces",
    summary = "Get a document",
    params(("id" = String, Path), ("doc_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_document(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    // `_url_space_id` is deliberately unused: it is caller-supplied and the gate
    // below resolves the document's REAL parent instead.
    axum::extract::Path((_url_space_id, doc_id)): axum::extract::Path<(String, String)>,
) -> axum::response::Response {
    // Org/team RBAC (coarse): reading a document requires `space.read`.
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
    // Per-resource ACL (fine): `space.read` says the caller may read documents at
    // all; this says they may read THIS one. Without it, any org member holding
    // `space.read` could read another member's PRIVATE document.
    if let Err(resp) = require_resource_read(
        spaces::doc_access_meta(&state.spaces, &doc_id).await,
        caller.as_ref(),
        "document not found",
    ) {
        return resp;
    }
    match state.spaces.get_document(&doc_id).await {
        Ok(Some(doc)) => Json(doc).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "document not found".to_owned()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct UpdateDocumentBody {
    pub(in crate::server) title: String,
    pub(in crate::server) source: String,
    #[serde(default)]
    pub(in crate::server) expected_revision: Option<i64>,
    #[serde(default)]
    pub(in crate::server) operation_id: Option<String>,
}

/// `PUT /api/spaces/:id/documents/:doc_id` — save edits (re-embeds on save).
#[utoipa::path(
    put,
    path = "/api/spaces/{id}/documents/{doc_id}",
    tag = "Spaces",
    summary = "Update a document",
    params(("id" = String, Path), ("doc_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn update_document(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    // `_url_space_id` is deliberately unused: it is caller-supplied and the gate
    // below resolves the document's REAL parent instead.
    axum::extract::Path((_url_space_id, doc_id)): axum::extract::Path<(String, String)>,
    Json(body): Json<UpdateDocumentBody>,
) -> axum::response::Response {
    if body
        .operation_id
        .as_deref()
        .is_some_and(|operation_id| operation_id.is_empty() || operation_id.len() > 128)
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "operation_id must contain between 1 and 128 bytes".to_owned(),
        );
    }
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
    // Per-resource ACL: a write needs `Access::Write` on THIS document, so an org
    // Viewer (read-only) and a non-owner on a private doc are both refused.
    if let Err(resp) = require_resource_write(
        spaces::doc_access_meta(&state.spaces, &doc_id).await,
        caller.as_ref(),
        "document not found",
    ) {
        return resp;
    }
    match state
        .spaces
        .update_document_versioned(
            &doc_id,
            body.title.trim(),
            &body.source,
            body.expected_revision,
            body.operation_id.as_deref(),
            caller.as_ref().map(|value| value.user_id.as_str()),
        )
        .await
    {
        Ok(spaces::DocumentUpdateOutcome::Applied(result)) => {
            Json(json!({ "success": true, "result": result })).into_response()
        }
        Ok(spaces::DocumentUpdateOutcome::Conflict { current_revision }) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "document revision conflict",
                "current_revision": current_revision,
            })),
        )
            .into_response(),
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

#[derive(serde::Deserialize)]
pub(in crate::server) struct SetDocumentAccessBody {
    /// `private`, `org`, or `team`.
    pub(in crate::server) visibility: String,
    /// Required when `visibility` is `team`; cleared for the other modes.
    #[serde(default)]
    pub(in crate::server) team_id: Option<String>,
}

/// `PUT /api/spaces/:id/documents/:doc_id/access` — change native document
/// visibility. This is separate from generic ACL overwrites: it controls the
/// document's owner/org/team tenancy row and therefore also drives list/search
/// filtering.
#[utoipa::path(
    put,
    path = "/api/spaces/{id}/documents/{doc_id}/access",
    tag = "Spaces",
    summary = "Set document visibility",
    params(("id" = String, Path), ("doc_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_document_access(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path((_url_space_id, doc_id)): axum::extract::Path<(String, String)>,
    Json(body): Json<SetDocumentAccessBody>,
) -> axum::response::Response {
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

    let visibility = body.visibility.trim().to_ascii_lowercase();
    if !matches!(visibility.as_str(), "private" | "org" | "team") {
        return json_error(
            StatusCode::BAD_REQUEST,
            "visibility must be \"private\", \"org\", or \"team\"".to_owned(),
        );
    }
    let team_id = body
        .team_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    if visibility == "team" && team_id.is_none() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "team visibility requires team_id".to_owned(),
        );
    }
    match state
        .spaces
        .set_document_access(&doc_id, &visibility, team_id)
        .await
    {
        Ok(true) => Json(json!({
            "success": true,
            "visibility": visibility,
            "team_id": team_id,
        }))
        .into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "document not found".to_owned()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
