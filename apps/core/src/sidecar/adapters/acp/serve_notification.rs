use super::*;

/// Forwards one `session/update` notification to the turn's event stream.
#[allow(clippy::too_many_arguments)]
pub(super) async fn handle_session_notification(
    notification: SessionNotification,
    tx_chunk: mpsc::UnboundedSender<AcpEvent>,
    banner_slot: Arc<Mutex<Option<String>>>,
    widget_mcp: Option<Arc<McpRegistry>>,
    widget_conversation: String,
    widget_agent_id: String,
    session_identifier: SessionId,
    agent_caps: AcpCaps,
) -> Result<(), agent_client_protocol::Error> {
    match notification.update {
        SessionUpdate::AgentMessageChunk(chunk) => {
            // Surface every content block, not just
            // text: inline images/audio become `Media`
            // (→ AI-SDK `file` part); resource links
            // and embedded text resources become text.
            match chunk.content {
                ContentBlock::Text(t) => {
                    // The agent's own startup banner
                    // is chrome, not a reply — it is
                    // emitted before the user has
                    // said anything. Route it off the
                    // assistant path so it is neither
                    // buffered into `reply` nor
                    // persisted as an assistant row.
                    let event = if take_startup_banner(&banner_slot, &t.text) {
                        AcpEvent::Banner(t.text)
                    } else {
                        AcpEvent::Text(t.text)
                    };
                    let _ = tx_chunk.send(event);
                }
                ContentBlock::Image(img) => {
                    let _ = tx_chunk.send(AcpEvent::Media {
                        mime: img.mime_type,
                        data: img.data,
                    });
                }
                ContentBlock::Audio(a) => {
                    let _ = tx_chunk.send(AcpEvent::Media {
                        mime: a.mime_type,
                        data: a.data,
                    });
                }
                ContentBlock::ResourceLink(r) => {
                    let label = r.title.filter(|s| !s.is_empty()).unwrap_or(r.name);
                    let _ = tx_chunk.send(AcpEvent::Text(format!("\n[{label}]({})\n", r.uri)));
                }
                ContentBlock::Resource(res) => {
                    // Embedded resource: surface text
                    // inline, and binary blobs as Media
                    // (→ AI-SDK `file` part) instead of
                    // dropping them as before.
                    match &res.resource {
                        EmbeddedResourceResource::TextResourceContents(t) if !t.text.is_empty() => {
                            let _ = tx_chunk.send(AcpEvent::Text(t.text.clone()));
                        }
                        EmbeddedResourceResource::BlobResourceContents(b) if !b.blob.is_empty() => {
                            let mime = b
                                .mime_type
                                .clone()
                                .unwrap_or_else(|| "application/octet-stream".to_owned());
                            let _ = tx_chunk.send(AcpEvent::Media {
                                mime,
                                data: b.blob.clone(),
                            });
                        }
                        _ => {}
                    }
                }
                // `ContentBlock` is #[non_exhaustive].
                _ => {}
            }
        }
        SessionUpdate::AgentThoughtChunk(chunk) => {
            if let ContentBlock::Text(t) = chunk.content {
                let _ = tx_chunk.send(AcpEvent::Thought(t.text));
            }
        }
        SessionUpdate::Plan(plan) => {
            if let Ok(entries) = serde_json::to_value(&plan.entries) {
                let _ = tx_chunk.send(AcpEvent::Plan(entries));
            }
        }
        SessionUpdate::ToolCall(call) => {
            let _ = tx_chunk.send(tool_call_event(&call));
        }
        SessionUpdate::ToolCallUpdate(update) => {
            if let Some(ev) = tool_update_event(&update) {
                let _ = tx_chunk.send(ev);
            }
            // Managed-Pi widget path: a COMPLETED update
            // whose `rawOutput.details.ryuWidget` binding
            // was stamped by the `ryu-mcp` extension yields
            // a widget. `pi_widget_binding` gates on
            // COMPLETED + marker presence (so a partial
            // `tool_execution_update` cannot emit a premature
            // widget) and extracts the raw MCP result. REUSE
            // the shared `build_widget_event` — no second
            // synthesizer; it reads `_meta`/`structuredContent`
            // from that result and never re-dispatches.
            if let Some(reg) = widget_mcp.as_deref() {
                if let Some((tool, args, result)) = pi_widget_binding(
                    update.fields.status.as_ref(),
                    update.fields.raw_output.as_ref(),
                ) {
                    let conversation =
                        (!widget_conversation.is_empty()).then(|| widget_conversation.clone());
                    if let Some(event) = super::super::mcp_bridge::build_widget_event(
                        reg,
                        &tool,
                        &args,
                        &result,
                        Some(update.tool_call_id.to_string()),
                        conversation,
                        widget_agent_id.clone(),
                    )
                    .await
                    {
                        let _ = tx_chunk.send(AcpEvent::ToolWidget(Box::new(event)));
                    }
                }
            }
            // Nested sub-step path: a tool result
            // that declares `details.ryuSteps` gets
            // those steps fanned out by mod.rs into
            // synthetic `<id>:<n>` child tool parts.
            // A SIBLING of the widget block above,
            // not nested in it — this has nothing to
            // do with the widget MCP registry, and
            // it keys on the same kind of generic
            // `details.*` marker (no agent id).
            if let Some(steps) = pi_subagent_steps(update.fields.raw_output.as_ref()) {
                // The final answer rides only the
                // TERMINAL update: emitting it while
                // the child is still working would
                // publish a truncated answer that
                // the id-keyed dedupe then pins.
                let final_answer = matches!(
                    update.fields.status.as_ref(),
                    Some(ToolCallStatus::Completed)
                )
                .then(|| pi_subagent_answer(update.fields.raw_output.as_ref()))
                .flatten();
                let _ = tx_chunk.send(AcpEvent::ToolSteps {
                    parent_id: update.tool_call_id.to_string(),
                    steps: steps.clone(),
                    final_answer,
                });
            }
            // Session-config write-back: a tool result
            // that declares `details.ryuConfig` asks the
            // CLIENT to update the config values it holds
            // and re-sends every turn. ALSO A SIBLING of
            // the two blocks above — in particular NOT
            // nested in the widget block, which is gated
            // on an MCP registry this has nothing to do
            // with. Generic `details.*` marker, no agent
            // id and no tool name (AGENTS.md).
            if let Some(updates) = pi_config_updates(
                update.fields.status.as_ref(),
                update.fields.raw_output.as_ref(),
            ) {
                let _ = tx_chunk.send(AcpEvent::ConfigUpdate(updates));
            }
        }
        SessionUpdate::CurrentModeUpdate(m) => {
            // Agent switched mode itself; keep the
            // desktop's mode picker in sync.
            let _ = tx_chunk.send(AcpEvent::ModeChanged(m.current_mode_id.to_string()));
        }
        SessionUpdate::AvailableCommandsUpdate(u) => {
            // The agent published its slash commands.
            // Normalize to { name, description, hint }
            // and forward; the desktop replaces its
            // cached list and renders the `/` popover.
            let commands: Vec<serde_json::Value> = u
                .available_commands
                .into_iter()
                .map(|c| {
                    let hint = match c.input {
                        Some(AvailableCommandInput::Unstructured(i)) => Some(i.hint),
                        _ => None,
                    };
                    serde_json::json!({
                        "name": c.name,
                        "description": c.description,
                        "hint": hint,
                    })
                })
                .collect();
            let _ = tx_chunk.send(AcpEvent::AvailableCommands(serde_json::Value::Array(
                commands,
            )));
        }
        SessionUpdate::UsageUpdate(u) => {
            // Live context-window meter (ACP unstable
            // usage): tokens-in-context / window size.
            // A non-final frame; mod.rs reconciles it
            // in place and adds wall-clock timing.
            //
            // `cost` is documented as the SESSION's
            // cumulative spend, so it ships under a
            // `session`-prefixed key and is labelled
            // as such in the UI — presenting it as
            // this turn's cost would bill turn 1 five
            // times over by turn 5.
            let mut frame = serde_json::json!({
                "used": u.used,
                "total": u.size,
                "done": false,
            });
            // claude-agent-acp names the serving
            // model here; the desktop keys the
            // prompt-cache lifetime on it.
            if let (Some(model), Some(obj)) = (
                u.meta
                    .as_ref()
                    .and_then(|meta| meta.get("_claude/model"))
                    .and_then(serde_json::Value::as_str),
                frame.as_object_mut(),
            ) {
                obj.insert("model".to_owned(), model.into());
            }
            if let (Some(cost), Some(obj)) = (u.cost.as_ref(), frame.as_object_mut()) {
                obj.insert(
                    "sessionCostAmount".to_owned(),
                    serde_json::json!(cost.amount),
                );
                obj.insert(
                    "sessionCostCurrency".to_owned(),
                    serde_json::json!(cost.currency),
                );
            }
            let _ = tx_chunk.send(AcpEvent::Usage(frame));
        }
        SessionUpdate::ConfigOptionUpdate(u) => {
            // The agent re-published its config
            // options unprompted. No agent is
            // known to send this today, so this
            // arm is insurance: without it the
            // frame fell into the catch-all
            // below and the desktop's pickers
            // would quietly disagree with the
            // agent's real state.
            if let Ok(json) = serde_json::to_value(&u.config_options) {
                let _ = tx_chunk.send(AcpEvent::ConfigOptions(json));
            }
        }
        SessionUpdate::SessionInfoUpdate(u) => {
            // Session metadata is a real ACP update, not
            // agent text. Preserve the partial-update shape
            // (including explicit nulls) for the desktop.
            if let Ok(mut json) = serde_json::to_value(&u) {
                if let Some(object) = json.as_object_mut() {
                    // The protocol update does not carry the
                    // session id, but the binding ledger needs
                    // the id returned by session/new. Enrich the
                    // event at the transport boundary rather
                    // than fabricating a native history file.
                    object.insert(
                        "sessionId".to_owned(),
                        serde_json::json!(session_identifier),
                    );
                    object.insert("capabilities".to_owned(), agent_caps_json(&agent_caps));
                }
                let _ = tx_chunk.send(AcpEvent::SessionInfo(json));
            }
        }
        SessionUpdate::UserMessageChunk(chunk) => {
            // The agent replayed a user message chunk
            // (mainly during a session/load history
            // replay). Forward text so it isn't
            // silently dropped; mod.rs surfaces it as a
            // user-echo data part.
            if let ContentBlock::Text(t) = chunk.content {
                let _ = tx_chunk.send(AcpEvent::UserText(t.text));
            }
        }
        _ => {}
    }
    Ok(())
}
