use super::*;

/// Build the widget-availability event for a tool that resolves to a
/// [`crate::sidecar::mcp::WidgetBinding`], or `None` when the tool renders no
/// widget / errored / the per-session instance cap is hit. Mints the
/// `WidgetInstance` (the round-trip identity) and resolves the widget HTML.
///
/// A free fn (not a method) so BOTH emit planes share it (R1 / A0):
/// - the ACP MCP bridge passes `tool_call_id = None` and gets the synthetic
///   `wgtcall_{instance_id}` id (behaviour unchanged);
/// - the Core OpenAI-compat chat tool loop passes `Some(real_id)`, the actual
///   `tool_calls[].id`, so the widget part carries the real correlation id (D1).
///
/// It reads `structuredContent`/`_meta` out of `result` and never re-dispatches
/// the tool, so it is safe to call after the tool has already executed on either
/// plane.
pub(crate) async fn build_widget_event(
    mcp: &McpRegistry,
    tool_id: &str,
    tool_input: &Value,
    result: &Value,
    tool_call_id: Option<String>,
    conversation_id: Option<String>,
    agent_id: String,
) -> Option<ToolWidgetEvent> {
    // DEDUP + grant gate (Round: one plugin model): the promotion decision now
    // routes through the single manifest-gated resolver. `contributes.widgets[]`
    // is the source of record for WHETHER a tool may render; the `_meta`/apps
    // discovery only supplies the binding DETAIL it returns on Allow. A tool whose
    // owning (enabled) plugin lacks the `widget:render` grant is refused here —
    // its result is still delivered as text, so refusal never breaks the turn.
    let binding = match mcp.widget_promotion_or_log(tool_id).await {
        Some(binding) => binding,
        None => return None,
    };
    let typed = McpToolResult::from_result_value(result.clone());
    // `isError` results NEVER emit a widget (spec §1.1).
    if typed.is_error {
        return None;
    }
    let normalized_tool_id = mcp.canonical_tool_id_for_registry(tool_id);
    let (server, _tool) = mcp.split_registered_tool_id(&normalized_tool_id)?;
    let resource = mcp.widget_resource(server, &binding.template_uri).await?;
    // Prewarm sibling widget resources for reload (best-effort).
    let _ = mcp.prewarm_widgets(server).await;
    let tool_ids = mcp.widget_accessible_tool_ids(server).await;
    let opener_meta = mcp
        .tools_for_server(server)
        .await
        .ok()
        .and_then(|tools| tools.into_iter().find(|tool| tool.id == normalized_tool_id))
        .and_then(|tool| tool.meta);
    let widget_accessible = crate::sidecar::mcp::app_visibility::instance_callable(
        opener_meta.as_ref(),
        binding.widget_accessible,
        !tool_ids.is_empty(),
    );

    // The frame's Gateway-sourced capabilities. Computed BEFORE the mint so the
    // set handed to the iframe and the permission recorded on the instance come
    // from one value and cannot drift into disagreeing: the desktop host gates
    // `ui.sendMessage` on the former, Core gates `/api/widgets/follow-up` on the
    // latter, and they must be the same decision.
    let approved_grants = if widget_accessible {
        vec!["tool:call".to_owned(), "ui:send_message".to_owned()]
    } else {
        Vec::new()
    };
    let may_send_follow_up = approved_grants.iter().any(|g| g == "ui:send_message");

    // Mint the instance (round-trip identity). The conversation/session key is
    // the permission scope; over the per-session cap → no widget.
    let instance = crate::server::widgets::mint_widget_instance(
        conversation_id.unwrap_or_default(),
        agent_id,
        server.to_owned(),
        tool_ids,
        may_send_follow_up,
    )?;

    // The WIDGET channel: `structuredContent` → `toolOutput`, `_meta` minus
    // `ryu/widget` → `toolResponseMetadata`. Delivered RAW — see
    // [`widget_payload`] for why, and for the trace proving the model edge stays
    // neutralized.
    let (tool_output, meta) = widget_payload(typed);

    // Real tool-call id when the caller has one (the chat loop); otherwise the
    // synthetic instance-derived id (the ACP bridge, which cannot see it).
    let tool_call_id = tool_call_id.unwrap_or_else(|| format!("wgtcall_{}", instance.instance_id));

    Some(ToolWidgetEvent {
        tool_call_id,
        tool_name: tool_id.to_owned(),
        instance_id: instance.instance_id,
        server_id: server.to_owned(),
        template_uri: binding.template_uri,
        widget_html: resource.html,
        widget_mime: resource.mime_type,
        tool_input: tool_input.clone(),
        tool_output,
        tool_response_metadata: meta,
        widget_accessible,
        approved_grants,
        invoking: binding.invoking_label,
        invoked: binding.invoked_label,
        initial_widget_state: instance.widget_state,
        display_mode: "inline".to_owned(),
        // The declared remote-asset hosts, parsed from the SAME widget-resource
        // `_meta` the server-side asset proxy uses as its authoritative allowlist
        // (`server::widgets::parse_resource_domains`). Threading it here is what
        // lights the governed CSP-widen + asset-rewrite path on the client; empty
        // ⇒ the CSP stays fully locked. One parse, reused — no forked allowlist.
        resource_domains: resource
            .meta
            .as_ref()
            .map(crate::server::widgets::parse_resource_domains)
            .unwrap_or_default(),
    })
}

/// Split an MCP tool result into the two values the **widget channel** carries:
/// `(toolOutput, toolResponseMetadata)` = (`structuredContent`, `_meta` minus the
/// Core-internal `ryu/widget` binding key). Missing `structuredContent` → `Null`;
/// missing `_meta` → `{}`.
///
/// # The widget payload is delivered RAW — and that is deliberate. Do not "fix" it.
///
/// This value is **presentation data**, not model context. It is handed to a
/// widget rendering inside a null-origin, CSP-locked, sandboxed iframe and is
/// never folded back into the LLM prompt. Boundary-marker neutralization
/// ([`untrusted::neutralize`]) is a *prompt-injection* defense: it exists so a
/// poisoned tool result cannot impersonate the transcript once it re-enters the
/// model. Applying it here bought nothing and corrupted every third-party widget
/// — a title came through as
/// `<<<EXTERNAL_UNTRUSTED_CONTENT>>>Pizza Palace<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>`
/// and rendered the markers literally. (First-party in-process apps were exempt,
/// which is why the corruption only ever showed on external servers.)
///
/// **The neutralization boundary belongs at the MODEL EDGE, not at widget
/// delivery.** Every path by which data on this channel could reach a model was
/// traced; each is defended at its own model edge, independently of this
/// function:
///
/// 1. **ACP model fold.** The bridge's `call_tool` stringifies the *original*
///    `result` (not this payload — the two channels are separate values derived
///    from the same result) and runs it through [`neutralize_external_result`]
///    before handing it to the agent. Still wrapped + template-token-stripped.
/// 2. **Widget → `sendFollowUpMessage`.** Reaches the model as a user-looking
///    turn, so it is firewall/DLP-scanned at `POST /api/widgets/follow-up`
///    (`crate::server::widgets::widget_follow_up`, gateway `check_exec_scan`,
///    fail-closed) before injection. Note this channel is attacker-controlled
///    *regardless*: the widget's own HTML/JS is served raw from the same
///    untrusted MCP server, so it can compose any prompt string it likes with or
///    without `toolOutput`. Neutralizing `toolOutput` never defended it.
/// 3. **Widget → `callTool`.** Governed by `POST /api/widgets/tools/call`
///    (provenance gate → gateway `/v1/exec/tool`: allowlist, firewall, budget,
///    audit). Its result is returned to the *iframe* (`pushGlobals({toolOutput})`
///    in `apps/desktop/src/contributions/host/AppWidget.tsx`); it is not appended
///    to the conversation and never re-enters the prompt.
/// 4. **Persistence / history replay.** The widget event is **emit-only**: the
///    `AcpEvent::ToolWidget` arm in `adapters/mod.rs` yields the SSE part and does
///    *not* push it into the `PartsAccumulator`, so no widget payload is written
///    to the `messages.parts` column and none can be replayed into model context
///    on reload. `widgetState` (`POST /api/widgets/state`) lives only in the
///    in-memory `WidgetInstanceStore` and is replayed to the *iframe*, not the model.
///
/// The OpenAI-compat chat tool loop (`adapters/mod.rs`, the
/// `oai_messages.push({"role":"tool"…})` after `exec_chat_tool`) is the third
/// model edge; it folds through [`neutralize_external_result`] too (gap closed
/// 2026-07-23 — it used to re-enter raw).
pub(super) fn widget_payload(typed: McpToolResult) -> (Value, Value) {
    let mut meta = typed
        .meta
        .unwrap_or_else(|| Value::Object(Default::default()));
    if let Some(obj) = meta.as_object_mut() {
        obj.remove("ryu/widget");
    }
    (typed.structured_content.unwrap_or(Value::Null), meta)
}
