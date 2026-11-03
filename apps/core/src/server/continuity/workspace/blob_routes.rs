//! The content-addressed blob relay routes (`GET`, `HEAD`, `PUT`).

use super::*;

pub(super) fn blob_digest(sha: &str) -> Result<(), Response> {
    if is_sha256(sha) {
        Ok(())
    } else {
        Err(coded_error(
            StatusCode::BAD_REQUEST,
            "invalid-digest",
            "blob digest is invalid",
        ))
    }
}

#[utoipa::path(
    get,
    path = "/api/rnp/v0/workspace-blobs/{sha256}",
    tag = "Conversations",
    summary = "Download a staged handoff blob (exporting caller only)",
    params(("sha256" = String, Path)),
    responses((status = 200, description = "Blob bytes (application/octet-stream)"), (status = 404))
)]
pub(crate) async fn get_blob(
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(sha): Path<String>,
) -> Response {
    if let Err(response) = blob_digest(&sha) {
        return response;
    }
    let roots = match Roots::resolve() {
        Ok(roots) => roots,
        Err(response) => return response,
    };
    read_staged_blob(&roots, &caller, sha).await
}

/// The staged blob `sha` exported by `caller`, as `get_blob` serves it.
pub(super) async fn read_staged_blob(
    roots: &Roots,
    caller: &Option<VerifiedCaller>,
    sha: String,
) -> Response {
    if let Err(response) = blob_digest(&sha) {
        return response;
    }
    let Some(path) = staged_blob(roots, &caller_key(caller), &sha) else {
        return coded_error(
            StatusCode::NOT_FOUND,
            "blob-missing",
            "blob is not staged for this caller",
        );
    };
    match tokio::task::spawn_blocking(move || read_blob(&path, &sha)).await {
        Ok(Ok(bytes)) => {
            ([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response()
        }
        _ => coded_error(
            StatusCode::NOT_FOUND,
            "blob-missing",
            "blob is no longer staged",
        ),
    }
}

#[utoipa::path(
    head,
    path = "/api/rnp/v0/workspace-blobs/{sha256}",
    tag = "Conversations",
    summary = "Check whether a handoff blob is already present",
    params(("sha256" = String, Path)),
    responses((status = 200), (status = 404))
)]
pub(crate) async fn head_blob(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(sha): Path<String>,
) -> Response {
    if let Err(response) = blob_digest(&sha) {
        return response;
    }
    let roots = match Roots::resolve() {
        Ok(roots) => roots,
        Err(response) => return response,
    };
    // HEAD answers for the received store only: the relay asks the destination
    // whether it can skip the PUT, and resume reads only received blobs. A blob
    // this node merely staged for its own export must not count as present.
    // Received blobs are visible to callers who may upload them.
    let present = received_blob_present(&roots, &sha)
        && enforce_permission(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_EDIT,
        )
        .await
        .is_ok();
    if present {
        StatusCode::OK.into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}

#[utoipa::path(
    put,
    path = "/api/rnp/v0/workspace-blobs/{sha256}",
    tag = "Conversations",
    summary = "Upload a content-addressed handoff blob to this node",
    params(("sha256" = String, Path)),
    request_body(
        content = Vec<u8>,
        content_type = "application/octet-stream",
        description = "The raw blob; its sha256 must equal the path digest."
    ),
    responses((status = 200), (status = 201), (status = 413), (status = 422))
)]
pub(crate) async fn put_blob(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(sha): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    .is_err()
    {
        return coded_error(
            StatusCode::FORBIDDEN,
            "forbidden",
            "insufficient permissions: agent.edit",
        );
    }
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream");
    if !content_type.starts_with("application/octet-stream") {
        return coded_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported-media-type",
            "blobs are uploaded as application/octet-stream",
        );
    }
    let roots = match Roots::resolve() {
        Ok(roots) => roots,
        Err(response) => return response,
    };
    let bytes = body.len();
    match tokio::task::spawn_blocking(move || {
        store_blob(&roots, &sha, &body).map(|stored| (sha, stored))
    })
    .await
    {
        Ok(Ok((sha, stored))) => {
            let (status, label) = match stored {
                StoredBlob::Created => (StatusCode::CREATED, "created"),
                StoredBlob::Unchanged => (StatusCode::OK, "unchanged"),
            };
            (
                status,
                Json(json!({ "sha256": sha, "bytes": bytes, "status": label })),
            )
                .into_response()
        }
        Ok(Err(response)) => response,
        Err(_) => coded_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal error",
        ),
    }
}
