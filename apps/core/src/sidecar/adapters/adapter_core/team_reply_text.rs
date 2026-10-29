use super::*;

/// Non-streaming team reply for the channel-bot path: fan out to the team's
/// members per its coordination strategy and return one combined, attributed
/// reply string. Mirrors [`route_team_chat_stream`] but assembles plain text —
/// channels deliver a single message, so progressive streaming is not needed.
///
/// Like the channel agent path, this persists the user turn and one combined
/// assistant turn (attributed to the team) so a later desktop reload of the
/// same conversation renders the same merged content.
///
/// Turn hooks: `pre_user_turn` fires ONCE here, before the single persisted user
/// row and before the fan-out, so a plugin's rewrite/redaction governs the text
/// every member sees and the text the transcript keeps. `post_assistant_turn` does
/// NOT fire — see the note on [`route_team_chat_stream`], whose reasoning is
/// identical and applies verbatim to this non-streaming twin.
#[allow(clippy::too_many_arguments)]
pub async fn run_team_reply_text(
    conversation_id: String,
    team: ryu_teams_contracts::TeamRecord,
    text: String,
    author_name: Option<String>,
    registry: Arc<AcpAgentRegistry>,
    conversations: ConversationStore,
    agent_store: AgentStore,
    manager: Arc<SidecarManager>,
    memory: MemoryStore,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    skills: SkillRegistry,
    traces: TraceStore,
) -> anyhow::Result<TextReplyResult> {
    use ryu_teams_contracts::Coordination;

    if team.members.is_empty() {
        anyhow::bail!(
            "Team '{}' has no members. Add agents to the team first.",
            team.name
        );
    }

    let mut admission = ChatStreamRequest {
        conversation_id: Some(conversation_id.clone()),
        persist: true,
        ..Default::default()
    };
    capture_acp_conversation_generation(&mut admission, &conversations)
        .await
        .map_err(anyhow::Error::msg)?;

    for member_id in &team.members {
        crate::agent_execution::ensure_noninteractive_run_allowed(&agent_store, Some(member_id))
            .await?;
    }

    let deps = TeamRunDeps {
        registry,
        acp_conversation_generation: admission.acp_conversation_generation,
        conversations: conversations.clone(),
        agent_store: agent_store.clone(),
        manager,
        memory,
        worktree_diffs,
        mcp,
        skills,
        traces,
        agent_resource_authorization: None,
    };

    // Pre-turn hooks run before anything is persisted or fanned out: one rewrite
    // for one user turn, whatever the member count. A `Handled` turn answers
    // without waking a single member, and owns both transcript rows itself.
    let inbound = text.clone();
    let text = match run_pre_user_turn_hooks(text, Some(&conversation_id), Some(&team.id)).await {
        PreUserTurn::Prompt(p) => p,
        PreUserTurn::Handled {
            reply,
            interactive_markup: _,
        } => {
            let assistant_message_id = persist_handled_turn(
                &conversations,
                &conversation_id,
                &inbound,
                &reply,
                Some(&team.id),
                None,
                author_name.as_deref(),
            )
            .await;
            return Ok(TextReplyResult {
                reply,
                assistant_message_ids: assistant_message_id.clone().into_iter().collect(),
                assistant_message_id,
                interactive_markup: None,
            });
        }
    };

    let original_messages = vec![UiMessage {
        metadata: None,
        role: "user".to_owned(),
        content: UiContent::Text(text.clone()),
        parts: vec![],
    }];
    let user_text = text;
    let conv = Some(conversation_id.clone());
    let members = member_names(&team.members, &agent_store).await;
    let lead_id = team
        .lead_agent_id
        .clone()
        .unwrap_or_else(|| team.members[0].clone());

    // Persist the user turn once (attributed to the user, not a member). The
    // verified author_user_id is still None on the team path (the channel caller
    // is unauthenticated); the connector-supplied display name is carried so a
    // multi-participant group thread records who spoke.
    if !user_text.trim().is_empty() {
        if let Err(e) = conversations
            .append_message_as(
                &conversation_id,
                "user",
                &user_text,
                None,
                None,
                author_name.as_deref(),
                // The row already exists (created + stamped upstream by
                // `chat_stream`/`gate_and_claim_conversation`, or genuinely
                // untenanted bot ingress). The choke point COALESCEs, so this
                // can never wipe a claimed owner.
                Tenancy::Unattributed,
            )
            .await
        {
            tracing::warn!("failed to persist team channel user message: {e:#}");
        }
    }

    // Resolve one member's reply, normalising empties/errors like the streaming
    // path. A nested item (not a closure) so it can be `await`ed in a loop.
    async fn member_reply(
        mid: &str,
        msgs: Vec<UiMessage>,
        conv: Option<String>,
        deps: &TeamRunDeps,
    ) -> String {
        match run_member_text(mid, msgs, conv, deps).await {
            Ok(t) if !t.trim().is_empty() => t,
            Ok(_) => "_(no response)_".to_owned(),
            Err(e) => format!("_(error: {e})_"),
        }
    }

    let mut combined = String::new();
    match team.coordination {
        // Every member answers the same prompt independently.
        Coordination::Broadcast => {
            for (mid, mname) in &members {
                let t = member_reply(mid, original_messages.clone(), conv.clone(), &deps).await;
                combined.push_str(&format!("**{mname}**\n\n{t}\n\n"));
            }
        }
        // Members answer in order; each sees the prior members' replies.
        Coordination::RoundRobin => {
            let mut transcript = String::new();
            for (mid, mname) in &members {
                let msgs = if transcript.is_empty() {
                    original_messages.clone()
                } else {
                    let preamble = format!(
                        "You are on a team. Your teammates have responded so far:\n\n{transcript}\nNow add your own response, building on theirs."
                    );
                    messages_with_preamble(&original_messages, &preamble)
                };
                let t = member_reply(mid, msgs, conv.clone(), &deps).await;
                transcript.push_str(&format!("{mname}: {t}\n\n"));
                combined.push_str(&format!("**{mname}**\n\n{t}\n\n"));
            }
        }
        // Members answer independently, then the lead synthesizes.
        Coordination::DebateSynthesis => {
            let mut round1 = String::new();
            for (mid, mname) in &members {
                let t = member_reply(mid, original_messages.clone(), conv.clone(), &deps).await;
                round1.push_str(&format!("{mname}: {t}\n\n"));
                combined.push_str(&format!("**{mname}**\n\n{t}\n\n"));
            }
            let lead_name = members
                .iter()
                .find(|(id, _)| id == &lead_id)
                .map(|(_, n)| n.clone())
                .unwrap_or_else(|| lead_id.clone());
            let preamble = format!(
                "You are the lead of a team. Your teammates gave these answers to the user's request:\n\n{round1}\nSynthesize them into one definitive, non-repetitive answer for the user."
            );
            let msgs = messages_with_preamble(&original_messages, &preamble);
            let synth = match run_member_text(&lead_id, msgs, conv.clone(), &deps).await {
                Ok(t) if !t.trim().is_empty() => t,
                Ok(_) => "_(no synthesis)_".to_owned(),
                Err(e) => format!("_(synthesis error: {e})_"),
            };
            combined.push_str(&format!("**{lead_name} (synthesis)**\n\n{synth}\n\n"));
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
            // No conversation_id: the routing decision is a side query.
            let pick = run_member_text(&lead_id, pick_msgs, None, &deps)
                .await
                .unwrap_or_default();
            let chosen = members
                .iter()
                .find(|(id, _)| pick.contains(id.as_str()))
                .cloned()
                .unwrap_or_else(|| members[0].clone());
            let t = member_reply(&chosen.0, original_messages.clone(), conv.clone(), &deps).await;
            combined.push_str(&format!("**{} (routed)**\n\n{t}\n\n", chosen.1));
        }
    }

    let combined = combined.trim_end().to_string();

    // Persist exactly one combined assistant turn attributed to the team.
    let assistant_message_id = if !combined.is_empty() {
        match conversations
            .append_message_as(
                &conversation_id,
                "assistant",
                &combined,
                Some(&team.id),
                None,
                None,
                Tenancy::Unattributed, // row exists; owner preserved by COALESCE
            )
            .await
        {
            Ok(message_id) => Some(message_id),
            Err(e) => {
                tracing::warn!("failed to persist team channel assistant message: {e:#}");
                None
            }
        }
    } else {
        None
    };

    Ok(TextReplyResult {
        reply: combined,
        assistant_message_ids: assistant_message_id.clone().into_iter().collect(),
        assistant_message_id,
        interactive_markup: None,
    })
}
