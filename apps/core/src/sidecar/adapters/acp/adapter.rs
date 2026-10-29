use super::*;

pub struct AcpAdapter {
    pub agent_name: &'static str,
    pub spawn_cmd: &'static str,
}

impl AgentAdapter for AcpAdapter {
    fn name(&self) -> &'static str {
        self.agent_name
    }

    fn is_available(&self) -> bool {
        true
    }

    fn send_message(
        &self,
        _agent_id: &str,
        req: ChatRequest,
    ) -> BoxFuture<anyhow::Result<Vec<ChatChunk>>> {
        let spawn_cmd = self.spawn_cmd.to_owned();
        // Key recorded tools the same way `list_tools` reads them back.
        let agent_id = format!("acp:{}", self.agent_name);
        let prompt = req.message;
        Box::pin(async move {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            // Legacy send_message path: no McpRegistry context available here,
            // so no Ryu tools are offered. The primary tool-loop path is
            // route_acp_stream in adapters/mod.rs which passes the full registry.
            let mut rx = spawn_acp_task(
                spawn_cmd,
                prompt.clone(),
                // Legacy one-shot path: an ephemeral, un-pooled instance whose
                // only turn is the first, so `delta_prompt` is never consulted.
                prompt,
                false,
                vec![],
                cwd,
                vec![],
                vec![],
                None,
                None,
                vec![],
                agent_id.clone(),
                None,
                vec![],
                None,
                None,
                None,
                AcpTurnConfig::default(),
                None,
                None,
                false,
                // A bare engine id, never an agent record with account access.
                crate::agent_access::AccountConfinement::None,
            );
            let mut chunks = Vec::new();
            while let Some(event) = rx.recv().await {
                match event {
                    AcpEvent::Text(text) if !text.is_empty() => {
                        chunks.push(ChatChunk {
                            delta: Some(text),
                            done: false,
                            metadata: None,
                        });
                    }
                    AcpEvent::ToolCall {
                        id,
                        title,
                        kind,
                        input,
                        locations,
                    } => {
                        record_observed_tool(&agent_id, &title, &kind);
                        chunks.push(ChatChunk {
                            delta: None,
                            done: false,
                            metadata: Some(serde_json::json!({
                                "toolCall": { "id": id, "title": title, "kind": kind, "input": input, "locations": locations }
                            })),
                        });
                    }
                    // `input` is deliberately not surfaced on this legacy
                    // chunk shape: it exists so the streaming UI can correct a
                    // tool part's arguments in place, and this path has no
                    // parts to correct — it flattens the turn into text chunks.
                    AcpEvent::ToolResult {
                        id, status, output, ..
                    } => {
                        chunks.push(ChatChunk {
                            delta: None,
                            done: false,
                            metadata: Some(serde_json::json!({
                                "toolResult": { "id": id, "status": status, "output": output }
                            })),
                        });
                    }
                    AcpEvent::Error(failure) => {
                        chunks.push(ChatChunk {
                            delta: Some(failure.message),
                            done: false,
                            metadata: Some(serde_json::json!({
                                "error": true,
                                "errorCode": failure.code,
                                "errorTitle": failure.title,
                            })),
                        });
                    }
                    // Reasoning, plan snapshots, mode changes, config write-backs,
                    // permission prompts, command advertisements and usage stats are
                    // surfaced only on the streaming path (route_acp_stream); this
                    // legacy collect path returns final text + tool metadata and runs
                    // non-interactively.
                    AcpEvent::Text(_)
                    | AcpEvent::UserText(_)
                    | AcpEvent::Banner(_)
                    | AcpEvent::Thought(_)
                    | AcpEvent::Plan(_)
                    | AcpEvent::Media { .. }
                    | AcpEvent::ModeChanged(_)
                    | AcpEvent::ConfigWarning { .. }
                    | AcpEvent::AvailableCommands(_)
                    | AcpEvent::Usage(_)
                    | AcpEvent::ToolWidget(_)
                    | AcpEvent::ToolSteps { .. }
                    | AcpEvent::ConfigUpdate(_)
                    | AcpEvent::ConfigOptions(_)
                    | AcpEvent::SessionInfo(_)
                    | AcpEvent::AuthNeeded { .. }
                    | AcpEvent::PermissionRequest { .. }
                    | AcpEvent::QuestionRequest { .. } => {}
                }
            }
            chunks.push(ChatChunk {
                delta: None,
                done: true,
                metadata: None,
            });
            Ok(chunks)
        })
    }

    fn list_agents(&self) -> BoxFuture<anyhow::Result<Vec<AgentInfo>>> {
        let name = self.agent_name.to_owned();
        Box::pin(async move {
            Ok(vec![AgentInfo {
                id: format!("acp:{name}"),
                engine: Some(name.clone()),
                name,
                title: None,
                description: None,
                install_hint: None,
                installed: None,
                model: None,
                system_prompt: None,
                created_at: None,
                transport: Some("acp".into()),
                recommended: None,
                version: None,
                latest_version: None,
                version_status: None,
                locked: None,
                enabled: None,
                gateway_bypass: None,
                avatar_url: None,
                avatar_glyph: None,
                lifecycle_status: None,
                safety_profile: None,
            }])
        })
    }

    fn create_agent(&self, config: AgentConfig) -> BoxFuture<anyhow::Result<AgentInfo>> {
        Box::pin(async move {
            Ok(AgentInfo {
                id: config.name.clone(),
                name: config.name,
                title: None,
                description: None,
                install_hint: None,
                installed: None,
                model: config.model,
                system_prompt: config.system_prompt,
                created_at: None,
                engine: None,
                transport: None,
                recommended: None,
                version: None,
                latest_version: None,
                version_status: None,
                locked: None,
                enabled: None,
                gateway_bypass: None,
                avatar_url: None,
                avatar_glyph: None,
                lifecycle_status: None,
                safety_profile: None,
            })
        })
    }

    fn get_memory(
        &self,
        _agent_id: &str,
        _query: String,
    ) -> BoxFuture<anyhow::Result<Vec<MemoryEntry>>> {
        Box::pin(async move { Ok(vec![]) })
    }

    fn list_tools(&self, agent_id: &str) -> BoxFuture<anyhow::Result<Vec<ToolInfo>>> {
        // ACP agents expose no static tool catalog (tools are internal, surfaced
        // only via ToolCall notifications). Report the tools this agent has
        // actually used this session — real tools, never a fabricated list.
        // Also report the Ryu registry tools this agent is allowed to use (AC4):
        // these are offered to the agent via the in-process MCP bridge during the
        // next turn, so exposing them here keeps list_tools consistent with what
        // the agent will actually see.
        let key = if agent_id.is_empty() {
            format!("acp:{}", self.agent_name)
        } else {
            agent_id.to_owned()
        };
        Box::pin(async move { Ok(observed_tools_for(&key)) })
    }
}

/// Run an ACP agent subprocess, send prompt, and forward structured events
/// (text, tool calls, tool results) to `tx`. The agent itself runs the tool
/// loop — request, execute, result, continue — across multiple session updates;
/// the `read_update` loop below stays open across all of them until the agent
/// reports a `StopReason`, so a single turn can call a tool and continue to a
/// final answer. `tx` is closed (dropped) when the session completes or errors.
///
/// `cwd` is the working folder for the session; the ACP session is rooted there.
///
/// `mcp` and `allowlist` bridge Ryu's registered tools into the session through
/// `acp_mcp_over_acp` (the `_mcp/*` MCP-over-ACP wire of ACP 0.11's
/// `with_mcp_server`). When `mcp` is `None` or no tools are
/// available after allowlist filtering, the session runs without Ryu tools (the
/// agent only sees its own built-ins). Every bridged call routes through
/// `McpRegistry::call_tool` which enforces the allowlist (no direct-egress path).
/// One queued turn for a pooled per-chat ACP instance. Every per-turn input
/// travels in here so one long-lived subprocess/connection can serve all of a
/// chat's turns.
pub(crate) struct AcpTurn {
    pub(super) admission: Result<crate::execution_control::Admission, &'static str>,
    /// The full prompt for this turn: long-term system preamble + short-term
    /// history + the new user message. Sent verbatim ONLY on a session's FIRST
    /// turn (the live ACP session holds no history yet).
    pub(super) prompt: String,
    /// The raw new user message alone (no history). Sent on every SUBSEQUENT
    /// turn — the live session already retains the transcript, so re-sending the
    /// full `prompt` would double-count history. See `run_acp_instance`.
    pub(super) delta_prompt: String,
    pub(super) images: Vec<ImagePart>,
    pub(super) turn: AcpTurnConfig,
    pub(super) mcp: Option<Arc<McpRegistry>>,
    pub(super) allowlist: Option<Vec<String>>,
    pub(super) composio_actions: Vec<String>,
    pub(super) agent_id: String,
    pub(super) provider_account_identity: Option<String>,
    pub(super) identity_profile_ids: Vec<String>,
    pub(super) composio_connection_scope:
        Option<Vec<crate::sidecar::adapters::ComposioConnectionBinding>>,
    pub(super) conversation_scope: Option<Vec<String>>,
    pub(super) permission_scope_id: Option<String>,
    pub(super) conversation_generation: Option<String>,
    pub(super) events: mpsc::UnboundedSender<AcpEvent>,
}
