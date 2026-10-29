use super::*;

/// What [`open_acp_session`] hands the turn loop: the live session, its bridge
/// guard and the instance-scoped values every turn reads.
pub(super) struct OpenedSession {
    pub(super) agent_caps: AcpCaps,
    pub(super) first_turn: AcpTurn,
    pub(super) scan_agent: String,
    pub(super) instance_conversation: String,
    pub(super) widget_mcp: Option<Arc<McpRegistry>>,
    pub(super) widget_agent_id: String,
    pub(super) instance_tx: mpsc::UnboundedSender<AcpEvent>,
    pub(super) sink: Arc<Mutex<Option<mpsc::UnboundedSender<AcpEvent>>>>,
    pub(super) instance_tx_keepalive: mpsc::UnboundedSender<AcpEvent>,
    pub(super) session_roots: Vec<PathBuf>,
    pub(super) session: agent_client_protocol::ActiveSession<'static, Agent>,
    pub(super) bridge_guard: Option<agent_client_protocol::DynamicHandlerGuard<Agent>>,
    pub(super) resumed: bool,
    pub(super) startup_banner: Arc<Mutex<Option<String>>>,
}

/// Initializes, peeks the first turn and opens (or resumes) the chat's one session;
/// `None` where the instance ends without serving it.
#[allow(clippy::too_many_arguments, clippy::ptr_arg)]
pub(super) async fn open_acp_session(
    cx: &ConnectionTo<Agent>,
    turns_rx: &mut mpsc::UnboundedReceiver<AcpTurn>,
    session_live: &mut bool,
    unserved_first_turn: &mut UnservedFirstTurn,
    bridge_spawn_cmd: &String,
    cwd: &PathBuf,
    additional_directories: &Vec<PathBuf>,
    is_claude_code: bool,
    activity: &Option<Arc<AcpInstanceActivity>>,
    session_grant: &Option<crate::server::acp_tool_broker::AcpToolSessionGrant>,
) -> Result<Option<OpenedSession>, agent_client_protocol::Error> {
    // Advertise Ryu's full client capabilities (fs + terminal) so the
    // agent routes file reads/writes and command execution through the
    // handlers in the dispatch chain below. Capture the agent's OWN
    // capabilities from the response (previously discarded) so we can
    // gate prompt content (image/audio) and features (session/load) on
    // what it actually advertised.
    let init_resp: InitializeResponse = cx
        .send_request(ryu_initialize_request())
        .block_task()
        .await?;
    let agent_caps = read_agent_caps(&init_resp);

    // Peek the FIRST turn (it carries the params the bridge + session
    // are built from). If none arrives within the idle TTL, this chat
    // never sent anything — tear the instance down.
    let first_turn =
        match tokio::time::timeout(crate::acp_runtime::settings().idle_timeout, turns_rx.recv())
            .await
        {
            Ok(Some(t)) => t,
            _ => return Ok(None),
        };
    *unserved_first_turn = Some((first_turn.events.clone(), first_turn.agent_id.clone()));

    // The ACP permission seam labels its command-approval scans with the
    // agent id; stable for the whole chat, so take it from the first turn.
    let scan_agent = first_turn.agent_id.clone();
    // Conversation id (Ryu's cancel/permission scope), stable for the
    // instance. Empty for an ephemeral (no-conversation) instance, which
    // the desktop can't target for cancellation anyway.
    let instance_conversation = first_turn.permission_scope_id.clone().unwrap_or_default();

    // Widget synthesis inputs for the managed-Pi widget path. Pi has no
    // MCP bridge, so a widget-bearing tool it calls through the `ryu-mcp`
    // extension carries its MCP `_meta`/`structuredContent` in the tool
    // result's `details.ryuWidget`, which pi-acp preserves as ACP
    // `rawOutput`. We rebuild the widget event from that below — REUSING
    // the shared `build_widget_event`, keyed to the real tool-call id —
    // so it flows to `ui_tool_widget` exactly like the bridge path. Held
    // at instance scope (stable for the chat) so each per-message closure
    // can clone them. `None` mcp (legacy/test) → no synthesis.
    let widget_mcp = first_turn.mcp.clone();
    let widget_agent_id = first_turn.agent_id.clone();

    // Persistent per-instance permission channel + a swappable sink. The
    // Ryu MCP bridge is built ONCE (below) with `instance_tx` as its
    // `permission_tx`, but each turn streams to a DIFFERENT consumer. A
    // relay task forwards every bridge-emitted event to whatever sink is
    // currently set; at each turn's start we point the sink at that turn's
    // events sender, so interactive tool-permission prompts raised by a
    // Ryu tool reach the live turn.
    let (instance_tx, mut instance_rx) = mpsc::unbounded_channel::<AcpEvent>();
    let sink: Arc<Mutex<Option<mpsc::UnboundedSender<AcpEvent>>>> = Arc::new(Mutex::new(None));
    let relay_sink = Arc::clone(&sink);
    tokio::spawn(async move {
        while let Some(ev) = instance_rx.recv().await {
            let target = relay_sink.lock().ok().and_then(|g| g.clone());
            if let Some(s) = target {
                let _ = s.send(ev);
            }
        }
    });

    // Build the Ryu MCP bridge ONCE for this chat. When enabled, the
    // session gets Ryu's universal governed bridge (Ghost/Shadow/Composio/
    // registry tools reached through the allowlist-gated `call_tool` path
    // — AC3 governance); when not, the agent runs with its own MCP only
    // (`ryu_server = None`). Loading user-level MCP happens here ONCE —
    // the whole point of building the session a single time (see below).
    //
    // This gate is `agent-tool-bridge` (default ON), NOT the egress
    // `agent-gateway-routing` toggle it used to share. See
    // `acp_tool_bridge_enabled` and the `agent_routing` module docs.
    //
    // The agent's OWN advertised capability is not the gate (see
    // `acp_bridge_supported` for why `mcpCapabilities.http` cannot be
    // trusted to distinguish "no" from "did not say"), but a mismatch is
    // worth a line in the log: the bridge Ryu injects is an
    // `McpServer::Http` entry, so an agent that advertised no HTTP MCP
    // support will most likely ignore it, and the model will then look
    // like it declined to use tools it was never actually offered.
    if acp_tool_bridge_enabled(&bridge_spawn_cmd, &first_turn.agent_id) && !agent_caps.mcp_http {
        tracing::warn!(
            agent = %first_turn.agent_id,
            "ACP agent advertised no HTTP MCP support (mcpCapabilities.http=false) \
             but is being given Ryu's MCP bridge; if it ignores session/new \
             mcpServers the agent will silently have no Ryu tools"
        );
    }
    let bridge_enabled = acp_tool_bridge_enabled(&bridge_spawn_cmd, &first_turn.agent_id);
    // A closure so a failed resume can build a second bridge for the
    // fresh session it falls back to (`start` consumes one).
    let build_bridge = || {
        let registry = first_turn.mcp.clone().filter(|_| bridge_enabled);
        let allowlist = first_turn.allowlist.clone();
        let composio_actions = first_turn.composio_actions.clone();
        let agent_id = first_turn.agent_id.clone();
        let identity_profile_ids = first_turn.identity_profile_ids.clone();
        let composio_connection_scope = first_turn.composio_connection_scope.clone();
        let conversation_scope = first_turn.conversation_scope.clone();
        let permission_tx = instance_tx.clone();
        let permission_scope_id = first_turn.permission_scope_id.clone();
        async move {
            let registry = registry?;
            super::super::mcp_bridge::build_ryu_mcp_server(
                registry,
                allowlist,
                composio_actions,
                agent_id,
                identity_profile_ids,
                composio_connection_scope,
                conversation_scope,
                Some(permission_tx),
                permission_scope_id,
            )
            .await
        }
    };
    let ryu_server = build_bridge().await;
    // Keep `instance_tx` alive for the whole instance so the relay task
    // survives idle gaps even when the bridge is absent.
    let _instance_tx_keepalive = instance_tx.clone();

    let session_cwd = cwd.clone();
    let mut session_roots = vec![session_cwd.clone()];
    session_roots.extend(additional_directories.clone());
    tracing::info!(
        cwd = %session_cwd.display(),
        additional_roots = session_roots.len().saturating_sub(1),
        "ACP build_session"
    );

    // Build the ACP session ONCE for the whole chat, injecting Ryu's
    // registered tools through `acp_mcp_over_acp` (the MCP-over-ACP wire
    // of ACP 0.11's `with_mcp_server`, kept by Ryu across the 3.x
    // upgrade). The bridge registers an in-process MCP server so the
    // agent's own MCP client connects back to it, calling Ryu tools through the registry's
    // allowlist-gated `call_tool` path. Building the session (and thus
    // loading user MCP) ONCE — then reusing it across every turn — is the
    // win: the live session already holds the conversation, so subsequent
    // turns send only the delta message (no history re-send).
    //
    // `ryu_server` is `None` for pi-acp and for agents the user has
    // explicitly opted out of the bridge, so those sessions are created
    // without it.
    // A pooled chat whose Claude instance was stopped (idle TTL,
    // admission eviction, Core restart) reopens its own Claude session
    // instead of starting blank. Ephemeral and fresh-context turns never
    // resume: they are unpooled (`activity` is `None`).
    let resume_session_id = if is_claude_code && activity.is_some() {
        acp_resume_candidate(
            first_turn.permission_scope_id.as_deref(),
            &first_turn.agent_id,
            &cwd,
            first_turn.provider_account_identity.as_deref(),
            first_turn.conversation_generation.as_deref(),
        )
        .await
    } else {
        None
    };
    let session_request = |resume: Option<&str>| {
        let mut request = NewSessionRequest::new(session_cwd.clone())
            .additional_directories(additional_directories.clone());
        if is_claude_code {
            // See `claude_code_session_meta`. This runs ONCE per chat
            // (not per turn), the whole win of the session reuse.
            request.meta = Some(claude_code_session_meta_resuming(resume));
        }
        request
    };
    // The bridge's handler is registered before `session/new` goes out
    // (the agent may connect while handling it) and lives as long as the
    // returned guard, which the caller keeps beside the session.
    let start = |mut request: NewSessionRequest,
                 server: Option<super::super::mcp_bridge::RyuMcpServer>| {
        let cx = &cx;
        async move {
            let bridge_guard = match server {
                Some(server) => {
                    tracing::info!("ACP: injecting Ryu MCP bridge into session");
                    let bridge = super::super::acp_mcp_over_acp::McpOverAcpBridge::new(server);
                    request.mcp_servers.push(bridge.declaration());
                    Some(bridge.attach(cx)?)
                }
                None => None,
            };
            let session = cx
                .build_session_from(request)
                .block_task()
                .start_session()
                .await?;
            Ok::<_, agent_client_protocol::Error>((session, bridge_guard))
        }
    };
    // Agents that take no Ryu bridge and advertise `session/load`
    // (pi-acp, including the managed `ryu` agent) reopen their stored
    // session the standard ACP way. The bridge cannot be carried
    // through a load, so a bridged agent never takes this path.
    let loaded =
        if !is_claude_code && activity.is_some() && agent_caps.load_session && ryu_server.is_none()
        {
            match acp_resume_candidate(
                first_turn.permission_scope_id.as_deref(),
                &first_turn.agent_id,
                &cwd,
                first_turn.provider_account_identity.as_deref(),
                first_turn.conversation_generation.as_deref(),
            )
            .await
            {
                Some(session_id) => {
                    load_stored_session(&cx, &session_id, &session_cwd, &additional_directories)
                        .await
                }
                None => None,
            }
        } else {
            None
        };
    let ((session, _bridge_guard), resumed) = if let Some(session) = loaded {
        ((session, None), true)
    } else {
        let started = start(session_request(resume_session_id.as_deref()), ryu_server).await;
        // A failed `session/new` (a signed-out agent raises
        // `auth_required` here, not on the prompt) leaves the first
        // turn to `run_acp_instance`, which answers it from the error.
        match started {
            Ok(started) => (started, resume_session_id.is_some()),
            Err(error) if resume_session_id.is_some() => {
                tracing::warn!(
                    %error,
                    "resuming this chat's Claude session failed; starting a fresh one"
                );
                let started = start(session_request(None), build_bridge().await).await?;
                (started, false)
            }
            Err(error) => return Err(error.into()),
        }
    };
    if resumed {
        tracing::info!("resumed this chat's native agent session");
    }

    if let Some(grant) = session_grant.as_ref() {
        let native_session_id = session.session_id().to_string();
        if !grant.bind_native_session(&native_session_id) {
            tracing::warn!("managed Pi ACP tool session could not bind to its native session");
            let failure = agent_start_failure("Ryu's tools could not attach to the agent session");
            *unserved_first_turn = None;
            answer_unserved_turn(&first_turn, &failure, None);
            fail_queued_turns(turns_rx, &failure, None);
            return Ok(None);
        }
        // Pi's native MCP client reaches the bridge over
        // `/api/acp/mcp`, outside this ACP connection. Handing the
        // capability record the instance channel lets those calls
        // render widgets and raise permission prompts in the live
        // turn, exactly like the in-process bridge above.
        if !grant.attach_events(instance_tx.clone()) {
            tracing::warn!("managed Pi ACP tool session expired before its events attached");
            let failure =
                agent_start_failure("Ryu's tool session expired before the agent started");
            *unserved_first_turn = None;
            answer_unserved_turn(&first_turn, &failure, None);
            fail_queued_turns(turns_rx, &failure, None);
            return Ok(None);
        }
    }
    *session_live = true;
    *unserved_first_turn = None;

    // `session/new` is the first authoritative native-session id. Persist
    // it immediately for conversation-bound ACP resume/load; later
    // `session_info_update` notifications enrich the same binding with
    // agent-provided title/activity metadata on the Gateway path.
    if let (Some(conversation_id), Some(store), Some(generation)) = (
        first_turn.permission_scope_id.as_deref(),
        crate::server::agent_sync::global_store(),
        first_turn.conversation_generation.as_deref(),
    ) {
        let agent_id = first_turn.agent_id.as_str();
        let engine = agent_id.strip_prefix("acp:").unwrap_or(agent_id);
        let native_session_id = session.session_id().to_string();
        let mut binding_capabilities = agent_caps_json(&agent_caps);
        if let Some(identity) = first_turn.provider_account_identity.as_deref() {
            binding_capabilities[ACP_ACCOUNT_BINDING_KEY] = identity.into();
        }
        if let Err(error) = store
            .record_acp_binding_async(
                conversation_id,
                agent_id,
                engine,
                &native_session_id,
                Some(&cwd),
                &binding_capabilities,
                generation,
            )
            .await
        {
            tracing::debug!("agent sync: initial ACP binding ledger update skipped: {error:#}");
        }
    }

    // The banner this session announced it was about to emit (pi-acp's
    // startup skills/commands listing and/or update notice). Held for
    // the life of the session and taken by the FIRST agent chunk that
    // matches it exactly, which routes that chunk to `AcpEvent::Banner`
    // instead of the assistant reply. `None` for every agent that
    // declares no such banner. See `declared_startup_banner`.
    let startup_banner: Arc<Mutex<Option<String>>> =
        Arc::new(Mutex::new(declared_startup_banner(session.meta())));
    Ok(Some(OpenedSession {
        agent_caps,
        first_turn,
        scan_agent,
        instance_conversation,
        widget_mcp,
        widget_agent_id,
        instance_tx,
        sink,
        instance_tx_keepalive: _instance_tx_keepalive,
        session_roots,
        session,
        bridge_guard: _bridge_guard,
        resumed,
        startup_banner,
    }))
}
