//! Spaces and RAG handlers: spaces, documents, files, graphs and embeddings: `query_space_database` through `replace_file_blob`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/spaces/:id/databases/:doc_id/query` — run bounded read-only SQL.
#[utoipa::path(
    post,
    path = "/api/spaces/{id}/databases/{doc_id}/query",
    tag = "Spaces",
    summary = "Query a Space database",
    description = "Runs one read-only SELECT or WITH query against the `data` table. Column names are normalized from database property labels. Query text is limited to 8,000 bytes, parameters to 64 values, execution to 500 ms, and the response to 500 rows or 1 MiB. Use bound `?` parameters for values.",
    params(("id" = String, Path), ("doc_id" = String, Path)),
    request_body = spaces::QueryDatabaseBody,
    responses((status = 200, description = "Query result", body = serde_json::Value))
)]
pub(in crate::server) async fn query_space_database(
    state: State<ServerState>,
    caller: Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((space_id, document_id)): Path<(String, String)>,
    Json(body): Json<spaces::QueryDatabaseBody>,
) -> axum::response::Response {
    spaces::query_database(state, caller, Path((space_id, document_id)), Json(body)).await
}

/// `POST /api/spaces/:id/whiteboards` — create an empty whiteboard (Excalidraw) doc.
/// Same lifecycle as a page; the editor saves its scene JSON via `update_document`.
#[utoipa::path(
    post,
    path = "/api/spaces/{id}/whiteboards",
    tag = "Spaces",
    summary = "Create a whiteboard document",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn create_whiteboard(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<CreatePageBody>,
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
    let title = if body.title.trim().is_empty() {
        "Untitled"
    } else {
        body.title.trim()
    };
    match state
        .spaces
        .create_whiteboard(&id, title, &spaces::owner_of(&caller_tenancy(&caller)))
        .await
    {
        Ok(document_id) => Json(json!({ "id": document_id })).into_response(),
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

/// Max decoded size for a single uploaded file artifact. Bounds memory on the create
/// path; larger assets should stream via a future chunked upload.
///
/// **Defined as [`uploads::MAX_UPLOAD_BYTES`] (32 MiB), not as a number of its own.**
/// It used to read `200 * 1024 * 1024`, and that figure was wrong twice: the route is
/// reached through a base64 JSON body, so the ceiling a client could actually hit was
/// ~1.5 MiB (axum's implicit 2 MiB body limit, no explicit layer, minus the 4/3
/// expansion) — and 200 MiB was nonetheless what the desktop settings panel printed as
/// "Maximum file in a Space". See [`uploads::SPACE_FILE_BODY_LIMIT`] for the alignment
/// and why the fix went down to 32 MiB rather than up to 200.
pub(in crate::server) const MAX_FILE_BYTES: usize = uploads::MAX_UPLOAD_BYTES;

#[derive(serde::Deserialize)]
pub(in crate::server) struct CreateFileBody {
    pub(in crate::server) title: String,
    /// MIME type of the file (e.g. `application/pdf`, `image/png`).
    #[serde(default)]
    pub(in crate::server) mime: Option<String>,
    /// Standard base64-encoded file bytes.
    pub(in crate::server) data_base64: String,
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct ReplaceFileBody {
    /// MIME type of the replacement file. Omitted values retain the stored MIME.
    #[serde(default)]
    pub(in crate::server) mime: Option<String>,
    /// Standard base64-encoded file bytes.
    pub(in crate::server) data_base64: String,
}

pub(in crate::server) fn decode_space_file_body(
    data_base64: &str,
) -> Result<Vec<u8>, axum::response::Response> {
    use base64::Engine as _;
    if uploads::decoded_len_lower_bound(data_base64.len()) > MAX_FILE_BYTES {
        return Err(json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            uploads::SPACE_FILE_BODY_LIMIT
                .too_large_message(uploads::Observed::BodyBytes(data_base64.len())),
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| json_error(StatusCode::BAD_REQUEST, format!("invalid base64: {e}")))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            uploads::SPACE_FILE_BODY_LIMIT
                .too_large_message(uploads::Observed::FileBytes(bytes.len())),
        ));
    }
    Ok(bytes)
}

/// `POST /api/spaces/:id/files` — store a binary file as a first-class Space
/// document (`kind = 'file'`). The bytes go to the content-addressed blob store;
/// the row carries the mime + sha + size. This is the substrate the
/// `create_artifact` tool and chat auto-filing of generated pptx/xlsx/csv/pdf/png
/// build on. Writing requires `space.write` (org/team RBAC) — the same governed
/// gate every external-agent write flows through.
#[utoipa::path(
    post,
    path = "/api/spaces/{id}/files",
    tag = "Spaces",
    summary = "Store a binary file document",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn create_file(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<CreateFileBody>,
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
    if let Err(resp) = require_space_content_write(&state, &caller, &id, "space not found").await {
        return resp;
    }
    let title = if body.title.trim().is_empty() {
        "Untitled"
    } else {
        body.title.trim()
    };
    let mime = body
        .mime
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or("application/octet-stream");
    // Refuse from the ENCODED length first, so an oversize upload is rejected without
    // ever allocating the decode buffer it was trying to make us allocate. The LOWER
    // bound is the right one to test: it cannot refuse a file that would have fit (see
    // `decoded_len_lower_bound` — the upper bound rejects a file of exactly the limit),
    // and the exact check below still enforces the boundary.
    let bytes = match decode_space_file_body(&body.data_base64) {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };
    // Shared ingest path (see [`crate::space_file_index`]): the bytes are stored AND
    // their text is extracted through the `document.parse` facade, so the document is
    // retrievable by its contents rather than only by its filename. Extraction can
    // never fail this call — `index` carries what happened to it.
    match crate::space_file_index::create_file_indexed(
        &state,
        &id,
        title,
        &bytes,
        mime,
        &spaces::owner_of(&caller_tenancy(&caller)),
    )
    .await
    {
        Ok(created) => Json(json!({
            "id": created.document_id,
            "mime": mime,
            "byte_size": bytes.len(),
            "index": created.index.to_json(),
        }))
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

/// `PUT /api/spaces/:id/documents/:doc_id/blob` — replace the bytes of an
/// existing file document and re-index the saved revision. The document's real
/// parent Space and its own ACL are authoritative; the URL Space id is never used
/// to grant access.
#[utoipa::path(
    put,
    path = "/api/spaces/{id}/documents/{doc_id}/blob",
    tag = "Spaces",
    summary = "Replace a file document's bytes",
    params(("id" = String, Path), ("doc_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn replace_file_blob(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path((_url_space_id, doc_id)): axum::extract::Path<(String, String)>,
    Json(body): Json<ReplaceFileBody>,
) -> axum::response::Response {
    let Some(owning_space) = document_parent_space(&state, &doc_id).await else {
        return json_error(StatusCode::NOT_FOUND, "file not found".to_owned());
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
    if let Err(response) = require_resource_write(
        spaces::doc_access_meta(&state.spaces, &doc_id).await,
        caller.as_ref(),
        "file not found",
    ) {
        return response;
    }
    let current = match state.spaces.get_file_meta(&doc_id).await {
        Ok(Some(meta)) => meta,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "file not found".to_owned()),
        Err(error) => {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    let mime = body
        .mime
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&current.mime);
    let bytes = match decode_space_file_body(&body.data_base64) {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };
    match crate::space_file_index::replace_file_indexed(&state, &doc_id, &bytes, mime).await {
        Ok(updated) => Json(json!({
            "id": updated.document_id,
            "mime": mime,
            "byte_size": bytes.len(),
            "index": updated.index.to_json(),
        }))
        .into_response(),
        Err(error) => {
            let message = error.to_string();
            let status = if message.contains("not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(status, message)
        }
    }
}
