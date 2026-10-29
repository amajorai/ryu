use super::*;

/// Fold referenced chats and working memory into the per-turn context.
///
/// Returns whether the working-memory tool must be withheld, and the turn context.
#[allow(clippy::too_many_arguments)]
pub(super) async fn assemble_turn_context(
    req: &ChatStreamRequest,
    conversations: &ConversationStore,
    memory: &MemoryStore,
    agent_store: &AgentStore,
    effective_agent_id: &Option<String>,
    memory_principal_available: bool,
    memory_owner: &str,
    breakdown: &mut context_breakdown::BreakdownBuilder,
    query_context: &mut Option<String>,
    session_memory: Option<String>,
) -> (bool, Option<String>) {
    let referenced_chats = assemble_referenced_chat_context(
        conversations,
        &req.referenced_conversation_ids,
        req.conversation_id.as_deref(),
    )
    .await;
    breakdown.add_text(
        "references",
        "Referenced chats",
        referenced_chats.as_deref(),
    );
    *query_context = append_turn_context(std::mem::take(query_context), referenced_chats);
    // Working memory (per-thread / per-resource scratchpad) for agents that
    // enable it in their MemorySlot. Delivered with the per-turn context, never
    // in the cached system block, because the agent rewrites it as it learns.
    // Needs a memory principal (on a bound node an anonymous turn gets none);
    // public / untrusted callers and temporary chats never see it. Temporary
    // chats are excluded even with the Memory composer flag: that flag is a
    // read-only exception, and the block invites the agent to write. The update
    // tool must also resolve to the same owner partition this turn reads.
    let working_memory = if memory_principal_available
        && req.public_agent_policy.is_none()
        && !req.untrusted_caller
        && req.persist
        && crate::server::memory_working::tool_writes_owner(
            conversations,
            req.conversation_id.as_deref(),
            memory_owner,
        )
        .await
    {
        crate::server::memory_working::turn_context_block(
            memory,
            agent_store,
            effective_agent_id.as_deref(),
            req.conversation_id.as_deref(),
            memory_owner,
        )
        .await
    } else {
        None
    };
    breakdown.add_text(
        "working_memory",
        "Working memory",
        working_memory.as_deref(),
    );
    // When the block was withheld for an agent that has working memory on, the
    // update tool must not stay callable either: dispatch derives its owner from
    // the host conversation, which is not the person chatting in a shared
    // conversation, and a temporary chat must not write durable memory.
    let working_memory_tool_withheld = working_memory.is_none()
        && crate::server::memory_working::agent_config(agent_store, effective_agent_id.as_deref())
            .await
            .is_some();
    *query_context = append_turn_context(std::mem::take(query_context), working_memory);
    // Everything a model that holds no transcript of its own needs this turn.
    let turn_context = append_turn_context(session_memory, query_context.clone());
    (working_memory_tool_withheld, turn_context)
}

/// Record the user's turn into long-term memory and hand it to the provider sync hook.
#[allow(clippy::too_many_arguments)]
pub(super) async fn record_turn_memory(
    req: &ChatStreamRequest,
    memory: &MemoryStore,
    traces: &TraceStore,
    memory_policy: &crate::memory_policy::MemoryPolicy,
    memory_principal_available: bool,
    memory_owner: &str,
    effective_agent_id: &Option<String>,
    memory_project_id: &Option<String>,
    user_text: &str,
) {
    // Record the user's turn into long-term memory when opted in, so it informs
    // future sessions. No-op (and nothing is stored) when disabled. Metadata is
    // auto-classified from the text + active project (`cwd`); users can edit any
    // field later in the desktop Memory Library.
    if memory_principal_available
        && memory_policy.should_write(req.enable_long_term && req.persist)
        && !user_text.is_empty()
    {
        let scope = long_term_agent_scope(effective_agent_id.as_deref());
        // Sanitize at WRITE time too: the raw turn is stored verbatim and will
        // re-enter a future session's system context, so template tokens are
        // stripped here (the recall side additionally boundary-wraps). Belt and
        // braces on both sides of the persistence boundary.
        let sanitized_text = crate::sidecar::untrusted::strip_template_tokens(user_text);
        let new = infer_new_memory(
            &sanitized_text,
            memory_project_id.as_deref(),
            effective_agent_id.as_deref(),
        );
        let sensitive = crate::server::memory::detect_sensitive_topics(&new.content);
        if !sensitive.is_empty() && !memory_policy.include_sensitive_topics {
            tracing::info!(
                "long-term memory capture skipped because sensitive-topic consent is off"
            );
        } else {
            // Attribute to the verified caller on a bound node so the fact is
            // recallable by its owner; LOCAL_USER on an unbound node keeps the
            // single-user path byte-identical.
            let owner = memory_owner.to_owned();
            let mirrored = new.content.clone();
            let mirrored_scope = new.scope.as_str();
            let memory_span = start_trace_span(
                traces,
                req.conversation_id.as_deref(),
                SpanStart::new(String::new(), SpanKind::Memory, "long-term memory write")
                    .attr("operation", "write")
                    .attr("scope", mirrored_scope),
            )
            .await;
            let recorded = memory.record_full(&owner, &scope, new).await;
            end_trace_span(
                traces,
                memory_span.as_ref(),
                match &recorded {
                    Ok(_) => SpanEnd::ok(),
                    Err(e) => SpanEnd::error(format!("{e:#}")),
                },
            )
            .await;
            if let Err(e) = recorded {
                tracing::warn!("failed to record long-term memory: {e:#}");
            } else if memory_policy.mirror_builtin {
                // MIRROR hook: echo the just-recorded fact to the external provider so
                // the two stores do not drift. Only on success — mirroring a write that
                // failed locally would put a fact in the remote store that this node has
                // no record of. Fire-and-forget: the built-in write is the source of
                // truth and already succeeded, so a mirror failure surfaces nowhere.
                crate::memory_provider::mirror(&mirrored, mirrored_scope);
            }
        }
    }

    // SYNC hook: hand the RAW turn to the external provider and let it extract.
    // Gated on its own setting rather than on `write_frequency`, because the two are
    // genuinely different acts: `write_frequency = never` means this NODE stores
    // nothing, while sync is about what a provider the user deliberately chose is
    // allowed to see. Off by default — raw turns leaving the node is not something to
    // start doing without being asked.
    if req.public_agent_policy.is_none()
        && !req.untrusted_caller
        && memory_principal_available
        && req.persist
        && memory_policy.sync_turns
        && !user_text.is_empty()
        && (memory_policy.include_sensitive_topics
            || crate::server::memory::detect_sensitive_topics(user_text).is_empty())
    {
        crate::memory_provider::sync_turn(user_text, "user");
    }
}
