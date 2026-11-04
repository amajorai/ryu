//! Spaces and RAG handlers: spaces, documents, files, graphs and embeddings: `search_space` through `create_database`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[utoipa::path(
    post,
    path = "/api/spaces/{id}/search",
    tag = "Spaces",
    summary = "Search a space (RAG)",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(crate) async fn search_space(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SearchBody>,
) -> axum::response::Response {
    // Coarse RBAC: searching a space requires `space.read` (this also denies a
    // tokenless caller on a bound node). The per-resource tenancy filter below then
    // ensures the returned chunks only come from documents THIS caller may read.
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
    let filter =
        match parse_retrieval_knobs(body.filter.as_ref(), body.hybrid.as_ref(), &body.expansion) {
            Ok(filter) => filter,
            Err(response) => return response,
        };
    let search_options = spaces::SpaceSearchOptions {
        limit: body.limit.clamp(1, 50),
        link_expansion: body.link_expansion,
        hybrid: body.hybrid,
        filter,
        parent: body.parent,
        rerank: body.rerank.unwrap_or(true),
    };
    if let Err(e) = search_options.validate() {
        return json_error(StatusCode::BAD_REQUEST, e.to_string());
    }
    // Lazily start the (off-by-default) reranker server so Spaces RAG can neural-
    // rerank. Fire-and-forget: the current search fails open to the vector order
    // if the server isn't warm yet; subsequent searches rerank once it is up.
    {
        let manager = state.manager.clone();
        tokio::spawn(async move {
            if let Err(e) = manager.start_sidecar("llamacpp-rerank").await {
                tracing::debug!("llamacpp-rerank lazy start skipped: {e:#}");
            }
        });
    }
    let expanded = retrieval_expansion::expand(
        &state,
        &body.query,
        &body.expansion,
        retrieval_expansion::caller_may_pick_model(&caller),
    )
    .await;
    match state
        .spaces
        .search_multi(
            &id,
            &expanded.search_texts(),
            &search_options,
            caller_doc_filter(&caller),
        )
        .await
    {
        Ok(matches) => {
            let mut response = json!({ "space_id": id, "matches": matches });
            if expanded.queries.len() > 1 || expanded.hypothetical_document.is_some() {
                response["queries"] = json!(expanded.queries);
                if let Some(passage) = &expanded.hypothetical_document {
                    response["hypothetical_document"] = json!(passage);
                }
            }
            if let Some(warning) = &expanded.warning {
                response["warning"] = json!(warning);
            }
            Json(response).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SpaceChunkingBody {
    /// The new strategy (`{ "strategy": "markdown", "chunk_size": 800, … }`), or
    /// `null` to restore the default splitter.
    #[serde(default)]
    pub(in crate::server) chunking: Option<retrieval::ChunkingStrategy>,
}

/// `GET /api/spaces/:id/chunking` — the Space's chunking strategy.
#[utoipa::path(
    get,
    path = "/api/spaces/{id}/chunking",
    tag = "Spaces",
    summary = "Get a space's chunking strategy",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_space_chunking(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
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
    match state.spaces.chunking(&id).await {
        Ok(Some(chunking)) => Json(json!({ "space_id": id, "chunking": chunking })).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "space not found".to_owned()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `PUT /api/spaces/:id/chunking` — set the strategy used for documents
/// ingested or edited from now on (existing chunks are not re-cut).
#[utoipa::path(
    put,
    path = "/api/spaces/{id}/chunking",
    tag = "Spaces",
    summary = "Set a space's chunking strategy",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_space_chunking(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SpaceChunkingBody>,
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
    if let Err(response) = require_resource_write(
        spaces::space_access_meta(&state.spaces, &id).await,
        caller.as_ref(),
        "space not found",
    ) {
        return response;
    }
    if let Some(chunking) = &body.chunking {
        if let Err(e) = chunking.validate() {
            return json_error(StatusCode::BAD_REQUEST, format!("invalid chunking: {e}"));
        }
    }
    match state.spaces.set_chunking(&id, body.chunking.as_ref()).await {
        Ok(true) => Json(json!({
            "space_id": id,
            "chunking": body.chunking.unwrap_or_default(),
        }))
        .into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "space not found".to_owned()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct CreatePageBody {
    pub(in crate::server) title: String,
    /// When set, create a child "row page" parented to this document (a database).
    #[serde(default)]
    pub(in crate::server) parent_id: Option<String>,
}

/// `POST /api/spaces/:id/pages` — create an empty Notion-style markdown page.
#[utoipa::path(
    post,
    path = "/api/spaces/{id}/pages",
    tag = "Spaces",
    summary = "Create a page document",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn create_page(
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
    let tenancy = spaces::owner_of(&caller_tenancy(&caller));
    let result = match body.parent_id.as_deref() {
        Some(parent) => {
            state
                .spaces
                .create_child_page(&id, title, parent, &tenancy)
                .await
        }
        None => state.spaces.create_page(&id, title, &tenancy).await,
    };
    match result {
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

/// `POST /api/spaces/:id/databases` — create an empty database (data-grid) doc.
/// Same lifecycle as a page; the editor saves its grid JSON via `update_document`.
#[utoipa::path(
    post,
    path = "/api/spaces/{id}/databases",
    tag = "Spaces",
    summary = "Create a database document",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn create_database(
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
        .create_database(&id, title, &spaces::owner_of(&caller_tenancy(&caller)))
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
