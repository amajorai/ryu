use super::*;

/// Turn-wide inputs the governed tool-loop dispatch reads for each tool call.
#[derive(Clone, Copy)]
pub(crate) struct OpenAiToolEnv<'a> {
    pub(crate) tools_payload: &'a [Value],
    pub(crate) cloud_tool_mode: bool,
    pub(crate) cloud_box_machine_tools: bool,
    pub(crate) client_tool_conversation_id: Option<&'a str>,
    pub(crate) client_tool_owner_user_id: &'a Option<String>,
    /// The turn's server-stamped phone device offer, if any.
    pub(crate) device_offer: Option<&'a crate::device_tools::DeviceOffer>,
    pub(crate) traces: &'a TraceStore,
    pub(crate) session_id: &'a Option<String>,
    pub(crate) agent_id: &'a Option<String>,
    pub(crate) http_client: &'a reqwest::Client,
    pub(crate) mcp: &'a Arc<McpRegistry>,
}

/// Append the assistant tool-call turn the next request must carry.
pub(crate) fn openai_push_assistant_tool_call_turn(
    oai_messages: &mut Vec<Value>,
    tool_calls: &[AccToolCall],
    iter_reply: String,
) {
    // Record the assistant tool-call turn (content may be null) so the
    // next request carries it (standard OpenAI tool-calling shape).
    let assistant_tool_calls: Vec<Value> = tool_calls
        .iter()
        .map(|t| {
            serde_json::json!({
                "id": t.id,
                "type": "function",
                "function": { "name": t.name, "arguments": t.arguments },
            })
        })
        .collect();
    let assistant_content = if iter_reply.is_empty() {
        Value::Null
    } else {
        Value::String(iter_reply)
    };
    oai_messages.push(serde_json::json!({
        "role": "assistant",
        "content": assistant_content,
        "tool_calls": assistant_tool_calls,
    }));
}

/// Hand one tool call to the browser client and wait for its result, yielding the frames.
pub(crate) fn openai_client_tool_frames<'a>(
    t: &'a AccToolCall,
    args_val: Value,
    env: OpenAiToolEnv<'a>,
    oai_messages: &'a mut Vec<Value>,
) -> impl futures_util::Stream<Item = Vec<u8>> + 'a {
    async_stream::stream! {
        let client_tool_span = crate::sidecar::gen_ai_spans::execute_tool_span(
            &crate::sidecar::gen_ai_spans::ToolCall {
                name: &t.name,
                call_id: Some(&t.id),
                tool_type: crate::sidecar::gen_ai_spans::ToolType::Function,
                description: crate::sidecar::gen_ai_spans::tool_description(
                    env.tools_payload,
                    &t.name,
                ),
                mcp_server: None,
            },
            Some(&args_val),
        );
        if let Some(reason) = crate::device_tools::taint::browser_egress_refusal(env.device_offer) {
            client_tool_span.record_result(Err("held after a private device read"));
            let result = serde_json::json!({ "isError": true, "error": reason });
            yield ui_tool_output(&t.id, &result, true, None);
            push_tool_result_message(oai_messages, t, &result);
            return;
        }
        let Some(conversation_id) = env.client_tool_conversation_id else {
            client_tool_span.record_result(Err("browser client tools require a conversation"));
            yield ui_tool_output(
                &t.id,
                &serde_json::json!({ "isError": true, "error": "browser client tools require a conversation" }),
                true,
                None,
            );
            return;
        };
        let (nonce, expires_at_ms, receiver) = register_client_tool_waiter(
            conversation_id,
            &t.id,
            env.client_tool_owner_user_id.clone(),
        );
        let _waiter_cleanup = ClientToolWaiterCleanup(nonce.clone());
        yield ui_tool_input(
            &t.id,
            &t.name,
            &args_val,
            true,
            Some(tool_now_ms()),
        );
        yield ui_data(
            "browser-tool-request",
            &serde_json::json!({
                "conversationId": conversation_id,
                "expiresAtMs": expires_at_ms,
                "nonce": nonce,
                "toolCallId": t.id,
                "toolName": t.name,
                "input": args_val,
            }),
        );
        let result = match tokio::time::timeout(
            std::time::Duration::from_millis(
                (expires_at_ms - client_tool_now_ms()).max(1) as u64,
            ),
            receiver,
        )
        .await
        {
            Ok(Ok(value)) => value,
            Ok(Err(_)) => serde_json::json!({ "isError": true, "error": "browser tool stream closed" }),
            Err(_) => serde_json::json!({ "isError": true, "error": "browser tool approval timed out" }),
        };
        client_tool_span.record_result(Ok(&result));
        // A page result is untrusted external content: later device calls ask.
        if let Some(offer) = env.device_offer {
            offer.mark_tainted_input();
        }
        yield ui_tool_output(
            &t.id,
            &result,
            true,
            None,
        );
        push_tool_result_message(oai_messages, t, &result);
    }
}

/// Feed one client-lane result back to the model as a neutralized `role:tool`
/// message (shared by the browser and device lanes).
pub(crate) fn push_tool_result_message(
    oai_messages: &mut Vec<Value>,
    t: &AccToolCall,
    result: &Value,
) {
    let content = match result {
        Value::String(value) => value.clone(),
        other => other.to_string(),
    };
    oai_messages.push(serde_json::json!({
        "role": "tool",
        "tool_call_id": t.id,
        "content": mcp_bridge::neutralize_external_result(&t.name, content),
    }));
}

/// Run one tool call through the Gateway exec front, yielding its frames.
pub(crate) fn openai_registry_tool_frames<'a>(
    t: &'a AccToolCall,
    args_val: Value,
    env: OpenAiToolEnv<'a>,
    oai_messages: &'a mut Vec<Value>,
) -> impl futures_util::Stream<Item = Vec<u8>> + 'a {
    async_stream::stream! {
        // No `ToolClock` here: this path runs the call inline, so the
        // start and the finish are two statements apart.
        let tool_started = tool_now_ms();
        yield ui_tool_input(&t.id, &t.name, &args_val, true, Some(tool_started));
        let registered_tool = if env.cloud_tool_mode {
            let machine_verb = if env.cloud_box_machine_tools {
                crate::sidecar::mcp::box_desktop::cloud_machine_verb(&t.name)
            } else {
                None
            };
            match (t.name.strip_prefix("cloud_"), machine_verb) {
                (Some(name @ ("exec" | "read_file" | "write_file" | "list_files")), _) => format!("cloud.{name}"),
                (_, Some(verb)) => verb.to_owned(),
                _ => {
                    let result = serde_json::json!({"isError":true,"error":"Only this conversation's closed cloud tools are permitted."});
                    yield ui_tool_output(&t.id, &result, true, Some((tool_started, tool_now_ms())));
                    oai_messages.push(serde_json::json!({"role":"tool","tool_call_id":t.id,"content":result.to_string()}));
                    return;
                }
            }
        } else { t.name.clone() };
        // `execute_tool {tool}`: current while the Gateway exec call is
        // in flight, so the governed dispatch behind it nests here.
        let tool_span = crate::sidecar::gen_ai_spans::execute_tool_span(
            &crate::sidecar::gen_ai_spans::ToolCall {
                description: crate::sidecar::gen_ai_spans::tool_description(
                    env.tools_payload,
                    &t.name,
                ),
                ..crate::sidecar::gen_ai_spans::ToolCall::registry(
                    &registered_tool,
                    Some(&t.id),
                )
            },
            Some(&args_val),
        );
        let tool_trace = start_trace_span(
            env.traces,
            env.session_id.as_deref(),
            SpanStart::new(String::new(), SpanKind::ToolCall, registered_tool.clone())
                .args(&args_val)
                .attr("tool_call_id", t.id.clone())
                .input(args_val.clone()),
        )
        .await;
        let result = match tracing::Instrument::instrument(
            crate::server::widgets::exec_chat_tool(
                env.http_client,
                &registered_tool,
                args_val.clone(),
                env.agent_id.as_deref(),
                env.session_id.as_deref(),
            ),
            tool_span.span.clone(),
        )
        .await
        {
            Ok(v) => v,
            Err(msg) => serde_json::json!({ "isError": true, "error": msg }),
        };
        let tool_failed = result.get("isError").and_then(Value::as_bool) == Some(true);
        end_trace_span(
            env.traces,
            tool_trace.as_ref(),
            (if tool_failed {
                SpanEnd::error(
                    result
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("tool returned an error")
                        .to_owned(),
                )
            } else {
                SpanEnd::ok()
            })
            .output(result.clone()),
        )
        .await;
        tool_span.record_result(Ok(&result));
        yield ui_tool_output(&t.id, &result, true, Some((tool_started, tool_now_ms())));
        // Widget emit (D1/D6) with the REAL tool-call id.
        if let Some(ev) = crate::sidecar::adapters::mcp_bridge::build_widget_event(
            env.mcp,
            &t.name,
            &args_val,
            &result,
            Some(t.id.clone()),
            env.session_id.clone(),
            env.agent_id.clone().unwrap_or_default(),
        )
        .await
        {
            yield ui_tool_widget(&ev);
        }
        // Feed the result back to the model as a `tool` message —
        // neutralized first, exactly like the ACP fold and the gateway
        // loop: raw web/tool output re-entering the model can carry
        // template-token transcript spoofing and prompt injection. This
        // closes the gap `widget_payload`'s doc comment flagged.
        let content = match &result {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        let content =
            mcp_bridge::neutralize_external_result(&t.name, content);
        oai_messages.push(serde_json::json!({
            "role": "tool",
            "tool_call_id": t.id,
            "content": content,
        }));
    }
}

/// Which client lanes this turn offers.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct OpenAiToolModes {
    pub(crate) client: bool,
    pub(crate) device: bool,
}

/// The lane one tool call is dispatched to, decided by its name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OpenAiToolLane {
    Browser,
    Device,
    Registry,
    /// A client-lane turn named a tool it was never offered.
    Refused,
}

pub(crate) fn openai_tool_lane(
    name: &str,
    modes: OpenAiToolModes,
    cloud_tool_mode: bool,
) -> OpenAiToolLane {
    if modes.device && crate::device_tools::catalog::canonical(name).is_some() {
        return OpenAiToolLane::Device;
    }
    if modes.client && name.starts_with("browser_") {
        return OpenAiToolLane::Browser;
    }
    if crate::device_tools::catalog::is_device_tool_name(name) {
        // A device name outside a device turn never reaches any other lane.
        return OpenAiToolLane::Refused;
    }
    if (modes.client || modes.device) && !cloud_tool_mode {
        return OpenAiToolLane::Refused;
    }
    OpenAiToolLane::Registry
}

/// Record the assistant tool-call turn, then dispatch each call by name,
/// yielding its frames.
pub(crate) fn openai_tool_round_frames<'a>(
    tool_calls: &'a [AccToolCall],
    iter_reply: String,
    modes: OpenAiToolModes,
    tool_env: OpenAiToolEnv<'a>,
    oai_messages: &'a mut Vec<Value>,
) -> impl futures_util::Stream<Item = Vec<u8>> + 'a {
    async_stream::stream! {
        openai_push_assistant_tool_call_turn(oai_messages, tool_calls, iter_reply);

        // Execute each requested tool through its lane: browser tools in the
        // extension, device tools on the paired phone, everything else through
        // the Gateway `/v1/exec/tool` front (D5, A7), where Core applies the
        // per-agent allowlist + identity.
        for t in tool_calls {
            let args_val: Value =
                serde_json::from_str(&t.arguments).unwrap_or(Value::Object(Default::default()));
            match openai_tool_lane(&t.name, modes, tool_env.cloud_tool_mode) {
                OpenAiToolLane::Browser => {
                    let frames = openai_client_tool_frames(t, args_val, tool_env, oai_messages);
                    tokio::pin!(frames);
                    while let Some(frame) = frames.next().await {
                        yield frame;
                    }
                }
                OpenAiToolLane::Device => {
                    let frames = openai_device_tool_frames(t, args_val, tool_env, oai_messages);
                    tokio::pin!(frames);
                    while let Some(frame) = frames.next().await {
                        yield frame;
                    }
                }
                OpenAiToolLane::Refused => {
                    let result = serde_json::json!({
                        "isError": true,
                        "error": format!("tool '{}' is not available in this conversation", t.name),
                    });
                    yield ui_tool_output(&t.id, &result, true, None);
                    push_tool_result_message(oai_messages, t, &result);
                }
                OpenAiToolLane::Registry => {
                    let frames = openai_registry_tool_frames(t, args_val, tool_env, oai_messages);
                    tokio::pin!(frames);
                    while let Some(frame) = frames.next().await {
                        yield frame;
                    }
                }
            }
        }
    }
}
