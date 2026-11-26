//! Phone device tools on the ACP plane, reached only through this in-process
//! bridge (design §2.2 "ACP plane").
//!
//! Device tools are listed for the whole session (agents cache `tools/list`
//! and the bridge never sends `list_changed`) once a turn of this conversation
//! and agent was stamped with an offer, i.e. the flag was on and the
//! conversation passed the own-chat check. Each call is decided at dispatch:
//! it runs only when this bridge has an in-process permission channel AND the
//! user's live turn was registered by THIS ACP instance (same bridge channel,
//! same agent; see `device_tools::turn_context`). Team-member, delegated and
//! other pooled instances on the same conversation get `device_unavailable`;
//! the network `POST /mcp/:agent_id` transport has no channel and always gets
//! `not_own_chat`.

use super::*;

impl RyuMcpHandler {
    /// Whether this session lists device tools: an in-process bridge whose
    /// conversation and agent had a turn stamped with a device offer (flag on,
    /// own chat), on a node where a phone is paired.
    pub(super) fn lists_device_tools(&self) -> bool {
        self.permission_tx.is_some()
            && self
                .permission_scope_id
                .as_deref()
                .is_some_and(|conversation| {
                    crate::device_tools::turn_context::device_listing_allowed(
                        conversation,
                        &self.agent_id,
                    )
                })
            && crate::device_tools::registry::store().is_some_and(|store| store.has_active_device())
    }

    /// The live turn's device offer, only when THIS instance (its bridge
    /// channel and agent) registered the turn.
    pub(super) fn device_turn_offer(&self) -> Option<Arc<crate::device_tools::DeviceOffer>> {
        crate::device_tools::turn_context::turn_context_for(
            self.permission_scope_id.as_deref()?,
            self.permission_tx.as_ref()?,
            &self.agent_id,
        )
    }

    /// Run the registry call `name` under the private-read scope the
    /// exfiltration guard reads: this turn's own after a device read in it,
    /// else one marked with the read the conversation already holds (another
    /// instance's live turn, an ended turn, the stored history; an unreadable
    /// history holds too). The meta-tools and device tools carry nothing out,
    /// so they skip the history read.
    pub(super) async fn with_private_read_scope<F: std::future::Future>(
        &self,
        name: &str,
        offer: Option<&Arc<crate::device_tools::DeviceOffer>>,
        future: F,
    ) -> F::Output {
        let conversation = self
            .permission_scope_id
            .as_deref()
            .filter(|_| {
                !matches!(name, "tool_search" | "describe")
                    && !crate::device_tools::catalog::is_device_tool_name(name)
            })
            .map(|conversation| (self.mcp.conversations.as_ref(), conversation));
        crate::device_tools::taint::with_device_read_scope(offer, conversation, future).await
    }

    /// [`Self::dispatch_tool`] behind the device-read guards, for every
    /// transport of the in-process bridge (rmcp and the managed Pi's JSON-RPC
    /// route): after a device read in this turn or earlier in the
    /// conversation, later egress is held by the exfiltration guard; any other
    /// tool result is untrusted input, so later device calls in the turn ask.
    pub(super) async fn dispatch_guarded(
        &self,
        name: &str,
        args: Value,
    ) -> Result<String, McpError> {
        let device_offer = self.device_turn_offer();
        let text = self
            .with_private_read_scope(name, device_offer.as_ref(), self.dispatch_tool(name, args))
            .await?;
        if let Some(offer) = device_offer.as_ref() {
            if !crate::device_tools::catalog::is_device_tool_name(name) {
                offer.mark_tainted_input();
            }
        }
        Ok(text)
    }

    pub(super) async fn dispatch_device_tool(
        &self,
        tool_id: &str,
        args: Value,
    ) -> Result<String, McpError> {
        use crate::device_tools::frames::DeviceUiEvent;
        use crate::device_tools::DeviceErrorCode;
        let envelope = match (self.permission_tx.as_ref(), self.device_turn_offer()) {
            (None, _) => DeviceErrorCode::NotOwnChat.envelope(),
            (Some(_), None) => DeviceErrorCode::DeviceUnavailable.envelope(),
            (Some(tx), Some(offer)) => {
                let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
                let tx = tx.clone();
                let forward = tokio::spawn(async move {
                    while let Some(event) = receiver.recv().await {
                        // The agent renders its own tool call; only Core's
                        // device data parts travel on the turn stream.
                        if let DeviceUiEvent::Data { name, id, data } = event {
                            let _ = tx.send(AcpEvent::UiData { name, id, data });
                        }
                    }
                });
                let call_id = format!("dev-{}", uuid::Uuid::new_v4().simple());
                // Recorded so the agent's own echo of this call (its
                // `tool_call` frame) is redacted whatever it titles it.
                let slot = crate::device_tools::catalog::catalog()
                    .tool(tool_id)
                    .and_then(|tool| offer.bridge_calls.record_args(tool, &args));
                let result = crate::device_tools::dispatch::dispatch_call(
                    &offer, &call_id, tool_id, args, &events,
                )
                .await;
                offer.bridge_calls.record_result(slot, &result);
                drop(events);
                let _ = forward.await;
                result
            }
        };
        Ok(neutralize_external_result(tool_id, envelope.to_string()))
    }
}

/// The device tool definitions a listing session offers.
pub(super) fn device_tool_defs() -> Vec<Value> {
    crate::device_tools::catalog::catalog()
        .available_tools()
        .map(crate::device_tools::catalog::openai_tool_schema)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_tools::identity::DevicePrincipal;
    use crate::device_tools::registry::{DeviceState, NewDevice};

    fn bridge(
        permission_tx: Option<tokio::sync::mpsc::UnboundedSender<AcpEvent>>,
        conversation: &str,
    ) -> RyuMcpHandler {
        RyuMcpHandler {
            mcp: Arc::new(McpRegistry::empty()),
            allowlist: None,
            composio_actions: Vec::new(),
            agent_id: "ryu".to_owned(),
            identity_profile_ids: Vec::new(),
            composio_connection_scope: None,
            conversation_scope: None,
            caps: crate::sidecar::mcp::AgentCapabilities::default(),
            permission_tx,
            permission_scope_id: Some(conversation.to_owned()),
        }
    }

    /// The managed Pi reaches the bridge over JSON-RPC: its calls pass the
    /// same device guards as the rmcp transport.
    #[tokio::test]
    async fn the_managed_pi_transport_is_guarded_like_the_rmcp_one() {
        let decl = serde_json::from_value(json!({
            "device_id": uuid::Uuid::new_v4().to_string(), "app": "ryu-bot", "platform": "ios",
            "foreground": true, "catalog_version": 1, "tools": [{ "app": "alarms", "permission": "granted" }],
        }))
        .unwrap();
        let conversation = format!("conv-{}", uuid::Uuid::new_v4().simple());
        let offer = Arc::new(crate::device_tools::DeviceOffer::new(
            conversation.clone(),
            DevicePrincipal::LocalOwner,
            decl,
            crate::approvals::policy::ApprovalMode::Smart,
        ));
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let _turn =
            crate::device_tools::offer::register_turn_context(Arc::clone(&offer), &tx, "ryu");
        let scope = AcpSessionMcpScope {
            agent_id: "ryu".to_owned(),
            conversation_id: conversation,
            allowlist: None,
            composio_actions: Vec::new(),
            identity_profile_ids: Vec::new(),
            composio_connection_scope: None,
            conversation_scope: None,
            events: Some(tx),
        };
        let call = json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "tool_search", "arguments": { "query": "x" } }
        });
        assert!(!offer.tainted_input());
        serve_acp_session_jsonrpc(Arc::new(McpRegistry::empty()), scope, &call)
            .await
            .expect("answered");
        // A non-device tool result is untrusted input: later device calls ask.
        assert!(offer.tainted_input());
    }

    #[tokio::test]
    async fn a_device_read_in_the_history_scopes_a_later_turns_registry_calls() {
        use crate::server::conversations::{ConversationStore, Tenancy};
        let conversation = format!("conv-{}", uuid::Uuid::new_v4().simple());
        let store = ConversationStore::open_in_memory().unwrap();
        let read = json!([{
            "type": "tool-device_location_current", "toolCallId": "t",
            "state": "output-available", "output": { "lat": 37.33, "lon": -122.03 }
        }]);
        store
            .append_message_as_with_render_data(
                &conversation,
                "assistant",
                "",
                None,
                None,
                None,
                Tenancy::Unattributed,
                None,
                None,
                Some(&read),
                None,
            )
            .await
            .unwrap();
        let mut registry = McpRegistry::empty();
        registry.conversations = Some(store);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let mut later = bridge(Some(tx), &conversation);
        later.mcp = Arc::new(registry);
        // No device turn is live: the stored read still scopes the call.
        assert!(later.device_turn_offer().is_none());
        let source = || async {
            crate::approvals::exfiltration_guard::current_sandbox_run()
                .and_then(|run| run.private_read_source().map(str::to_owned))
        };
        let scoped = later
            .with_private_read_scope("delegate.fanout", None, source())
            .await;
        assert_eq!(scoped.as_deref(), Some("device.location.current"));
        // The meta-tools carry nothing out and skip the history read.
        let meta = later
            .with_private_read_scope("tool_search", None, source())
            .await;
        assert_eq!(meta, None);
    }

    #[tokio::test]
    async fn network_mcp_is_not_own_chat_and_no_live_turn_is_unavailable() {
        let network = bridge(None, "conv-net");
        assert!(!network.lists_device_tools());
        let text = network
            .dispatch_tool("device_timer_set", json!({ "duration_seconds": 5 }))
            .await
            .unwrap();
        assert!(text.contains("not_own_chat"), "{text}");
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let idle = bridge(Some(tx), "conv-idle");
        let text = idle
            .dispatch_tool("device.timer.set", json!({ "duration_seconds": 5 }))
            .await
            .unwrap();
        assert!(text.contains("device_unavailable"), "{text}");
    }

    #[tokio::test]
    async fn a_live_own_chat_turn_reaches_the_gate_and_streams_ui_data() {
        let principal = DevicePrincipal::User(format!("bridge-{}", uuid::Uuid::new_v4().simple()));
        let device_id = uuid::Uuid::new_v4().to_string();
        crate::device_tools::registry::store()
            .unwrap()
            .pair(
                &NewDevice {
                    principal_id: &principal.id(),
                    device_id: &device_id,
                    public_key: b"k",
                    app: "ryu-bot",
                    platform: "ios",
                    label: "Phone",
                    attestation: None,
                    initial_state: DeviceState::Active,
                },
                crate::device_tools::now_ms(),
            )
            .unwrap();
        crate::device_tools::presence::refresh(
            &principal.id(),
            &device_id,
            true,
            crate::device_tools::now_ms(),
        );
        let decl = serde_json::from_value(json!({
            "device_id": device_id, "app": "ryu-bot", "platform": "ios", "foreground": true,
            "catalog_version": 1, "tools": [{ "app": "alarms", "permission": "granted" }],
        }))
        .unwrap();
        let conversation = format!("conv-{}", uuid::Uuid::new_v4().simple());
        let offer = Arc::new(crate::device_tools::DeviceOffer::new(
            conversation.clone(),
            principal.clone(),
            decl,
            crate::approvals::policy::ApprovalMode::Smart,
        ));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let live = bridge(Some(tx.clone()), &conversation);
        assert!(
            !live.lists_device_tools(),
            "nothing is listed before a turn of this conversation was stamped"
        );
        let _turn =
            crate::device_tools::offer::register_turn_context(Arc::clone(&offer), &tx, "ryu");
        assert!(live.lists_device_tools());

        // Another instance on the same conversation (its own bridge channel),
        // or the same channel under another agent, never gets the offer.
        let (other_tx, _other_rx) = tokio::sync::mpsc::unbounded_channel();
        let other_instance = bridge(Some(other_tx), &conversation);
        let text = other_instance
            .dispatch_tool("device_timer_set", json!({ "duration_seconds": 60 }))
            .await
            .unwrap();
        assert!(text.contains("device_unavailable"), "{text}");
        let mut other_agent = bridge(Some(tx.clone()), &conversation);
        other_agent.agent_id = "team-member".to_owned();
        assert!(!other_agent.lists_device_tools());
        let text = other_agent
            .dispatch_tool("device_timer_set", json!({ "duration_seconds": 60 }))
            .await
            .unwrap();
        assert!(text.contains("device_unavailable"), "{text}");
        let call = live.dispatch_tool("device_timer_set", json!({ "duration_seconds": 60 }));
        let answer = async {
            loop {
                match rx.recv().await {
                    Some(AcpEvent::UiData { name, data, .. }) if name == "ryu-permission" => {
                        let id = data["requestId"].as_str().unwrap().to_owned();
                        crate::device_tools::prompts::resolve(&id, Some("deny"), &principal.id())
                            .unwrap();
                        break;
                    }
                    Some(_) => {}
                    None => panic!("no permission card"),
                }
            }
        };
        let (text, ()) = tokio::join!(call, answer);
        assert!(text.unwrap().contains("cancelled_by_user"));
        // The bridge recorded the call, so the agent's own echo of it is
        // recognized whatever the agent titles it.
        let tool = offer
            .bridge_calls
            .match_input(&json!({ "arguments": { "duration_seconds": 60 } }))
            .expect("recorded arguments");
        assert_eq!(tool.id, "device.timer.set");
        let envelope = crate::device_tools::DeviceErrorCode::CancelledByUser.envelope();
        assert_eq!(
            offer
                .bridge_calls
                .match_output(&envelope)
                .map(|t| t.id.as_str()),
            Some("device.timer.set")
        );
    }
}

#[cfg(test)]
#[path = "device_read_runtime_test.rs"]
mod runtime_test;
