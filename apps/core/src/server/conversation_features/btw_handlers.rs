//! Goals, context-window management, `/btw` side questions and multi-agent participants: `list_btw_handler` through `runs_stream`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `GET /api/conversations/:id/btw` — list persisted `/btw` side chats for a
/// conversation, newest first.
#[utoipa::path(
    get,
    path = "/api/conversations/{id}/btw",
    tag = "Chat",
    summary = "List a conversation's side questions",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_btw_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(conversation_id): Path<String>,
) -> axum::response::Response {
    // Per-resource ACL: side chats are part of a conversation's transcript.
    if let Err(resp) = require_resource_read(
        state.conversations.get_access_meta(&conversation_id).await,
        caller.as_ref(),
        &format!("conversation '{conversation_id}' not found"),
    ) {
        return resp;
    }
    match state.conversations.list_btw(&conversation_id).await {
        Ok(entries) => Json(entries).into_response(),
        Err(e) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not list side chats: {e}"),
        ),
    }
}

/// `DELETE /api/btw/:id` — delete a single persisted side chat.
#[utoipa::path(
    delete,
    path = "/api/btw/{id}",
    tag = "Chat",
    summary = "Delete a side question",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn delete_btw_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> axum::response::Response {
    // Per-resource ACL, keyed on the PARENT conversation (a btw entry carries no
    // tenancy of its own).
    if let Err(resp) = require_parent_conversation(
        &state,
        &caller,
        state.conversations.conversation_id_for_btw(&id).await,
        true,
        "side chat not found",
    )
    .await
    {
        return resp;
    }
    match state.conversations.delete_btw(&id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "side chat not found".to_string()),
        Err(e) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not delete side chat: {e}"),
        ),
    }
}

// ── Multi-agent participant handlers (#414) ───────────────────────────────────

#[derive(serde::Deserialize)]
pub(in crate::server) struct AddParticipantBody {
    pub(in crate::server) agent_id: String,
}

/// `POST /api/conversations/:id/participants` — add an agent to a conversation.
#[utoipa::path(
    get,
    path = "/api/conversations/{id}/participants",
    tag = "Conversations",
    summary = "List conversation participants",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_participants_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_read(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    match state.conversations.get_participants(&id).await {
        Ok(participants) => {
            let list: Vec<serde_json::Value> = participants
                .iter()
                .map(|a| json!({ "agent_id": a }))
                .collect();
            Json(json!({ "participants": list })).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/api/conversations/{id}/participants",
    tag = "Conversations",
    summary = "Add a participant agent",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn add_participant_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
    Json(body): Json<AddParticipantBody>,
) -> axum::response::Response {
    if body.agent_id.trim().is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "agent_id is required".to_owned());
    }
    // Per-resource ACL. `add_participant` upserts the conversation row, so like
    // `chat_stream` it is a create-or-use path: gate an existing row, claim a new one.
    if let Err(resp) = gate_and_claim_conversation(&state, &caller, &id).await {
        return resp;
    }
    match state
        .conversations
        .add_participant(&id, body.agent_id.trim(), caller_tenancy(&caller))
        .await
    {
        Ok(participants) => {
            // A chat a user deliberately adds a second agent to becomes a group:
            // its own (ad-hoc) group main thread, the coordinator for its members.
            if participants.len() > 1 {
                if let Err(error) = state.conversations.promote_to_group_main(&id).await {
                    tracing::warn!(conversation_id = %id, "could not mark group main thread: {error:#}");
                }
            }
            Json(json!({ "participants": participants })).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `DELETE /api/conversations/:id/participants/:agent_id` — remove an agent from a conversation.
#[utoipa::path(
    delete,
    path = "/api/conversations/{id}/participants/{agent_id}",
    tag = "Conversations",
    summary = "Remove a participant agent",
    params(("id" = String, Path), ("agent_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn remove_participant_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((id, agent_id)): Path<(String, String)>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    match state.conversations.remove_participant(&id, &agent_id).await {
        Ok(participants) => Json(json!({ "participants": participants })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `GET /api/runs` — list conversations that have a `run_status` set, ordered
/// most-recently-updated first.  Used by the desktop's background-runs view
/// (issue #128): the sidebar polls this to show active/recent run status, and
/// the notification logic watches for `running → completed/failed` transitions.
#[utoipa::path(
    get,
    path = "/api/runs",
    tag = "Conversations",
    summary = "List runs",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_runs_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    // Per-resource ACL, in SQL: a run IS a conversation, so listing every run on
    // the node handed out every user's run titles + working folders.
    let (user_id, org_id, team_ids_json, node_bound) = tenancy_filter_args(&caller);
    match state
        .conversations
        .list_runs_visible_for_teams(
            user_id.as_deref(),
            org_id.as_deref(),
            node_bound,
            team_ids_json.as_deref(),
        )
        .await
    {
        Ok(items) => Json(json!({ "runs": items })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// One frame of the `/api/runs/stream` feed. `snapshot` carries the full run list
/// on connect; each subsequent `run` carries a single run whose status just
/// changed. The `type` tag lets the client branch without a second endpoint.
#[derive(serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(in crate::server) enum RunStreamFrame {
    Snapshot {
        runs: Vec<conversations::ConversationSummary>,
    },
    Run {
        run: conversations::ConversationSummary,
    },
}

/// `GET /api/runs/stream` — SSE: a full run snapshot on connect, then a frame per
/// run whose `run_status` transitions. Replaces the desktop's 3s poll of
/// `/api/runs` (issue #128); the snapshot-first contract lets a late/lagged client
/// self-heal, so a `running → completed/failed` transition is never silently
/// missed. Mirrors [`downloads_stream`].
#[utoipa::path(
    get,
    path = "/api/runs/stream",
    tag = "Conversations",
    summary = "Background-runs SSE stream",
    responses((status = 200, description = "Server-Sent Events stream"))
)]
pub(in crate::server) async fn runs_stream(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::sse::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use tokio::sync::broadcast::error::RecvError;

    // Subscribe BEFORE snapshotting so a transition in the gap between the two is
    // still delivered as a delta (the snapshot may or may not include it; either
    // way the client converges on the right terminal status).
    let rx = conversations::subscribe_run_events();
    // Per-resource ACL on the opening snapshot: this used to fan out EVERY run on
    // the node to every subscriber.
    let (user_id, org_id, team_ids_json, node_bound) = tenancy_filter_args(&caller);
    let visible_runs = state
        .conversations
        .list_runs_visible_for_teams(
            user_id.as_deref(),
            org_id.as_deref(),
            node_bound,
            team_ids_json.as_deref(),
        )
        .await
        .unwrap_or_default();
    let snapshot = RunStreamFrame::Snapshot { runs: visible_runs };

    // …and on the live deltas, which are the other half of the leak (a `running →
    // completed` frame carries the run's title + working folder). A run id IS a
    // conversation id, so each delta is re-gated against the same per-resource ACL.
    // `None` on an unbound node ⇒ zero extra work on the single-user path.
    let gate = node_bound.then(|| (state.conversations.clone(), caller.clone()));

    // State carries the (one-shot) snapshot until it's been emitted, then `None`.
    // First poll yields the snapshot; subsequent polls forward live deltas.
    let stream = futures_util::stream::unfold(
        (rx, Some(snapshot), gate),
        |(mut rx, pending_snapshot, gate)| async move {
            if let Some(snap) = pending_snapshot {
                let data = serde_json::to_string(&snap).unwrap_or_default();
                return Some((Ok(Event::default().data(data)), (rx, None, gate)));
            }
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        if let Some((store, caller)) = gate.as_ref() {
                            let meta = store.get_access_meta(&ev.run.id).await;
                            if require_resource_read(meta, caller.as_ref(), "run not found")
                                .is_err()
                            {
                                continue;
                            }
                        }
                        let frame = RunStreamFrame::Run { run: ev.run };
                        let data = serde_json::to_string(&frame).unwrap_or_default();
                        return Some((Ok(Event::default().data(data)), (rx, None, gate)));
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return None,
                }
            }
        },
    );
    Sse::new(stream).keep_alive(KeepAlive::default())
}
