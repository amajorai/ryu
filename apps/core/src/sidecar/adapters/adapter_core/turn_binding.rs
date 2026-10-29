use super::*;

/// Per-modality slot selections resolved from a carded agent's `AgentRecord`.
///
/// These are forwarded to the Gateway as `x-ryu-slot-*` headers so the Gateway
/// can route each modality call to the provider the agent card specifies, rather
/// than the static `modality_map` default. An unset slot means "use the gateway's
/// configured default for that modality" and no header is sent for it.
///
/// Chat, image, TTS, and STT slots are all carried here. For chat, the provider
/// is resolved from `chat_model.engine` (which doubles as the gateway provider
/// identifier, e.g. `"openai"`, `"anthropic"`, `"local"`). On the gateway side
/// `pre_process` calls `route_modality_with_slot(Chat, ...)` when a chat slot
/// is present, so the agent card's chat provider wins over eval/model routing.
#[derive(Debug, Clone, Default)]
pub struct AgentSlots {
    /// Chat-generation slot: `(provider, model)`. Provider is the gateway
    /// ProviderKind string (openai, anthropic, local, openrouter, core).
    pub chat: Option<(String, Option<String>)>,
    /// Image-generation slot: `(provider, model)`. Both may be `None`.
    pub image: Option<(String, Option<String>)>,
    /// Video-generation slot: `(provider, model)`. Both may be `None`.
    pub video: Option<(String, Option<String>)>,
    /// Text-to-speech slot: `(provider, model)`. Both may be `None`.
    pub tts: Option<(String, Option<String>)>,
    /// Speech-to-text slot: `(provider, model)`. Both may be `None`.
    pub stt: Option<(String, Option<String>)>,
}

/// Resolve the engine an agent is bound to. Built-in agents are seeded into the
/// store with `engine = id`, and custom agents carry an explicit `engine`; either
/// way the store is the source of truth for the binding. We also surface the
/// agent's `model`, which a local-engine request needs, its per-attribute
/// modality slots (M3 / #164) so the Gateway can route each call independently,
/// and the persona slot (#410) so the caller can build a tone prefix for the system
/// prompt. Falls back to treating `agent_id` itself as the engine so clients that
/// pass a registry id directly (the legacy path) keep working even before any store
/// row exists.
/// Everything [`resolve_binding`] resolves for a turn, plus the agent it was
/// resolved for. Named so the fallback-policy hook can hand the whole set back
/// after a rule may have moved the turn to a different agent.
pub(crate) type ResolvedTurnBinding = (
    Option<String>,
    Option<String>,
    Option<String>,
    AgentSlots,
    Option<PersonaSlot>,
    Vec<String>,
    Vec<String>,
    Vec<String>,
);

/// Apply the node's threshold fallback rules to one turn.
///
/// Returns the binding to actually run with. When no rule fires — the case on
/// every node that has not configured this — the inputs come straight back out
/// and nothing was read, computed or spawned.
///
/// **What a fired rule may change.** A rule whose target names only a model
/// swaps the model and keeps the agent. That is the case this feature is really
/// about, and the ACP plane supports it natively: `req.acp_model` is the
/// per-turn `session/set_model` pin the composer's picker already writes, so
/// pinning it here is indistinguishable from the user having picked that model
/// themselves. A rule whose target names a different *agent* is heavier — an ACP
/// agent owns its own thread state, so switching vendors mid-conversation
/// silently starts a new session and loses the thread the user is looking at.
/// Those swaps are therefore applied only at the START of a conversation. That
/// gate is NOT implemented here but inside the evaluator
/// (`routing_policy::Target::at_conversation_start`), so the composer's info bar
/// — which runs the same evaluator — predicts exactly what this does instead of
/// announcing a switch the turn then declines to make.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn apply_routing_policy(
    agent_id: Option<String>,
    engine: Option<String>,
    model: Option<String>,
    agent_slots: AgentSlots,
    persona: Option<PersonaSlot>,
    composio_actions: Vec<String>,
    skills_allowlist: Vec<String>,
    identity_profile_ids: Vec<String>,
    req: &mut ChatStreamRequest,
    agent_store: &AgentStore,
) -> ResolvedTurnBinding {
    let unchanged = |agent_id, engine, model, slots, persona, composio, skills, identities| {
        (
            agent_id, engine, model, slots, persona, composio, skills, identities,
        )
    };
    let Some(state) = crate::learning::global_state() else {
        return unchanged(
            agent_id,
            engine,
            model,
            agent_slots,
            persona,
            composio_actions,
            skills_allowlist,
            identity_profile_ids,
        );
    };

    // The turn as the user aimed it: the composer's per-turn model pin when
    // there is one, else whatever the agent's binding says.
    let target = crate::routing_policy::Target {
        agent_id: agent_id.clone().unwrap_or_default(),
        model: req
            .acp_model
            .clone()
            .filter(|m| !m.trim().is_empty())
            .or_else(|| model.clone())
            .unwrap_or_default(),
        // `messages` carries the client's history for this thread and the current
        // user turn is the last entry, so "one message" is the first turn of a
        // conversation. Free, and it avoids a store round-trip on every turn.
        at_conversation_start: req.conversation_id.is_none() || req.messages.len() <= 1,
    };
    let advice = crate::routing_policy::advice_for_turn(&state.preferences, &target).await;
    if !advice.swaps() {
        if advice.severity == crate::routing_policy::Severity::Warn {
            tracing::info!(reason = ?advice.reason, "routing policy: headroom warning");
        }
        return unchanged(
            agent_id,
            engine,
            model,
            agent_slots,
            persona,
            composio_actions,
            skills_allowlist,
            identity_profile_ids,
        );
    }

    let switches_agent = !advice
        .effective
        .agent_id
        .eq_ignore_ascii_case(&target.agent_id);

    tracing::info!(
        rule = ?advice.rule_id,
        from_agent = %target.agent_id,
        from_model = %target.model,
        to_agent = %advice.effective.agent_id,
        to_model = %advice.effective.model,
        reason = ?advice.reason,
        "routing policy: fallback applied"
    );

    // Pin the model on BOTH planes. `acp_model` is the ACP session pin; the
    // binding `model` is what the OpenAI-compat / local-engine routes put in the
    // request body. Each plane ignores the other's field, so setting both is how
    // one rule governs a turn whose route is not yet decided here.
    let new_model = (!advice.effective.model.is_empty()).then(|| advice.effective.model.clone());
    if !switches_agent {
        if let Some(ref m) = new_model {
            req.acp_model = Some(m.clone());
        }
        return unchanged(
            agent_id,
            engine,
            new_model.clone().or(model),
            agent_slots,
            persona,
            composio_actions,
            skills_allowlist,
            identity_profile_ids,
        );
    }

    // Cross-agent: re-resolve the whole binding for the agent we moved to, or
    // the new agent would run with the old one's engine, persona, skills and
    // identity bindings.
    let new_agent_id = advice.effective.agent_id.clone();
    let (engine, resolved_model, agent_slots, persona, composio_actions, skills, identities) =
        resolve_binding(&new_agent_id, agent_store).await;
    let model = new_model.or(resolved_model);
    req.acp_model = model.clone();
    req.agent_id = Some(new_agent_id.clone());
    (
        Some(new_agent_id),
        engine,
        model,
        agent_slots,
        persona,
        composio_actions,
        skills,
        identities,
    )
}

pub(crate) async fn resolve_binding(
    agent_id: &str,
    store: &AgentStore,
) -> (
    Option<String>,
    Option<String>,
    AgentSlots,
    Option<PersonaSlot>,
    Vec<String>,
    // Per-agent Skill allowlist (empty = all enabled). Injected in Core on both
    // planes; see `SkillRegistry::enabled_for`.
    Vec<String>,
    // Per-agent Identity Vault profile binding (epic #517, Unit 4). Empty = the
    // agent sees NO identity profiles (binding is opt-in, never "all"). At
    // tool-call time decrypted credential state is fetched only for the domains
    // of these bound profiles via [`crate::identity`]; state is never broadcast.
    Vec<String>,
) {
    match store.get(agent_id).await {
        Ok(Some(record)) => {
            let skills_allowlist = record.skill_allowlist();
            let account_policy = crate::agent_access::AgentAccountPolicy::from_record(&record);
            let engine = record.engine.or_else(|| Some(agent_id.to_owned()));
            // Chat slot: engine doubles as the gateway ProviderKind identifier
            // (e.g. "openai", "anthropic", "local"). When set, the gateway's
            // pre_process will call route_modality_with_slot(Chat, ...) so the
            // agent card's provider wins over eval/model routing. Only populate
            // when chat_model.engine is set; otherwise let model routing handle it.
            let chat_slot = record
                .chat_model
                .as_ref()
                .and_then(|s| s.engine.as_ref().map(|e| (e.clone(), s.model_id.clone())));
            let slots = AgentSlots {
                chat: chat_slot,
                image: record
                    .image_model
                    .as_ref()
                    .and_then(|s| s.provider.as_ref().map(|p| (p.clone(), s.model_id.clone()))),
                video: record
                    .video_model
                    .as_ref()
                    .and_then(|s| s.provider.as_ref().map(|p| (p.clone(), s.model_id.clone()))),
                tts: record
                    .tts
                    .as_ref()
                    .and_then(|s| s.provider.as_ref().map(|p| (p.clone(), s.model_id.clone()))),
                stt: record
                    .stt
                    .as_ref()
                    .and_then(|s| s.provider.as_ref().map(|p| (p.clone(), s.model_id.clone()))),
            };
            let persona = record.persona;
            // An agent with its own identity never acts with the user's bound
            // profiles. The governed dispatch core drops them again per call
            // and also narrows Composio and MCP OAuth there, so the Gateway and
            // programmatic tool calls are covered without a turn-level scope.
            let identity_profile_ids =
                account_policy.user_identity_profiles(record.identity_profile_ids);
            (
                engine,
                record.model,
                slots,
                persona,
                record.composio_actions,
                skills_allowlist,
                identity_profile_ids,
            )
        }
        Ok(None) => (
            Some(agent_id.to_owned()),
            None,
            AgentSlots::default(),
            None,
            Vec::new(),
            Vec::new(),
            Vec::new(),
        ),
        Err(e) => {
            tracing::warn!("resolve_binding: store lookup failed for '{agent_id}': {e:#}");
            (
                Some(agent_id.to_owned()),
                None,
                AgentSlots::default(),
                None,
                Vec::new(),
                Vec::new(),
                Vec::new(),
            )
        }
    }
}
