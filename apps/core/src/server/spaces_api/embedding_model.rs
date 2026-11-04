//! Spaces and RAG handlers: spaces, documents, files, graphs and embeddings: `validate_embedding_inputs` through `reindex_status`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

pub(in crate::server) fn validate_embedding_inputs(inputs: &[String]) -> Result<(), &'static str> {
    if inputs.is_empty() {
        return Err("input must contain at least one text");
    }
    if inputs.len() > MAX_EMBEDDING_INPUTS {
        return Err("input may contain at most 64 texts");
    }
    let mut total_bytes = 0usize;
    for input in inputs {
        if input.trim().is_empty() {
            return Err("input texts must not be empty");
        }
        if input.chars().count() > MAX_EMBEDDING_TEXT_CHARS {
            return Err("each input text may contain at most 8192 characters");
        }
        total_bytes = total_bytes.saturating_add(input.len());
        if total_bytes > MAX_EMBEDDING_BATCH_BYTES {
            return Err("combined input text may not exceed 256 KiB");
        }
    }
    Ok(())
}

/// `POST /api/embeddings` — embed bounded transient text through Core's active
/// semantic model. Inputs and returned vectors are not written to a Space or DB.
#[utoipa::path(
    post,
    path = "/api/embeddings",
    tag = "Spaces",
    summary = "Embed transient text with the active model",
    request_body = EmbedTextsBody,
    responses(
        (status = 200, description = "Vectors in input order", body = EmbedTextsResponse),
        (status = 400, description = "Invalid or oversized input"),
        (status = 503, description = "Embedding provider unavailable")
    )
)]
pub(in crate::server) async fn embed_texts(
    State(state): State<ServerState>,
    Json(body): Json<EmbedTextsBody>,
) -> axum::response::Response {
    if let Err(error) = validate_embedding_inputs(&body.input) {
        return json_error(StatusCode::BAD_REQUEST, error.to_owned());
    }
    match state.spaces.embed_texts(&body.input).await {
        Ok(result) => no_store_response(
            Json(EmbedTextsResponse {
                dims: result.dims,
                embeddings: result
                    .embeddings
                    .into_iter()
                    .map(|item| EmbedTextsItem {
                        embedding: item.embedding,
                        index: item.index,
                    })
                    .collect(),
                model_id: result.model_id,
            })
            .into_response(),
        ),
        Err(error) => {
            tracing::warn!(error = %error, "transient embedding request failed");
            json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "embedding provider unavailable".to_owned(),
            )
        }
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SetEmbeddingModelBody {
    pub(in crate::server) model_id: String,
    #[serde(default)]
    pub(in crate::server) base_url: Option<String>,
    #[serde(default)]
    pub(in crate::server) dims: Option<usize>,
    #[serde(default)]
    pub(in crate::server) provider: Option<String>,
}

/// `POST /api/embeddings/model` — change the default embedding model. Persists the
/// choice, swaps the live embedder, and kicks a background re-index (every existing
/// vector lives in the old model's space and must be re-embedded).
#[utoipa::path(
    post,
    path = "/api/embeddings/model",
    tag = "Spaces",
    summary = "Set the embedding model",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_embedding_model(
    State(state): State<ServerState>,
    Json(body): Json<SetEmbeddingModelBody>,
) -> axum::response::Response {
    if body.model_id.trim().is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "model_id is required".to_owned());
    }
    if body.dims == Some(0) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "dims must be greater than zero".to_owned(),
        );
    }
    let provider = body
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|provider| !provider.is_empty())
        .map(str::to_ascii_lowercase);
    if provider
        .as_deref()
        .is_some_and(|provider| provider != "gateway")
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "provider must be 'gateway' when specified".to_owned(),
        );
    }
    if provider.as_deref() == Some("gateway")
        && body
            .base_url
            .as_deref()
            .is_some_and(|base_url| !base_url.trim().is_empty())
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "gateway embedding providers cannot accept a direct base_url".to_owned(),
        );
    }
    let pref = spaces::EmbeddingModelPref {
        model_id: body.model_id.trim().to_owned(),
        base_url: body.base_url.clone(),
        dims: body.dims,
        provider,
    };
    let raw = match serde_json::to_string(&pref) {
        Ok(s) => s,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if let Err(e) = state
        .preferences
        .set(spaces::EMBEDDING_MODEL_PREF_KEY, &raw)
        .await
    {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    // Stage the new vectors before swapping the live vec0 table. A provider
    // failure or a concurrent content edit therefore leaves the old index and
    // active embedder usable; the store swaps both only after a complete pass.
    let embedder = spaces::embedder_for_pref(&pref);
    state.spaces.apply_embedder_change(embedder.clone()).await;
    state.retrieval.set_embedder(embedder.clone());
    if let Err(error) = state
        .conversations
        .set_message_embedder(std::sync::Arc::new(
            crate::search_host::CoreSearchEmbedder::from_embedder(embedder),
        ))
        .await
    {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    let retrieval = state.retrieval.clone();
    let conversations = state.conversations.clone();
    tokio::spawn(async move {
        if let Err(error) = retrieval.reindex_stale_embeddings().await {
            tracing::warn!("embedding reindex failed for retrieval.db: {error:#}");
        }
        if let Err(error) = conversations.reindex_message_embeddings().await {
            tracing::warn!("embedding reindex failed for message index: {error:#}");
        }
    });
    Json(json!({ "success": true, "reindexing": true })).into_response()
}

/// `POST /api/embeddings/reindex` — manually kick a background re-index.
#[utoipa::path(
    post,
    path = "/api/embeddings/reindex",
    tag = "Spaces",
    summary = "Trigger a re-index",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn trigger_reindex(
    State(state): State<ServerState>,
) -> axum::response::Response {
    let store = state.spaces.clone();
    let retrieval = state.retrieval.clone();
    let conversations = state.conversations.clone();
    tokio::spawn(async move {
        let _ = store.reindex_all().await;
        let _ = retrieval.reindex_stale_embeddings().await;
        let _ = conversations.reindex_message_embeddings().await;
    });
    Json(json!({ "started": true })).into_response()
}

/// `GET /api/embeddings/reindex/status` — re-index progress (pending chunk count).
#[utoipa::path(
    get,
    path = "/api/embeddings/reindex/status",
    tag = "Spaces",
    summary = "Re-index progress",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn reindex_status(
    State(state): State<ServerState>,
) -> axum::response::Response {
    match state.spaces.reindex_status().await {
        Ok(status) => Json(status).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
