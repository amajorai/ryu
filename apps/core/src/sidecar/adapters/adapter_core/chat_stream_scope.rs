use super::*;

/// Per-scope defaults read from the thread's place in the Projects/Bots hierarchy.
pub(super) struct TurnScopeDefaults {
    pub(super) turn_is_feed_main_thread: bool,
    pub(super) turn_project_id: Option<String>,
    pub(super) memory_project_id: Option<String>,
    pub(super) session_pinned_model: bool,
    pub(super) session_pinned_effort: bool,
    pub(super) scope_levels: crate::server::conversations::CascadeLevels,
    pub(super) project_model_applies_to_facade: bool,
}

/// Apply the scope model cascade and the interactive/background lane default.
pub(super) async fn apply_scope_defaults(
    req: &mut ChatStreamRequest,
    conversations: &ConversationStore,
    durable_conversation: bool,
    effective_agent_id: &mut Option<String>,
) -> TurnScopeDefaults {
    // Projects › Bots/Groups › Sessions: where this thread sits, and the per-scope
    // model defaults that apply when the turn carries no explicit pin. The cascade
    // is `session > project:<p>/agent:<a> > agent:<a> > agent binding >
    // project:<p> > settings (global scope) > lane`; provider and model resolve
    // as a pair, effort falls through on its own (see
    // `server::conversations::resolve_cascade`). Main threads read the
    // coordinator defaults, sessions the thread defaults
    // (`CascadeLevels::for_role`). Session pins (the composer's model control)
    // are the `req.acp_model` / `req.model` the client already sent, so they are
    // never overridden here.
    let turn_hierarchy = if durable_conversation {
        match req.conversation_id.as_deref() {
            Some(conversation_id) => conversations
                .thread_hierarchy(conversation_id)
                .await
                .ok()
                .flatten(),
            None => None,
        }
    } else {
        None
    };
    let defaults_role = turn_hierarchy.as_ref().map_or_else(
        crate::server::conversations::DefaultsRole::default,
        |hierarchy| {
            crate::server::conversations::DefaultsRole::for_thread_role(&hierarchy.thread_role)
        },
    );
    // Brief replies apply to the main threads users scan like a feed: a
    // project's coordinator thread and a bot's own thread. Group main threads and
    // sessions keep the agent's usual length.
    let turn_is_feed_main_thread = turn_hierarchy.as_ref().is_some_and(|hierarchy| {
        hierarchy.is_main()
            && matches!(
                hierarchy.owner_kind.as_deref(),
                Some("project") | Some("agent")
            )
    });
    let turn_project_id: Option<String> = turn_hierarchy.and_then(|hierarchy| hierarchy.project_id);
    // Project memory is keyed by the thread's project when it has one, and by
    // its working folder otherwise (the pre-hierarchy behaviour, unchanged for
    // threads outside any project).
    let memory_project_id = turn_project_id.clone().or_else(|| req.cwd.clone());
    let session_pinned_model = req
        .acp_model
        .as_deref()
        .is_some_and(|model| !model.trim().is_empty())
        || req
            .model
            .as_deref()
            .is_some_and(|model| !model.trim().is_empty());
    let session_pinned_effort = req
        .inference
        .as_ref()
        .is_some_and(|inference| inference.extra.contains_key("reasoning_effort"));
    let scope_levels = if session_pinned_model && session_pinned_effort {
        crate::server::conversations::CascadeLevels::default()
    } else {
        conversations
            .stored_cascade_levels(
                turn_project_id.as_deref(),
                effective_agent_id.as_deref(),
                defaults_role,
            )
            .await
            .unwrap_or_else(|error| {
                tracing::warn!("scope defaults lookup failed; using node defaults: {error:#}");
                crate::server::conversations::CascadeLevels::default()
            })
    };
    let has_model = |level: &Option<crate::server::conversations::ScopeDefault>| {
        level
            .as_ref()
            .is_some_and(|level| !level.model.trim().is_empty())
    };
    let project_model_applies_to_facade =
        effective_agent_id.is_none() || effective_agent_id.as_deref() == Some("ryu");
    let mut scope_model_applied = false;
    if !session_pinned_model {
        // Bot-specific levels beat the agent card's binding; the project and
        // Settings › Models levels beat only the lane default, so for the
        // built-in facade (which has no binding of its own) they apply before
        // the lane default below.
        let picked = [&scope_levels.project_agent, &scope_levels.agent]
            .into_iter()
            .find(|level| has_model(level))
            .or_else(|| {
                project_model_applies_to_facade
                    .then(|| {
                        [&scope_levels.project, &scope_levels.settings]
                            .into_iter()
                            .find(|level| has_model(level))
                    })
                    .flatten()
            })
            .and_then(Option::as_ref);
        if let Some(level) = picked {
            req.acp_model = Some(level.model.trim().to_owned());
            scope_model_applied = true;
        }
    }

    // Interactive chats consume the cloud lane when it is configured, and
    // transparently fall back to the local lane otherwise. Programmatic work
    // (plugins, delegated turns, and local utility features) consumes the local
    // lane unless it provides an explicit model. Ryu is the built-in facade
    // that can carry the agent, provider, model, and effort together; external
    // ACP agents are left to their advertised controls below.
    if effective_agent_id.is_none() || effective_agent_id.as_deref() == Some("ryu") {
        let selection = if req.background {
            crate::agent_selection::local_default_selection()
        } else {
            crate::agent_selection::chat_default_selection()
        };
        let using_lane_default = req
            .acp_model
            .as_deref()
            .is_none_or(|model| model.trim().is_empty());
        if using_lane_default && !selection.agent_id.is_empty() {
            req.lane_default = true;
            *effective_agent_id = Some(selection.agent_id.clone());
            req.agent_id = effective_agent_id.clone();
        }
        if using_lane_default && !selection.model.is_empty() {
            req.acp_model = Some(selection.model);
        }
        // Effort falls through on its own (`resolve_cascade`): a scope level
        // that set only a model still runs at the lane's effort, unless the
        // turn pins one. A scope effort, applied below, still wins over it.
        let lane_effort_applies =
            using_lane_default || (scope_model_applied && !session_pinned_effort);
        if lane_effort_applies && !selection.effort.is_empty() {
            apply_hook_effort(req, &selection.effort);
        }
    }
    TurnScopeDefaults {
        turn_is_feed_main_thread,
        turn_project_id,
        memory_project_id,
        session_pinned_model,
        session_pinned_effort,
        scope_levels,
        project_model_applies_to_facade,
    }
}

/// The agent binding a turn runs with; later phases may still hand it off or narrow it.
pub(super) struct TurnBinding {
    pub(super) effective_agent_id: Option<String>,
    pub(super) engine: Option<String>,
    pub(super) model: Option<String>,
    pub(super) agent_slots: AgentSlots,
    pub(super) persona: Option<PersonaSlot>,
    pub(super) composio_actions: Vec<String>,
    pub(super) skills_allowlist: Vec<String>,
    pub(super) identity_profile_ids: Vec<String>,
}

/// Resolve the agent's binding, fill scope model/effort defaults and run the routing policy.
pub(super) async fn resolve_turn_binding(
    req: &mut ChatStreamRequest,
    agent_store: &AgentStore,
    effective_agent_id: Option<String>,
    scope: &TurnScopeDefaults,
) -> TurnBinding {
    let session_pinned_model = scope.session_pinned_model;
    let session_pinned_effort = scope.session_pinned_effort;
    let project_model_applies_to_facade = scope.project_model_applies_to_facade;
    let scope_levels = &scope.scope_levels;
    // Resolve the agent's engine binding from the store (U6), then map it to a
    // concrete route. The binding lets a custom agent target a local engine or a
    // registry transport; unknown agents fall back to the default plain-LLM agent.
    // Per-attribute slots (M3 / #164) are also resolved here and threaded into
    // the gateway request headers so each modality call routes independently.
    // The persona slot (#410) is also resolved so we can build a tone prefix for
    // the system prompt before dispatching.
    // `identity_profile_ids` are the agent's bound Identity Vault profiles (epic
    // #517), resolved per request alongside the other bindings. They are carried
    // (IDs only — not secrets) and threaded into the ACP MCP bridge so the
    // tool-call-time consult (`crate::identity::consult_for_tool_call`) fetches
    // decrypted state ONLY for the domains of these bound profiles, at call time —
    // state is never broadcast to the LLM. An empty list means the agent sees no
    // identities. The consumer is wired in `route_acp_stream` → the MCP bridge.
    let (
        engine,
        model,
        agent_slots,
        persona,
        composio_actions,
        skills_allowlist,
        identity_profile_ids,
    ) = match effective_agent_id.as_deref() {
        Some(id) => resolve_binding(id, agent_store).await,
        None => (
            None,
            None,
            AgentSlots::default(),
            None,
            Vec::new(),
            Vec::new(),
            Vec::new(),
        ),
    };

    // An external agent with no bound model of its own takes the project's model
    // default (the facade already took it above, before the lane default).
    if !session_pinned_model
        && !project_model_applies_to_facade
        && model.is_none()
        && req
            .acp_model
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
    {
        if let Some(level) = [&scope_levels.project, &scope_levels.settings]
            .into_iter()
            .filter_map(Option::as_ref)
            .find(|level| !level.model.trim().is_empty())
        {
            req.acp_model = Some(level.model.trim().to_owned());
        }
    }
    // Effort falls through the scope levels independently of the model, and wins
    // over the lane default but never over an explicit per-turn effort.
    if !session_pinned_effort {
        if let Some(effort) = [
            &scope_levels.project_agent,
            &scope_levels.agent,
            &scope_levels.project,
            &scope_levels.settings,
        ]
        .into_iter()
        .filter_map(Option::as_ref)
        .map(|level| level.effort.trim())
        .find(|effort| !effort.is_empty())
        {
            apply_hook_effort(req, effort);
        }
    }

    // The desktop's Standard/Expert composer sends its explicit OpenAI-compatible
    // pin as `model`. Apply it before the policy pass so routing rules can still
    // deliberately replace it, while Simple mode (which omits the field) keeps
    // the automatic binding/default behavior.
    let model = req
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or(model);

    // Threshold-driven fallback (`crate::routing_policy`). THE enforcement point
    // for it: every chat turn — gateway-routed and ACP alike — passes through
    // here with its agent and model resolved but nothing dispatched yet, and the
    // ACP plane is reachable *only* from Core (those agents bypass the Gateway
    // entirely with their own vendor credential), so a rule like "Claude weekly
    // under 50% → finish the week on Sonnet" has nowhere else it could be
    // applied.
    //
    // Inert unless the user wrote a rule: `advice_for_turn` short-circuits on an
    // empty policy before it reads a single signal.
    let (
        effective_agent_id,
        engine,
        model,
        agent_slots,
        persona,
        composio_actions,
        skills_allowlist,
        identity_profile_ids,
    ) = apply_routing_policy(
        effective_agent_id,
        engine,
        model,
        agent_slots,
        persona,
        composio_actions,
        skills_allowlist,
        identity_profile_ids,
        req,
        agent_store,
    )
    .await;
    TurnBinding {
        effective_agent_id,
        engine,
        model,
        agent_slots,
        persona,
        composio_actions,
        skills_allowlist,
        identity_profile_ids,
    }
}
