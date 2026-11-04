//! Session handlers, agent-thread imports and setup-import items: `import_agent_thread_handler` through `import_agent_thread_inner`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Import one native thread into a Ryu conversation: read the agent's on-disk
/// transcript and persist it as conversation messages, stamping the origin + the
/// agent-native session id (for a future `session/load` resume). Re-importing the
/// same native thread appends only messages added since the previous import.
/// Returns the conversation id so the client can open it.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/threads/import",
    tag = "Agents",
    summary = "Import a native thread into a Ryu conversation",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Agent view or edit permission required", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn import_agent_thread_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(agent_id): axum::extract::Path<String>,
    Json(body): Json<ImportThreadBody>,
) -> axum::response::Response {
    if let Err(response) = enforce_agent_resource_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
        &agent_id,
    )
    .await
    {
        return response;
    }
    if let Err(response) = enforce_agent_resource_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
        &agent_id,
    )
    .await
    {
        return response;
    }
    if let Some(response) = native_history_access_denied(caller.as_ref()) {
        return response;
    }
    import_agent_thread_inner(&state, &caller, agent_id, body, None).await
}

/// Import a native thread from the in-process sync worker. This is deliberately
/// separate from the HTTP handler: the worker has an explicit service context,
/// while the HTTP path must continue to require a verified human caller on a
/// registered node.
pub(crate) async fn import_agent_thread_for_sync(
    state: &ServerState,
    agent_id: String,
    thread_id: String,
) -> axum::response::Response {
    let tenancy = crate::sidecar::control_plane::registered_org()
        .map(|org| conversations::Tenancy::shared_with_org(&org.id));
    import_agent_thread_inner(
        state,
        &None,
        agent_id,
        ImportThreadBody {
            thread_id,
            dry_run: false,
        },
        tenancy,
    )
    .await
}

pub(in crate::server) async fn import_agent_thread_inner(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    agent_id: String,
    body: ImportThreadBody,
    tenancy_override: Option<conversations::Tenancy>,
) -> axum::response::Response {
    let engine = match resolve_registered_agent_engine(&state, &agent_id) {
        Some(e) => e,
        None => return json_error(StatusCode::BAD_REQUEST, "unknown agent".to_string()),
    };
    let thread_id = body.thread_id.clone();
    let read = tokio::task::spawn_blocking({
        let engine = engine.clone();
        move || crate::native_history::read_thread(&engine, &thread_id)
    })
    .await;
    let imported = match read {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => return json_error(StatusCode::NOT_FOUND, e.to_string()),
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if imported.messages.is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "thread has no messages".to_string(),
        );
    }

    let tenancy = tenancy_override
        .clone()
        .unwrap_or_else(|| caller_tenancy(caller));
    // Dedup + sync: a repeat import of the same agent-native thread updates the
    // existing Ryu conversation with the source transcript's new tail.
    let origin = format!("import:{engine}");
    if let Some(native_id) = imported.thread.native_session_id.as_deref() {
        match state
            .conversations
            .find_imported_conversation_with_generation(&origin, native_id, &tenancy)
            .await
        {
            Ok(Some((existing, generation))) => {
                // The tenancy key prevents cross-owner matches. Keep the
                // canonical conversation write check as defense in depth for
                // resource ACL denies and stale rows. The sync service is an
                // explicit SharedOrg writer; its scoped query cannot match a
                // private human import.
                let service_reuse = matches!(
                    tenancy_override.as_ref(),
                    Some(conversations::Tenancy::SharedOrg { .. })
                );
                let caller_can_update = if service_reuse {
                    true
                } else {
                    match import_reuse_permission(require_resource_write(
                        state.conversations.get_access_meta(&existing).await,
                        caller.as_ref(),
                        "conversation not found",
                    )) {
                        Ok(can_update) => can_update,
                        Err(response) => return response,
                    }
                };
                if caller_can_update {
                    let existing_messages = match state.conversations.get_messages(&existing).await
                    {
                        Ok(messages) => messages,
                        Err(e) => {
                            return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
                        }
                    };
                    let missing_messages =
                        missing_imported_message_tail(&existing_messages, &imported.messages);
                    let messages_added = missing_messages.len();
                    if body.dry_run {
                        return Json(json!({
                            "conversation_id": existing,
                            "agent_id": agent_id,
                            "engine": engine,
                            "message_count": imported.messages.len(),
                            "messages_added": messages_added,
                            "truncated": imported.truncated,
                            "title": imported.thread.title,
                            "cwd": imported.thread.cwd,
                            "already_imported": true,
                            "dry_run": true,
                            "would_create": false,
                        }))
                        .into_response();
                    }
                    for msg in missing_messages {
                        if let Err(e) = state
                            .conversations
                            .append_imported_message_at(
                                &existing,
                                &generation,
                                &msg.role,
                                &msg.content,
                                Some(&agent_id),
                                tenancy.clone(),
                                msg.created_at,
                            )
                            .await
                        {
                            return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
                        }
                    }
                    if messages_added > 0 {
                        crate::events::publish_system_notification_for_user(
                            "Thread import updated",
                            format!(
                                "{} synced {messages_added} new messages from {engine}.",
                                imported.thread.title
                            ),
                            "success",
                            caller.as_ref().map(|verified| verified.user_id.clone()),
                        );
                    }
                    if let Some(native_id) = imported.thread.native_session_id.as_deref() {
                        crate::server::agent_sync::remember_native_session(
                            &existing,
                            &generation,
                            &agent_id,
                            &engine,
                            native_id,
                            imported.thread.cwd.as_deref(),
                        );
                    }
                    return Json(json!({
                        "conversation_id": existing,
                        "agent_id": agent_id,
                        "engine": engine,
                        "message_count": imported.messages.len(),
                        "messages_added": messages_added,
                        "truncated": imported.truncated,
                        "title": imported.thread.title,
                        "cwd": imported.thread.cwd,
                        "already_imported": true,
                        "dry_run": false,
                        "would_create": false,
                    }))
                    .into_response();
                }
            }
            Ok(None) => {}
            Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        }
    }

    if body.dry_run {
        return Json(json!({
            "conversation_id": Value::Null,
            "agent_id": agent_id,
            "engine": engine,
            "message_count": imported.messages.len(),
            "messages_added": imported.messages.len(),
            "truncated": imported.truncated,
            "title": imported.thread.title,
            "cwd": imported.thread.cwd,
            "already_imported": false,
            "dry_run": true,
            "would_create": true,
        }))
        .into_response();
    }

    let conversation_id = format!("conv_{}", uuid::Uuid::new_v4());
    // Per-resource ACL: import is a conversation-CREATION site like `chat_stream`
    // and `fork`, so it must stamp tenancy too. Without this the imported thread is
    // untenanted, which `resource_access` denies to EVERYONE on an org-bound node —
    // the importer would 403 out of the thread they just imported. No-op on a
    // personal node (see `caller_tenancy`).
    let generation = match state
        .conversations
        .ensure_conversation_with_generation(
            &conversation_id,
            Some(&agent_id),
            Some(&imported.thread.title),
            tenancy.clone(),
        )
        .await
    {
        Ok(generation) => generation,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if let Some(native_id) = imported.thread.native_session_id.as_deref() {
        crate::server::agent_sync::remember_native_session(
            &conversation_id,
            &generation,
            &agent_id,
            &engine,
            native_id,
            imported.thread.cwd.as_deref(),
        );
    }
    for msg in &imported.messages {
        if let Err(e) = state
            .conversations
            .append_imported_message_at(
                &conversation_id,
                &generation,
                &msg.role,
                &msg.content,
                Some(&agent_id),
                tenancy.clone(),
                // When the turn actually happened, per the agent's own transcript.
                // `None` for a line that carried no parseable timestamp, which falls
                // back to now — the old behaviour, but now only for the messages
                // that genuinely have no recorded time rather than for all of them.
                msg.created_at,
            )
            .await
        {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    }
    // Group the imported conversation under the workspace folder the thread ran
    // in (Claude Code / Codex both record a `cwd`), plus its git branch. Without
    // this the chat lands loose in "Chats" instead of nested under its project —
    // the sidebar buckets conversations by `folder_path`, so stamping it here is
    // what makes an imported (or auto-imported) thread appear in the right folder.
    if imported.thread.cwd.is_some() || imported.thread.git_branch.is_some() {
        if let Err(e) = state
            .conversations
            .set_run_metadata(
                &conversation_id,
                imported.thread.cwd.as_deref(),
                imported.thread.git_branch.as_deref(),
                None,
            )
            .await
        {
            tracing::warn!("import: failed to set folder for {conversation_id}: {e:#}");
        }
    }
    if let Err(e) = state
        .conversations
        .set_import_source(
            &conversation_id,
            &origin,
            imported.thread.native_session_id.as_deref(),
        )
        .await
    {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    // Preserve the title even though append_message derives one from the first
    // user turn — a native summary is a better title when present. set_title
    // marks it custom so the background auto-namer never clobbers it.
    if let Err(e) = state
        .conversations
        .set_title(&conversation_id, &imported.thread.title)
        .await
    {
        tracing::warn!("import: failed to set title for {conversation_id}: {e:#}");
    }

    crate::events::publish_system_notification_for_user(
        "Thread imported",
        format!("{} is ready from {engine}.", imported.thread.title),
        "success",
        caller.as_ref().map(|verified| verified.user_id.clone()),
    );

    Json(json!({
        "conversation_id": conversation_id,
        "agent_id": agent_id,
        "engine": engine,
        "message_count": imported.messages.len(),
        "messages_added": imported.messages.len(),
        "truncated": imported.truncated,
        "title": imported.thread.title,
        "cwd": imported.thread.cwd,
        "already_imported": false,
        "dry_run": false,
        "would_create": true,
    }))
    .into_response()
}
