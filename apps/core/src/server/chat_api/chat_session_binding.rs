//! Cloud-account auth handlers and the chat turn pipeline with its plugin hooks: `bind_chat_turn_to_session` through `route_single_turn`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Bind a session-scoped chat turn to Core's durable session row (a step of
/// [`chat_stream`]). A session-bound caller may omit `conversation_id` and the
/// runnable target, so both are filled in from the session; a body that names a
/// different conversation or runnable is refused before history, memory or
/// provider routing can observe the mismatch.
pub(in crate::server) async fn bind_chat_turn_to_session(
    state: &ServerState,
    req: &mut ChatStreamRequest,
    session_id: &str,
) -> Result<(), axum::response::Response> {
    let session = match state.conversations.get_session(&session_id).await {
        Ok(Some(session)) => session,
        Ok(None) => {
            return Err(json_error(
                StatusCode::NOT_FOUND,
                "session not found".to_owned(),
            ))
        }
        Err(error) => {
            return Err(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("session lookup failed: {error}"),
            ));
        }
    };
    if let Some(conversation_id) = req.conversation_id.as_deref() {
        if conversation_id != session.conversation_id {
            return Err(json_error(
                StatusCode::CONFLICT,
                "session and conversation_id do not match".to_owned(),
            ));
        }
    }
    req.conversation_id = Some(session.conversation_id.clone());
    match session.runnable_kind {
        crate::runnable::RunnableKind::Agent => {
            if let Some(agent_id) = req.agent_id.as_deref() {
                if agent_id != session.runnable_id {
                    return Err(json_error(
                        StatusCode::CONFLICT,
                        "session and agent_id do not match".to_owned(),
                    ));
                }
            }
            if req.workflow_id.is_some() || req.team_id.is_some() {
                return Err(json_error(
                    StatusCode::CONFLICT,
                    "an agent session cannot target a workflow or team".to_owned(),
                ));
            }
            req.agent_id = Some(session.runnable_id);
        }
        crate::runnable::RunnableKind::Workflow => {
            if req.agent_id.is_some() || req.team_id.is_some() {
                return Err(json_error(
                    StatusCode::CONFLICT,
                    "a workflow session cannot target an agent or team".to_owned(),
                ));
            }
            if let Some(workflow_id) = req.workflow_id.as_deref() {
                if workflow_id != session.runnable_id {
                    return Err(json_error(
                        StatusCode::CONFLICT,
                        "session and workflow_id do not match".to_owned(),
                    ));
                }
            }
            req.workflow_id = Some(session.runnable_id);
        }
        _ => {
            return Err(json_error(
                StatusCode::NOT_IMPLEMENTED,
                "this session runnable kind has no chat adapter".to_owned(),
            ));
        }
    }
    Ok(())
}

/// Every agent a team turn can run: its members plus a lead (the
/// DebateSynthesis synthesizer / Router classifier) that is not also a member.
pub(in crate::server) fn team_runnable_agent_ids(
    team: &ryu_teams_contracts::TeamRecord,
) -> Vec<&str> {
    let mut ids: Vec<&str> = Vec::new();
    for id in team
        .members
        .iter()
        .chain(team.lead_agent_id.iter())
        .map(String::as_str)
        .filter(|id| *id != crate::agent_routing::AUTO_AGENT_ID)
    {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

/// The single-agent turn's fleet and exact-agent `agent.run` checks, applied to
/// every agent of a team turn.
pub(in crate::server) async fn enforce_team_agents_runnable(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    team: &ryu_teams_contracts::TeamRecord,
) -> Result<(), axum::response::Response> {
    for agent_id in team_runnable_agent_ids(team) {
        if !crate::fleet::is_agent_available(agent_id) {
            return Err(json_error(
                StatusCode::FORBIDDEN,
                format!("agent '{agent_id}' is unavailable under organization policy"),
            ));
        }
        enforce_agent_resource_permission(
            state,
            caller,
            crate::identity_verify::permissions::AGENT_RUN,
            agent_id,
        )
        .await?;
    }
    Ok(())
}

/// Run one chat turn, retrying it on another subscription plan when the one it
/// was aimed at turns out to be out of room.
///
/// Wrapper around [`route_single_turn_once`] rather than logic inside it: the
/// retry has to re-resolve the whole per-turn binding (engine, persona, skills,
/// MCP bridge, identity slots) for the agent it moves to, and re-entering at
/// this level is what gets that for free. Doing it at the failure site — 500
/// lines inside the ACP stream generator — would mean rebuilding all of it by
/// hand from a scope that does not have it.
///
/// Inert unless the node opted in: [`RetryPolicy::enabled`] is false by default,
/// and the disabled path is one preference read followed by the ordinary call
/// with a disarmed watch.
///
/// [`RetryPolicy::enabled`]: crate::routing_policy::reactive::RetryPolicy::enabled
pub(in crate::server) async fn route_single_turn(
    state: &ServerState,
    mut req: crate::sidecar::adapters::ChatStreamRequest,
) -> axum::response::Response {
    use crate::routing_policy::reactive;

    if req.agent_resource_authorization.is_none() && req.verified_caller.is_some() {
        req.agent_resource_authorization = Some(Arc::new(
            crate::sidecar::adapters::AgentResourceAuthorization {
                state: state.clone(),
                caller: req.verified_caller.clone(),
            },
        ));
    }

    if req.cloud_task_context.is_some() {
        return route_single_turn_once(state, req, reactive::TurnWatch::off()).await;
    }

    let policy = reactive::load(&state.preferences).await;
    if !policy.enabled {
        return route_single_turn_once(state, req, reactive::TurnWatch::off()).await;
    }

    // Attempt 1. `route_single_turn_once` returns as soon as the stream is set
    // up — the body is lazy — so its head (status + SSE headers) is available to
    // reuse for whichever attempt ends up answering. Reusing it also means an
    // early non-stream refusal is forwarded with its own head intact rather than
    // being wrapped in a fabricated one.
    let watch = reactive::TurnWatch::armed();
    let first = route_single_turn_once(state, req.clone(), watch.clone()).await;
    let (parts, body) = first.into_parts();
    let state = state.clone();

    let stream = async_stream::stream! {
        use futures_util::StreamExt as _;

        let mut upstream = body.into_data_stream();
        // Frames are held back only until the first assistant content appears.
        // After that a retry is impossible anyway, so the buffer is flushed and
        // everything passes straight through — the hold-back can never grow to
        // the size of an answer.
        let mut buffered: Vec<axum::body::Bytes> = Vec::new();
        let mut gate = reactive::FrameGate::default();

        while let Some(chunk) = upstream.next().await {
            let Ok(bytes) = chunk else { break };
            match gate.admit(watch.saw_content()) {
                reactive::FrameAction::Pass => {
                    yield Ok::<_, std::convert::Infallible>(bytes);
                }
                reactive::FrameAction::Hold => buffered.push(bytes),
                reactive::FrameAction::Flush => {
                    buffered.push(bytes);
                    for frame in buffered.drain(..) {
                        yield Ok::<_, std::convert::Infallible>(frame);
                    }
                }
            }
        }

        if gate.forwarded_anything() {
            return;
        }

        // Nothing was shown. Either the turn simply produced no content, or it
        // failed early — which is exactly the shape a vendor cap arrives in.
        let Some(failure) = watch.retryable() else {
            for frame in buffered {
                yield Ok::<_, std::convert::Infallible>(frame);
            }
            return;
        };

        // Confirm against the plans themselves, never against the error text.
        let installed: Vec<String> = state
            .agent_store
            .installed_ids()
            .await
            .map(|ids| ids.into_iter().collect())
            .unwrap_or_default();
        let readings =
            reactive::read_all_windows(&policy, &failure.agent_id, &installed).await;
        let verdict = reactive::decide(
            &policy,
            &failure.agent_id,
            failure.model.as_deref(),
            failure.kind,
            &readings,
        );

        let Some(target) = verdict.reroute_agent().map(str::to_owned) else {
            // Not a cap, or nowhere to go. Announce whatever we did learn (which
            // window reopens first, or that notify-only held the swap back) and
            // let the original error stand behind it.
            let note = (!matches!(verdict, reactive::Verdict::Stand)).then(|| {
                tracing::info!(?verdict, agent = %failure.agent_id, "reactive failover: not rerouting");
                let mut frames = crate::sidecar::adapters::ui_failover_note(&verdict);
                if let Some(text) = crate::sidecar::adapters::ui_failover_text(&verdict) {
                    frames.extend(text);
                }
                axum::body::Bytes::from(frames)
            });
            // The note goes AFTER the stream's opening frame, never before it: a
            // data part that arrives ahead of `start` has no message to attach
            // to, so the client would drop it or hang it off the previous turn.
            let mut frames = buffered.into_iter();
            if let Some(first) = frames.next() {
                yield Ok::<_, std::convert::Infallible>(first);
            }
            if let Some(note) = note {
                yield Ok::<_, std::convert::Infallible>(note);
            }
            for frame in frames {
                yield Ok::<_, std::convert::Infallible>(frame);
            }
            return;
        };

        tracing::info!(
            from = %failure.agent_id,
            to = %target,
            detail = %failure.detail,
            "reactive failover: retrying the turn on another plan"
        );
        // Attempt 1's frames are dropped wholesale — they are the error triple
        // and its preamble, and the client is about to be given a real answer.
        drop(buffered);
        let note = axum::body::Bytes::from({
            let mut frames = crate::sidecar::adapters::ui_failover_note(&verdict);
            if let Some(text) = crate::sidecar::adapters::ui_failover_text(&verdict) {
                frames.extend(text);
            }
            frames
        });

        let mut retry = req;
        retry.agent_id = Some(target);
        // `target_agent_id` WINS over `agent_id` when resolving the effective
        // agent for a turn (`route_chat_stream`), so leaving it set would send
        // the retry straight back to the plan that just ran out — a failover
        // that looks like it works and never moves anything.
        retry.target_agent_id = None;
        // The user turn is already persisted by attempt 1; appending it again
        // would duplicate it in the thread.
        retry.skip_user_append = true;
        // The per-turn model pin belonged to the agent that ran out. Clearing it
        // lets the agent we moved to run on its own binding — carrying it over
        // would ask a different vendor for a model it does not have.
        retry.acp_model = None;

        // Disarmed watch: exactly one retry. Chaining failovers would walk a
        // user through every plan they own on a single message.
        let second = route_single_turn_once(&state, retry, reactive::TurnWatch::off()).await;
        let mut retry_stream = second.into_body().into_data_stream();
        // The note rides immediately behind the retry's opening frame so it
        // attaches to the message the retry is about to write — emitting it
        // first would leave a data part with no message to belong to.
        let mut note = Some(note);
        while let Some(chunk) = retry_stream.next().await {
            let Ok(bytes) = chunk else { break };
            yield Ok::<_, std::convert::Infallible>(bytes);
            if let Some(note) = note.take() {
                yield Ok::<_, std::convert::Infallible>(note);
            }
        }
    };

    axum::response::Response::from_parts(parts, axum::body::Body::from_stream(stream))
}
