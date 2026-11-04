//! Assistant-first opening.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Assistant-first opening ──────────────────────────────────────────────────

/// Request body for the one-time assistant-first opening used by desktop and
/// authorized channel runtimes. The idempotency key is optional so a caller can
/// use the stable `(agent, conversation)` pair as its default key.
#[derive(serde::Deserialize)]
pub(in crate::server) struct ProactiveOpeningRequest {
    pub(in crate::server) conversation_id: String,
    #[serde(default)]
    pub(in crate::server) agent_id: Option<String>,
    #[serde(default)]
    pub(in crate::server) idempotency_key: Option<String>,
    /// The language to write the opening in. A Gateway channel sends its
    /// owner's locale; when absent, Core uses the node's UI language.
    #[serde(default)]
    pub(in crate::server) locale: Option<String>,
}

pub(in crate::server) fn proactive_opening_retryable(error: &anyhow::Error) -> bool {
    let text = error.to_string().to_ascii_lowercase();
    [
        "not ready",
        "no model",
        "model unavailable",
        "engine unavailable",
        "sidecar",
        "gateway",
        "timed out",
        "timeout",
        "no agent selected",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

pub(in crate::server) async fn latest_assistant_reply(
    state: &ServerState,
    conversation_id: &str,
) -> anyhow::Result<Option<String>> {
    Ok(state
        .conversations
        .get_messages(conversation_id)
        .await?
        .into_iter()
        .rev()
        .find(|message| message.role == "assistant")
        .map(|message| message.content))
}

/// `POST /api/proactive/opening` — generate the first Ryu message without a
/// synthetic user row. The same Core contract is used by desktop and gateway
/// channel runtimes, so readiness, persistence, and idempotency are shared.
#[utoipa::path(
    post,
    path = "/api/proactive/opening",
    tag = "Chat",
    summary = "Create the assistant's first proactive opening",
    request_body = serde_json::Value,
    responses((status = 200, description = "Opening completed", body = serde_json::Value))
)]
pub(in crate::server) async fn proactive_opening(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(req): Json<ProactiveOpeningRequest>,
) -> axum::response::Response {
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_RUN,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: agent.run".to_owned(),
        );
    }
    let conversation_id = req.conversation_id.trim().to_owned();
    if conversation_id.is_empty() || conversation_id.len() > 200 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "conversation_id must be between 1 and 200 characters".to_owned(),
        );
    }
    if let Err(resp) = gate_and_claim_conversation(&state, &caller, &conversation_id).await {
        return resp;
    }

    let agent_id = req
        .agent_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or("ryu")
        .to_owned();
    let idempotency_key = req
        .idempotency_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("ryu-opening:v1:{agent_id}:{conversation_id}"));
    if idempotency_key.len() > 500 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "idempotency_key is too long".to_owned(),
        );
    }

    let claimed = match state
        .conversations
        .claim_proactive_opening(&idempotency_key, &conversation_id)
        .await
    {
        Ok(claimed) => claimed,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    if !claimed {
        match state
            .conversations
            .proactive_opening_status(&idempotency_key)
            .await
        {
            Ok(Some(status)) if status.conversation_id != conversation_id => {
                return json_error(
                    StatusCode::CONFLICT,
                    "idempotency_key is already bound to another conversation".to_owned(),
                );
            }
            Ok(Some(status)) if status.status == "completed" => {
                match latest_assistant_reply(&state, &conversation_id).await {
                    Ok(Some(reply)) => {
                        return (
                            StatusCode::OK,
                            Json(json!({
                                // A retry after a Gateway restart must not send the
                                // same already-delivered welcome a second time. The
                                // desktop still reloads the durable assistant row.
                                "status": "already_completed",
                                "conversation_id": conversation_id,
                                "reply": reply,
                            })),
                        )
                            .into_response();
                    }
                    Ok(None) => {
                        return json_error(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "opening was marked complete without an assistant message".to_owned(),
                        );
                    }
                    Err(error) => {
                        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
                    }
                }
            }
            Ok(_) => {
                return (
                    StatusCode::ACCEPTED,
                    Json(json!({
                        "status": "pending",
                        "conversation_id": conversation_id,
                    })),
                )
                    .into_response();
            }
            Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        }
    }

    let locale = crate::sidecar::adapters::opening_locale(req.locale.as_deref()).await;
    let result = run_proactive_opening_text(
        conversation_id.clone(),
        Some(agent_id),
        Arc::clone(&state.agents),
        state.conversations.clone(),
        state.agent_store.clone(),
        Arc::clone(&state.manager),
        state.memory.clone(),
        Arc::clone(&state.worktree_diffs),
        Arc::clone(&state.mcp),
        state.skills.clone(),
        state.traces.clone(),
        &locale,
    )
    .await;

    match result {
        Ok(reply) if !reply.trim().is_empty() => {
            match latest_assistant_reply(&state, &conversation_id).await {
                Ok(Some(durable_reply)) if durable_reply == reply => {
                    if let Err(error) = state
                        .conversations
                        .complete_proactive_opening(&idempotency_key)
                        .await
                    {
                        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
                    }
                    (
                        StatusCode::OK,
                        Json(json!({
                            "status": "completed",
                            "conversation_id": conversation_id,
                            "reply": reply,
                        })),
                    )
                        .into_response()
                }
                Ok(Some(_)) => {
                    let _ = state
                        .conversations
                        .release_proactive_opening(&idempotency_key)
                        .await;
                    json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "the opening reply did not match the saved assistant message".to_owned(),
                    )
                }
                Ok(None) => {
                    let _ = state
                        .conversations
                        .release_proactive_opening(&idempotency_key)
                        .await;
                    json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "the opening reply was not saved".to_owned(),
                    )
                }
                Err(error) => {
                    let _ = state
                        .conversations
                        .release_proactive_opening(&idempotency_key)
                        .await;
                    json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
                }
            }
        }
        Ok(_) => {
            let _ = state
                .conversations
                .release_proactive_opening(&idempotency_key)
                .await;
            json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Ryu is not ready to send its opening yet".to_owned(),
            )
        }
        Err(error) => {
            let retryable = proactive_opening_retryable(&error);
            let _ = state
                .conversations
                .release_proactive_opening(&idempotency_key)
                .await;
            let status = if retryable {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(status, error.to_string())
        }
    }
}
