use super::*;

/// Refuse a turn whose cloud or project-environment context is not allowed to run.
pub(super) async fn admit_chat_turn(
    req: &mut ChatStreamRequest,
    conversations: &ConversationStore,
) -> Result<(), Response> {
    if let Err(error) = capture_acp_conversation_generation(req, conversations).await {
        return Err(error_stream(error));
    }

    let server_bound_cloud = match req.conversation_id.as_deref() {
        Some(id) => crate::server::cloud_tasks::has_bound_task(id).await,
        None => false,
    };
    if (req.cloud_environment_id.is_some() || server_bound_cloud)
        && req.cloud_task_context.is_none()
    {
        return Err(error_stream("Cloud conversations require the authenticated cloud execution context; host fallback is disabled.".to_owned()));
    }
    if let Some(context) = req.cloud_task_context.as_ref() {
        if req.cloud_authorization.is_none()
            || req.cloud_environment_id.as_deref() != Some(context.environment_id.as_str())
        {
            return Err(error_stream(
                "Cloud execution context is invalid.".to_owned(),
            ));
        }
        req.cwd = None;
        req.workspace_folders.clear();
        req.branch = None;
        req.project_environment = None;
        req.worktree_isolation = false;
        req.worktree_path = None;
        req.worktree_branch = None;
        req.client_tools.clear();
        req.browser_context_consent = false;
    }
    if req
        .project_environment
        .as_ref()
        .is_some_and(ProjectEnvironmentRequest::contains_scripts)
    {
        return Err(error_stream(
            "Project environment setup and cleanup scripts are disabled for security; use a local action or a reviewed project instruction instead".to_owned(),
        ));
    }
    Ok(())
}

/// What the turn knows once its agent is chosen (`target_agent_id` and the "auto" sentinel).
pub(super) struct TurnAgentStart {
    pub(super) user_text: String,
    pub(super) durable_conversation: bool,
    pub(super) widget_provenance: Option<crate::server::conversations::MessageProvenance>,
    pub(super) provider_reg: ProviderRegistry,
    pub(super) effective_agent_id: Option<String>,
}

/// Log the request, read its durable/provenance facts and resolve the turn's agent.
pub(super) async fn resolve_turn_agent(
    req: &ChatStreamRequest,
    conversations: &ConversationStore,
) -> TurnAgentStart {
    tracing::info!(
        agent_id = ?req.agent_id,
        conversation_id = ?req.conversation_id,
        msg_count = req.messages.len(),
        enable_long_term = req.enable_long_term,
        last_role = req.messages.last().map(|m| m.role.as_str()),
        last_content_bytes = req.messages.last().map(|m| m.content.as_text().len()),
        last_parts_count = req.messages.last().map(|m| m.parts.len()),
        "route_chat_stream: received request"
    );

    let user_text = last_user_message(&req.messages);
    // A normal turn is allowed to create its row later in this function, but a
    // non-persisted turn may only reuse a conversation that an orchestrator has
    // already created (team members). This keeps client-held temporary chats from
    // becoming durable through participant/status/trace side effects.
    let durable_conversation = if req.persist {
        req.conversation_id.is_some()
    } else {
        match req.conversation_id.as_deref() {
            Some(conversation_id) => conversations
                .get_access_meta(conversation_id)
                .await
                .ok()
                .flatten()
                .is_some(),
            None => false,
        }
    };
    let widget_provenance =
        req.widget_provenance
            .as_ref()
            .map(|p| crate::server::conversations::MessageProvenance {
                source: p.source.to_owned(),
                widget_instance_id: p.widget_instance_id.clone(),
                origin_server: p.origin_server.clone(),
            });

    // Load the unified provider/model/strategy registry (env > file > literal).
    // This is the single source of truth for the default chat base_url and model.
    let provider_reg = ProviderRegistry::load();

    // Resolve the effective agent for this turn: if `target_agent_id` is set,
    // auto-add it as a participant and route this message to it (#414). Otherwise
    // use the primary `agent_id` (backward compatible).
    let effective_agent_id: Option<String> = if let Some(ref target) = req.target_agent_id {
        // Auto-register the target as a participant in this conversation.
        if durable_conversation {
            if let Some(ref conv_id) = req.conversation_id {
                // The conversation row already exists and is stamped by
                // `gate_and_claim_conversation` upstream; COALESCE preserves its owner.
                if let Err(e) = conversations
                    .add_participant(conv_id, target, Tenancy::Unattributed)
                    .await
                {
                    tracing::warn!("failed to add participant {target}: {e:#}");
                }
            }
        }
        Some(target.clone())
    } else {
        req.agent_id.clone()
    };

    // Plane B agent-auto routing (spec §2): when the selected agent is the "auto"
    // sentinel, resolve a concrete agent id for this turn FIRST, then continue
    // exactly as if the user had picked it — the binding, memory scope, route,
    // session keying, and persistence below all read this resolved id. Runs before
    // `resolve_binding` so the resolved agent's engine/model binding is loaded.
    // Always yields a concrete id (fails open to `default_agent_id`, else "ryu").
    let effective_agent_id = if effective_agent_id.as_deref()
        == Some(crate::agent_routing::AUTO_AGENT_ID)
    {
        let resolved =
            crate::agent_routing::resolve_auto_agent(&user_text, req.conversation_id.as_deref())
                .await;
        tracing::info!(resolved_agent = %resolved, "agent-auto: resolved 'auto' to concrete agent");
        // Register the resolved agent as a participant so the conversation reflects
        // which agent actually handled the turn (mirrors the target_agent_id path).
        if durable_conversation {
            if let Some(ref conv_id) = req.conversation_id {
                if let Err(e) = conversations
                    .add_participant(conv_id, &resolved, Tenancy::Unattributed)
                    .await
                {
                    tracing::warn!(
                        "agent-auto: failed to add resolved participant {resolved}: {e:#}"
                    );
                }
            }
        }
        Some(resolved)
    } else {
        effective_agent_id
    };
    TurnAgentStart {
        user_text,
        durable_conversation,
        widget_provenance,
        provider_reg,
        effective_agent_id,
    }
}
