//! Spaces and RAG handlers: spaces, documents, files, graphs and embeddings: `search_space_documents` through `default_search_limit`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `GET /api/spaces/search` — literal global search over visible Space metadata
/// and document text. This is intentionally separate from per-Space RAG search:
/// the palette needs fast, predictable lexical recall and must still work when no
/// embedding model is available.
#[utoipa::path(
    get,
    path = "/api/spaces/search",
    tag = "Spaces",
    summary = "Search visible spaces and pages lexically",
    params(
        ("q" = String, Query, description = "Text to find"),
        ("limit" = Option<usize>, Query, description = "Maximum number of page hits")
    ),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn search_space_documents(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Query(query): axum::extract::Query<SearchSpacesQuery>,
) -> axum::response::Response {
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
    let text = query.q.trim();
    if text.len() < 2 {
        return Json(json!({ "hits": [], "indexed": true })).into_response();
    }
    let limit = query.limit.unwrap_or(8).clamp(1, 50);
    match state
        .spaces
        .search_documents_lexical(text, limit, caller_doc_filter(&caller))
        .await
    {
        Ok(hits) => Json(json!({ "hits": hits, "indexed": true })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// The seeded system-space NAME an app's documents live in. There is no server-side
/// app→space link yet — the association is the space NAME, seeded at boot in
/// `main.rs` (`ensure_system_space("Canvas"/"Whiteboard"/…)`), so the mapping lives
/// here. An app not in this map has no document space (its section shows nothing).
pub(in crate::server) fn app_space_name(plugin_id: &str) -> Option<&'static str> {
    match plugin_id {
        "@ryu/canvas" => Some("Canvas"),
        "@ryu/whiteboard" => Some("Whiteboard"),
        _ => None,
    }
}

/// `GET /api/apps/:id/docs` — an app's documents (kind `app:<id>`, isolated by
/// `app_list_docs`) in its seeded Space, shaped for a sidebar section's declarative
/// `source`: `{ documents: [{ id, title, space_id, updated_at }] }`.
pub(in crate::server) async fn list_app_docs(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(plugin_id): axum::extract::Path<String>,
) -> axum::response::Response {
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
    let Some(space_name) = app_space_name(&plugin_id) else {
        return Json(json!({ "documents": [] })).into_response();
    };
    let space_id = match state.spaces.ensure_system_space(space_name, None).await {
        Ok(id) => id,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    match state.spaces.app_list_docs(&plugin_id, &space_id).await {
        Ok(docs) => {
            let documents: Vec<serde_json::Value> = docs
                .iter()
                .map(|d| {
                    json!({
                        "id": d.id,
                        "title": d.title,
                        "space_id": space_id,
                        "updated_at": d.updated_at,
                    })
                })
                .collect();
            Json(json!({ "documents": documents })).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct CreateAppDocBody {
    #[serde(default)]
    pub(in crate::server) title: Option<String>,
}

/// `POST /api/apps/:id/docs` (`{ title? }`) — create a doc of kind `app:<id>` in the
/// app's Space and return `{ id, space_id }`, so a section's "+" can create-and-open.
pub(in crate::server) async fn create_app_doc(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(plugin_id): axum::extract::Path<String>,
    Json(body): Json<CreateAppDocBody>,
) -> axum::response::Response {
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
    let Some(space_name) = app_space_name(&plugin_id) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            format!("no document space for app: {plugin_id}"),
        );
    };
    let space_id = match state.spaces.ensure_system_space(space_name, None).await {
        Ok(id) => id,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let title = body
        .title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "Untitled".to_owned());
    match state
        .spaces
        .app_create_doc(
            &plugin_id,
            &space_id,
            &title,
            &crate::server::spaces::background_owner(),
        )
        .await
    {
        Ok(id) => Json(json!({ "id": id, "space_id": space_id })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct IngestBody {
    pub(in crate::server) title: String,
    pub(in crate::server) content: String,
}

#[utoipa::path(
    post,
    path = "/api/spaces/{id}/documents",
    tag = "Spaces",
    summary = "Ingest a document into a space",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn ingest_document(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<IngestBody>,
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
    match state
        .spaces
        .ingest_document(
            &id,
            body.title.trim(),
            &body.content,
            &spaces::owner_of(&caller_tenancy(&caller)),
        )
        .await
    {
        Ok(document_id) => Json(json!({ "document_id": document_id })).into_response(),
        Err(e) => {
            let msg = e.to_string();
            let status = if msg.contains("not found") {
                StatusCode::NOT_FOUND
            } else if msg.contains("file quota exceeded") {
                StatusCode::PAYLOAD_TOO_LARGE
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(status, msg)
        }
    }
}

#[derive(serde::Deserialize, Default)]
pub(crate) struct SearchBody {
    pub(crate) query: String,
    #[serde(default = "default_search_limit")]
    pub(crate) limit: usize,
    /// Override wiki link-expansion for this search (`None` = server default,
    /// governed by `RYU_SPACES_LINK_EXPANSION`).
    #[serde(default)]
    pub(crate) link_expansion: Option<bool>,
    /// Fuse a BM25 keyword ranking with the Space's own ranking
    /// (`{ "alpha": 0.5 }`; `alpha` weights the semantic side).
    #[serde(default)]
    pub(crate) hybrid: Option<retrieval::HybridOptions>,
    /// Metadata predicate (`ryu_rag::MetadataFilter` JSON) every hit must match.
    #[serde(default)]
    pub(crate) filter: Option<serde_json::Value>,
    /// Small-to-big expansion: `{ "mode": "window", "window": 1 }` or
    /// `{ "mode": "document", "max_chars": 8000 }`.
    #[serde(default)]
    pub(crate) parent: Option<spaces::ParentExpansion>,
    /// Re-score candidates with the reranker (default true).
    #[serde(default)]
    pub(crate) rerank: Option<bool>,
    #[serde(flatten)]
    pub(crate) expansion: retrieval_expansion::ExpansionRequest,
}

pub(in crate::server) fn default_search_limit() -> usize {
    5
}
