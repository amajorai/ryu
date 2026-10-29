use super::*;

/// Narrow restricted turns and enforce permission and lifecycle; returns the agent's instructions.
pub(super) async fn enforce_turn_gates(
    req: &mut ChatStreamRequest,
    binding: &mut TurnBinding,
    agent_store: &AgentStore,
) -> Result<Option<String>, Response> {
    let TurnBinding {
        effective_agent_id,
        composio_actions,
        skills_allowlist,
        identity_profile_ids,
        ..
    } = binding;
    if let Some(policy) = req.public_agent_policy.as_ref() {
        if effective_agent_id.as_deref() != Some(policy.agent_id.as_str()) {
            return Err(error_stream(
                "Public agent routing cannot leave its assigned agent".to_owned(),
            ));
        }
        req.enable_long_term = false;
        req.profile_conversation_scope = Some(Vec::new());
        req.composio_connection_scope = Some(Vec::new());
        req.referenced_conversation_ids.clear();
        req.client_tools.clear();
        req.browser_context_consent = false;
        composio_actions.retain(|action| policy.allows("composio", action));
        identity_profile_ids.retain(|profile_id| policy.allows("identity", profile_id));
        restrict_public_agent_skills(skills_allowlist, policy);
    }
    if req.read_only_tools {
        // A read-only app run gets no client-executed or Composio actions: Core
        // cannot prove either side-effect free.
        req.client_tools.clear();
        composio_actions.clear();
    }
    // An unverified caller speaks for nobody on this node. Drop every layer that
    // would hand them the owner's data or accounts before any memory read,
    // model connection or tool bridge is opened; the tool allowlist itself is
    // narrowed per plane below, where it is enforced.
    if req.untrusted_caller {
        req.enable_long_term = false;
        req.referenced_conversation_ids.clear();
        req.client_tools.clear();
        req.browser_context_consent = false;
        composio_actions.clear();
        identity_profile_ids.clear();
        skills_allowlist.clear();
        skills_allowlist.push(crate::agents::NO_AGENT_CAPABILITIES.to_owned());
    }

    // Lifecycle is enforced after every routing/handoff decision and before any
    // memory write, worktree allocation, model connection, or tool bridge is
    // opened. A foreground trial is the one deliberately allowed evaluation
    // path; all background/channel/delegated requests require active. Keep the
    // shared helpers as the authority so direct chat, team members, and future
    // callers cannot drift into subtly different lifecycle rules.
    if let (Some(authorization), Some(agent_id)) = (
        req.agent_resource_authorization.as_ref(),
        effective_agent_id.as_deref(),
    ) {
        if let Err(response) = crate::server::enforce_agent_resource_permission(
            &authorization.state,
            &authorization.caller,
            crate::identity_verify::permissions::AGENT_RUN,
            agent_id,
        )
        .await
        {
            return Err(response);
        }
    }
    // The settled agent's own instructions (its record's `system_prompt`), read
    // from the same row the lifecycle gate loads below. See
    // `agent_instructions_layer` for where they enter the prompt.
    let mut agent_instructions: Option<String> = None;
    if let Some(agent_id) = effective_agent_id.as_deref() {
        let lifecycle = if req.background {
            crate::agent_execution::ensure_noninteractive_run_allowed(agent_store, Some(agent_id))
                .await
        } else {
            crate::agent_execution::ensure_foreground_run_allowed(agent_store, Some(agent_id)).await
        };
        if let Err(error) = lifecycle {
            return Err(error_stream(error.to_string()));
        }
        match agent_store.get(agent_id).await {
            Ok(Some(record)) => {
                if record.lifecycle_status == crate::agents::AgentLifecycleStatus::Trial
                    || record.safety_profile == crate::agents::AgentSafetyProfile::ReadOnly
                {
                    // Evaluation/read-only turns may inspect existing memory but
                    // must not create durable facts or mirror raw text out.
                    req.enable_long_term = false;
                }
                agent_instructions = record
                    .system_prompt
                    .map(|prompt| prompt.trim().to_owned())
                    .filter(|prompt| !prompt.is_empty());
            }
            Ok(None) => {
                return Err(error_stream(format!("Unknown agent: {agent_id}")));
            }
            Err(error) => {
                tracing::warn!(agent_id, "failed to load agent lifecycle: {error:#}");
                return Err(error_stream(
                    "Unable to load the selected agent's lifecycle.".to_owned(),
                ));
            }
        }
    }
    Ok(agent_instructions)
}

/// Persist the accepted user turn before any model work; returns its message id.
pub(super) async fn persist_user_turn(
    req: &ChatStreamRequest,
    conversations: &ConversationStore,
    user_text: &str,
    widget_provenance: &Option<crate::server::conversations::MessageProvenance>,
) -> Option<String> {
    // Persist the latest user turn after routing and lifecycle gates have
    // accepted it, so a rejected Draft or non-active background turn cannot
    // leave a durable message behind. It still happens before model work, so
    // history survives if the connection drops mid-stream. Skipped when
    // `persist` is false because the team orchestrator records the user turn
    // once itself and runs each member without duplicate rows.
    let mut persisted_user_message_id: Option<String> = None;
    if req.persist && !req.skip_user_append {
        if let Some(conversation_id) = req.conversation_id.clone() {
            let user_message = req
                .messages
                .iter()
                .rev()
                .find(|message| message.role == "user");
            let user_parts = user_message.and_then(UiMessage::render_parts);
            if !user_text.is_empty() || user_parts.is_some() {
                match conversations
                    .append_message_as_with_render_data(
                        &conversation_id,
                        "user",
                        user_text,
                        req.agent_id.as_deref(),
                        // Verified human author (Phase 0): stamped from the request's
                        // user JWT in `chat_stream`. `None` in the anonymous /
                        // loopback flow, which keeps the single-tenant behavior.
                        req.author_user_id.as_deref(),
                        // Unverified sender display name for group/channel chats.
                        req.author_name.as_deref(),
                        // Tenancy is stamped UPSTREAM, before this ever runs:
                        // `chat_stream` gates + claims the conversation
                        // (`gate_and_claim_conversation`) so the row already carries
                        // its owner. The choke point COALESCEs, so passing
                        // `Unattributed` here preserves that owner and never wipes it.
                        Tenancy::Unattributed,
                        widget_provenance.as_ref(),
                        req.client_id.as_deref(),
                        user_parts.as_ref(),
                        user_message.and_then(|message| message.metadata.as_ref()),
                    )
                    .await
                {
                    Ok(message_id) => persisted_user_message_id = Some(message_id),
                    Err(e) => tracing::warn!("failed to persist user message: {e:#}"),
                }
            }
        }
    }
    persisted_user_message_id
}

/// The persona tone prefix and the turn's output-style prefix.
pub(super) fn resolve_turn_style(
    req: &ChatStreamRequest,
    persona: &Option<PersonaSlot>,
    agent_instructions: &Option<String>,
) -> (Option<String>, Option<String>) {
    // Build persona tone prefix (#410). Merged into the system prompt before
    // dispatching — prepended to long_term_system for both adapters.
    let persona_prefix = persona_tone_prefix(persona.as_ref());

    // The output style for this turn (docs/output-styles.md §5), resolved ONCE here
    // for both planes. Only the *text* is computed at this point — the injection
    // happens further down, per plane, because the style has to land in front of the
    // skills block and the skills block is folded in later.
    //
    // Resolved per turn, after routing policy has settled the agent: a rule that
    // swapped agents mid-turn changes whose base instructions
    // `keep-coding-instructions` composes against.
    //
    // Scope (design §5): the style applies to the MAIN conversation only, so every
    // programmatic sub-turn is skipped — a delegated subagent's or team member's
    // reply is structured text the parent parses back, and reshaping it would corrupt
    // that. `background` is the existing discriminant for exactly this class
    // (sub-agent fan-out, worker, scheduled run), and skipping here rather than at the
    // construction sites keeps profile injection off those turns.
    let resolved_style = if req.background {
        None
    } else {
        output_style_for_turn(
            req.output_style.as_deref(),
            // The selected agent owns its profile. A missing profile is an explicit
            // "agent's own voice" state; there is no node-wide fallback here.
            persona
                .as_ref()
                .and_then(|value| value.output_style_id.as_deref()),
        )
    };
    let style_prefix = match resolved_style {
        Some(record) => {
            let prefix = output_style_prefix(&record, agent_instructions.as_deref());
            if prefix.is_some() {
                tracing::debug!(
                    style = %record.id,
                    keep_coding_instructions = record.keep_coding_instructions,
                    "output style applied to this turn"
                );
            }
            prefix
        }
        None => None,
    };
    (persona_prefix, style_prefix)
}
