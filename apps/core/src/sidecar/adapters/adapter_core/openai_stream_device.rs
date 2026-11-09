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
