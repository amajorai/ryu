use super::*;

/// The assembled, cache-stable system block and the context breakdown measured while building it.
pub(super) struct TurnSystem {
    pub(super) breakdown: context_breakdown::BreakdownBuilder,
    pub(super) long_term_system: Option<String>,
    pub(super) project_instructions: Option<String>,
    pub(super) project_rules: Option<Vec<Value>>,
    pub(super) recency_fact_ids: std::collections::HashSet<String>,
}

/// Merge every stable system-prompt layer, measuring each one for the Context panel.
#[allow(clippy::too_many_arguments)]
pub(super) async fn assemble_turn_system(
    req: &ChatStreamRequest,
    conversations: &ConversationStore,
    session_memory: &Option<String>,
    query_context: &Option<String>,
    persona_prefix: Option<String>,
    agent_instructions: &Option<String>,
    style_prefix: &Option<String>,
    turn_project_id: &Option<String>,
    effective_agent_id: &Option<String>,
    turn_is_feed_main_thread: bool,
    memory_principal_available: bool,
    memory_context_enabled: bool,
    auto_recall_allowed: bool,
    recency_ids: Vec<String>,
) -> TurnSystem {
    let long_term_system: Option<String> = None;

    // Context-breakdown accounting for the desktop Context panel. Purely
    // observational — nothing below may change what is sent. The system block is
    // assembled by successive `merge_system_prompt` calls that collapse every
    // layer into ONE string, so per-layer cost cannot be recovered afterwards;
    // each layer is measured here, at its merge site, while it is still a
    // separate value.
    let mut breakdown = context_breakdown::BreakdownBuilder::new();
    breakdown.add_text(
        "memory",
        "Long-term memory",
        append_turn_context(session_memory.clone(), query_context.clone()).as_deref(),
    );
    breakdown.add_text("persona", "Persona", persona_prefix.as_deref());
    let instructions_layer =
        agent_instructions_layer(agent_instructions.as_deref(), style_prefix.is_some());
    breakdown.add_text(
        "instructions",
        "Agent instructions",
        instructions_layer.as_deref(),
    );

    // The project's standing instructions, the project goal, the bot's goal, and
    // the bot's goal inside this project, plus the brief-replies instruction for
    // project and bot main threads. All are
    // pure functions of stored settings (`server::conversations::TurnGuidance`),
    // so they stay byte-identical across turns and only an edit to them moves
    // the cached prefix. They follow the agent's instructions; brevity stands
    // down when an output style is in force, background turns carry neither
    // (their replies are parsed by a caller, not read), and untrusted callers do
    // not see the owner's goals.
    let turn_guidance = if req.background || req.untrusted_caller {
        crate::server::conversations::TurnGuidance::default()
    } else {
        conversations
            .turn_guidance(turn_project_id.as_deref(), effective_agent_id.as_deref())
            .await
            .unwrap_or_else(|error| {
                tracing::warn!("scope guidance lookup failed; turn runs without goals: {error:#}");
                crate::server::conversations::TurnGuidance::default()
            })
    };
    let project_instructions_layer = turn_guidance.instructions_layer();
    breakdown.add_text(
        "instructions",
        "Project instructions",
        project_instructions_layer.as_deref(),
    );
    let goals_layer = turn_guidance.goals_layer();
    breakdown.add_text("instructions", "Goals", goals_layer.as_deref());
    let brief_layer = (turn_is_feed_main_thread
        && !req.background
        && style_prefix.is_none()
        && turn_guidance.brief_replies())
    .then(|| crate::server::conversations::BRIEF_REPLIES_INSTRUCTION.to_owned());
    breakdown.add_text("instructions", "Brief replies", brief_layer.as_deref());
    let long_term_system = merge_system_prompt(long_term_system, brief_layer);
    let long_term_system = merge_system_prompt(long_term_system, goals_layer);
    let long_term_system = merge_system_prompt(long_term_system, project_instructions_layer);

    // The persona leads the system prompt and the agent's own instructions follow
    // it (`merge_system_prompt` prepends, hence the order of these two merges).
    // The long-term memory they used to share the block with now rides as turn
    // context (above), which still reaches the model after both.
    let long_term_system = merge_system_prompt(long_term_system, instructions_layer);
    let long_term_system = merge_system_prompt(long_term_system, persona_prefix);
    let long_term_system = merge_system_prompt(long_term_system, req.cloud_task_context.as_ref().map(|context| {
        format!("Cloud environment: {} (revision {}). All code tools execute in its isolated workspace. Working directory: {}. File tool paths are relative to this directory. Use only cloud_exec, cloud_read_file, cloud_write_file and cloud_list_files for project work; host tools and browser client tools are unavailable.{}\n\nEnvironment start instructions:\n{}", context.environment_name, context.revision, context.working_directory, if context.backend == "box" { " This cloud box has its own screen: the box_computer_* and box_browser_* tools drive its desktop and browser." } else { "" }, context.start_instructions)
    }));

    // Fleet instructions are a distinct, signed layer. They never overwrite a
    // repository AGENTS.md and project-scoped rules are narrowed using the
    // node-local longest-root mapping before they enter the prompt.
    let managed_instructions = crate::fleet::managed_instruction_block(req.cwd.as_deref());
    breakdown.add_text(
        "system",
        "Organization-managed instructions",
        managed_instructions.as_deref(),
    );
    let long_term_system = merge_system_prompt(long_term_system, managed_instructions);
    // The owner's own description of themselves is not for an unverified caller.
    let user_personalization = if memory_principal_available
        && !req.untrusted_caller
        && (req.persist || memory_context_enabled)
    {
        match crate::learning::global_state() {
            Some(state) => user_personalization_block(&state.preferences).await,
            None => None,
        }
    } else {
        None
    };
    let long_term_system = merge_system_prompt(long_term_system, user_personalization);

    // Project instructions remain host-discovered data, but injection belongs to
    // the rules plugin. Keeping the raw legacy file and the normalized folder
    // rules on HookContext lets plugins choose placement and cadence without Core
    // silently adding a second copy to the system prompt.
    let project_instructions = project_instructions_hint(req.cwd.as_deref());
    let project_rules = if crate::safe_mode::is_active() {
        None
    } else {
        req.cwd.as_deref().map(|cwd| {
            crate::server::rules::discover_rules(std::path::Path::new(cwd))
                .rules
                .into_iter()
                .filter_map(|rule| serde_json::to_value(rule).ok())
                .collect::<Vec<_>>()
        })
    };
    // The standing docs pointer (see `RYU_DOCS_HINT`). Merged HERE, before the
    // plane branch, because this is the one seam every caller shares: desktop
    // chat, voice (`voice/session.rs`), sub-agent and team replies
    // (`run_reply_text` / `run_team_reply_text`) and the chat-channel bots
    // (`POST /api/channels/run`, which is `run_reply_text`) all reach the model
    // through `route_chat_stream`, and both planes below send `long_term_system`
    // verbatim — the openai-compat plane as a leading `system` message, ACP via
    // `build_acp_prompt`. So one merge is the whole feature, and a per-plane
    // copy would silently miss whichever plane nobody remembered.
    //
    // The ONE path this does not cover is a channel with no agent bound, which
    // runs the legacy gateway pipeline (`ChannelHost::run_pipeline`) instead of
    // Core and therefore has no Core-assembled system block to append to.
    //
    // NB argument order: the hint is the FIRST argument precisely so it lands
    // last — `merge_system_prompt` prepends its second argument. Every layer
    // merged after this one (the skills block, the output style) also prepends,
    // so the hint stays at the tail of the stable block and never outranks a
    // user-configured instruction. Only the compaction/handoff summary goes
    // after it (`append_system_suffix`): it changes as the history is
    // re-summarized, so it must not sit in front of the cacheable prefix.
    let docs_hint = ryu_docs_hint();
    breakdown.add_text("system", "Ryu docs", docs_hint.as_deref());
    let long_term_system = merge_system_prompt(docs_hint, long_term_system);
    // Single-screen generative UI guidance (the Island opts in per turn). Merged
    // as the first argument, like the docs hint, so it sits at the block's tail.
    let generative_ui = generative_ui::generative_ui_hint(&req.plugin_flags);
    breakdown.add_text("system", "Generative UI screen", generative_ui.as_deref());
    let long_term_system = merge_system_prompt(generative_ui, long_term_system);
    let platform_contract = crate::ryu_platform::operating_contract(
        effective_agent_id.as_deref(),
        crate::safe_mode::is_active(),
        req.response_mode,
    );
    breakdown.add_text(
        "platform",
        "Ryu everyday setup guide",
        platform_contract.as_deref(),
    );
    let long_term_system = merge_system_prompt(platform_contract, long_term_system);

    // The set of fact ids the RECENCY path injected this turn, so auto-recall can
    // dedup BY ID (the two blocks use different formats, so content-match would
    // silently double-inject). CRITICAL: only populate this when `enable_long_term`
    // is true — recency injects NOTHING when it's off (`assemble_long_term_system_message`
    // returns `None`), so dropping these ids then would surface them NOWHERE.
    // These ids come from the same recall result that built the recency block, so
    // citation metadata and auto-recall dedup cannot drift apart.
    let recency_fact_ids: std::collections::HashSet<String> = if auto_recall_allowed {
        recency_ids.into_iter().collect()
    } else {
        std::collections::HashSet::new()
    };

    // Auto-recall (U17, now wired): retrieve relevant prior knowledge (long-term
    // MEMORY + PAST CHAT MESSAGES, current conversation excluded) and add it to
    // `turn_context` ONCE here, so BOTH the openai-compat and ACP planes receive it
    // after their cached prefix. Recall matches this turn's text, so inside the
    // system block it would change that block every turn. This is gated solely by
    // the `auto-recall-enabled` pref (encoded as `recall: Some`/`None` by the
    // handler) and is INDEPENDENT of `enable_long_term`. Fully fail-open — any error
    // inside `run_auto_recall` logs and yields `None`, never blocking the turn.
    // Mutable: a context-window compaction summary (if enabled) is merged in below.
    let mut long_term_system = long_term_system;
    if req.public_agent_policy.is_some() {
        long_term_system = merge_system_prompt(
            long_term_system,
            Some(PUBLIC_AGENT_SYSTEM_POLICY.to_owned()),
        );
    }
    if req.untrusted_caller {
        long_term_system = merge_system_prompt(
            long_term_system,
            Some(UNTRUSTED_CALLER_SYSTEM_POLICY.to_owned()),
        );
    }
    TurnSystem {
        breakdown,
        long_term_system,
        project_instructions,
        project_rules,
        recency_fact_ids,
    }
}
