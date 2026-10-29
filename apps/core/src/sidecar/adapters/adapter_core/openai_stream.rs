use super::*;

pub(crate) async fn route_openai_stream<F, Fut>(
    req: ChatStreamRequest,
    base_url: String,
    model: String,
    api_key: Option<String>,
    long_term_system: Option<String>,
    memory_citations: Vec<MemoryCitation>,
    // The exact AGENTS.md / CLAUDE.md block assembled for this turn, exposed to
    // context hooks separately from the folded system prompt.
    project_instructions: Option<String>,
    // Normalized Cursor/Claude/AGENTS rule records for context plugins.
    project_rules: Option<Vec<Value>>,
    // When forwarding to the gateway, the selected agent id for per-agent
    // budgets (U21). `None` for direct-to-provider calls.
    agent_id: Option<String>,
    persist: F,
    // Crash checkpoint the terminal `persist` finishes; `None` when not persisted.
    checkpoint: Option<ReplyCheckpoint>,
    // Fallback chain for the default/"ryu" agent. Empty for non-default agents.
    fallback_chain: Vec<FallbackProvider>,
    // Active skill registry (M3 / #145). Enabled skills have their instructions
    // injected into the assembled messages before the request is forwarded, and
    // skill ids are attached via `x-ryu-skill-ids` for Gateway attribution (AC3).
    skills: SkillRegistry,
    // Per-agent Skill allowlist. Empty = all enabled skills (back-compat); a
    // non-empty list narrows injection to its intersection with the enabled set.
    // Enforced entirely in Core (skills are injected, not gateway-gated).
    skills_allowlist: Vec<String>,
    // The output-style prefix for this turn, already composed by the caller
    // (`output_style_prefix`, which is where `keep-coding-instructions` is applied).
    // `None` = no style, and the assembled messages are then byte-identical to what
    // they were before the feature existed. Sits next to `skills_allowlist` because
    // the two are ordered against each other: this is injected AFTER skill injection
    // so it lands in FRONT of the skills block (docs/output-styles.md §5).
    output_style: Option<String>,
    // Per-agent Composio action allowlist (#456). Signalled to the gateway via
    // `x-ryu-composio-actions` so its Composio tool loop offers/executes only the
    // actions this agent selected (overriding the gateway's global allowlist).
    // Empty for non-gateway hops (direct provider / local engine / SDK app).
    composio_actions: Vec<String>,
    // Per-attribute modality slot overrides (M3 / #164). Forwarded to the gateway
    // so each modality call from this agent card can reach a different provider.
    slots: AgentSlots,
    // Advanced sampling params (temperature/top_p/top_k/…), already merged from the
    // agent defaults + per-request override. Applied to the outbound chat body,
    // field-name-translated for `sampling_engine`.
    sampling: crate::inference::SamplingConfig,
    sampling_engine: crate::inference::Engine,
    // The tool registry, for resolving a widget-rendering tool's binding when the
    // governed chat tool loop emits its widget part (R1 / A0-A6).
    mcp: Arc<McpRegistry>,
    // Core-owned model-call spans pair with the Gateway audit session id. The
    // trace keeps model identity, timing, and failure state only; prompts and
    // completions remain in the conversation transcript.
    traces: TraceStore,
    // Enable the governed chat tool loop for this turn. Set ONLY by the caller on
    // the `via_gateway && gateway_healthy` OpenAI-compat branch, so every tool
    // dispatch is governed by the Gateway `/v1/exec/tool` front (D5). `false`
    // everywhere else (direct-provider / local-engine / SDK-app) preserves the
    // exact prior single-shot behaviour — no tools, no loop.
    tools_enabled: bool,
    // Run the local, cache-safe capability preflight for this Gateway hop.
    capability_suggestions_enabled: bool,
    // The effective agent's tool allowlist, narrowing which app render tools are
    // offered. `None` = every render tool (the default-agent case).
    tool_allowlist: Option<Vec<String>>,
    // Per-agent Plane A model-routing override (spec §1). `Some` only on the
    // gateway-forward path for an agent that has a stored override; injected into
    // the outbound body as `ryu_smart_route` for the gateway to read and strip.
    smart_route_override: Option<Value>,
    // This node's pre-encoded `x-ryu-node-routing` preferences (fallback order +
    // its own extra firewall rules). `Some` only on the gateway-forward path, for
    // the same reason `smart_route_override` is.
    node_routing: Option<String>,
    // The verified caller's JWT for `x-ryu-user-jwt`. `Some` only on the
    // gateway-forward path, for the same reason `node_routing` is — and more
    // so, because it is a credential.
    gateway_user_jwt: Option<String>,
    // A provider-native in-flight reasoning control target. Only direct
    // llama.cpp routes populate this; the stream suppresses it when a browser
    // tool loop is active because ending reasoning must not bypass tool policy.
    native_turn_control: Option<turn_control::NativeTurnControl>,
    // Endpoint kind, which picks how long the stream may stay silent: `Local`
    // for the local-engine and SDK-app routes, `Provider` everywhere else.
    stream_hop: StreamHop,
    // The turn's conversation when its author owns it
    // (`gateway_host_conversation_for_turn`). `Some` only on the
    // gateway-forward path; relayed by the Gateway's tool loop so Core applies
    // the author's own tool rules.
    gateway_host_conversation: Option<String>,
    // How this turn ended, for the reactive failover wrapper. Disarmed on every
    // path but the interactive chat one.
    watch: crate::routing_policy::reactive::TurnWatch,
) -> Response
where
    F: FnOnce(String, &'static str, Vec<Value>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Option<String>> + Send + 'static,
{
    // Identity of the turn, captured for the reactive failover watch before the
    // request-building code below consumes `agent_id` / `model`.
    let admission = match crate::execution_control::admit() {
        Ok(admission) => admission,
        Err(message) => return error_stream(message.to_owned()),
    };
    let watch_agent_id = agent_id.clone();
    let watch_model = model.clone();
    // One `invoke_agent` span per turn (disabled without export consent). It is
    // current while the SSE stream below is polled, so the Gateway model calls
    // (via the injected traceparent) and the tool spans nest under it.
    let turn_span =
        crate::sidecar::gen_ai_spans::invoke_agent_span(&crate::sidecar::gen_ai_spans::AgentTurn {
            agent_id: req.agent_id.as_deref().or(agent_id.as_deref()),
            agent_name: None,
            conversation_id: req.conversation_id.as_deref(),
            session_id: req.session_id.as_deref(),
            request_model: Some(model.as_str()),
        });
    let turn_error_span = turn_span.clone();
    let (mut oai_messages, active_skill_ids) = openai_assemble_messages(
        &req,
        long_term_system.as_deref(),
        &skills,
        &skills_allowlist,
        output_style.as_deref(),
    );

    let OpenAiContextPhase {
        plugin_flags,
        capability_hint_header,
    } = openai_context_phase(
        &req,
        &mut oai_messages,
        agent_id.as_deref(),
        project_instructions.as_deref(),
        project_rules.as_deref(),
        capability_suggestions_enabled,
        &mcp,
        &skills_allowlist,
        tool_allowlist.as_deref(),
    )
    .await;

    // The conversation id doubles as the session correlation key forwarded to the
    // gateway via `x-ryu-session-id` so audit rows can be grouped per chat run
    // without a separate session store (M4 / #176).
    let session_id = req.conversation_id.clone();

    // Verified caller identity (server-stamped from the inbound `x-ryu-user-id`
    // header via `identity_from_headers`; `#[serde(skip)]` so a client body cannot
    // spoof it). Forwarded to the gateway as `x-ryu-user-id` so per-user usage
    // attribution and budgets are live. `None` on anonymous/loopback turns.
    let user_id = req.author_user_id.clone();

    let OpenAiToolPlan {
        tools_payload,
        client_tool_mode,
        cloud_tool_mode,
        untrusted_caller,
        cloud_box_machine_tools,
        tool_loop_active,
    } = match openai_select_turn_tools(&req, &mcp, tool_allowlist.as_deref(), tools_enabled) {
        Ok(plan) => plan,
        Err(refusal) => return refusal,
    };
    let native_turn_control = native_turn_control.filter(|_| !tool_loop_active);
    let native_reasoning_control = native_turn_control.is_some();

    // Values moved into the (`'static`) stream. The connection now happens INSIDE
    // the stream so it can be re-issued per tool-loop iteration.
    let companion_source = req.companion_source;
    let background = req.background;
    let http_client = shared_http_client();
    let agent_control_applied = req.agent_control_applied.clone();
    let client_tool_owner_user_id = req.author_user_id.clone();
    let client_tool_conversation_id = req.conversation_id.clone();
    // Keyed like the ACP plane (`req.agent_id`), so one agent's cache countdown
    // is the same entry whichever plane served its last turn.
    let cache_warmth_agent_id = req.agent_id.clone().unwrap_or_default();

    // Bounded number of tool-executing rounds. After the cap, one final tool-free
    // request produces a closing answer instead of terminating mid-tool-result.
    const MAX_TOOL_ITERATIONS: usize = 8;

    let transformed = async_stream::stream! {
        // Ends this conversation's `agent_run` trace scope when the stream ends
        // or the client drops it (a no-op when no run scope is active).
        let mut run_finisher = session_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(|conversation_id| traces.run_finisher(conversation_id));
        let mut persist = Some(persist);
        // Assistant text accumulated across every iteration, persisted once at the
        // single terminal exit (or once on any error exit).
        let mut reply_all = String::new();
        let mut iteration: usize = 0;
        let turn_registration = native_turn_control.map(turn_control::register);

        {
            let frames = openai_prologue_frames(&memory_citations, agent_control_applied.as_ref());
            tokio::pin!(frames);
            while let Some(frame) = frames.next().await {
                yield Ok::<_, std::convert::Infallible>(frame);
            }
        }
        let failure_sink = OpenAiFailureSink {
            traces: &traces,
            turn_error_span: &turn_error_span,
            watch: &watch,
            watch_agent_id: watch_agent_id.as_deref(),
            watch_model: &watch_model,
        };

        loop {
            // Offer tools only while under the cap. Once at the cap we send a
            // final tool-free request so the model must produce a text answer,
            // which lands on the terminal branch below (guaranteed termination).
            let offer_tools = tool_loop_active && iteration < MAX_TOOL_ITERATIONS;
            let request_tools: &[Value] = if offer_tools { &tools_payload } else { &[] };
            let mut model_span_id =
                openai_open_model_span(&traces, session_id.as_deref(), &model).await;

            // TTFT is measured from here, so it includes connecting, provider
            // queueing, and any fallback hops the user also waited through.
            let request_sent_at = std::time::Instant::now();
            // Connect (with self-healing fallback, AC1–AC4).
            let upstream = match connect_with_fallback(
                &oai_messages,
                &base_url,
                &model,
                api_key.as_deref(),
                agent_id.as_deref(),
                user_id.as_deref(),
                gateway_user_jwt.as_deref(),
                active_skill_ids.as_slice(),
                composio_actions.as_slice(),
                session_id.as_deref(),
                &fallback_chain,
                &slots,
                companion_source,
                background,
                &sampling,
                sampling_engine,
                request_tools,
                tool_allowlist.as_deref(),
                capability_hint_header.as_deref(),
                smart_route_override.as_ref(),
                node_routing.clone(),
                native_reasoning_control,
                untrusted_caller,
                stream_hop,
                gateway_host_conversation.as_deref(),
            )
            .await
            {
                Ok(r) => r,
                Err(e) => {
                    openai_record_connect_failure(
                        &e,
                        failure_sink,
                        &mut model_span_id,
                        &mut run_finisher,
                        &mut persist,
                        &mut reply_all,
                    )
                    .await;
                    for line in error_ui_lines(&e) {
                        yield Ok::<_, std::convert::Infallible>(line);
                    }
                    return;
                }
            };

            // Read the gateway policy-alert stamp off the response HEAD before the
            // branch below consumes the body. This single read covers BOTH the
            // success path AND the error/402 path (the latter early-returns after
            // reading `.text()`, discarding the head) — the highest-value budget
            // `Stop` (402) and firewall `block` alerts ride the error head, so
            // reading here (above that return) is the only place both are caught.
            // Lenient + fire-and-forget: a missing/bad header is a no-op and
            // delivery is spawned so it never blocks the stream.
            crate::policy_alerts::dispatch_from_headers(upstream.headers());

            if !upstream.status().is_success() {
                let detail = openai_record_upstream_failure(
                    upstream,
                    failure_sink,
                    &mut model_span_id,
                    &mut run_finisher,
                    &mut persist,
                    &mut reply_all,
                )
                .await;
                for line in error_ui_lines(&detail) {
                    yield Ok::<_, std::convert::Infallible>(line);
                }
                return;
            }

            let byte_stream = upstream.bytes_stream();
            tokio::pin!(byte_stream);

            // Per-iteration streaming state. A fresh text id per iteration keeps
            // interleaved text/tool parts unambiguous in the data stream.
            let text_id = iteration.to_string();
            let mut buf = String::new();
            let mut st = OpenAiIterState {
                text_open: false,
                iter_reply: String::new(),
                // Accumulate streamed `tool_calls` fragments by their `index`.
                tool_calls: Vec::new(),
                // Per-message inference stats (see `build_stats_part`).
                first_token_at: None,
                delta_count: 0,
                last_timings: None,
                last_usage: None,
            };
            let stream_open = request_sent_at;
            let mut saw_done = false;

            let mut failed = false;
            {
                let frames = openai_read_upstream_frames(
                    byte_stream.as_mut(),
                    OpenAiReadCtx {
                        stream_hop,
                        failure_sink,
                        turn_registration: turn_registration.as_ref(),
                        watch: &watch,
                        checkpoint: checkpoint.as_ref(),
                        text_id: &text_id,
                    },
                    OpenAiReadState {
                        st: &mut st,
                        buf: &mut buf,
                        saw_done: &mut saw_done,
                        model_span_id: &mut model_span_id,
                        run_finisher: &mut run_finisher,
                        persist: &mut persist,
                        reply_all: &mut reply_all,
                        failed: &mut failed,
                    },
                );
                tokio::pin!(frames);
                while let Some(frame) = frames.next().await {
                    yield Ok::<_, std::convert::Infallible>(frame);
                }
            }
            if failed {
                return;
            }
            // The generation window ends with the upstream stream, not after the
            // message-end hooks and the transcript write below.
            let stream_end = std::time::Instant::now();

            openai_close_model_span(&traces, &mut model_span_id).await;

            // Close this iteration's text block, then fold its text into the
            // running reply.
            if st.text_open {
                yield Ok::<_, std::convert::Infallible>(ui_text_end(&text_id));
            }
            reply_all.push_str(&st.iter_reply);

            // Drop malformed (nameless) tool calls defensively.
            st.tool_calls.retain(|t| !t.name.is_empty());

            // Terminal iff we did not offer tools this round OR the model asked
            // for none. Tool calls we did not offer are never executed (the cap
            // guard), so the loop is bounded to MAX_TOOL_ITERATIONS + 1 requests.
            let should_execute = offer_tools && !st.tool_calls.is_empty();
            if !should_execute {
                let frames = openai_finish_turn_frames(
                    OpenAiFinish {
                        session_id: session_id.as_deref(),
                        agent_id: agent_id.as_deref(),
                        plugin_flags: &plugin_flags,
                        st: &st,
                        stream_open,
                        stream_end,
                        conversation_id: client_tool_conversation_id.as_deref(),
                        cache_warmth_agent_id: &cache_warmth_agent_id,
                        model: &model,
                    },
                    &mut reply_all,
                    &mut persist,
                );
                tokio::pin!(frames);
                while let Some(frame) = frames.next().await {
                    yield Ok::<_, std::convert::Infallible>(frame);
                }
                return;
            }

            let tool_env = OpenAiToolEnv {
                tools_payload: &tools_payload,
                cloud_tool_mode,
                cloud_box_machine_tools,
                client_tool_conversation_id: client_tool_conversation_id.as_deref(),
                client_tool_owner_user_id: &client_tool_owner_user_id,
                traces: &traces,
                session_id: &session_id,
                agent_id: &agent_id,
                http_client: &http_client,
                mcp: &mcp,
            };
            {
                let frames = openai_tool_round_frames(
                    &st.tool_calls,
                    st.iter_reply,
                    client_tool_mode,
                    tool_env,
                    &mut oai_messages,
                );
                tokio::pin!(frames);
                while let Some(frame) = frames.next().await {
                    yield Ok::<_, std::convert::Infallible>(frame);
                }
            }

            iteration += 1;
        }
    };

    sse_response(Body::from_stream(
        crate::sidecar::gen_ai_spans::instrument_stream(
            admission.interrupt_stream(transformed),
            turn_span,
        ),
    ))
}
