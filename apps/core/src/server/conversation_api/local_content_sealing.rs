//! Local content sealing for local clients.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Local content sealing for local clients ─────────────────────────────────
//
// The CLI (Bun) cannot reach the OS keychain, so it seals its own local files
// (prompt history) through Core: `POST /api/local-content/seal` and `/open`.
// Owner-only (route policy) and loopback-only (checked here), a fixed purpose
// allowlist, 1 MiB per value. Content store `cli-prompt-history`, AAD = the
// purpose. Nothing is stored by Core.

/// Content store for values sealed for local clients.
pub(in crate::server) const LOCAL_CONTENT_STORE: &str = "cli-prompt-history";
/// Purposes a local client may seal or open.
pub(in crate::server) const LOCAL_CONTENT_PURPOSES: &[&str] = &["cli.prompt-history"];
/// Largest plaintext or sealed value accepted.
pub(in crate::server) const LOCAL_CONTENT_MAX_BYTES: usize = 1024 * 1024;
/// Request body limit (the value plus JSON escaping headroom).
pub(in crate::server) const LOCAL_CONTENT_BODY_LIMIT: usize = 3 * LOCAL_CONTENT_MAX_BYTES;

#[derive(serde::Deserialize)]
pub(in crate::server) struct LocalContentRequest {
    pub(in crate::server) purpose: String,
    pub(in crate::server) value: String,
}

/// Owner-only (the route policy) and only from this machine.
pub(in crate::server) fn local_content_guard(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> Option<axum::response::Response> {
    let local = REQUEST_PEER_IS_LOCAL
        .try_with(|local| *local)
        .unwrap_or(false);
    if !local {
        return Some(json_error(
            StatusCode::FORBIDDEN,
            "local content sealing is only available on this machine".to_owned(),
        ));
    }
    if let Some(caller) = caller {
        let owner =
            crate::sidecar::control_plane::registered_node().and_then(|node| node.owner_user_id);
        if owner.is_some_and(|owner| owner != caller.user_id) {
            return Some(json_error(
                StatusCode::FORBIDDEN,
                "only this node's owner can use local content sealing".to_owned(),
            ));
        }
    }
    None
}

pub(in crate::server) fn local_content_check(
    request: &LocalContentRequest,
) -> Result<ryu_crypto::ContentContext, axum::response::Response> {
    if !LOCAL_CONTENT_PURPOSES.contains(&request.purpose.as_str()) {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "unknown local content purpose".to_owned(),
        ));
    }
    if request.value.len() > LOCAL_CONTENT_MAX_BYTES {
        return Err(json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "local content values are limited to 1 MiB".to_owned(),
        ));
    }
    Ok(ryu_crypto::ContentContext::new(request.purpose.clone()))
}

pub(in crate::server) fn local_content_cipher(
) -> Result<ryu_crypto::ContentCipher, axum::response::Response> {
    ryu_crypto::content_cipher(LOCAL_CONTENT_STORE).map_err(|error| {
        tracing::warn!("local content sealing has no key: {error:#}");
        json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "no content key is available".to_owned(),
        )
    })
}

/// `POST /api/local-content/seal` — `{purpose, value}` → `{sealed}` (`encb:v1:`).
pub(in crate::server) async fn local_content_seal(
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(request): Json<LocalContentRequest>,
) -> axum::response::Response {
    if let Some(denied) = local_content_guard(&caller) {
        return denied;
    }
    let context = match local_content_check(&request) {
        Ok(context) => context,
        Err(response) => return response,
    };
    let cipher = match local_content_cipher() {
        Ok(cipher) => cipher,
        Err(response) => return response,
    };
    match cipher.seal_text(&request.value, &context) {
        Ok(sealed) => (
            [(axum::http::header::CACHE_CONTROL, "no-store")],
            Json(json!({ "sealed": sealed })),
        )
            .into_response(),
        Err(error) => {
            tracing::warn!("local content sealing failed: {error:#}");
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "sealing failed".to_owned(),
            )
        }
    }
}

/// `POST /api/local-content/open` — `{purpose, value: sealed}` → `{value}`.
/// Only values this store sealed open; plaintext is refused (the client keeps
/// its own legacy-file migration).
pub(in crate::server) async fn local_content_open(
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(request): Json<LocalContentRequest>,
) -> axum::response::Response {
    if let Some(denied) = local_content_guard(&caller) {
        return denied;
    }
    let context = match local_content_check(&request) {
        Ok(context) => context,
        Err(response) => return response,
    };
    if !ryu_crypto::ContentCipher::is_sealed_text(&request.value) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "the value is not sealed".to_owned(),
        );
    }
    let cipher = match local_content_cipher() {
        Ok(cipher) => cipher,
        Err(response) => return response,
    };
    match cipher.open_text(&request.value, &context) {
        Ok(opened) => (
            [(axum::http::header::CACHE_CONTROL, "no-store")],
            Json(json!({ "value": opened.value, "needsReseal": opened.needs_reseal })),
        )
            .into_response(),
        Err(_) => json_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "the sealed value does not open with this node's key".to_owned(),
        ),
    }
}

/// Delete the Pi and Codex transcripts of a deleted conversation's native agent
/// sessions (both write them in plaintext in their own format) and forget the
/// bindings.
pub(in crate::server) async fn delete_agent_transcripts(conversation_id: &str) {
    let Some(store) = agent_sync::global_store() else {
        return;
    };
    let sessions = match store.native_sessions_for(conversation_id).await {
        Ok(sessions) => sessions,
        Err(error) => {
            tracing::warn!("listing a deleted conversation's agent sessions failed: {error:#}");
            return;
        }
    };
    if !sessions.is_empty() {
        let pi_sessions = sessions.clone();
        let result = tokio::task::spawn_blocking(move || {
            crate::pi_config::transcripts::delete_sessions(
                &crate::pi_config::config_dir(),
                &pi_sessions,
            )
        })
        .await;
        if let Err(error) = result {
            tracing::warn!("deleting Pi transcripts failed: {error}");
        }
        // Codex writes its rollouts in plaintext under the Ryu-owned homes.
        let result = tokio::task::spawn_blocking(move || {
            crate::codex_config::transcripts::delete_sessions(
                &crate::codex_config::transcripts::managed_homes(),
                &sessions,
            )
        })
        .await;
        if let Err(error) = result {
            tracing::warn!("deleting Codex transcripts failed: {error}");
        }
    }
    if let Err(error) = store.forget_acp_bindings(conversation_id).await {
        tracing::warn!("forgetting a deleted conversation's agent sessions failed: {error:#}");
    }
}

/// Snapshot a conversation's transcript and fire `session_end` hooks detached
/// (observation-only). Cheap DB-free early-out when no `session_end` plugin is
/// loaded, so a normal delete pays nothing.
pub(in crate::server) async fn fire_session_end_hooks(state: &ServerState, conversation_id: &str) {
    if !crate::plugin_host::any_manifest_declares(state, crate::plugin_host::ON_SESSION_END).await {
        return;
    }
    let transcript = state
        .conversations
        .get_active_messages(conversation_id)
        .await
        .map(|msgs| {
            msgs.into_iter()
                .map(|m| crate::plugin_host::HookMessage {
                    role: m.role,
                    content: m.content,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let ctx = crate::plugin_host::HookContext {
        conversation_id: Some(conversation_id.to_string()),
        transcript,
        event: Some(json!({ "reason": "deleted" })),
        ..Default::default()
    };
    tokio::spawn(async move {
        let _ = crate::plugin_host::dispatch_global(crate::plugin_host::ON_SESSION_END, ctx).await;
    });
}

#[derive(serde::Deserialize, Default)]
pub(in crate::server) struct ForkConversationBody {
    /// Copy messages up to and including this message id. When omitted, the whole
    /// conversation is copied.
    #[serde(default)]
    pub(in crate::server) message_id: Option<String>,
}

/// `POST /api/conversations/:id/fork`
///
/// "Branch in new chat": copy this conversation's history up to a
/// chosen message into a fresh, independent conversation and return its summary.
/// The caller opens the returned conversation to continue the branch.
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/fork",
    tag = "Conversations",
    summary = "Fork a conversation",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn fork_conversation(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    body: Option<Json<ForkConversationBody>>,
) -> axum::response::Response {
    // Per-resource ACL. Fork was the open door next to the gated `GET`: it COPIES
    // the whole transcript into a new conversation the caller then owns and can
    // read freely, so leaving it ungated handed out any user's history verbatim.
    // READ on the source is the right gate (forking only reads it), and the FORKER
    // — not the source's owner — owns the copy.
    if let Err(resp) = require_resource_read(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    let message_id = body.and_then(|Json(b)| b.message_id);
    // Only an org-bound node scopes rows (see `resource_access`); on a personal node
    // the copy stays untenanted like every other row there.
    match state
        .conversations
        .fork_conversation(&id, message_id.as_deref(), caller_tenancy(&caller))
        .await
    {
        Ok(Some(summary)) => (
            StatusCode::CREATED,
            Json(json!({ "conversation": summary })),
        )
            .into_response(),
        Ok(None) => json_error(
            StatusCode::NOT_FOUND,
            format!("conversation '{id}' or fork message not found"),
        ),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct EditMessageBody {
    /// The new text for the user message.
    pub(in crate::server) content: String,
}

/// `POST /api/conversations/:id/messages/:message_id/edit`
///
/// In-place version-tree edit (ChatGPT/Claude-style): create a new sibling of
/// the named user message carrying `content` and switch the active thread to it.
/// The caller then streams a normal chat turn (with `skip_user_append`) so the
/// reply attaches beneath the edit. Returns the new sibling's id.
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/messages/{message_id}/edit",
    tag = "Conversations",
    summary = "Edit a user message into a new version",
    params(("id" = String, Path), ("message_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn edit_message_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path((id, message_id)): axum::extract::Path<(String, String)>,
    Json(body): Json<EditMessageBody>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    match state
        .conversations
        .edit_user_message(&id, &message_id, &body.content)
        .await
    {
        Ok(Some(new_id)) => Json(json!({ "ok": true, "message_id": new_id })).into_response(),
        Ok(None) => json_error(
            StatusCode::NOT_FOUND,
            format!("user message '{message_id}' not found in conversation '{id}'"),
        ),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
