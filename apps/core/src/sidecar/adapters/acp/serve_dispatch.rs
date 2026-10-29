use super::*;

/// The instance and turn state one agent message's handlers read.
pub(super) struct MessageScope<'a> {
    pub(super) tx: &'a mpsc::UnboundedSender<AcpEvent>,
    pub(super) widget_mcp: &'a Option<Arc<McpRegistry>>,
    pub(super) widget_agent_id: &'a String,
    pub(super) instance_conversation: &'a String,
    pub(super) turn: &'a AcpTurnConfig,
    pub(super) cancel: &'a TurnCancel,
    pub(super) workspace_autonomy: &'a WorkspaceAutonomy,
    pub(super) scan_agent: &'a String,
    pub(super) session_roots: &'a Vec<PathBuf>,
    pub(super) session: &'a agent_client_protocol::ActiveSession<'static, Agent>,
    pub(super) startup_banner: &'a Arc<Mutex<Option<String>>>,
    pub(super) agent_caps: AcpCaps,
}

/// Routes one agent message (notification or request) to its handler.
pub(super) async fn dispatch_session_message(
    message: agent_client_protocol::Dispatch,
    scope: MessageScope<'_>,
) -> Result<(), agent_client_protocol::Error> {
    let MessageScope {
        tx,
        widget_mcp,
        widget_agent_id,
        instance_conversation,
        turn,
        cancel,
        workspace_autonomy,
        scan_agent,
        session_roots,
        session,
        startup_banner,
        agent_caps,
    } = scope;
    let tx_chunk = tx.clone();
    let tx_perm = tx.clone();
    let tx_question = tx.clone();
    // Per-message copies for the managed-Pi widget synthesis
    // in the `ToolCallUpdate` arm (the closure is `move`).
    let widget_mcp = widget_mcp.clone();
    let widget_agent_id = widget_agent_id.clone();
    let widget_conversation = instance_conversation.clone();
    let interactive = turn.interactive;
    // A cancelled turn is only draining the agent's tail:
    // nobody is there to answer a new prompt or question.
    let turn_cancelled = cancel.flag.load(std::sync::atomic::Ordering::SeqCst);
    let workspace_trusted = workspace_autonomy.trusted;
    let scan_agent = scan_agent.clone();
    // Per-message copy of the instance's conversation id: the
    // permission handler below is a `move` closure, so it needs
    // its own owned copy to scope the prompt it registers.
    let perm_conversation = instance_conversation.clone();
    // Workspace roots for the confined fs handlers.
    let fs_roots_read = session_roots.clone();
    let fs_roots_write = session_roots.clone();
    let question_conversation = perm_conversation.clone();
    // The notification callback is `move`; capture only the
    // immutable ACP id so the live session remains available
    // to the outer read loop.
    let session_identifier = session.session_id().clone();
    // Per-message handle on the session's undelivered startup
    // banner (the notification closure below is `move`).
    let banner_slot = Arc::clone(&startup_banner);
    MatchDispatch::new(message)
        .if_notification(async move |notification: SessionNotification| {
            handle_session_notification(
                notification,
                tx_chunk,
                banner_slot,
                widget_mcp,
                widget_conversation,
                widget_agent_id,
                session_identifier,
                agent_caps,
            )
            .await
        })
        .await
        // ── structured user input ─────────────────────
        // Unlike a ToolCall notification, elicitation is
        // an ACP request. Keep the responder open while
        // the HTTP question route resolves the shared
        // waiter; responding here is what lets the
        // agent's in-flight tool call continue.
        .if_request(async move |req: ElicitationCreateRequest, responder| {
            handle_elicitation_request(
                req,
                responder,
                turn_cancelled,
                tx_question,
                question_conversation,
            )
            .await
        })
        .await
        .if_request(async move |req: RequestPermissionRequest, responder| {
            handle_permission_request(
                req,
                responder,
                turn_cancelled,
                scan_agent,
                interactive,
                workspace_trusted,
                tx_perm,
                perm_conversation,
            )
            .await
        })
        .await
        // ── fs/read_text_file ──────────────────────────
        .if_request(async move |req: ReadTextFileRequest, responder| {
            // Up to 4 MiB of disk read + decode: keep it off the
            // async worker that also dispatches this session.
            let roots = fs_roots_read.clone();
            let text =
                tokio::task::spawn_blocking(move || read_text_file_scoped_in_roots(&req, &roots))
                    .await
                    .unwrap_or_default();
            responder.respond(ReadTextFileResponse::new(text))?;
            Ok(())
        })
        .await
        // ── fs/write_text_file ─────────────────────────
        .if_request(async move |req: WriteTextFileRequest, responder| {
            // A refused (out-of-workspace) or failed write is
            // logged; the ACP response shape carries no error
            // channel, so the agent sees the write as a no-op.
            let roots = fs_roots_write.clone();
            let written =
                tokio::task::spawn_blocking(move || write_text_file_scoped_in_roots(&req, &roots))
                    .await
                    .unwrap_or_else(|e| Err(anyhow::anyhow!("write task failed: {e}")));
            if let Err(e) = written {
                tracing::warn!("fs/write_text_file: {e}");
            }
            responder.respond(WriteTextFileResponse::new())?;
            Ok(())
        })
        .await
        // ── terminal/create ────────────────────────────
        .if_request(async move |_req: CreateTerminalRequest, responder| {
            if let Err(e) = terminal_create() {
                tracing::warn!("terminal/create refused: {e}");
            }
            // Report a sentinel id so the agent doesn't hang; the
            // output/exit lookups below return empty/none.
            responder.respond(CreateTerminalResponse::new(TerminalId::new("term-error")))?;
            Ok(())
        })
        .await
        // ── terminal/output ────────────────────────────
        .if_request(async move |_req: TerminalOutputRequest, responder| {
            responder.respond(TerminalOutputResponse::new(String::new(), false))?;
            Ok(())
        })
        .await
        // ── terminal/wait_for_exit ─────────────────────
        .if_request(async move |_req: WaitForTerminalExitRequest, responder| {
            let resp: WaitForTerminalExitResponse = serde_json::from_value(serde_json::json!({
                "exitCode": serde_json::Value::Null,
                "signal": serde_json::Value::Null,
            }))
            .expect("exit status");
            responder.respond(resp)?;
            Ok(())
        })
        .await
        // ── terminal/kill ──────────────────────────────
        .if_request(async move |_req: KillTerminalRequest, responder| {
            responder.respond(KillTerminalResponse::new())?;
            Ok(())
        })
        .await
        // ── terminal/release ───────────────────────────
        .if_request(async move |_req: ReleaseTerminalRequest, responder| {
            responder.respond(ReleaseTerminalResponse::new())?;
            Ok(())
        })
        .await
        // Answer any other request so the agent is never
        // left waiting on a method Ryu does not serve.
        .otherwise(async |message| match message {
            agent_client_protocol::Dispatch::Request(_, responder) => {
                responder.respond_with_error(agent_client_protocol::Error::method_not_found())
            }
            _ => Ok(()),
        })
        .await?;
    Ok(())
}
