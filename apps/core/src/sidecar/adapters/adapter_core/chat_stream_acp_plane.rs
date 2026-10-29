use super::*;

/// Run the turn on an ACP agent, folding skills and the output style into its preamble.
pub(super) async fn dispatch_acp_plane<F>(
    plane: TurnPlane<F>,
    run_trace: &mut Option<ryu_tracing::ScopeGuard>,
    spawn_cmd: String,
) -> Response {
    let TurnPlane {
        mut req,
        registry,
        agent_store,
        manager,
        worktree_diffs,
        mcp,
        skills,
        traces,
        watch,
        subscription_costs,
        provider_reg,
        durable_conversation,
        effective_agent_id,
        composio_actions,
        skills_allowlist,
        identity_profile_ids,
        style_prefix,
        mut breakdown,
        long_term_system,
        project_instructions,
        project_rules,
        memory_citations,
        working_memory_tool_withheld,
        account_confinement,
        short_term,
        requested_environment,
        worktree_reused,
        effective_cwd,
        worktree_guard,
        turn_rejection,
        conversation_id_for_persist,
        persist_agent_id,
        persist_store_for_acp,
        ..
    } = plane;
    // Fresh-node degradation guard (zero-setup first run). The flagship
    // `ryu` agent routes its model calls through the gateway's `local`
    // provider; on a node with no model weights and no remote provider that
    // 503s, but the managed Pi swallows the error and streams its
    // context/skills banner as a fake reply. Short-circuit BEFORE spawning
    // Pi with an actionable error so the user is told what to do rather than
    // shown input-independent garbage. Conservative — fails open on any
    // servable configuration (see `ryu_default_unservable`).
    let bridge_agent_id = effective_agent_id
        .clone()
        .unwrap_or_else(|| format!("acp:{spawn_cmd}"));
    let direct_managed_pi = acp::is_direct_managed_pi_account_spawn(&spawn_cmd);
    // Attached documents fold into the turn BEFORE the emptiness guard:
    // dropping a PDF in with no typed message is a real turn ("read this"),
    // and refusing it as "no user message" would be the silent discard
    // wearing an error message.
    let mut user_message = last_user_message(&req.messages);
    if let Some(block) = req
        .messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .and_then(document_context_block)
    {
        user_message.push_str(&block);
    }
    if user_message.is_empty() {
        return turn_rejection
            .reject_acp(
                "No user message to send to ACP agent".to_owned(),
                &worktree_diffs,
                req.conversation_id.as_deref(),
                worktree_guard,
                worktree_reused,
            )
            .await;
    }
    // The per-turn SDK model/provider selection must precede account
    // capture, otherwise a provider switch captures the previous login.
    if direct_managed_pi && !req.lane_default {
        if let Some(model) = req
            .acp_model
            .as_deref()
            .map(str::trim)
            .filter(|model| !model.is_empty())
        {
            if let Err(error) = crate::pi_config::persist_turn_model(model) {
                return turn_rejection
                    .reject_acp(
                        format!("Could not apply Pi model selection: {error}"),
                        &worktree_diffs,
                        req.conversation_id.as_deref(),
                        worktree_guard,
                        worktree_reused,
                    )
                    .await;
            }
        }
    }
    let pi_config = crate::pi_config::current();
    // Capture once before the guard, usage attribution and dispatch.
    // Bound-account errors remain actionable even on an empty node.
    let sdk_turn_selection = if direct_managed_pi {
        match crate::pi_config::session_accounts::capture_for_turn(
            &pi_config.provider,
            if durable_conversation {
                req.conversation_id.as_deref()
            } else {
                None
            },
            &bridge_agent_id,
        )
        .await
        {
            Ok(captured) => {
                captured.map(|account| SdkTurnSelection::from_config(account, &pi_config))
            }
            Err(error) => {
                return turn_rejection
                    .reject_acp(
                        error.to_string(),
                        &worktree_diffs,
                        req.conversation_id.as_deref(),
                        worktree_guard,
                        worktree_reused,
                    )
                    .await
            }
        }
    } else {
        None
    };
    if let Some(selection) = sdk_turn_selection.as_ref() {
        selection.pin_request_model(&mut req);
    }
    if !direct_managed_pi_configured(
        direct_managed_pi,
        &pi_config,
        sdk_turn_selection
            .as_ref()
            .map(|selection| &selection.account),
    ) && ryu_default_unservable(&manager, &provider_reg, effective_agent_id.as_deref()).await
    {
        return turn_rejection
            .reject_acp(
                "No model is configured yet, so the default Ryu agent can't reply. \
                 Open Settings > Engines to download a local model or add a provider \
                 API key, then try again."
                    .to_owned(),
                &worktree_diffs,
                req.conversation_id.as_deref(),
                worktree_guard,
                worktree_reused,
            )
            .await;
    }
    let conversation_id = req.conversation_id.clone();
    // Resolve the per-agent allowlist so the MCP bridge only offers the
    // tools the agent is permitted to call (AC3 governance). Use the
    // effective agent id so target_agent_id routing gets the correct allowlist.
    let allowlist = resolve_agent_tool_allowlist(
        effective_agent_id.as_deref(),
        registry.as_ref(),
        &agent_store,
    )
    .await;
    let allowlist = match req.public_agent_policy.as_ref() {
        Some(policy) => {
            Some(restrict_public_agent_tool_allowlist(mcp.as_ref(), allowlist, policy).await)
        }
        None => allowlist,
    };
    // Unverified callers are moved off ACP routes before dispatch; narrow
    // the bridge here as well so the MCP call gate would still hold if a
    // future route change reached this plane.
    let allowlist = caller_scoped_tool_allowlist(req.untrusted_caller, mcp.as_ref(), allowlist);
    let allowlist = if working_memory_tool_withheld {
        Some(withhold_working_memory_tool_allowlist(mcp.as_ref(), allowlist).await)
    } else {
        allowlist
    };
    // Effective agent id for the MCP bridge (PTC scoping). Falls back to
    // the ACP transport id form when no agent id is set.
    // Make the per-agent skill allowlist real on the ACP plane. ACP
    // subprocesses make their own provider calls, so Core cannot inject a
    // separate system message the way the openai-compat path does — instead
    // we fold the resolved skill block into the prompt preamble via
    // `long_term_system` (consumed by `build_acp_prompt`). Empty allowlist =
    // all enabled skills, matching the openai-compat path.
    //
    // The ACP plane always runs a tool loop (the MCP bridge), so it is the
    // one plane where progressive disclosure is safe: inject only the L1
    // index (+ any always-on bodies) and let the model load full bodies on
    // demand via `skills.load`. When the global mode is `full` (or there
    // are no progressive skills) we fall back to the full-body block. The
    // no-tool openai-compat path always uses the full block (see
    // `route_openai_stream`), so a weak model is never starved.
    //
    // Safe Mode suppresses the block entirely on this plane too. A skill is
    // an instruction the user did not write into this turn, and the point of
    // safe mode is a baseline with nothing extra in the prompt.
    let skill_block = if crate::safe_mode::is_active() {
        None
    } else if ryu_skills::is_progressive_disclosure() {
        skills.progressive_block(&skills_allowlist)
    } else {
        skills.skill_block(&skills_allowlist)
    };
    if let Some((header, ids)) = skill_block.as_ref() {
        breakdown.add_detailed(
            "skills",
            "Skills",
            context_window::estimate_tokens(header),
            Some(format!("{} enabled", ids.len())),
        );
    }
    let long_term_system = match skill_block {
        Some((header, _ids)) => merge_system_prompt(long_term_system, Some(header)),
        None => long_term_system,
    };
    // The output style folds into the SAME preamble, for the same reason: an
    // ACP subprocess makes its own provider calls, so there is no separate
    // system message to add.
    //
    // Applied AFTER the skills merge, which puts it BEFORE the skills block in
    // the text — `merge_system_prompt` prepends its second argument. That order
    // is deliberate: a skill's own formatting instructions are task-specific and
    // must win over the style's general shape when the two disagree. The result
    // reads base instructions (unless the style replaced them) → style body →
    // skills block → persona + memory.
    let long_term_system = merge_system_prompt(long_term_system, style_prefix.clone());

    // Finish the breakdown for this plane. Everything Core hands the
    // agent is now known: the preamble layers above, the replayed window,
    // the current turn's attachments, and the tools offered to the bridge.
    // What Core CANNOT see — the agent's own base prompt, its tool-result
    // accumulation, and skill bodies it loads mid-turn under progressive
    // disclosure — is why this is labelled an estimate and reconciled
    // against the reported prompt tokens in the panel.
    breakdown.add_text("instructions", "Output style", style_prefix.as_deref());
    breakdown.add_detailed(
        "messages",
        "Conversation history",
        short_term
            .as_deref()
            .map(context_window::estimate_tokens)
            .unwrap_or(0),
        Some("replayed turns".to_owned()),
    );
    // Only the LAST message: ACP forwards that one turn (the rest arrive
    // via `short_term`), so charging the whole array would double-count.
    breakdown.add_messages(
        "Conversation history",
        req.messages
            .last()
            .map(std::slice::from_ref)
            .unwrap_or_default(),
    );
    breakdown.add_tools(&mcp.tools_for_agent(allowlist.as_deref()).await);
    record_context_breakdown(
        if durable_conversation {
            req.conversation_id.as_deref()
        } else {
            None
        },
        breakdown,
        context_breakdown::ContextPlane::Acp,
    );

    // The plane owns the run trace from here and finishes it at turn end.
    handoff_run_trace(run_trace);
    route_acp_stream(
        req,
        user_message,
        spawn_cmd,
        effective_cwd,
        worktree_guard,
        requested_environment,
        short_term,
        long_term_system,
        memory_citations,
        project_instructions,
        project_rules,
        persist_store_for_acp,
        conversation_id_for_persist,
        persist_agent_id,
        if durable_conversation {
            conversation_id
        } else {
            None
        },
        worktree_diffs,
        mcp,
        allowlist,
        skills_allowlist,
        // #477: thread the per-agent Composio actions (in scope from
        // resolve_binding) + effective agent id into the ACP bridge so
        // Composio reaches the ACP plane and PTC execution is scoped.
        composio_actions.clone(),
        bridge_agent_id,
        // #517: thread the agent's bound Identity Vault profiles so the
        // tool-call-time vault consult runs on the ACP plane.
        identity_profile_ids,
        traces,
        watch,
        subscription_costs,
        sdk_turn_selection,
        account_confinement,
    )
    .await
}
