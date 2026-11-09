//! Assistant-first opening, channel bot runs, the channel command registry and background processes: `channel_run` through `channel_run`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/channels/run` — non-streaming channel bot entry point (M11 / #226).
///
/// Channel bots (Telegram, Slack, WhatsApp, Discord) call this endpoint with a
/// `(conversation_id, agent_id, text)` turn and receive `reply`, durable assistant
/// message ids, and optional `interactiveMarkup` from a plugin or app turn hook.
/// Markup supports plain-text quick replies and typed callback actions; the
/// callback arrives on a later request as the untrusted `channelAction` field.
/// Unsupported channel adapters can degrade markup to the reply text. Model calls
/// still flow Core → Gateway so the governance layer (firewall, DLP, budgets,
/// audit) governs every bot-initiated call. `idempotencyKey` is the provider
/// delivery identity; when supplied, Core stores and replays the completed result,
/// including markup, rather than running the model twice, so a retried delivery
/// with the same key does not append another user message. The durable assistant
/// ids let a channel bind a later provider reaction to this exact turn after it
/// sends the reply.
#[utoipa::path(
    post,
    path = "/api/channels/run",
    tag = "Chat",
    summary = "Run a channel-bot inbound message turn",
    request_body = ChannelRunRequest,
    responses((status = 200, description = "OK", body = ChannelRunResponse))
)]
pub(in crate::server) async fn channel_run(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(mut req): Json<ChannelRunRequest>,
) -> axum::response::Response {
    // An enrolled node whose registration is pending, failed or revoked is not an
    // unbound personal node. Running the turn now would hand the caller an
    // unrestricted tool principal, free agent choice and orphaned rows, so the
    // bot door fails closed (like `enforce_permission`) until the binding resolves.
    if crate::sidecar::node_binding::binding_unresolved() {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "this node's organization binding is not resolved yet; retry shortly".to_owned(),
        );
    }
    let admission = match crate::execution_control::admit() {
        Ok(admission) => admission,
        Err(message) => return json_error(StatusCode::CONFLICT, message.to_owned()),
    };
    if !crate::sidecar::adapters::acp::is_safe_host_conversation_id(&req.conversation_id) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "conversation_id must be 1-128 ASCII letters, digits, '.', '_' or '-'".to_owned(),
        );
    }
    if let Some(action) = req.channel_action.as_ref() {
        if let Err(error) = action.validate() {
            return json_error(StatusCode::BAD_REQUEST, error);
        }
    }
    // Per-resource ACL (machine-ingress variant). `conversation_id` is caller-supplied
    // here too, so without this a node-token holder could pass a HUMAN's conversation
    // id and have that thread's history loaded as context and their turn appended
    // into it — the `chat_stream` bypass through the bot door. Bot conversations
    // themselves carry no human owner and stay reachable; see
    // `require_conversation_write_if_owned`.
    if let Err(resp) =
        require_conversation_write_if_owned(&state, &caller, &req.conversation_id).await
    {
        return resp;
    }
    let team_id = req.team_id.clone().filter(|value| !value.trim().is_empty());
    let node_bound = crate::sidecar::node_binding::node_bound_for_tenancy();
    if team_id.is_some() {
        return json_error(
            StatusCode::FORBIDDEN,
            "channel team fan-out requires a verified team/member binding; the channel ingress does not yet carry that proof".to_owned(),
        );
    }
    if node_bound
        && req.agent_id.as_deref().is_some_and(|agent_id| {
            agent_id.trim() != crate::registry::ProviderRegistry::load().default_agent_id
        })
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "channel agent selection requires a verified agent binding; explicit agent selection is disabled on managed nodes".to_owned(),
        );
    }
    let (effective_agent_id, fallback_warning) = if team_id.is_none() {
        match resolve_channel_agent(&state.agent_store, req.agent_id.clone()).await {
            Ok(resolved) => resolved,
            Err(error) => {
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
            }
        }
    } else {
        (req.agent_id.clone(), None)
    };
    req.agent_id = effective_agent_id.clone();

    // Claim the provider delivery before creating/running the Core turn. A
    // duplicate after a Gateway or provider timeout receives the exact durable
    // result instead of appending another user message and invoking the model a
    // second time. The hash makes accidental reuse of one key for different
    // payloads a visible conflict rather than silent data loss.
    let idempotency_key = req
        .idempotency_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_owned);
    if let Some(idempotency_key) = idempotency_key.as_deref() {
        let request_hash = ryu_tracing::hash_args(&json!({
            "conversation_id": &req.conversation_id,
            "channel_id": req.channel_id.as_deref(),
            "agent_id": effective_agent_id.as_deref(),
            "team_id": team_id.as_deref(),
            "text": &req.text,
            "author_name": req.author_name.as_deref(),
            "channel_action": req.channel_action.as_ref(),
        }));
        match state
            .conversations
            .claim_channel_turn(idempotency_key, &req.conversation_id, &request_hash)
            .await
        {
            Ok(ChannelTurnClaim::Claimed) => {}
            Ok(ChannelTurnClaim::InFlight) => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({
                        "error": "channel turn is already in flight",
                        "code": "channel_turn_in_flight",
                    })),
                )
                    .into_response();
            }
            Ok(ChannelTurnClaim::Completed(replay)) => {
                let agent_reactions =
                    channel_turn_agent_reactions(&state.conversations, &req.conversation_id).await;
                return Json(json!({
                    "reply": replay.reply,
                    "assistantMessageId": replay.assistant_message_id,
                    "assistantMessageIds": replay.assistant_message_ids,
                    "agentId": replay.agent_id,
                    "fallbackWarning": replay.fallback_warning,
                    "interactiveMarkup": replay.interactive_markup,
                    "agentReactions": agent_reactions,
                }))
                .into_response();
            }
            Err(error) => {
                return json_error(StatusCode::CONFLICT, error.to_string());
            }
        }
    }

    if let Some(channel_id) = req.channel_id.as_deref() {
        if let Err(error) = state
            .conversations
            .ensure_channel_conversation(
                &req.conversation_id,
                channel_id,
                effective_agent_id.as_deref(),
                node_org_id().as_deref(),
            )
            .await
        {
            if let Some(idempotency_key) = idempotency_key.as_deref() {
                let _ = state
                    .conversations
                    .release_channel_turn(idempotency_key)
                    .await;
            }
            // An existing owned human conversation is never converted into a
            // channel session: the stamp would open it to every channel writer.
            if error
                .downcast_ref::<crate::server::conversations::ChannelAttachRefused>()
                .is_some()
            {
                return json_error(StatusCode::FORBIDDEN, error.to_string());
            }
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("could not create channel session: {error}") })),
            )
                .into_response();
        }
    }

    // A non-empty team_id targets a whole team (lead orchestrates members) and
    // takes precedence over agent_id; otherwise route to a single agent.
    let result = if let Some(team_id) = team_id.as_deref() {
        let capabilities =
            crate::sidecar::capability_consumer::CapabilityConsumer::from_state(&state);
        match crate::agent_teams::resolve_team(&capabilities, team_id).await {
            Ok(Some(team)) => {
                run_team_reply_text(
                    req.conversation_id.clone(),
                    team,
                    req.text,
                    req.author_name,
                    Arc::clone(&state.agents),
                    state.conversations.clone(),
                    state.agent_store.clone(),
                    Arc::clone(&state.manager),
                    state.memory.clone(),
                    Arc::clone(&state.worktree_diffs),
                    Arc::clone(&state.mcp),
                    state.skills.clone(),
                    state.traces.clone(),
                )
                .await
            }
            Ok(None) => Err(anyhow::anyhow!("team '{team_id}' not found")),
            Err(e) => Err(e),
        }
    } else {
        crate::sidecar::adapters::run_reply_text_with_channel_action(
            req.conversation_id.clone(),
            req.agent_id,
            req.text,
            req.author_name,
            Arc::clone(&state.agents),
            state.conversations.clone(),
            state.agent_store.clone(),
            Arc::clone(&state.manager),
            state.memory.clone(),
            Arc::clone(&state.worktree_diffs),
            Arc::clone(&state.mcp),
            state.skills.clone(),
            state.traces.clone(),
            req.channel_action,
        )
        .await
    };

    // An agent may acknowledge cancellation by finishing with partial text.
    // Never deliver that text to a bot, even if execution has since resumed.
    if admission.is_cancelled() {
        if let Some(idempotency_key) = idempotency_key.as_deref() {
            let _ = state
                .conversations
                .release_channel_turn(idempotency_key)
                .await;
        }
        return json_error(
            StatusCode::CONFLICT,
            crate::execution_control::PAUSED_MESSAGE.to_owned(),
        );
    }

    match result {
        Ok(result) => {
            if let Some(idempotency_key) = idempotency_key.as_deref() {
                let replay = ChannelTurnReplay {
                    reply: result.reply.clone(),
                    assistant_message_id: result.assistant_message_id.clone(),
                    assistant_message_ids: result.assistant_message_ids.clone(),
                    agent_id: effective_agent_id.clone(),
                    fallback_warning: fallback_warning.clone(),
                    interactive_markup: result.interactive_markup.clone(),
                };
                if let Err(error) = state
                    .conversations
                    .complete_channel_turn(idempotency_key, &replay)
                    .await
                {
                    return json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("could not persist channel turn result: {error}"),
                    );
                }
            }
            let agent_reactions =
                channel_turn_agent_reactions(&state.conversations, &req.conversation_id).await;
            Json(json!({
                "reply": result.reply,
                "assistantMessageId": result.assistant_message_id,
                "assistantMessageIds": result.assistant_message_ids,
                "agentId": effective_agent_id,
                "fallbackWarning": fallback_warning,
                "interactiveMarkup": result.interactive_markup,
                "agentReactions": agent_reactions,
            }))
            .into_response()
        }
        Err(e) => {
            if let Some(idempotency_key) = idempotency_key.as_deref() {
                let _ = state
                    .conversations
                    .release_channel_turn(idempotency_key)
                    .await;
            }
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response()
        }
    }
}
