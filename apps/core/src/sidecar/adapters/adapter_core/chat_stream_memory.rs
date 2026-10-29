use super::*;

/// The turn's memory policy, principal and recalled long-term context.
pub(super) struct TurnMemory {
    pub(super) memory_policy: crate::memory_policy::MemoryPolicy,
    pub(super) memory_principal_available: bool,
    pub(super) memory_owner: String,
    pub(super) memory_context_enabled: bool,
    pub(super) auto_recall_allowed: bool,
    pub(super) recall: Option<AutoRecallConfig>,
    pub(super) memory_citations: Vec<MemoryCitation>,
    pub(super) recency_ids: Vec<String>,
    pub(super) query_context: Option<String>,
    pub(super) session_memory: Option<String>,
}

/// Resolve the memory policy once and recall long-term context before the turn is recorded.
pub(super) async fn load_turn_memory(
    req: &ChatStreamRequest,
    memory: &MemoryStore,
    recall: Option<AutoRecallConfig>,
    effective_agent_id: &Option<String>,
    memory_project_id: &Option<String>,
    user_text: &str,
) -> TurnMemory {
    // The node's memory policy (recall mode / budget / write frequency), resolved
    // ONCE for the whole turn. Memory touches this function in three places and
    // "recall is off" has to mean all of them, so every downstream decision reads
    // this one value rather than re-reading preferences. Defaults reproduce the
    // pre-policy behaviour exactly, and an unreadable store yields those defaults.
    let memory_policy = match crate::learning::global_state() {
        Some(state) => crate::memory_policy::MemoryPolicy::load(&state.preferences).await,
        None => crate::memory_policy::MemoryPolicy::default(),
    };
    // Sensitive-topic consent is per verified user on a bound node. The request
    // author wins over the local-account fallback; an unbound node keeps the
    // single LOCAL_USER principal.
    let memory_principal_available = has_memory_principal(
        crate::server::node_org_id().is_some(),
        req.author_user_id.as_deref(),
    );
    let memory_owner = if crate::server::node_org_id().is_some() {
        req.author_user_id
            .clone()
            .unwrap_or_else(crate::server::background_memory_user_id)
    } else {
        LOCAL_USER.to_owned()
    };
    let memory_policy = memory_policy.with_sensitive_topics(if memory_principal_available {
        memory
            .include_sensitive_topics(&memory_owner)
            .await
            .unwrap_or(false)
    } else {
        false
    });
    // A temporary chat normally opts out of every personalized context layer.
    // The Memory plugin's composer flag is the explicit read-only exception: it
    // allows existing facts/recall for this request, but never changes the
    // `persist` boundary or the separate write decision below.
    let temporary_context_flag_enabled = req
        .plugin_flags
        .get(crate::memory_policy::TEMPORARY_CONTEXT_FLAG)
        .copied()
        .unwrap_or(false);
    let memory_context_enabled = req.public_agent_policy.is_none()
        && !req.untrusted_caller
        && memory_principal_available
        && crate::memory_policy::MemoryPolicy::context_enabled(
            req.enable_long_term,
            req.persist,
            temporary_context_flag_enabled,
        );
    // The per-REQUEST opt-in AND the per-NODE policy. The policy can only narrow
    // what the request asked for — it can never turn memory on for a caller that
    // did not request it, which is what keeps privacy-by-default intact.
    let auto_recall_allowed = memory_policy.should_auto_recall(memory_context_enabled);
    // Auto-recall is independently resolved by the interactive handler. Keep a
    // second boundary here because programmatic callers can invoke this shared
    // route directly and must not inherit the bound node's local-owner fallback.
    let recall = if req.public_agent_policy.is_none()
        && !req.untrusted_caller
        && memory_principal_available
        && (req.persist || temporary_context_flag_enabled)
    {
        recall
    } else {
        None
    };

    // Recall long-term (cross-session) memory BEFORE recording the current turn,
    // so the just-sent message does not echo back to the model as a remembered
    // "fact". This keeps long-term context strictly cross-session.
    // Use effective_agent_id so multi-agent turns scope memory correctly.
    let memory_read_levels = recall
        .as_ref()
        .map(|config| config.read_levels.as_slice())
        .unwrap_or(&[]);
    let memory_node_org = crate::server::node_org_id();
    let memory_visibility = MemoryVisibility::for_caller_in_org(
        req.author_user_id.as_deref(),
        memory_node_org.as_deref(),
        memory_node_org.is_some(),
    );
    let LongTermMemoryContext {
        system: long_term_system,
        citations: memory_citations,
        recency_ids,
    } = assemble_long_term_context_for_user(
        memory,
        auto_recall_allowed,
        &memory_owner,
        effective_agent_id.as_deref(),
        memory_project_id.as_deref(),
        memory_read_levels,
        memory_visibility,
        memory_policy.recall_budget.long_term_limit(),
        memory_policy.include_sensitive_topics,
    )
    .await;

    // External memory provider PREFETCH hook. Inert unless the user selected a
    // provider other than the built-in store — the kernel already reads the built-in
    // directly, and far more precisely (scoped recall, read levels, project filter).
    //
    // Placed here, after the recency block and before the persona merge, so it obeys
    // the same recall-BEFORE-record ordering: the turn just sent must not echo back
    // as a remembered fact. Bounded and fail-open inside `memory_provider`, so a slow
    // or broken provider costs the turn time and nothing else.
    let query_context = if auto_recall_allowed {
        // Both READ-side hooks under ONE timeout budget, run concurrently: the
        // provider's standing summary (opt-in) and the facts matching this turn.
        // Sequentially they would spend two budgets on a turn that needs one.
        let blocks = crate::memory_provider::read_hooks_with_consent(
            user_text,
            memory_policy.recall_budget.long_term_limit(),
            memory_policy.provider_context,
            memory_policy.include_sensitive_topics,
        )
        .await;
        (!blocks.is_empty()).then(|| blocks.join("\n\n"))
    } else {
        None
    };
    // Recency memory and the provider prefetch are picked per turn: the prefetch
    // matches this turn's text, and every recorded turn can change the recency
    // set. They travel as turn context, after the cached prefix, and the system
    // block below is built only from layers that hold still between turns. The
    // recency window stays separate from the query-matched context because a live
    // ACP session only needs it once (see `ChatStreamRequest::turn_query_context`).
    let session_memory = long_term_system;
    TurnMemory {
        memory_policy,
        memory_principal_available,
        memory_owner,
        memory_context_enabled,
        auto_recall_allowed,
        recall,
        memory_citations,
        recency_ids,
        query_context,
        session_memory,
    }
}

/// Auto-recall into the turn context under a hard timeout, traced as a retrieval span.
#[allow(clippy::too_many_arguments)]
pub(super) async fn run_turn_auto_recall(
    recall: &Option<AutoRecallConfig>,
    traces: &TraceStore,
    req: &ChatStreamRequest,
    user_text: &str,
    conversations: &ConversationStore,
    memory: &MemoryStore,
    memory_project_id: &Option<String>,
    recency_fact_ids: &std::collections::HashSet<String>,
    breakdown: &mut context_breakdown::BreakdownBuilder,
    memory_citations: &mut Vec<MemoryCitation>,
    query_context: &mut Option<String>,
) {
    if let Some(cfg) = recall {
        // Hard wall-clock bound so recall NEVER slows a turn fatally. Both halves
        // do a lazy backfill (the chat-search path embeds any not-yet-indexed
        // message inline; the memory path embeds any not-yet-indexed long-term
        // fact); on a large backlog with a live embedder that first call can be
        // slow, so a timeout degrades to "no recall this turn" rather than
        // stalling the reply. Fail-open on both the timeout and any inner error.
        let retrieval_span = start_trace_span(
            traces,
            req.conversation_id.as_deref(),
            SpanStart::new(String::new(), SpanKind::Retrieval, "auto-recall")
                .attr("top_k", cfg.top_k)
                .attr("space_count", cfg.space_ids.len())
                .input(Value::String(user_text.to_owned())),
        )
        .await;
        let recalled = match tokio::time::timeout(
            AUTO_RECALL_TIMEOUT,
            run_auto_recall_context(
                cfg,
                conversations,
                memory,
                memory_project_id.as_deref(),
                recency_fact_ids,
                user_text,
                req.conversation_id.as_deref(),
            ),
        )
        .await
        {
            Ok(context) => context,
            Err(_) => {
                tracing::warn!("auto-recall timed out, skipping for this turn");
                end_trace_span(
                    traces,
                    retrieval_span.as_ref(),
                    SpanEnd::error("auto-recall timed out"),
                )
                .await;
                None
            }
        };
        if let Some(context) = recalled.as_ref() {
            end_trace_span(
                traces,
                retrieval_span.as_ref(),
                SpanEnd::ok()
                    .attr("injected", true)
                    .attr("memory_citations", context.memory_citations.len())
                    .output(Value::String(context.block.clone())),
            )
            .await;
        } else {
            end_trace_span(
                traces,
                retrieval_span.as_ref(),
                SpanEnd::ok().attr("injected", false),
            )
            .await;
        }
        breakdown.add_text(
            "recall",
            "Auto-recall",
            recalled.as_ref().map(|context| context.block.as_str()),
        );
        if let Some(context) = recalled {
            memory_citations.extend(context.memory_citations);
            *query_context =
                append_turn_context(std::mem::take(query_context), Some(context.block));
        }
    }
}
