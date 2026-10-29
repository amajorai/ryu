use super::*;

/// [`run_acp_instance`]'s body. Start-up steps that can name what failed attach
/// that [`AcpFailure`] as error context. `unserved_first_turn` holds the taken
/// first turn's sender until the session opens, when `session_live` is set.
#[allow(clippy::too_many_arguments)]
pub(super) async fn serve_acp_instance(
    spawn_cmd: String,
    cwd: PathBuf,
    additional_directories: Vec<PathBuf>,
    environment: Vec<(String, String)>,
    session_grant: Option<crate::server::acp_tool_broker::AcpToolSessionGrant>,
    // Held for the whole instance: dropping it revokes the credential.
    inference_grant: Option<crate::server::acp_inference_proxy::AcpInferenceGrant>,
    turns_rx: &mut mpsc::UnboundedReceiver<AcpTurn>,
    session_live: &mut bool,
    unserved_first_turn: &mut UnservedFirstTurn,
    activity: Option<Arc<AcpInstanceActivity>>,
    account_confinement: crate::agent_access::AccountConfinement,
) -> anyhow::Result<()> {
    // Held for the whole instance: dropping it on any exit path kills the
    // subprocess tree, not just the direct child the ACP crate knows about.
    let process_tree = crate::acp_runtime::AcpProcessTree::new();
    let prep = prepare_instance(&spawn_cmd, &cwd, &additional_directories, &environment).await?;
    let bridge_spawn_cmd = prep.bridge_spawn_cmd;
    let is_claude_code = prep.is_claude_code;
    let workspace_autonomy = prep.workspace_autonomy;
    let is_managed_pi = prep.is_managed_pi;
    let captured_pi_account = prep.captured_pi_account;
    let _projection = prep.projection;

    let Some(LaunchedServer {
        server,
        sandbox_notice,
    }) = launch_agent_server(
        &spawn_cmd,
        environment,
        &process_tree,
        is_managed_pi,
        &captured_pi_account,
        &session_grant,
        &inference_grant,
        turns_rx,
        account_confinement,
        is_claude_code,
        &workspace_autonomy,
        &cwd,
        &additional_directories,
    )
    .await?
    else {
        return Ok(());
    };
    let agent = AcpSpawn::new(server)
        .into_agent()?
        // Surface the ACP subprocess's own output. Without this the agent's
        // stderr is piped-and-dropped, so a crash inside pi-acp / the engine only
        // reaches us as an opaque "stream was destroyed". Stderr is logged at WARN
        // (real errors), cut to 512 characters and redacted. JSON-RPC frames carry
        // prompts, replies and file contents, so even at TRACE only their method,
        // id and size are logged, never the frame. Since ACP 3.x the callback
        // runs inline on the connection's own task (so it must stay cheap and
        // non-blocking), and stderr is no longer read once the connection ends.
        .with_debug(|line, direction| match direction {
            agent_client_protocol::LineDirection::Stderr => {
                tracing::warn!(
                    target: "acp_subprocess",
                    "{}",
                    crate::log_rotation::truncate_for_log(line)
                );
            }
            _ => {
                tracing::trace!(
                    target: "acp_subprocess",
                    ?direction,
                    "{}",
                    acp_frame_summary(line)
                );
            }
        });

    Client
        .builder()
        .connect_with(agent, move |cx: ConnectionTo<Agent>| {
            async move {
                let mut sandbox_notice = sandbox_notice;
                let Some(opened) = open_acp_session(
                    &cx,
                    turns_rx,
                    session_live,
                    unserved_first_turn,
                    &bridge_spawn_cmd,
                    &cwd,
                    &additional_directories,
                    is_claude_code,
                    &activity,
                    &session_grant,
                )
                .await?
                else {
                    return Ok(());
                };
                let agent_caps = opened.agent_caps;
                let first_turn = opened.first_turn;
                let scan_agent = opened.scan_agent;
                let instance_conversation = opened.instance_conversation;
                let widget_mcp = opened.widget_mcp;
                let widget_agent_id = opened.widget_agent_id;
                let _instance_tx = opened.instance_tx;
                let sink = opened.sink;
                let _instance_tx_keepalive = opened.instance_tx_keepalive;
                let session_roots = opened.session_roots;
                let ((mut session, _bridge_guard), resumed) =
                    ((opened.session, opened.bridge_guard), opened.resumed);
                let startup_banner = opened.startup_banner;

                // Serve every turn for this chat on the ONE session. The first turn
                // is already in hand (peeked above); subsequent turns block on the
                // queue until the idle TTL or the pool dropping the queue tears the
                // instance down (the chat's next message respawns it — see
                // `spawn_acp_task`).
                let mut pending_first = Some(first_turn);
                // A session's FIRST turn sends the full `prompt` (history via
                // short_term); every SUBSEQUENT turn sends ONLY `delta_prompt` (the
                // raw new user message) because the live session already holds the
                // transcript — re-sending the full prompt would DOUBLE-COUNT it.
                // A resumed session already holds the conversation, so even its
                // first turn sends only the new message.
                let mut is_first_turn = !resumed;
                // Running sum of the per-turn totals this connection has seen,
                // shipped as `sessionTotalTokens` (see `AcpUsageSnapshot`).
                let mut session_total_tokens: Option<u64> = None;
                loop {
                    let Some(AcpTurn {
                        admission,
                        prompt,
                        delta_prompt,
                        images,
                        turn,
                        events: tx,
                        // `mcp`/`allowlist`/`composio_actions`/`agent_id`/
                        // `identity_profile_ids`/`permission_scope_id` are consumed
                        // once from the first turn to build the fixed bridge above;
                        // per-turn copies are ignored (the session is immutable).
                        ..
                    }) = next_turn(&mut pending_first, &activity, turns_rx).await
                    else {
                        break;
                    };

                    let Some(mut admission) =
                        admit_turn(admission, &tx, &sink, is_managed_pi, &captured_pi_account)
                            .await
                    else {
                        continue;
                    };

                    if let Some(notice) = sandbox_notice.take() {
                        let _ = tx.send(AcpEvent::ConfigWarning {
                            field: WORKSPACE_TRUST_WARNING_FIELD.to_owned(),
                            requested: "sandbox".to_owned(),
                            message: notice,
                        });
                    }
                    // Apply the user's chosen session controls before prompting.
                    // Re-applied each turn (sticky on the client); each is agent-
                    // reported via session/new, failures logged and ignored.
                    apply_turn_config(
                        session.connection().clone(),
                        session.session_id().clone(),
                        &turn,
                        &workspace_autonomy,
                        &tx,
                    )
                    .await;

                    // First turn: full prompt (carries history). Later turns: delta
                    // only — the live session retains everything before it.
                    let turn_text = if is_first_turn { prompt } else { delta_prompt };
                    is_first_turn = false;

                    let TurnPrompt {
                        turn_usage,
                        turn_error,
                        mut stop_rx,
                    } = send_turn_prompt(&session, turn_text, images, agent_caps)?;

                    // Register this turn's cancel handle so an explicit user Stop
                    // (`POST /api/chat/cancel` → `request_cancel`) can end it.
                    let cancel = Arc::new(TurnCancel::default());
                    let cancel_registration =
                        CancelRegistration::register(&instance_conversation, &cancel);
                    // True once we've told the agent to cancel, so end-of-turn
                    // handling can note the turn was user-interrupted.
                    let mut cancelled = false;
                    // When a cancelled turn stops waiting for the agent's
                    // `stopReason: cancelled` answer (see the flag check below).
                    let mut cancel_deadline: Option<tokio::time::Instant> = None;

                    loop {
                        let message = match read_turn_update(
                            &mut session,
                            &mut admission,
                            &cancel,
                            &mut cancelled,
                            &mut cancel_deadline,
                            &mut stop_rx,
                            &tx,
                            &sink,
                        )
                        .await?
                        {
                            TurnRead::Message(message) => message,
                            TurnRead::Continue => continue,
                            TurnRead::Break => break,
                        };
                        match message {
                            SessionMessage::SessionMessage(message) => {
                                dispatch_session_message(
                                    message,
                                    MessageScope {
                                        tx: &tx,
                                        widget_mcp: &widget_mcp,
                                        widget_agent_id: &widget_agent_id,
                                        instance_conversation: &instance_conversation,
                                        turn: &turn,
                                        cancel: &cancel,
                                        workspace_autonomy: &workspace_autonomy,
                                        scan_agent: &scan_agent,
                                        session_roots: &session_roots,
                                        session: &session,
                                        startup_banner: &startup_banner,
                                        agent_caps,
                                    },
                                )
                                .await?;
                            }
                            SessionMessage::StopReason(_) => break,
                            _ => {}
                        }
                    }

                    // Turn over: drop this turn's cancel handle so a later
                    // `request_cancel` for the same conversation can't hit a stale
                    // turn.
                    drop(cancel_registration);

                    finish_turn(
                        &turn_error,
                        cancelled,
                        &tx,
                        &widget_agent_id,
                        &sink,
                        is_managed_pi,
                        &turn_usage,
                        &mut session_total_tokens,
                    );
                }

                Ok(())
            }
        })
        .await
        // Keep the typed error so `instance_start_failure` can read its code.
        .map_err(|e| anyhow::Error::new(e).context("ACP connection"))
}
