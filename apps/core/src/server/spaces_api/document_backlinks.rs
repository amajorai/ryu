//! Spaces and RAG handlers: spaces, documents, files, graphs and embeddings: `restore_document_version` through `EmbedTextsItem`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/spaces/:id/documents/:doc_id/versions/:version_id/restore` —
/// restore a version as the document's current content. The current content is
/// checkpointed first as a named undo point, so a restore is itself undoable.
#[utoipa::path(
    post,
    path = "/api/spaces/{id}/documents/{doc_id}/versions/{version_id}/restore",
    tag = "Spaces",
    summary = "Restore a document version",
    params(
        ("id" = String, Path),
        ("doc_id" = String, Path),
        ("version_id" = String, Path)
    ),
    request_body = RestoreDocumentVersionBody,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn restore_document_version(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path((_id, doc_id, version_id)): axum::extract::Path<(String, String, String)>,
    Json(body): Json<RestoreDocumentVersionBody>,
) -> axum::response::Response {
    if body.operation_id.is_empty() || body.operation_id.len() > 128 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "operation_id must contain between 1 and 128 bytes".to_owned(),
        );
    }
    // Restoring overwrites the document's current content — a write.
    if let Err(resp) = require_resource_write(
        spaces::doc_access_meta(&state.spaces, &doc_id).await,
        caller.as_ref(),
        "document not found",
    ) {
        return resp;
    }
    match state
        .spaces
        .restore_document_version_versioned(
            &doc_id,
            &version_id,
            body.expected_revision,
            &body.operation_id,
            caller.as_ref().map(|value| value.user_id.as_str()),
        )
        .await
    {
        Ok(spaces::DocumentUpdateOutcome::Applied(result)) => match state.collab.reset(&doc_id) {
            Ok(epoch) => {
                state.realtime.publish_document_reset(&doc_id, epoch);
                Json(json!({
                    "success": true,
                    "result": result,
                    "document_epoch": epoch,
                }))
                .into_response()
            }
            Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        },
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

/// `GET /api/spaces/:id/documents/:doc_id/backlinks` — documents linking to this
/// document (Obsidian/Notion "linked references"), each with a context snippet.
#[utoipa::path(
    get,
    path = "/api/spaces/{id}/documents/{doc_id}/backlinks",
    tag = "Spaces",
    summary = "List backlinks to a document",
    params(("id" = String, Path), ("doc_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_document_backlinks(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path((_id, doc_id)): axum::extract::Path<(String, String)>,
) -> axum::response::Response {
    // Backlinks carry titles + context snippets of the linking documents, so this
    // is document content — gated like a read of the document itself
    // (`get_document`): `space.read` on its TRUE parent, then the row ACL.
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
    // Every backlink row is SOURCE-document content (id, title, body snippet), so
    // reading the target authorizes none of it: the store keeps only sources the
    // caller's tenancy can see, and each source's own Space ACL must allow it too.
    let backlinks = match state
        .spaces
        .get_backlinks(&doc_id, caller_doc_filter(&caller))
        .await
    {
        Ok(backlinks) => backlinks,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let backlinks = backlinks_readable_by(&state, &caller, backlinks).await;
    Json(json!({ "doc_id": doc_id, "backlinks": backlinks })).into_response()
}

/// Drop backlinks whose source document sits in a Space the caller may not
/// `space.read` (a per-Space deny overwrite). Permissions are resolved once and
/// each distinct source Space is decided once; a source whose Space cannot be
/// resolved is dropped (fail closed).
pub(in crate::server) async fn backlinks_readable_by(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    backlinks: Vec<spaces::DocLink>,
) -> Vec<spaces::DocLink> {
    match resource_permission_candidate(caller) {
        Ok(None) => return backlinks,
        Ok(Some(_)) => {}
        Err(_) => return Vec::new(),
    }
    let resolved = match caller {
        Some(caller) => {
            crate::sidecar::control_plane::resolve_permission_context(
                &state.client,
                &caller.user_id,
            )
            .await
        }
        None => Default::default(),
    };
    let mut decided: HashMap<String, bool> = HashMap::new();
    let mut readable = Vec::with_capacity(backlinks.len());
    for link in backlinks {
        let Some(space_id) = document_parent_space(state, &link.src_doc_id).await else {
            continue;
        };
        let allowed = match decided.get(&space_id) {
            Some(allowed) => *allowed,
            None => {
                let allowed = enforce_permission_on_resolved(
                    caller,
                    crate::identity_verify::permissions::SPACE_READ,
                    crate::acl::KIND_SPACE,
                    &space_id,
                    resolved.clone(),
                )
                .is_ok();
                decided.insert(space_id, allowed);
                allowed
            }
        };
        if allowed {
            readable.push(link);
        }
    }
    readable
}

/// `GET /api/spaces/:id/documents/:doc_id/links` — outgoing links from this
/// document (resolved doc references and pending, not-yet-created targets).
#[utoipa::path(
    get,
    path = "/api/spaces/{id}/documents/{doc_id}/links",
    tag = "Spaces",
    summary = "List outgoing links from a document",
    params(("id" = String, Path), ("doc_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_document_links(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path((_id, doc_id)): axum::extract::Path<(String, String)>,
) -> axum::response::Response {
    // Outgoing links are extracted from the document's body — reading them is
    // reading (part of) the document.
    if let Err(resp) = require_resource_read(
        spaces::doc_access_meta(&state.spaces, &doc_id).await,
        caller.as_ref(),
        "document not found",
    ) {
        return resp;
    }
    match state.spaces.get_outgoing_links(&doc_id).await {
        Ok(links) => Json(json!({ "doc_id": doc_id, "links": links })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `GET /api/spaces/:id/graph` — the document-link graph for one space.
#[utoipa::path(
    get,
    path = "/api/spaces/{id}/graph",
    tag = "Spaces",
    summary = "Document-link graph for a space",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_space_graph(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    // Org/team RBAC (coarse): reading the graph requires `space.read`.
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
    // Per-resource ACL (fine): the graph carries document titles + link topology, so
    // filter nodes/edges to what the caller may read (a member never sees another
    // member's private page title or link structure on a bound node).
    match state
        .spaces
        .space_graph(&id, caller_doc_filter(&caller))
        .await
    {
        Ok(graph) => Json(graph).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `GET /api/graph` — the global document-link graph across every space.
#[utoipa::path(
    get,
    path = "/api/graph",
    tag = "Spaces",
    summary = "Global document-link graph",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_global_graph(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    // Org/team RBAC (coarse): reading the graph requires `space.read`.
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_READ,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: space.read".to_owned(),
        );
    }
    // Per-resource ACL (fine): the cross-space graph carries document titles + link
    // topology across every space, so filter to what the caller may read.
    match state.spaces.global_graph(caller_doc_filter(&caller)).await {
        Ok(graph) => Json(graph).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `GET /api/embeddings/model` — the active default embedding model + dims.
#[utoipa::path(
    get,
    path = "/api/embeddings/model",
    tag = "Spaces",
    summary = "Get the active embedding model",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_embedding_model(
    State(state): State<ServerState>,
) -> axum::response::Response {
    Json(state.spaces.embedding_model().await).into_response()
}

pub(in crate::server) const MAX_EMBEDDING_INPUTS: usize = 64;
pub(in crate::server) const MAX_EMBEDDING_TEXT_CHARS: usize = 8192;
pub(in crate::server) const MAX_EMBEDDING_BATCH_BYTES: usize = 256 * 1024;
pub(in crate::server) const MAX_EMBEDDING_REQUEST_BYTES: usize = 300 * 1024;

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub(in crate::server) struct EmbedTextsBody {
    /// Texts to embed with the currently configured Core embedding model.
    pub(in crate::server) input: Vec<String>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(in crate::server) struct EmbedTextsResponse {
    /// Number of dimensions produced by the active model.
    pub(in crate::server) dims: usize,
    /// One vector per input, in input order.
    pub(in crate::server) embeddings: Vec<EmbedTextsItem>,
    /// Identifier of the model snapshot used for this batch.
    pub(in crate::server) model_id: String,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub(in crate::server) struct EmbedTextsItem {
    /// Semantic vector for the source input.
    pub(in crate::server) embedding: Vec<f32>,
    /// Position of the source text in the request's `input` array.
    pub(in crate::server) index: usize,
}
