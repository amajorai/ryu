use super::*;

/// Orchestrate a team turn: fan out to members per the coordination strategy and
/// stream one merged, attributed assistant message. Logic lives entirely in Core.
///
/// This is the ONE place a team turn meets the turn-boundary plugin hooks; the
/// per-member path stays clear of them on purpose ([`run_member_text`] says why).
#[allow(clippy::too_many_arguments)]
pub async fn route_team_chat_stream(
    mut req: ChatStreamRequest,
    team: ryu_teams_contracts::TeamRecord,
    registry: Arc<AcpAgentRegistry>,
    conversations: ConversationStore,
    agent_store: AgentStore,
    manager: Arc<SidecarManager>,
    memory: MemoryStore,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    skills: SkillRegistry,
    traces: TraceStore,
) -> Response {
    if let Err(error) = capture_acp_conversation_generation(&mut req, &conversations).await {
        return error_stream(error);
    }

    use ryu_teams_contracts::Coordination;

    if team.members.is_empty() {
        return error_stream(format!(
            "Team '{}' has no members. Add agents to the team first.",
            team.name
        ));
    }

    let deps = TeamRunDeps {
        registry,
        acp_conversation_generation: req.acp_conversation_generation.clone(),
        conversations: conversations.clone(),
        agent_store: agent_store.clone(),
        manager,
        memory,
        worktree_diffs,
        mcp,
        skills,
        traces,
        agent_resource_authorization: req.agent_resource_authorization.clone(),
    };

    // Turn-boundary hooks for a team turn fire exactly ONCE, here, over the whole
    // turn — never per member. A `Replace`/`Inject` is applied to the outgoing
    // messages before either the single persisted user row or the fan-out reads
    // them, so every member sees the governed prompt and the transcript keeps the
    // text that actually ran.
    //
    // `post_assistant_turn` is deliberately NOT wired for a team turn. Its
    // `continue` directive means "run another assistant turn", and on this path an
    // assistant turn is a whole N-member fan-out: one user message could become
    // MAX_CONTINUE_TURNS × N model calls, with the team's coordination strategy —
    // which already owns the who-runs-next decision — and the hook loop each
    // driving it. A team that wants iteration expresses it as a coordination
    // strategy; a plugin loop wrapped around one multiplies rather than composes.
    let inbound_text = last_user_message(&req.messages);
    // Bound to a local before the match so the borrow of `req` taken by the
    // dispatch ends here — the `Prompt` arm rewrites `req.messages` in place.
    let pre = run_pre_user_turn_hooks(
        inbound_text.clone(),
        req.conversation_id.as_deref(),
        Some(&team.id),
    )
    .await;
    match pre {
        PreUserTurn::Prompt(prompt) => {
            if prompt != inbound_text && !set_last_user_text(&mut req.messages, prompt) {
                tracing::warn!(
                    "plugin_host: team turn has no user message to rewrite; sending it unchanged"
                );
            }
        }
        PreUserTurn::Handled {
            reply,
            interactive_markup: _,
        } => {
            // No member runs at all. Both rows are written here because
            // `route_chat_stream` — the only site that persists the user turn — is
            // never reached, and the reply is framed exactly like a streamed turn so
            // the client cannot tell the difference (it must not: a client that gets
            // a turn which never opens or never closes hangs).
            if req.persist {
                if let Some(conv_id) = req.conversation_id.as_deref() {
                    let _ = persist_handled_ui_turn(
                        &conversations,
                        &req,
                        conv_id,
                        &inbound_text,
                        &reply,
                        Some(&team.id),
                    )
                    .await;
                }
            }
            let mut payload = Vec::new();
            for frame in synthetic_assistant_frames(&reply) {
                payload.extend_from_slice(&frame);
            }
            payload.extend_from_slice(&done_sse_frame());
            return sse_response(Body::from(payload));
        }
    }

    let user_text = last_user_message(&req.messages);
    let user_message = req
        .messages
        .iter()
        .rev()
        .find(|message| message.role == "user");
    let user_parts = user_message.and_then(UiMessage::render_parts);
    let widget_provenance =
        req.widget_provenance
            .as_ref()
            .map(|p| crate::server::conversations::MessageProvenance {
                source: p.source.to_owned(),
                widget_instance_id: p.widget_instance_id.clone(),
                origin_server: p.origin_server.clone(),
            });
    let conversation_id = req.conversation_id.clone();
    let original_messages = req.messages.clone();
    let members = member_names(&team.members, &agent_store).await;

    // Persist the user turn once (attributed to no agent — it's the user's), so
    // the conversation has exactly one user row regardless of member count.
    // TODO (Phase 0 follow-up): stamp the verified author_user_id here once the
    // team path carries the caller (single-agent path is wired; see chat_stream).
    if req.persist {
        if let Some(ref conv_id) = conversation_id {
            if !user_text.is_empty() || user_parts.is_some() {
                if let Err(e) = conversations
                    .append_message_as_with_render_data(
                        conv_id,
                        "user",
                        &user_text,
                        None,
                        req.author_user_id.as_deref(),
                        req.author_name.as_deref(),
                        Tenancy::Unattributed, // row exists; owner preserved by COALESCE
                        widget_provenance.as_ref(),
                        req.client_id.as_deref(),
                        user_parts.as_ref(),
                        user_message.and_then(|message| message.metadata.as_ref()),
                    )
                    .await
                {
                    tracing::warn!("failed to persist team user message: {e:#}");
                }
            }
        }
    }

    // Build the merged stream. Members run inside the stream so each block is
    // emitted as soon as that member finishes (progressive output).
    let team_id = team.id.clone();
    let coordination = team.coordination;
    let lead_id = team
        .lead_agent_id
        .clone()
        .unwrap_or_else(|| team.members[0].clone());
    let member_plugin_flags = req.plugin_flags.clone();
    let persist_combined = req.persist;

    let stream = async_stream::stream! {
        yield Ok::<_, std::convert::Infallible>(ui_start());

        let mut frames: Vec<Vec<u8>> = Vec::new();
        let mut combined = String::new();

        match coordination {
            // Every member answers the same prompt independently.
            Coordination::Broadcast => {
                for (idx, (mid, mname)) in members.iter().enumerate() {
                    let text = match run_member_text_with_flags(mid, original_messages.clone(), conversation_id.clone(), &deps, member_plugin_flags.clone()).await {
                        Ok(t) if !t.trim().is_empty() => t,
                        Ok(_) => "_(no response)_".to_owned(),
                        Err(e) => format!("_(error: {e})_"),
                    };
                    let mut block = Vec::new();
                    push_member_block(&mut block, &mut combined, &format!("m{idx}"), mname, &text);
                    for f in &block { yield Ok(f.clone()); }
                    frames.extend(block);
                }
            }
            // Members answer in order; each sees the prior members' replies.
            Coordination::RoundRobin => {
                let mut transcript = String::new();
                for (idx, (mid, mname)) in members.iter().enumerate() {
                    let msgs = if transcript.is_empty() {
                        original_messages.clone()
                    } else {
                        let preamble = format!(
                            "You are on a team. Your teammates have responded so far:\n\n{transcript}\nNow add your own response, building on theirs."
                        );
                        messages_with_preamble(&original_messages, &preamble)
                    };
                    let text = match run_member_text_with_flags(mid, msgs, conversation_id.clone(), &deps, member_plugin_flags.clone()).await {
                        Ok(t) if !t.trim().is_empty() => t,
                        Ok(_) => "_(no response)_".to_owned(),
                        Err(e) => format!("_(error: {e})_"),
                    };
                    transcript.push_str(&format!("{mname}: {text}\n\n"));
                    let mut block = Vec::new();
                    push_member_block(&mut block, &mut combined, &format!("m{idx}"), mname, &text);
                    for f in &block { yield Ok(f.clone()); }
                    frames.extend(block);
                }
            }
            // Members answer independently (round 1), then a lead synthesizes.
            Coordination::DebateSynthesis => {
                let mut round1 = String::new();
                for (idx, (mid, mname)) in members.iter().enumerate() {
                    let text = match run_member_text_with_flags(mid, original_messages.clone(), conversation_id.clone(), &deps, member_plugin_flags.clone()).await {
                        Ok(t) if !t.trim().is_empty() => t,
                        Ok(_) => "_(no response)_".to_owned(),
                        Err(e) => format!("_(error: {e})_"),
                    };
                    round1.push_str(&format!("{mname}: {text}\n\n"));
                    let mut block = Vec::new();
                    push_member_block(&mut block, &mut combined, &format!("m{idx}"), mname, &text);
                    for f in &block { yield Ok(f.clone()); }
                    frames.extend(block);
                }
                // Synthesis pass by the lead agent.
                let lead_name = members
                    .iter()
                    .find(|(id, _)| id == &lead_id)
                    .map(|(_, n)| n.clone())
                    .unwrap_or_else(|| lead_id.clone());
                let preamble = format!(
                    "You are the lead of a team. Your teammates gave these answers to the user's request:\n\n{round1}\nSynthesize them into one definitive, non-repetitive answer for the user."
                );
                let msgs = messages_with_preamble(&original_messages, &preamble);
                let synth = match run_member_text_with_flags(&lead_id, msgs, conversation_id.clone(), &deps, member_plugin_flags.clone()).await {
                    Ok(t) if !t.trim().is_empty() => t,
                    Ok(_) => "_(no synthesis)_".to_owned(),
                    Err(e) => format!("_(synthesis error: {e})_"),
                };
                let mut block = Vec::new();
                push_member_block(&mut block, &mut combined, "synth", &format!("{lead_name} (synthesis)"), &synth);
                for f in &block { yield Ok(f.clone()); }
                frames.extend(block);
            }
            // A router picks the single best-suited member, then only it answers.
            Coordination::Router => {
                let menu = members
                    .iter()
                    .map(|(id, name)| format!("- {name} (id: {id})"))
                    .collect::<Vec<_>>()
                    .join("\n");
                let route_prompt = format!(
                    "You are a router for a team of agents. Given the user's message, pick the SINGLE best-suited teammate to answer it. Reply with ONLY that teammate's id and nothing else.\n\nTeammates:\n{menu}\n\nUser message:\n{user_text}"
                );
                let pick_msgs = vec![UiMessage {
                    metadata: None,
                    role: "user".to_owned(),
                    content: UiContent::Text(route_prompt),
                    parts: vec![],
                }];
                // No conversation_id: the routing decision is a side query, not a turn.
                let pick = run_member_text(&lead_id, pick_msgs, None, &deps).await.unwrap_or_default();
                // Choose the first member whose id appears in the router's reply;
                // fall back to the first member when parsing fails.
                let chosen = members
                    .iter()
                    .find(|(id, _)| pick.contains(id.as_str()))
                    .cloned()
                    .unwrap_or_else(|| members[0].clone());
                let text = match run_member_text_with_flags(&chosen.0, original_messages.clone(), conversation_id.clone(), &deps, member_plugin_flags.clone()).await {
                    Ok(t) if !t.trim().is_empty() => t,
                    Ok(_) => "_(no response)_".to_owned(),
                    Err(e) => format!("_(error: {e})_"),
                };
                let mut block = Vec::new();
                push_member_block(&mut block, &mut combined, "m0", &format!("{} (routed)", chosen.1), &text);
                for f in &block { yield Ok(f.clone()); }
                frames.extend(block);
            }
        }

        yield Ok(ui_finish());

        // Persist exactly one combined assistant turn attributed to the team, so a
        // later reload re-renders the same merged content that just streamed.
        if persist_combined {
            if let Some(ref conv_id) = conversation_id {
                if !combined.trim().is_empty() {
                    if let Err(e) = conversations
                        .append_message_as(conv_id, "assistant", combined.trim_end(), Some(&team_id), None, None, Tenancy::Unattributed)
                        .await
                    {
                        tracing::warn!("failed to persist team assistant message: {e:#}");
                    }
                }
            }
        }

        yield Ok(DONE_SSE_LINE.as_bytes().to_vec());
    };

    sse_response(Body::from_stream(stream))
}
