//! Cloud-account auth handlers and the chat turn pipeline with its plugin hooks: `chat_stream` through `chat_stream`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[utoipa::path(
    post,
    path = "/api/chat/stream",
    tag = "Chat",
    summary = "Stream a chat turn (SSE, Vercel AI format)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Server-Sent Events stream"))
)]
pub(in crate::server) async fn chat_stream(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    // Verified human author (Phase 0), attached by `attach_verified_caller`.
    // `None` in the anonymous single-tenant / loopback flow. Always present as an
    // extension (the middleware inserts it on every protected route), so the
    // direct `Extension` extractor is safe here.
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::Extension(VerifiedUserJwt(user_jwt)): axum::Extension<VerifiedUserJwt>,
    authorization: Option<axum::Extension<ResolvedAuthorization>>,
    Json(mut req): Json<ChatStreamRequest>,
) -> axum::response::Response {
    if crate::execution_control::is_paused() {
        return json_error(
            StatusCode::CONFLICT,
            crate::execution_control::PAUSED_MESSAGE.to_owned(),
        );
    }
    // Stamp the verified author onto this turn unconditionally (None when
    // anonymous). `author_user_id` is `#[serde(skip)]`, so this server-side write
    // is the ONLY source — a client request body can neither set nor spoof it.
    req.author_user_id = caller.as_ref().map(|c| c.user_id.clone());
    req.verified_caller = caller.clone();
    req.cloud_authorization = authorization.map(|axum::Extension(value)| Arc::new(value));
    if req.cloud_environment_id.is_some() && req.conversation_id.is_none() {
        req.conversation_id = Some(uuid::Uuid::new_v4().to_string());
    }
    req.client_id = match header_str(&headers, "x-ryu-client-id") {
        Some(value) => match uuid::Uuid::parse_str(value.trim()) {
            Ok(id) => Some(id.to_string()),
            Err(_) => {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "x-ryu-client-id must be a UUID".to_owned(),
                );
            }
        },
        None => None,
    };
    req.user_jwt = user_jwt;
    // A session-bound caller may omit `conversation_id` and the runnable target;
    // resolve both from Core's durable session row. If the body tries to mix a
    // different conversation or runnable into that session, reject it before
    // history, memory, or provider routing can observe the mismatch.
    if let Some(session_id) = req.session_id.clone() {
        if let Err(response) = bind_chat_turn_to_session(&state, &mut req, &session_id).await {
            return response;
        }
    }
    if let Some(conversation_id) = req.conversation_id.as_deref() {
        if !crate::sidecar::adapters::acp::is_safe_host_conversation_id(conversation_id) {
            return json_error(
                StatusCode::BAD_REQUEST,
                "conversation_id must be 1-128 ASCII letters, digits, '.', '_' or '-'".to_owned(),
            );
        }
    }
    // Widget follow-ups carry only an opaque ticket on the wire. Validate it
    // here, but defer consumption until the final pre-dispatch point below so
    // RBAC and conversation ACL rejection do not burn a valid ticket. Core is
    // the sole source of the provenance; client-supplied source/instance/origin
    // fields do not exist on the wire.
    if let Some(ticket) = req.widget_follow_up_ticket.as_deref() {
        let prompt = req
            .messages
            .iter()
            .rev()
            .find(|message| message.role == "user")
            .map(crate::sidecar::adapters::ui_message_text)
            .unwrap_or_default();
        let Some(conversation_id) = req.conversation_id.as_deref() else {
            return json_error(
                StatusCode::BAD_REQUEST,
                "widget follow-up requires its bound conversation".to_owned(),
            );
        };
        match crate::server::widgets::validate_follow_up_ticket(ticket, conversation_id, &prompt) {
            Ok(provenance) => req.widget_provenance = Some(provenance),
            Err(reason) => return json_error(StatusCode::FORBIDDEN, reason.to_owned()),
        }
    }
    // Org/team RBAC: running an agent (a chat turn) requires `agent.run`. This is
    // the run path for agents — there is no separate REST "run" endpoint — so the
    // gate lands here, before either the team or single-agent branch dispatches.
    // Non-breaking: an anonymous (node-token-only) caller is allowed unchanged.
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_RUN,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: agent.run".to_owned(),
        );
    }
    // The collection-level `agent.run` permission is not enough when the turn
    // names a concrete agent. Apply the same exact-resource ACL used by the
    // agent REST surface before any conversation history or provider work is
    // touched. The auto sentinel is resolved inside the routing adapter; its
    // concrete target is still checked by the runtime availability guard there.
    let requested_agent_id = req
        .target_agent_id
        .as_deref()
        .or(req.agent_id.as_deref())
        .filter(|id| *id != crate::agent_routing::AUTO_AGENT_ID);
    if let Some(agent_id) = requested_agent_id {
        if !crate::fleet::is_agent_available(agent_id) {
            return json_error(
                StatusCode::FORBIDDEN,
                format!("agent '{agent_id}' is unavailable under organization policy"),
            );
        }
        if let Err(response) = enforce_agent_resource_permission(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_RUN,
            agent_id,
        )
        .await
        {
            return response;
        }
    }
    // Per-resource ACL. `conversation_id` is CLIENT-supplied, so without this gate
    // user B could POST another user's conversation id and have that thread's
    // history loaded as context, streamed back, and their own turn appended into it
    // — a read AND write bypass on the primary chat path, strictly worse than the
    // ungated `fork`. A brand-new chat (no row yet) is not a 404 here: it falls
    // through and is CLAIMED for this caller, which is the write that makes every
    // downstream gate on this conversation non-vacuous.
    if let Some(conversation_id) = req.conversation_id.clone() {
        if req.persist {
            if let Err(resp) = gate_and_claim_conversation(&state, &caller, &conversation_id).await
            {
                return resp;
            }
        } else {
            // Temporary/team-member turns must never claim or reuse a durable
            // conversation id. A fresh client-held id is fine; an existing id
            // would let a non-persisted turn attach itself to another transcript.
            match state.conversations.get_access_meta(&conversation_id).await {
                Ok(Some(_)) => {
                    return json_error(
                        StatusCode::CONFLICT,
                        "temporary chat id is already in use".to_owned(),
                    );
                }
                Ok(None) => {}
                Err(error) => {
                    return json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("conversation access lookup failed: {error}"),
                    );
                }
            }
        }
    }
    // Tool calls reach the MCP registry without this request (an ACP agent
    // calls back on another task), so record who owns this turn for the
    // session Box router. Recorded only after the conversation ACL above
    // passed, so a refused caller can never replace the owner's authority.
    if let (Some(conversation_id), Some(authority)) = (
        req.conversation_id.as_deref(),
        req.cloud_authorization.as_ref(),
    ) {
        crate::sidecar::mcp::box_desktop::remember_turn_authority(
            conversation_id,
            Arc::clone(authority),
        );
    }
    if let Some(conversation_id) = req.conversation_id.clone() {
        let bound = cloud_tasks::has_bound_task(&conversation_id).await;
        if req.cloud_environment_id.is_some() || bound {
            if !req.persist || req.team_id.is_some() || req.workflow_id.is_some() {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "Cloud environments require a saved single-agent conversation.".to_owned(),
                );
            }
            if !crate::sidecar::adapters::cloud_agent_supported(
                req.target_agent_id.as_deref().or(req.agent_id.as_deref()),
            ) {
                return json_error(StatusCode::BAD_REQUEST, "Select Ryu for the native cloud harness; host ACP agents cannot run in this cloud workspace.".to_owned());
            }
            let Some(authority) = req.cloud_authorization.as_deref() else {
                return json_error(
                    StatusCode::FORBIDDEN,
                    "Cloud execution requires a verified authorization context.".to_owned(),
                );
            };
            let environment_id = match cloud_tasks::validate_requested_binding(
                authority,
                &conversation_id,
                req.cloud_environment_id.as_deref(),
            )
            .await
            {
                Ok(Some(value)) => value,
                Ok(None) => {
                    return json_error(
                        StatusCode::BAD_REQUEST,
                        "Choose a published cloud environment.".to_owned(),
                    );
                }
                Err((status, body)) => return (status, body).into_response(),
            };
            let context = match cloud_tasks::ensure_task_workspace(
                authority,
                &conversation_id,
                &environment_id,
            )
            .await
            {
                Ok(context) => context,
                Err((status, body)) => return (status, body).into_response(),
            };
            if context.executor != "ryu" {
                return json_error(
                    StatusCode::CONFLICT,
                    "This cloud environment runs a managed agent; send prompts from the cloud task panel.".to_owned(),
                );
            }
            req.cloud_environment_id = Some(environment_id);
            req.cloud_task_context = Some(context);
            req.cwd = None;
            req.workspace_folders.clear();
            req.branch = None;
            req.project_environment = None;
            req.worktree_path = None;
            req.worktree_branch = None;
            req.worktree_isolation = false;
            req.client_tools.clear();
            req.browser_context_consent = false;
        }
    }
    // `referenced_conversation_ids` are client supplied too. The active-thread
    // gate above does not cover them, yet the adapter loads their plaintext into
    // model context. Keep only conversations this caller may read; stale,
    // missing, or forbidden ids are ignored so they cannot become a cross-user
    // history read while a deleted mention still remains non-fatal.
    let mut readable_references = Vec::new();
    for conversation_id in req.referenced_conversation_ids.iter().take(3) {
        if req.conversation_id.as_deref() == Some(conversation_id.as_str()) {
            continue;
        }
        if require_resource_read(
            state.conversations.get_access_meta(conversation_id).await,
            caller.as_ref(),
            "referenced conversation not found",
        )
        .is_ok()
        {
            readable_references.push(conversation_id.clone());
        }
    }
    req.referenced_conversation_ids = readable_references;
    // Community Marketplace usage is recorded locally as a counter only. The
    // consent-gated Core beacon later sends an anonymous snapshot, and resolves
    // portable agent runtime ids back to their Marketplace listing ids.
    if req.workflow_id.is_none() {
        if let Some(agent_id) = req.agent_id.as_deref() {
            if let Ok(Some(agent)) = state.agent_store.get(agent_id).await {
                crate::stats_beacon::record_definition_run("agent", agent_id, &agent);
            }
        }
    }
    // Wake any `onChat`-gated plugins the first time a chat turn is handled
    // (once per process, off the hot path — see `fire_on_chat_once`). Cheap
    // atomic on every subsequent request; covers both the single- and team-chat
    // branches below because it fires before either dispatches.
    fire_on_chat_once(&state);
    // Workflow turn: run the DAG with the user's message as its chat input,
    // streaming node progress into the thread. Per-resource ACL on the workflow
    // (workflow.run), then a fail-closed chat-input gate so a message never
    // silently vanishes down a workflow that has no entry `Input` node.
    // Dispatched before the team branch: a workflow target is the most specific
    // intent (the message IS the run's input), so it wins when both are set.
    if let Some(workflow_id) = req.workflow_id.clone() {
        if enforce_permission_on(
            &state,
            &caller,
            crate::identity_verify::permissions::WORKFLOW_RUN,
            crate::acl::KIND_WORKFLOW,
            &workflow_id,
        )
        .await
        .is_err()
        {
            return json_error(
                StatusCode::FORBIDDEN,
                "insufficient permissions: workflow.run".to_owned(),
            );
        }
        let workflow = match crate::workflow::store::load_workflow(&workflow_id) {
            Ok(w) => w,
            Err(_) => {
                return crate::sidecar::adapters::error_stream(format!(
                    "Unknown workflow: {workflow_id}"
                ));
            }
        };
        if let Err(error) = crate::workflow::ensure_runnable_on_this_node(&workflow) {
            return json_error(StatusCode::FORBIDDEN, error);
        }
        if !crate::workflow::accepts_chat_input(&workflow) {
            return crate::sidecar::adapters::error_stream(format!(
                "Workflow '{}' doesn't accept a chat input — add an Input node at the entry to run it from chat.",
                workflow.name
            ));
        }
        if let Err(reason) = consume_widget_follow_up_ticket(&mut req) {
            return json_error(StatusCode::FORBIDDEN, reason.to_owned());
        }
        crate::stats_beacon::record_definition_run("workflow", &workflow_id, &workflow);
        let durable_id = durable_turn_id(&req);
        return crate::sidecar::adapters::durable_turn(
            durable_id,
            crate::sidecar::adapters::route_workflow_chat_stream(
                req,
                workflow,
                state.conversations.clone(),
            ),
        )
        .await;
    }
    // Team turn: fan out to the team's members per its coordination strategy.
    if let Some(team_id) = req.team_id.clone() {
        let capabilities =
            crate::sidecar::capability_consumer::CapabilityConsumer::from_state(&state);
        let team = match crate::agent_teams::resolve_team(&capabilities, &team_id).await {
            Ok(Some(t)) => t,
            Ok(None) => {
                return crate::sidecar::adapters::error_stream(format!("Unknown team: {team_id}"));
            }
            Err(e) => {
                return crate::sidecar::adapters::error_stream(format!(
                    "failed to load team {team_id}: {e}"
                ));
            }
        };
        // Naming a team must not route around the exact-agent ACL the
        // single-agent branch applies above: every agent this turn can run (each
        // member, plus a lead that synthesizes or routes) needs `agent.run` for
        // this caller. One denied agent refuses the whole turn rather than
        // silently changing the team's output. Checked before the follow-up
        // ticket is consumed so a refusal does not burn it.
        if let Err(response) = enforce_team_agents_runnable(&state, &caller, &team).await {
            return response;
        }
        if req.agent_resource_authorization.is_none() && req.verified_caller.is_some() {
            req.agent_resource_authorization = Some(Arc::new(
                crate::sidecar::adapters::AgentResourceAuthorization {
                    state: state.clone(),
                    caller: req.verified_caller.clone(),
                },
            ));
        }
        if let Err(reason) = consume_widget_follow_up_ticket(&mut req) {
            return json_error(StatusCode::FORBIDDEN, reason.to_owned());
        }
        let durable_id = durable_turn_id(&req);
        return crate::sidecar::adapters::durable_turn(
            durable_id,
            crate::sidecar::adapters::route_team_chat_stream(
                req,
                team,
                Arc::clone(&state.agents),
                state.conversations.clone(),
                state.agent_store.clone(),
                Arc::clone(&state.manager),
                state.memory.clone(),
                Arc::clone(&state.worktree_diffs),
                Arc::clone(&state.mcp),
                state.skills.clone(),
                state.traces.clone(),
            ),
        )
        .await;
    }
    if let Err(reason) = consume_widget_follow_up_ticket(&mut req) {
        return json_error(StatusCode::FORBIDDEN, reason.to_owned());
    }
    // Wrap the turn with the plugin turn-hook runtime (M5): after the assistant
    // turn streams + persists, enabled `post_assistant_turn` hooks run and may
    // surface a note or drive a server-side continue loop. Zero-overhead when no
    // hook plugins are enabled (the wrapper returns the inner stream unwrapped).
    run_chat_with_hooks(state, req).await
}
