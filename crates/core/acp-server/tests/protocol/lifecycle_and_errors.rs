use super::*;

#[tokio::test]
async fn load_session_replays_history_and_keeps_it_for_the_next_turn() {
    let (url, core) = start_core(Scenario::TextAndTool).await;
    let (missing, log) = run_client(
        config(&url, None),
        PermissionReply::Cancel,
        async |cx, _| {
            initialize(&cx).await?;
            let loaded = cx
                .send_request(LoadSessionRequest::new("known-conversation", "/work"))
                .block_task()
                .await?;
            assert_eq!(
                loaded.modes.expect("modes").current_mode_id.0.as_ref(),
                "coder"
            );
            cx.send_request(text_prompt("known-conversation".into(), "follow up"))
                .block_task()
                .await?;
            Ok(cx
                .send_request(LoadSessionRequest::new("missing", "/work"))
                .block_task()
                .await)
        },
    )
    .await;
    assert!(missing.is_err());

    let updates = log.updates.lock().unwrap();
    let replay: Vec<(&str, String)> = updates.iter().take(2).filter_map(chunk_text).collect();
    assert_eq!(
        replay,
        [
            ("user", "earlier question".to_owned()),
            ("message", "earlier answer".to_owned())
        ]
    );
    let body = &core.recorded.lock().unwrap().chat_bodies[0];
    assert_eq!(body["conversation_id"], json!("known-conversation"));
    assert_eq!(body["agent_id"], json!("coder"));
    assert_eq!(body["messages"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn core_unavailable_fails_initialize_with_a_clear_error() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let (result, _) = run_client(
        config(&url, None),
        PermissionReply::Cancel,
        async |cx, _| Ok(initialize(&cx).await),
    )
    .await;
    let error = result.expect_err("initialize fails without Core");
    assert!(error.message.contains("not running"), "{}", error.message);
    assert!(error.message.contains(&url), "{}", error.message);
}

#[tokio::test]
async fn rejected_credentials_fail_new_session_clearly() {
    let (url, _core) = start_core(Scenario::TextAndTool).await;
    let mut bad = config(&url, None);
    bad.endpoint.token = Some("wrong".to_owned());
    let (result, _) = run_client(bad, PermissionReply::Cancel, async |cx, _| {
        initialize(&cx).await?;
        Ok(cx
            .send_request(NewSessionRequest::new("/work"))
            .block_task()
            .await)
    })
    .await;
    let error = result.expect_err("bad token is rejected");
    assert!(error.message.contains("credentials"), "{}", error.message);
}

#[tokio::test]
async fn permission_denials_report_cores_reason() {
    let (url, _core) = start_core(Scenario::TextAndTool).await;
    let mut limited = config(&url, None);
    limited.endpoint.token = Some("policy-limited".to_owned());
    let (result, _) = run_client(limited, PermissionReply::Cancel, async |cx, _| {
        initialize(&cx).await?;
        Ok(cx
            .send_request(NewSessionRequest::new("/work"))
            .block_task()
            .await)
    })
    .await;
    let error = result.expect_err("a forbidden agent list fails the session");
    assert!(
        error
            .message
            .contains("insufficient permissions: agent.view"),
        "{}",
        error.message
    );
    assert!(!error.message.contains("credentials"), "{}", error.message);
}

#[tokio::test]
async fn shutdown_stops_in_flight_core_runs() {
    let (url, core) = start_core(Scenario::Hang).await;
    let (client_io, server_io) = tokio::io::duplex(1 << 16);
    let (server_read, server_write) = tokio::io::split(server_io);
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(serve_until(
        config(&url, None),
        ByteStreams::new(server_write.compat_write(), server_read.compat()),
        async move {
            let _ = shutdown_rx.await;
        },
    ));

    let (client_read, client_write) = tokio::io::split(client_io);
    let first_chunk = Arc::new(Notify::new());
    let on_update = Arc::clone(&first_chunk);
    let session_id = tokio::time::timeout(
        Duration::from_secs(30),
        Client
            .builder()
            .on_receive_notification(
                async move |notification: SessionNotification, _cx: ConnectionTo<Agent>| {
                    if matches!(notification.update, SessionUpdate::AgentMessageChunk(_)) {
                        on_update.notify_one();
                    }
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .connect_with(
                ByteStreams::new(client_write.compat_write(), client_read.compat()),
                async move |cx: ConnectionTo<Agent>| {
                    initialize(&cx).await?;
                    let session = cx
                        .send_request(NewSessionRequest::new("/work"))
                        .block_task()
                        .await?;
                    let _pending =
                        cx.send_request(text_prompt(session.session_id.clone(), "long job"));
                    first_chunk.notified().await;
                    Ok(session.session_id)
                },
            ),
    )
    .await
    .expect("client finished in time")
    .expect("client ran");

    // The editor goes away mid-turn.
    shutdown_tx.send(()).expect("server still running");
    tokio::time::timeout(Duration::from_secs(10), server)
        .await
        .expect("server exits after shutdown")
        .expect("server task")
        .expect("clean shutdown");
    assert_eq!(
        core.recorded.lock().unwrap().cancels,
        [session_id.0.to_string()]
    );
}
