use super::*;

#[tokio::test]
async fn cancel_mid_stream_ends_with_cancelled_and_stops_core() {
    let (url, core) = start_core(Scenario::Hang).await;
    let ((session_id, response), _) = run_client(
        config(&url, None),
        PermissionReply::Cancel,
        async |cx, log| {
            initialize(&cx).await?;
            let session = cx
                .send_request(NewSessionRequest::new("/work"))
                .block_task()
                .await?;
            let pending = cx.send_request(text_prompt(session.session_id.clone(), "long job"));
            log.first_message_chunk.notified().await;
            cx.send_notification(CancelNotification::new(session.session_id.clone()))?;
            let response = pending.block_task().await?;
            Ok((session.session_id, response))
        },
    )
    .await;
    assert_eq!(response.stop_reason, StopReason::Cancelled);
    // Core is told to stop the run before the prompt is answered.
    assert_eq!(
        core.recorded.lock().unwrap().cancels,
        [session_id.0.to_string()]
    );
}

#[tokio::test]
async fn permission_request_is_forwarded_and_denial_honoured() {
    let (url, core) = start_core(Scenario::Permission).await;
    let (response, log) = run_client(
        config(&url, None),
        PermissionReply::Select("reject"),
        async |cx, _| {
            initialize(&cx).await?;
            let session = cx
                .send_request(NewSessionRequest::new("/work"))
                .block_task()
                .await?;
            cx.send_request(text_prompt(session.session_id, "clean up"))
                .block_task()
                .await
        },
    )
    .await;
    assert_eq!(response.stop_reason, StopReason::EndTurn);

    let requests = log.permission_requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].tool_call.tool_call_id.0.as_ref(), "c7");
    let option_ids: Vec<&str> = requests[0]
        .options
        .iter()
        .map(|option| option.option_id.0.as_ref())
        .collect();
    assert_eq!(option_ids, ["allow", "reject"]);

    // The tool call was announced before the permission referenced it.
    let updates = log.updates.lock().unwrap();
    assert!(updates.iter().any(|update| matches!(
        update,
        SessionUpdate::ToolCall(call) if call.tool_call_id.0.as_ref() == "c7"
    )));
    let texts: Vec<String> = updates
        .iter()
        .filter_map(chunk_text)
        .map(|(_, text)| text)
        .collect();
    assert_eq!(texts, ["denied"]);

    let recorded = core.recorded.lock().unwrap();
    assert_eq!(
        recorded.permissions,
        [json!({ "request_id": "perm-1", "option_id": "reject" })]
    );
}

#[tokio::test]
async fn core_gate_permission_keeps_its_title_and_arguments() {
    let (url, _core) = start_core(Scenario::CoreGatePermission).await;
    let (_, log) = run_client(
        config(&url, None),
        PermissionReply::Select("reject"),
        async |cx, _| {
            initialize(&cx).await?;
            let session = cx
                .send_request(NewSessionRequest::new("/work"))
                .block_task()
                .await?;
            cx.send_request(text_prompt(session.session_id, "clean up"))
                .block_task()
                .await
        },
    )
    .await;
    let requests = log.permission_requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let fields = &requests[0].tool_call.fields;
    assert_eq!(fields.title.as_deref(), Some("delete the build folder"));
    assert_eq!(fields.raw_input, Some(json!({ "path": "build" })));
}

#[tokio::test]
async fn in_progress_tool_updates_do_not_complete_the_call() {
    let (url, _core) = start_core(Scenario::ToolProgress).await;
    let (_, log) = run_client(
        config(&url, None),
        PermissionReply::Cancel,
        async |cx, _| {
            initialize(&cx).await?;
            let session = cx
                .send_request(NewSessionRequest::new("/work"))
                .block_task()
                .await?;
            cx.send_request(text_prompt(session.session_id, "build"))
                .block_task()
                .await
        },
    )
    .await;
    let updates = log.updates.lock().unwrap();
    let tool_updates: Vec<_> = updates
        .iter()
        .filter_map(|update| match update {
            SessionUpdate::ToolCallUpdate(update) => Some(&update.fields),
            _ => None,
        })
        .collect();
    assert_eq!(tool_updates.len(), 2, "{tool_updates:#?}");
    assert_eq!(tool_updates[0].status, Some(ToolCallStatus::InProgress));
    assert_eq!(tool_updates[0].raw_output, None);
    assert_eq!(tool_updates[1].status, Some(ToolCallStatus::Completed));
    assert_eq!(tool_updates[1].raw_output, Some(json!("built")));
}

#[tokio::test]
async fn blocking_question_is_asked_and_answered_in_core() {
    let (url, core) = start_core(Scenario::Question).await;
    let ((session_id, response), log) = run_client(
        config(&url, None),
        PermissionReply::Select("option-1"),
        async |cx, _| {
            initialize(&cx).await?;
            let session = cx
                .send_request(NewSessionRequest::new("/work"))
                .block_task()
                .await?;
            let response = cx
                .send_request(text_prompt(session.session_id.clone(), "set it up"))
                .block_task()
                .await?;
            Ok((session.session_id, response))
        },
    )
    .await;
    assert_eq!(response.stop_reason, StopReason::EndTurn);

    // The choice question became a prompt in the editor, with a Skip option.
    let requests = log.permission_requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].tool_call.tool_call_id.0.as_ref(), "q1");
    assert_eq!(
        requests[0].tool_call.fields.title.as_deref(),
        Some("Which database?")
    );
    let option_names: Vec<&str> = requests[0]
        .options
        .iter()
        .map(|option| option.name.as_str())
        .collect();
    assert_eq!(option_names, ["Postgres", "SQLite", "Skip"]);

    // Core's waiter was released with one answer per question; the free-text
    // one is skipped because an editor prompt cannot carry typed text.
    assert_eq!(
        core.recorded.lock().unwrap().questions,
        [json!({
            "conversation_id": session_id.0.as_ref(),
            "tool_call_id": "q1",
            "answers": [
                { "kind": "single", "selectedIds": ["sqlite"] },
                { "kind": "skip" }
            ]
        })]
    );
    let texts: Vec<String> = log
        .updates
        .lock()
        .unwrap()
        .iter()
        .filter_map(chunk_text)
        .map(|(_, text)| text)
        .collect();
    assert!(
        texts.iter().any(|text| text.contains("Anything else?")),
        "{texts:?}"
    );
    assert_eq!(texts.last().map(String::as_str), Some("thanks"));
}

#[tokio::test]
async fn answer_core_no_longer_waits_for_is_reported_to_the_user() {
    let (url, core) = start_core(Scenario::StaleQuestion).await;
    let (response, log) = run_client(
        config(&url, None),
        PermissionReply::Select("option-0"),
        async |cx, _| {
            initialize(&cx).await?;
            let session = cx
                .send_request(NewSessionRequest::new("/work"))
                .block_task()
                .await?;
            cx.send_request(text_prompt(session.session_id, "set it up"))
                .block_task()
                .await
        },
    )
    .await;
    assert_eq!(response.stop_reason, StopReason::EndTurn);
    assert_eq!(core.recorded.lock().unwrap().questions.len(), 1);
    let texts: Vec<String> = log
        .updates
        .lock()
        .unwrap()
        .iter()
        .filter_map(chunk_text)
        .map(|(_, text)| text)
        .collect();
    assert!(
        texts
            .iter()
            .any(|text| text.contains("Postgres") && text.contains("did not reach")),
        "{texts:?}"
    );
}

#[tokio::test]
async fn agent_question_tool_is_shown_but_not_asked() {
    let (url, core) = start_core(Scenario::AgentQuestion).await;
    let (response, log) = run_client(
        config(&url, None),
        PermissionReply::Select("option-0"),
        async |cx, _| {
            initialize(&cx).await?;
            let session = cx
                .send_request(NewSessionRequest::new("/work"))
                .block_task()
                .await?;
            cx.send_request(text_prompt(session.session_id, "go"))
                .block_task()
                .await
        },
    )
    .await;
    assert_eq!(response.stop_reason, StopReason::EndTurn);
    // Core registered no waiter for it: no editor prompt, no answer posted.
    assert!(log.permission_requests.lock().unwrap().is_empty());
    assert!(core.recorded.lock().unwrap().questions.is_empty());
    let updates = log.updates.lock().unwrap();
    assert!(
        updates.iter().any(|update| matches!(
            update,
            SessionUpdate::ToolCall(call) if call.tool_call_id.0.as_ref() == "c9"
        )),
        "{updates:#?}"
    );
    let texts: Vec<String> = updates
        .iter()
        .filter_map(chunk_text)
        .map(|(_, text)| text)
        .collect();
    assert_eq!(texts, ["done"]);
}

#[tokio::test]
async fn cancelled_permission_prompt_is_sent_to_core_as_denial() {
    let (url, core) = start_core(Scenario::Permission).await;
    let (response, _) = run_client(
        config(&url, None),
        PermissionReply::Cancel,
        async |cx, _| {
            initialize(&cx).await?;
            let session = cx
                .send_request(NewSessionRequest::new("/work"))
                .block_task()
                .await?;
            cx.send_request(text_prompt(session.session_id, "clean up"))
                .block_task()
                .await
        },
    )
    .await;
    assert_eq!(response.stop_reason, StopReason::EndTurn);
    assert_eq!(
        core.recorded.lock().unwrap().permissions,
        [json!({ "request_id": "perm-1", "option_id": null })]
    );
}
