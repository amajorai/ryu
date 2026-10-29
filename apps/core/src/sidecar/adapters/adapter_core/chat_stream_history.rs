use super::*;

/// The ACP plane's short-term replay (handoff briefing, budgeted window or last turns).
pub(super) async fn replay_acp_short_term(
    req: &mut ChatStreamRequest,
    route: &AgentRoute,
    ctx_window: &Option<context_window::ContextWindowConfig>,
    long_term_system: &Option<String>,
    turn_context: &Option<String>,
    conversations: &ConversationStore,
) -> Option<String> {
    // Short-term context for the ACP path: replay recent conversation turns,
    // since ACP otherwise sends only the last user message. Assembled before the
    // `persist` closure consumes `store`. The OpenAI-compat path already receives
    // the full message list from the client, so it needs no short-term injection.
    if matches!(route, AgentRoute::Acp { .. }) {
        match (req.conversation_id.as_deref(), req.context_handoff.as_ref()) {
            // A model change handed the earlier history off: replay the briefing
            // plus the turns since the switch, bounded by any configured budget.
            (Some(id), Some(handoff)) => {
                let budget = ctx_window.as_ref().map(|cfg| {
                    let system_tokens = long_term_system
                        .as_deref()
                        .map(context_window::estimate_tokens)
                        .unwrap_or(0)
                        + turn_context
                            .as_deref()
                            .map(context_window::estimate_tokens)
                            .unwrap_or(0);
                    cfg.input_budget(system_tokens)
                });
                // Charged with the rest of the replay as "Conversation history".
                context_handoff::short_term(conversations, id, handoff, budget).await
            }
            // When a context budget is set, replay a token-budgeted window of
            // recent turns (optionally summarizing the dropped tail) instead of
            // the fixed last-10 cap. The system block is counted against the
            // budget so the replay leaves room for it + the reply.
            (Some(id), None) => match ctx_window {
                Some(cfg) => {
                    let system_tokens = long_term_system
                        .as_deref()
                        .map(context_window::estimate_tokens)
                        .unwrap_or(0)
                        + turn_context
                            .as_deref()
                            .map(context_window::estimate_tokens)
                            .unwrap_or(0);
                    let cache_expired = cfg.compact_on_cache_expire
                        && prompt_cache_warmth::expired_for_agent(
                            id,
                            req.agent_id.as_deref().unwrap_or_default(),
                        );
                    let replay = context_window::budgeted_short_term_replay(
                        conversations,
                        id,
                        system_tokens,
                        cfg,
                        cache_expired,
                    )
                    .await;
                    // The agent's native session still holds the uncompacted
                    // history and a pooled respawn would resume it. Its cache is
                    // cold, so starting over on the compacted replay costs no cache
                    // hits; the new native session is what later turns resume.
                    if replay
                        .as_ref()
                        .is_some_and(|replay| replay.compacted_on_cache_expiry)
                    {
                        tracing::info!(
                            conversation_id = id,
                            "prompt cache expired; starting the agent on a compacted history"
                        );
                        req.fresh_session = true;
                    }
                    replay.map(|replay| replay.block)
                }
                None => assemble_short_term_context(conversations, id).await,
            },
            (None, _) => None,
        }
    } else {
        None
    }
}

/// Fit the OpenAI-compatible history (handoff, budget trim) and finish that plane's breakdown.
#[allow(clippy::too_many_arguments)]
pub(super) async fn fit_openai_history(
    req: &mut ChatStreamRequest,
    route: &AgentRoute,
    ctx_window: &Option<context_window::ContextWindowConfig>,
    long_term_system: &mut Option<String>,
    turn_context: &Option<String>,
    breakdown: &mut context_breakdown::BreakdownBuilder,
    skills: &SkillRegistry,
    skills_allowlist: &Vec<String>,
    style_prefix: &Option<String>,
    durable_conversation: bool,
) {
    // OpenAI-compat plane: a recorded handoff replaces the turns from before the
    // model change with its briefing, appended to the system prompt's tail like a
    // compaction summary. Runs before the budget trim so the trim sees the
    // already-shortened history.
    if !matches!(route, AgentRoute::Acp { .. }) {
        if let Some(handoff) = req.context_handoff.as_ref() {
            if let Some(summary) = context_handoff::apply_openai(&mut req.messages, handoff) {
                breakdown.add_text("compact", "Handoff summary", Some(&summary));
                *long_term_system = append_system_suffix(long_term_system.take(), Some(summary));
            }
        }
    }

    // OpenAI-compat / local path: trim the outbound history to the token budget
    // (off by default). ACP is handled above via its short-term replay, so this
    // only runs for the OpenAI-compat plane. Keeps every system message and the
    // last turn; when auto-compact is on, dropped turns are summarized and the
    // summary is appended to the system prompt's tail (labelled, not a memory
    // fact) so the stable layers ahead of it stay a cacheable prefix.
    if let Some(cfg) = ctx_window {
        if !matches!(route, AgentRoute::Acp { .. }) {
            let system_tokens = long_term_system
                .as_deref()
                .map(context_window::estimate_tokens)
                .unwrap_or(0)
                + turn_context
                    .as_deref()
                    .map(context_window::estimate_tokens)
                    .unwrap_or(0);
            if let Some(summary) =
                context_window::apply_openai(&mut req.messages, system_tokens, cfg).await
            {
                breakdown.add_text("compact", "Compacted summary", Some(&summary));
                *long_term_system = append_system_suffix(long_term_system.take(), Some(summary));
            }
        }
    }

    // The ring's denominator and the reply reservation, when an app-level budget
    // is configured. Left at 0 (unknown) otherwise — the panel then reports
    // attribution without a percentage rather than inventing a window.
    if let Some(cfg) = ctx_window {
        breakdown.set_window(cfg.max_tokens);
        breakdown.set_reserve_output(cfg.reserve_output);
    }

    // Finish the breakdown for every non-ACP plane here, where `req.messages` is
    // final (post-trim) and the remaining layers are still separate values. The
    // ACP arm finishes its own further down, because its skills block and style
    // are folded in there. `mem::take` rather than a move so the ACP arm still
    // owns the builder — a conditional move would not compile.
    //
    // Tool definitions are NOT charged on this plane: the governed chat tool loop
    // is permanently off (`chat_tools_enabled = false`), so no tool schema is sent.
    if !matches!(route, AgentRoute::Acp { .. }) {
        let mut plane_breakdown = std::mem::take(breakdown);
        // The same call `inject_into_messages_filtered` makes downstream in
        // `route_openai_stream`, so this measures the block that is actually sent.
        if let Some((header, ids)) = skills.skill_block(skills_allowlist) {
            plane_breakdown.add_detailed(
                "skills",
                "Skills",
                context_window::estimate_tokens(&header),
                Some(format!("{} enabled", ids.len())),
            );
        }
        plane_breakdown.add_text("instructions", "Output style", style_prefix.as_deref());
        plane_breakdown.add_messages("Conversation history", &req.messages);
        record_context_breakdown(
            if durable_conversation {
                req.conversation_id.as_deref()
            } else {
                None
            },
            plane_breakdown,
            context_breakdown::ContextPlane::Openai,
        );
    }
}
