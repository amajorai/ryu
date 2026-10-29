use super::*;

#[tokio::test]
async fn initialize_advertises_supported_capabilities() {
    let (url, _core) = start_core(Scenario::TextAndTool).await;
    let (response, _) = run_client(
        config(&url, None),
        PermissionReply::Cancel,
        async |cx, _| initialize(&cx).await,
    )
    .await;
    assert_eq!(response.protocol_version, ProtocolVersion::V1);
    let caps = &response.agent_capabilities;
    assert!(caps.load_session);
    assert!(caps.prompt_capabilities.image);
    assert!(caps.prompt_capabilities.embedded_context);
    assert!(!caps.prompt_capabilities.audio);
    assert_eq!(response.agent_info.expect("agent info").name, "ryu");
}

#[tokio::test]
async fn new_session_offers_agents_as_modes() {
    let (url, _core) = start_core(Scenario::TextAndTool).await;
    let (default_session, _) = run_client(
        config(&url, None),
        PermissionReply::Cancel,
        async |cx, _| {
            initialize(&cx).await?;
            cx.send_request(NewSessionRequest::new("/work"))
                .block_task()
                .await
        },
    )
    .await;
    let modes = default_session.modes.expect("agents exposed as modes");
    assert_eq!(modes.current_mode_id.0.as_ref(), "ryu");
    let ids: Vec<&str> = modes
        .available_modes
        .iter()
        .map(|mode| mode.id.0.as_ref())
        .collect();
    assert_eq!(ids, ["ryu", "coder"]);

    let (flagged, _) = run_client(
        config(&url, Some("coder")),
        PermissionReply::Cancel,
        async |cx, _| {
            initialize(&cx).await?;
            cx.send_request(NewSessionRequest::new("/work"))
                .block_task()
                .await
        },
    )
    .await;
    assert_eq!(
        flagged.modes.expect("modes").current_mode_id.0.as_ref(),
        "coder"
    );

    let (unknown, _) = run_client(
        config(&url, Some("ghost")),
        PermissionReply::Cancel,
        async |cx, _| {
            initialize(&cx).await?;
            Ok(cx
                .send_request(NewSessionRequest::new("/work"))
                .block_task()
                .await)
        },
    )
    .await;
    let error = unknown.expect_err("unknown agent is rejected");
    assert!(error.message.contains("ghost"), "{}", error.message);
}

#[tokio::test]
async fn prompt_streams_text_reasoning_and_tool_calls() {
    let (url, core) = start_core(Scenario::TextAndTool).await;
    let ((session_id, first, second), log) = run_client(
        config(&url, None),
        PermissionReply::Cancel,
        async |cx, _| {
            initialize(&cx).await?;
            let session = cx
                .send_request(NewSessionRequest::new("/work/project"))
                .block_task()
                .await?;
            let first = cx
                .send_request(text_prompt(session.session_id.clone(), "list files"))
                .block_task()
                .await?;
            cx.send_request(SetSessionModeRequest::new(
                session.session_id.clone(),
                "coder",
            ))
            .block_task()
            .await?;
            let second = cx
                .send_request(text_prompt(session.session_id.clone(), "again"))
                .block_task()
                .await?;
            Ok((session.session_id, first, second))
        },
    )
    .await;
    assert_eq!(first.stop_reason, StopReason::EndTurn);
    assert_eq!(second.stop_reason, StopReason::EndTurn);

    let updates = log.updates.lock().unwrap().clone();
    // First turn only (the second repeats the script).
    let first_turn = &updates[..updates.len() / 2];
    let texts: Vec<(&str, String)> = first_turn.iter().filter_map(chunk_text).collect();
    assert_eq!(
        texts,
        [
            ("thought", "Considering".to_owned()),
            ("message", "Hello".to_owned()),
            ("message", " world".to_owned()),
        ]
    );
    let tool_events: Vec<&SessionUpdate> = first_turn
        .iter()
        .filter(|update| {
            matches!(
                update,
                SessionUpdate::ToolCall(_) | SessionUpdate::ToolCallUpdate(_)
            )
        })
        .collect();
    assert_eq!(
        tool_events.len(),
        3,
        "start, input, output: {tool_events:#?}"
    );
    let SessionUpdate::ToolCall(call) = tool_events[0] else {
        panic!("tool call opens with tool_call");
    };
    assert_eq!(call.tool_call_id.0.as_ref(), "c1");
    assert_eq!(call.kind, ToolKind::Execute);
    assert_eq!(call.status, ToolCallStatus::Pending);
    let SessionUpdate::ToolCallUpdate(input) = tool_events[1] else {
        panic!("arguments arrive as tool_call_update");
    };
    assert_eq!(input.fields.status, Some(ToolCallStatus::InProgress));
    assert_eq!(input.fields.title.as_deref(), Some("Bash: ls"));
    assert_eq!(input.fields.raw_input, Some(json!({ "command": "ls" })));
    let SessionUpdate::ToolCallUpdate(done) = tool_events[2] else {
        panic!("result arrives as tool_call_update");
    };
    assert_eq!(done.fields.status, Some(ToolCallStatus::Completed));
    assert_eq!(done.fields.raw_output, Some(json!("file.txt")));

    // What Core received: the session is the conversation, cwd and agent ride
    // along, and the second turn replays the first as history.
    let recorded = core.recorded.lock().unwrap();
    let first_body = &recorded.chat_bodies[0];
    assert_eq!(
        first_body["conversation_id"].as_str(),
        Some(session_id.0.as_ref())
    );
    assert_eq!(first_body["agent_id"], json!("ryu"));
    assert_eq!(first_body["cwd"], json!("/work/project"));
    assert_eq!(
        first_body["messages"],
        json!([{ "role": "user", "parts": [{ "type": "text", "text": "list files" }] }])
    );
    let second_body = &recorded.chat_bodies[1];
    assert_eq!(second_body["agent_id"], json!("coder"));
    let history = second_body["messages"].as_array().unwrap();
    assert_eq!(history.len(), 3);
    assert_eq!(history[0]["content"][0]["text"], json!("list files"));
    assert_eq!(history[1]["role"], json!("assistant"));
    assert_eq!(history[1]["content"][0]["text"], json!("Hello world"));
}
