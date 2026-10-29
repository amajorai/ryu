use super::*;

/// The tool offer resolved for one OpenAI-compat turn before its stream starts.
pub(crate) struct OpenAiToolPlan {
    pub(crate) tools_payload: Vec<Value>,
    pub(crate) client_tool_mode: bool,
    pub(crate) cloud_tool_mode: bool,
    pub(crate) untrusted_caller: bool,
    pub(crate) cloud_box_machine_tools: bool,
    pub(crate) tool_loop_active: bool,
}

/// Values the `context` / capability phase hands to the stream.
pub(crate) struct OpenAiContextPhase {
    pub(crate) plugin_flags: std::collections::HashMap<String, bool>,
    pub(crate) capability_hint_header: Option<String>,
}

/// Assemble the outbound messages (memory, history, skills, output style, turn
/// context); returns them with the active skill ids.
pub(crate) fn openai_assemble_messages(
    req: &ChatStreamRequest,
    long_term_system: Option<&str>,
    skills: &SkillRegistry,
    skills_allowlist: &[String],
    output_style: Option<&str>,
) -> (Vec<Value>, Vec<String>) {
    // Long-term memory (opt-in) is injected as a leading system message. The
    // client already supplies short-term context (the full message list), so we
    // do not re-inject it here.
    let mut oai_messages: Vec<Value> = Vec::with_capacity(req.messages.len() + 1);
    if let Some(system) = long_term_system {
        oai_messages.push(serde_json::json!({ "role": "system", "content": system }));
    }
    let history: Vec<Value> = req
        .messages
        .iter()
        .map(|m| {
            let mut text = {
                let from_content = m.content.as_text();
                if !from_content.is_empty() {
                    from_content
                } else {
                    m.parts
                        .iter()
                        .filter_map(|p| p.get("text")?.as_str().map(str::to_owned))
                        .collect::<Vec<_>>()
                        .join("")
                }
            };
            // Attached documents: extracted text rides along as a labelled block
            // appended to this message's text. Per message (not just the last), so a
            // document attached ten turns ago is still readable when the user asks a
            // follow-up about it.
            if let Some(block) = document_context_block(m) {
                text.push_str(&block);
            }
            // Multimodal: a message carrying image `file` parts becomes an
            // OpenAI content array (text + each image as an `image_url` data-URL)
            // so a locally-served vision model (with its `--mmproj` adapter
            // loaded) or any multimodal provider actually receives the image.
            // Text-only messages keep the plain-string content shape — the common
            // case, unchanged — so this never alters non-vision chat.
            let images = message_image_parts(m);
            if images.is_empty() {
                return serde_json::json!({ "role": m.role, "content": text });
            }
            let mut content: Vec<Value> = Vec::with_capacity(images.len() + 1);
            if !text.is_empty() {
                content.push(serde_json::json!({ "type": "text", "text": text }));
            }
            for img in &images {
                content.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:{};base64,{}", img.mime_type, img.data)
                    }
                }));
            }
            serde_json::json!({ "role": m.role, "content": content })
        })
        .collect();
    oai_messages.extend(history);

    // Inject active skill instructions (M3 / #145 AC2).
    // Core decides what skills run (what runs → Core). The gateway governs egress;
    // we signal active skill ids via `x-ryu-skill-ids` so the Gateway can attribute
    // budget/audit rows to the skill (AC3). Injection is non-blocking and
    // lenient — a missing skill dir is not an error.
    //
    // Safe Mode skips the injection outright (and therefore reports no active ids,
    // so the Gateway attributes nothing to a skill that never ran).
    let active_skill_ids = if crate::safe_mode::is_active() {
        Vec::new()
    } else {
        skills.inject_into_messages_filtered(&mut oai_messages, skills_allowlist)
    };

    // Output style (docs/output-styles.md §5), injected right after the skills block
    // and therefore in FRONT of it: a skill's own formatting instructions are
    // task-specific and must win over the style's general shape when the two
    // disagree. The assembled system message reads base instructions (unless the
    // style replaced them) → style body → skills block → persona + memory.
    if let Some(prefix) = output_style.filter(|p| !p.is_empty()) {
        prepend_system_prefix(&mut oai_messages, prefix);
    }

    // Per-turn context (memory, recall, referenced chats) rides on the newest user
    // message so the system block and history stay byte-stable for prompt caching.
    // Added before the `context` phase below, so a context plugin still sees it.
    if let Some(context) = req.turn_context.as_deref() {
        append_ephemeral_turn_context(&mut oai_messages, context);
    }
    (oai_messages, active_skill_ids)
}

/// Run the `context` hook phase and the capability preflight over the messages.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn openai_context_phase(
    req: &ChatStreamRequest,
    oai_messages: &mut Vec<Value>,
    agent_id: Option<&str>,
    project_instructions: Option<&str>,
    project_rules: Option<&[Value]>,
    capability_suggestions_enabled: bool,
    mcp: &Arc<McpRegistry>,
    skills_allowlist: &[String],
    tool_allowlist: Option<&[String]>,
) -> OpenAiContextPhase {
    // Per-request plugin flags, copied out of `req` because the SSE generator below
    // is `'static` and cannot borrow it. A hook reads its own composer flag to
    // decide whether to act this turn.
    let plugin_flags = req.plugin_flags.clone();

    // The `context` phase — the last stop before the assembled window leaves Ryu.
    // Placed AFTER skill injection on purpose: a context-engineering plugin has to
    // see the array exactly as the model will, skills included, or it would rewrite
    // a window that no longer exists by the time the request goes out. (A hook that
    // drops the injected skill blocks is free to; `active_skill_ids` still reports
    // what Core selected, which is what the gateway attributes budget/audit rows
    // to — an attribution record, not a claim about the final prompt.)
    // Bound to its own local first so the borrow of `oai_messages` ends before the
    // rewrite can replace it.
    let rewritten_context = run_context_hooks_messages(
        oai_messages,
        req.conversation_id.as_deref(),
        agent_id,
        &plugin_flags,
        project_instructions,
        project_rules,
    )
    .await;
    if let Some(rewritten) = rewritten_context {
        *oai_messages = rewritten;
    }

    let capability_suggestions = if capability_suggestions_enabled && !crate::safe_mode::is_active()
    {
        crate::sidecar::mcp::suggestions::suggest(
            mcp,
            &last_user_message(&req.messages),
            skills_allowlist,
            tool_allowlist,
        )
        .await
    } else {
        crate::sidecar::mcp::suggestions::CapabilitySuggestions::default()
    };
    let capability_hint_header = capability_suggestions.wire_header();
    if let Some(turn_context) = capability_suggestions.prompt_block() {
        append_ephemeral_turn_context(oai_messages, &turn_context);
    }
    OpenAiContextPhase {
        plugin_flags,
        capability_hint_header,
    }
}

/// Resolve which tools this turn offers; `Err` is the refusal response the
/// caller returns as-is.
pub(crate) fn openai_select_turn_tools(
    req: &ChatStreamRequest,
    mcp: &Arc<McpRegistry>,
    tool_allowlist: Option<&[String]>,
    tools_enabled: bool,
) -> Result<OpenAiToolPlan, Response> {
    // Browser client tools are offered only when the authenticated caller opted
    // into browser-context consent. The closed prefix check prevents a client
    // from turning this continuation lane into an arbitrary server tool bridge.
    let _ = &tool_allowlist;
    let client_tools_payload: Vec<Value> =
        if req.browser_context_consent && req.cloud_task_context.is_none() {
            req.client_tools
                .iter()
                .filter(|tool| allowed_client_tool_schema(tool))
                .cloned()
                .collect()
        } else {
            Vec::new()
        };
    let client_tool_mode = !client_tools_payload.is_empty();
    let cloud_tool_mode = req.cloud_task_context.is_some();
    let untrusted_caller = req.untrusted_caller;
    // A Box cloud task has its own screen: its turns may also drive it with
    // `computer.*` and `browser.*` (design §7.4), routed to that Box.
    let cloud_box_machine_tools = req
        .cloud_task_context
        .as_ref()
        .is_some_and(|context| context.backend == "box");
    let tools_payload: Vec<Value> = if cloud_tool_mode {
        let mut payload: Vec<Value> = mcp.cloud_tools_for_agent(tool_allowlist).into_iter()
            .map(|tool| serde_json::json!({"type":"function","function":{"name":format!("cloud_{}",tool.name),"description":tool.description,"parameters":tool.input_schema}})).collect();
        if cloud_box_machine_tools {
            payload.extend(
                mcp.cloud_box_machine_tools_for_agent(tool_allowlist)
                    .into_iter()
                    .map(|tool| serde_json::json!({"type":"function","function":{"name":crate::sidecar::mcp::box_desktop::cloud_machine_tool_name(&tool.id),"description":tool.description,"parameters":tool.input_schema}})),
            );
        }
        payload
    } else {
        client_tools_payload
    };
    if cloud_tool_mode && tools_payload.is_empty() {
        return Err(error_stream(
            "No cloud tools are permitted for this agent.".to_owned(),
        ));
    }

    // A loop with no tools to offer is just a plain single-shot chat.
    let tool_loop_active = !tools_payload.is_empty() && (tools_enabled || client_tool_mode);
    Ok(OpenAiToolPlan {
        tools_payload,
        client_tool_mode,
        cloud_tool_mode,
        untrusted_caller,
        cloud_box_machine_tools,
        tool_loop_active,
    })
}
