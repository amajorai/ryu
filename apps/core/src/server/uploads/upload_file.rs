//! Upload and body-limit policy: `upload_file` through `safe_inline_mime`.
// test-exempt: moved verbatim out of uploads.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use crate::server::uploads::*;

/// `POST /api/uploads` — store raw request-body bytes as a file document in the
/// Uploads system space. Filename from `x-filename` / `?name=`; content-type from
/// the `content-type` header. Returns id + serve URL (`/api/uploads/<id>`).
#[utoipa::path(
    post,
    path = "/api/uploads",
    tag = "Uploads",
    summary = "Store a user file in the Uploads system space",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn upload_file(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if body.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "empty upload" })),
        )
            .into_response();
    }
    // Reachable only for a body between the layer's ceiling and this one — which for
    // a raw route is nothing, since they are the same number. Kept because the two
    // ceilings are separate fields that a future encoding change could separate, and
    // a handler that trusts its layer is a handler that stops checking.
    if body.len() > MAX_UPLOAD_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({
                "error": UPLOADS_BODY_LIMIT.too_large_message(Observed::BodyBytes(body.len()))
            })),
        )
            .into_response();
    }

    let name = headers
        .get("x-filename")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| params.get("name").cloned())
        .unwrap_or_else(|| "upload".to_string());
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|c| c.split(';').next().unwrap_or(c).trim().to_owned())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "application/octet-stream".to_owned());

    let space_id = match state
        .spaces
        .ensure_system_space(
            UPLOADS_SPACE_NAME,
            Some("Files you upload in chat and pages"),
        )
        .await
    {
        Ok(id) => id,
        Err(e) => {
            tracing::error!("upload_file: ensuring Uploads space: {e:#}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "failed to resolve Uploads space" })),
            )
                .into_response();
        }
    };

    let title = if name.trim().is_empty() {
        "Untitled"
    } else {
        name.trim()
    };
    let tenancy = spaces::owner_of(&caller_tenancy(&caller));
    // Through the shared ingest path, NOT `store.create_file` directly: that one
    // indexes a file by its `{title}\n{mime}` descriptor only, so a PDF dropped in
    // chat was searchable by its filename and by nothing inside it. `index` reports
    // what happened to the contents — never an error, since a file the parser cannot
    // read is still a file the user wanted stored. See [`crate::space_file_index`].
    match crate::space_file_index::create_file_indexed(
        &state, &space_id, title, &body, &mime, &tenancy,
    )
    .await
    {
        Ok(created) => (
            StatusCode::OK,
            Json(json!({
                "id": created.document_id,
                "space_id": space_id,
                "file_name": title,
                "url": format!("/api/uploads/{}", created.document_id),
                "size": body.len(),
                "content_type": mime,
                "index": created.index.to_json(),
            })),
        )
            .into_response(),
        Err(e) => {
            let message = e.to_string();
            let status = if message.contains("file quota exceeded") {
                StatusCode::PAYLOAD_TOO_LARGE
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            tracing::error!("upload_file: create_file: {e:#}");
            (status, Json(json!({ "error": message }))).into_response()
        }
    }
}

/// `GET /api/uploads/:id` — serve a file that lives in the Uploads system space.
/// Images render inline (editor `<img>`); risky MIME types are neutralized.
#[utoipa::path(
    get,
    path = "/api/uploads/{id}",
    tag = "Uploads",
    summary = "Serve a user upload from the Uploads system space",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK"))
)]
pub async fn serve_upload(
    State(state): State<ServerState>,
    Path(doc_id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    // Uploads are Spaces content, so the coarse Spaces read permission is required
    // before any metadata or blob lookup. The per-document check below is still
    // necessary because a node member may be allowed to use Spaces without being
    // allowed to read this particular private upload.
    if crate::server::enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_READ,
    )
    .await
    .is_err()
    {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }

    let Some(meta) = (match state.spaces.get_file_meta(&doc_id).await {
        Ok(m) => m,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    }) else {
        return (StatusCode::NOT_FOUND, "upload not found").into_response();
    };

    // Only documents in the Uploads system space are reachable here.
    let uploads_id = match state
        .spaces
        .ensure_system_space(UPLOADS_SPACE_NAME, None)
        .await
    {
        Ok(id) => id,
        Err(e) => {
            tracing::error!("serve_upload: ensuring Uploads space: {e:#}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response();
        }
    };
    if meta.space_id != uploads_id {
        return (StatusCode::NOT_FOUND, "upload not found").into_response();
    }

    if let Err(response) = crate::server::require_resource_read(
        spaces::doc_access_meta(&state.spaces, &doc_id).await,
        caller.as_ref(),
        "upload not found",
    ) {
        return response;
    }

    let Some((mime, bytes)) = (match state.spaces.read_file_blob(&doc_id).await {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    }) else {
        return (StatusCode::NOT_FOUND, "upload not found").into_response();
    };

    let content_type = safe_inline_mime(&mime);
    let is_image = content_type.starts_with("image/");
    if is_image {
        (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, content_type),
                (
                    header::CACHE_CONTROL,
                    "private, max-age=31536000, immutable".to_owned(),
                ),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
            ],
            bytes,
        )
            .into_response()
    } else {
        (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, content_type),
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
}

/// Collapse script-capable MIME types; leave images/PDF/plain data alone so the
/// editor can render uploads inline.
pub(in crate::server::uploads) fn safe_inline_mime(mime: &str) -> String {
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
