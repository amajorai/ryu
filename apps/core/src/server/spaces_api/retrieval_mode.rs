//! Spaces and RAG handlers: spaces, documents, files, graphs and embeddings: `set_retrieval_mode` through `SearchSpacesQuery`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/spaces/:id/retrieval-mode` — change an existing Space's retrieval mode.
///
/// **The switch is not a metadata edit, and this route does not pretend it is.**
/// Graph extraction is gated on the mode at ingest, so a Space built in vector mode
/// has no entity graph at all. Flipping only the column would route its searches at
/// an empty graph: the Space would return nothing while reporting
/// `retrieval_mode: "graph"`. So [`spaces::SpaceStore::set_retrieval_mode`] rebuilds
/// the graph from the chunks already on disk, in the same atomic swap as the column
/// write. The route returns HTTP 202 with a job id; clients poll for progress and
/// the committed `change` (`chunks_scanned`, `graph_nodes`, `graph_edges`) rather
/// than treating acceptance as completion.
///
/// A rebuild is *possible* at all — without re-embedding — because entity
/// extraction is deterministic offline co-occurrence: no embedder, no model call,
/// no network, so the graph is a pure function of the chunk text already on disk.
/// Chunk *vectors* are never touched, which is why toggling back and forth is safe.
/// That is the determinism argument, and it is the whole of it: it says the rebuild
/// is reproducible, **not** that it is cheap.
///
/// # This is a long operation with bounded staging and cooperative cancellation.
///
/// The doc here used to call the rebuild "affordable inline". Both halves were
/// wrong. It is not inline — the store runs the work on a blocking worker because
/// it is not affordable on a runtime worker — and "affordable" was asserted, never
/// measured. The HTTP path stages 32 chunks per transaction and atomically swaps
/// the completed graph after validating the source snapshot.
/// What the measurement found:
///
/// - The cost is not the extractor, it is the quadratic edge fan-out it feeds:
///   `O(chunks × entities²)`. Ordinary English prose yields ≈57 distinct entities
///   per ~1,000-character chunk, and each chunk emits `n·(n−1)` directed edge rows.
/// - Entities per chunk are bounded by the chunk size; **chunk count is not
///   bounded** — it is whatever the Space happens to hold, and this route hands
///   over every chunk in it from one click.
/// - On an on-disk db (what a real Space is) that lands at tens of seconds to
///   minutes for a Space in the low thousands of chunks, and per-chunk cost *rises*
///   with size rather than staying flat.
///
/// The measured table, the exact row counts, its error bars and the command to
/// re-derive it live on `ryu_spaces::build_graph_for_chunks`. They are deliberately
/// not copied here: two copies of a measured number drift, and the copy is always
/// the stale one.
///
/// Three consequences a client of this route has to surface, not swallow:
///
/// - **A no-op re-assert is not a no-op.** Posting `"graph"` to a Space that is
///   already `"graph"` returns `changed: false` and still performs a *full*
///   rebuild — that is the only graph-repair path there is. It is frequently the
///   most expensive call this endpoint makes, so rendering `changed: false` as
///   "nothing happened" misinforms the user.
/// - **The connection is unavailable only during each bounded batch and final swap.**
///   Other Space calls can run between batches.
/// - **The job is cooperatively cancellable.** Cancellation leaves the previous
///   mode and graph intact; a client should poll the status endpoint until it
///   reaches `cancelled` or `completed`.
///
/// Switching to `"vector"` drops the graph rows instead (nothing maintains them in
/// vector mode, so keeping them would leave a graph that rots as documents change).
/// That direction skips the chunk scan and the fan-out entirely — it is two
/// `DELETE`s — but it is not instant either, and nobody has measured it: the rows it
/// deletes are the millions the rebuild wrote, plus their two indexes. Assume the
/// same "long operation" contract above; it is merely the cheaper of the two
/// directions, not a cheap one.
#[utoipa::path(
    post,
    path = "/api/spaces/{id}/retrieval-mode",
    tag = "Spaces",
    summary = "Change a space's retrieval mode (rebuilds its entity graph)",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 202, description = "Retrieval-mode rebuild accepted", body = serde_json::Value))
)]
pub(in crate::server) async fn set_retrieval_mode(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SetRetrievalModeBody>,
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
    // Per-resource ACL: changing retrieval mode rewrites THIS space's graph, so it
    // is a write on this resource — not merely a caller who holds `space.write`
    // somewhere. Same gate as `set_space_icon`/`delete_space`; without it a member
    // of a bound node could re-mode a colleague's private Space.
    if let Err(resp) = require_resource_write(
        spaces::space_access_meta(&state.spaces, &id).await,
        caller.as_ref(),
        "space not found",
    ) {
        return resp;
    }
    let Some(requested) = body.retrieval_mode.as_deref().filter(|s| !s.is_empty()) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "retrieval_mode is required: \"vector\" or \"graph\"".to_owned(),
        );
    };
    // Strict parse: unlike creation there is no node-wide default to fall back to
    // here — the Space already has a mode, and quietly leaving it alone (or quietly
    // resetting it to vector) on a typo is exactly the silent-no-op this route was
    // added to eliminate.
    let Some(mode) = spaces::RetrievalMode::parse(requested) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            format!("unknown retrieval_mode {requested:?}: expected \"vector\" or \"graph\""),
        );
    };
    match state.spaces.start_retrieval_mode_rebuild(&id, mode).await {
        Ok(Some(job)) => (
            StatusCode::ACCEPTED,
            Json(json!({
                "success": true,
                "job_id": job.job_id,
                "space_id": job.space_id,
                "retrieval_mode": job.requested_mode.as_str(),
                "status": format!("/api/spaces/{}/retrieval-mode/status", job.space_id),
                "cancel": format!("/api/spaces/{}/retrieval-mode/cancel", job.space_id),
            })),
        )
            .into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "space not found".to_owned()),
        Err(error)
            if error
                .downcast_ref::<spaces::RetrievalModeRebuildConflict>()
                .is_some() =>
        {
            json_error(StatusCode::CONFLICT, error.to_string())
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct RetrievalModeStatusQuery {
    pub(in crate::server) job_id: String,
}

/// `GET /api/spaces/:id/retrieval-mode/status` — progress and terminal outcome
/// for the requested mode rebuild. A cancelled job leaves the old mode and graph in
/// place because the worker rolls back its single transaction.
#[utoipa::path(
    get,
    path = "/api/spaces/{id}/retrieval-mode/status",
    tag = "Spaces",
    summary = "Get retrieval-mode rebuild progress",
    params(("id" = String, Path), ("job_id" = String, Query)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn retrieval_mode_status(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<RetrievalModeStatusQuery>,
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
    match state.spaces.retrieval_mode_status(&id, query.job_id.trim()) {
        Some(status) => Json(status).into_response(),
        None => json_error(
            StatusCode::NOT_FOUND,
            "no retrieval-mode job found".to_owned(),
        ),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct CancelRetrievalModeBody {
    pub(in crate::server) job_id: String,
}

/// `POST /api/spaces/:id/retrieval-mode/cancel` — request cooperative
/// cancellation. The worker stops at a chunk boundary and rolls back.
#[utoipa::path(
    post,
    path = "/api/spaces/{id}/retrieval-mode/cancel",
    tag = "Spaces",
    summary = "Cancel a retrieval-mode rebuild",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn cancel_retrieval_mode(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<CancelRetrievalModeBody>,
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
    let cancelled = state
        .spaces
        .cancel_retrieval_mode_rebuild(&id, body.job_id.trim());
    Json(json!({ "cancelled": cancelled })).into_response()
}

/// `GET /api/spaces/:id/documents` — the Space's documents, each **file** row
/// carrying its content-extraction state under `index`.
///
/// The `index` object is `FileIndexRecord::to_json` — byte-identical to what the
/// create responses and `…/documents/:doc_id/index` return, so a client needs one
/// reader for all three. It is attached **only** to `kind = 'file'` rows: a page,
/// database or whiteboard is re-chunked from its own source on every save, so the
/// question does not apply to it and answering anyway would be a fresh overclaim.
///
/// Joined in one pass ([`crate::space_file_index::attach_index_states`]) rather than
/// left to the client. It is a two-store join — the rows come from `ryu-spaces`, the
/// state from Core's own `space-file-index.db` — and the desktop was paying one HTTP
/// request per file row to render a searchability badge, against a Space (Uploads)
/// whose length is bounded by nothing.
///
/// The join runs **after** `caller_doc_filter`, so state is attached only to rows
/// this caller was already permitted to see; it adds no ACL of its own because the
/// list's own filter is the check.
#[utoipa::path(
    get,
    path = "/api/spaces/{id}/documents",
    tag = "Spaces",
    summary = "List documents in a space",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_documents(
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
    match state
        .spaces
        .list_documents(&id, caller_doc_filter(&caller))
        .await
    {
        Ok(documents) => {
            // Serialize first, then decorate: `spaces::Document` has no index field
            // and must not grow one (the crate has zero dependency on `apps/core`,
            // which is what keeps parser provenance out of its schema). A failure to
            // serialize the rows is not survivable, but it is also not a reason to
            // lose the list — fall back to the undecorated payload.
            let mut rows = match serde_json::to_value(&documents) {
                Ok(serde_json::Value::Array(rows)) => rows,
                other => {
                    tracing::warn!("list_documents: unexpected document encoding: {other:?}");
                    return Json(json!({ "space_id": id, "documents": documents })).into_response();
                }
            };
            crate::space_file_index::attach_index_states(&mut rows).await;
            Json(json!({ "space_id": id, "documents": rows })).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SearchSpacesQuery {
    pub(in crate::server) q: String,
    pub(in crate::server) limit: Option<usize>,
}
