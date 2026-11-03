use super::*;
use crate::i18n::Message;

/// Gate `agent_builder.configure_agent` — an agent rewriting its OWN
/// configuration — behind an interactive user prompt raised over `permission_tx`.
///
/// **No channel ⇒ DENY.** `permission_tx` is the ACP stream back-channel the
/// prompt travels on; its absence does not mean "unattended, proceed", it means
/// there is nobody to ask. A permission check that cannot ask must not assume
/// yes. In-process ACP callers always supply the channel (`acp.rs` builds the
/// bridge with `Some(instance_tx)` and keeps a relay alive for the whole
/// instance), so for years this branch was unreachable — it was the transport
/// contract, written down before a transport that trips it existed.
///
/// **That transport now exists: `POST /mcp/:agent_id`** ([`serve_http_jsonrpc`]).
/// A network MCP client can never hold an `AcpEvent` sender, so it lands in this
/// branch on every call, and returning `Ok` here would hand a remote caller agent
/// self-reconfiguration with no prompt and no inbox item. The branch is live;
/// `configure_agent_is_denied_without_a_permission_channel` is what holds it.
///
/// This was the one governance layer in the `call_tool` path that read the
/// transport at all. Every other layer decides the same way for every caller:
/// [`crate::approvals::gate_tool_call`] routes an approval through the inbox
/// engine without ever looking at whether a stream is attached, and the allowlist
/// recheck inside `McpRegistry::call_tool` refuses an un-granted tool id no matter
/// who is asking. Only this one treated "nobody is listening" as consent.
///
/// The channel check deliberately runs BEFORE the one-time session-approval
/// cache. The cache records a decision a human made through an interactive
/// prompt, keyed by a caller-supplied scope id this function does not
/// authenticate; replaying it for a transport that could never have raised that
/// prompt would let a network client inherit somebody else's "Allow" just by
/// naming their conversation. "No channel is never allowed" holds unconditionally.
pub(super) async fn require_agent_builder_configure_permission(
    permission_tx: &Option<tokio::sync::mpsc::UnboundedSender<AcpEvent>>,
    permission_scope_id: Option<&str>,
    args: &Value,
) -> Result<(), McpError> {
    let Some(tx) = permission_tx else {
        return Err(McpError::new(
            rmcp::model::ErrorCode::INVALID_REQUEST,
            "'agent_builder.configure_agent' requires an interactive permission channel \
             to ask the user for approval, and this transport has none; call it from an \
             interactive session"
                .to_owned(),
            None,
        ));
    };
    if let Some(scope_id) = permission_scope_id {
        if AGENT_BUILDER_CONFIGURE_APPROVALS
            .lock()
            .map(|approvals| approvals.contains(scope_id))
            .unwrap_or(false)
        {
            return Ok(());
        }
    }
    let agent_id = args
        .get("agent_id")
        .and_then(Value::as_str)
        .unwrap_or("this agent");
    let chosen = crate::sidecar::adapters::acp::request_user_permission(
        tx,
        json!({
            "title": "configure itself",
            "kind": "agent_builder.configure",
            "agent_id": agent_id,
            "fields": {
                "title": "configure itself"
            },
            "i18n": configure_agent_consent_i18n()
        }),
        json!([
            {
                "optionId": "allow_once",
                "name": "Allow once",
                "kind": "allow_once"
            },
            {
                "optionId": "allow_session",
                "name": "Allow for session",
                "kind": "allow_always"
            },
            {
                "optionId": "reject_once",
                "name": "Deny",
                "kind": "reject_once"
            }
        ]),
        // The host conversation, so `POST /api/chat/permission` can gate the decision
        // on the thread that raised it.
        permission_scope_id.map(str::to_owned),
    )
    .await;
    match chosen.as_deref() {
        Some("allow_once") => Ok(()),
        Some("allow_session") => {
            if let Some(scope_id) = permission_scope_id {
                if let Ok(mut approvals) = AGENT_BUILDER_CONFIGURE_APPROVALS.lock() {
                    approvals.insert(scope_id.to_owned());
                }
            }
            Ok(())
        }
        _ => Err(McpError::new(
            rmcp::model::ErrorCode::INVALID_REQUEST,
            "user denied permission to configure the agent".to_owned(),
            None,
        )),
    }
}

/// Whether `gate_id` changes settings that are approved one call at a time:
/// Gateway or routing configuration, preferences (approval mode, the command
/// scan, trusted workspaces) and workspace trust. "Allow for this chat" covers
/// every later call to the tool whatever its arguments, so one approved edit
/// would let a later, injected edit run without asking. See
/// [`crate::approvals::chat_grants::requires_per_call_consent`].
pub(super) fn requires_per_call_consent(gate_id: &str) -> bool {
    crate::approvals::chat_grants::requires_per_call_consent(gate_id)
}

/// The in-chat permission card's choices for `gate_id`: no "Allow for this
/// chat" for a per-call change (see [`requires_per_call_consent`]).
pub(super) fn consent_options(gate_id: &str) -> Value {
    if requires_per_call_consent(gate_id) {
        return json!([
            { "optionId": "allow_once", "name": "Allow once", "kind": "allow_once" },
            { "optionId": "reject_once", "name": "Deny", "kind": "reject_once" }
        ]);
    }
    json!([
        { "optionId": "allow_once", "name": "Allow once", "kind": "allow_once" },
        { "optionId": "allow_session", "name": "Allow for this chat", "kind": "allow_always" },
        { "optionId": "reject_once", "name": "Deny", "kind": "reject_once" }
    ])
}

/// What an in-chat permission prompt says the agent wants to do.
pub(super) fn in_chat_consent_title(tool_id: &str, args: &Value) -> String {
    if tool_id == crate::approvals::chat_grants::SWITCH_INTERFACE_TOOL_ID {
        let interface = args
            .get("interface")
            .and_then(Value::as_str)
            .unwrap_or("another interface");
        return format!("switch your interface to {interface}");
    }
    if let Some(route) = crate::self_api::route_for(tool_id) {
        let summary = route.summary.trim().trim_end_matches('.');
        let endpoint = format!("{} {}", route.method, route.path_template);
        return if summary.is_empty() {
            format!("change Ryu settings ({endpoint})")
        } else {
            format!("{} ({endpoint})", summary.to_lowercase())
        };
    }
    format!("run {tool_id}")
}

/// The localizable form of an in-chat consent prompt, sent as `toolCall.i18n`
/// beside the English `fields.title` (which older clients keep showing): the
/// action as a whole-sentence Core message, a label message per allow choice
/// keyed by `optionId` (the desktop catalogues the one-word "Deny" itself), and
/// an optional untranslated technical `detail`.
fn consent_i18n(
    action: Message,
    detail: Option<String>,
    allow_session_label: crate::i18n::Template,
) -> Value {
    use crate::i18n::messages::CONSENT_ALLOW_ONCE_MESSAGE;
    let mut i18n = json!({
        "title": action.to_wire(),
        "options": {
            "allow_once": Message::new(CONSENT_ALLOW_ONCE_MESSAGE).to_wire(),
            "allow_session": Message::new(allow_session_label).to_wire(),
        }
    });
    if let Some(detail) = detail {
        i18n["detail"] = Value::String(detail);
    }
    i18n
}

/// [`consent_i18n`] for `agent_builder.configure_agent`.
fn configure_agent_consent_i18n() -> Value {
    use crate::i18n::messages::{
        CONSENT_ALLOW_FOR_SESSION_MESSAGE, CONSENT_CONFIGURE_AGENT_MESSAGE,
    };
    consent_i18n(
        Message::new(CONSENT_CONFIGURE_AGENT_MESSAGE),
        None,
        CONSENT_ALLOW_FOR_SESSION_MESSAGE,
    )
}

/// [`consent_i18n`] for [`in_chat_consent_title`]: a whole sentence per shape;
/// a Core self-API route is "Change a Ryu setting" with the endpoint as detail.
pub(super) fn in_chat_consent_i18n(tool_id: &str, args: &Value) -> Value {
    use crate::i18n::messages::{
        CONSENT_ALLOW_FOR_CHAT_MESSAGE, CONSENT_CHANGE_SETTING_MESSAGE, CONSENT_RUN_CALL_MESSAGE,
        CONSENT_SWITCH_INTERFACE_MESSAGE, CONSENT_SWITCH_INTERFACE_UNNAMED_MESSAGE,
    };
    let (action, detail) = if tool_id == crate::approvals::chat_grants::SWITCH_INTERFACE_TOOL_ID {
        let action = match args.get("interface").and_then(Value::as_str) {
            Some(interface) if !interface.trim().is_empty() => {
                Message::new(CONSENT_SWITCH_INTERFACE_MESSAGE).text("interface", interface.trim())
            }
            _ => Message::new(CONSENT_SWITCH_INTERFACE_UNNAMED_MESSAGE),
        };
        (action, None)
    } else if let Some(route) = crate::self_api::route_for(tool_id) {
        (
            Message::new(CONSENT_CHANGE_SETTING_MESSAGE),
            Some(format!("{} {}", route.method, route.path_template)),
        )
    } else {
        (
            Message::new(CONSENT_RUN_CALL_MESSAGE).text("tool", tool_id),
            None,
        )
    };
    consent_i18n(action, detail, CONSENT_ALLOW_FOR_CHAT_MESSAGE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offers_allow_for_this_chat(gate_id: &str) -> bool {
        consent_options(gate_id)
            .as_array()
            .expect("consent options are a list")
            .iter()
            .any(|option| option["optionId"] == "allow_session")
    }

    #[test]
    fn policy_and_gateway_changes_are_offered_allow_once_only() {
        assert!(!offers_allow_for_this_chat(
            "ryu_api.put_api_preferences_key"
        ));
        assert!(offers_allow_for_this_chat(
            "ryu_api.put_api_models_id_launch_config"
        ));
    }

    fn option_source(i18n: &Value, option_id: &str) -> String {
        i18n["options"][option_id]["message"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }

    #[test]
    fn switch_interface_consent_is_one_sentence_with_the_interface_as_a_value() {
        let i18n = in_chat_consent_i18n(
            crate::approvals::chat_grants::SWITCH_INTERFACE_TOOL_ID,
            &json!({ "interface": "minimal" }),
        );
        assert_eq!(
            i18n["title"]["message"],
            "Switch your interface to {interface}"
        );
        assert_eq!(i18n["title"]["args"]["interface"], "minimal");
        assert!(i18n.get("detail").is_none());
        assert_eq!(option_source(&i18n, "allow_session"), "Allow for this chat");

        let unnamed = in_chat_consent_i18n(
            crate::approvals::chat_grants::SWITCH_INTERFACE_TOOL_ID,
            &json!({}),
        );
        assert_eq!(unnamed["title"]["message"], "Switch your interface");
    }

    #[test]
    fn settings_route_consent_is_generic_and_keeps_the_endpoint_as_detail() {
        let tool_id = "ryu_api.put_api_preferences_key";
        let route = crate::self_api::route_for(tool_id).expect("preferences route exists");
        let i18n = in_chat_consent_i18n(tool_id, &json!({ "key": "approval-mode" }));
        assert_eq!(i18n["title"]["message"], "Change a Ryu setting");
        assert_eq!(
            i18n["detail"],
            format!("{} {}", route.method, route.path_template)
        );
        // The English summary never leaks into the localizable sentence.
        assert!(!i18n["title"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains(&route.path_template));
    }

    #[test]
    fn other_tools_and_agent_self_configuration_name_whole_sentences() {
        let run = in_chat_consent_i18n("files.delete", &json!({}));
        assert_eq!(run["title"]["message"], "Run the tool {tool}");
        assert_eq!(run["title"]["args"]["tool"], "files.delete");
        assert_eq!(option_source(&run, "allow_once"), "Allow once");
        assert_eq!(option_source(&run, "reject_once"), "");

        let configure = configure_agent_consent_i18n();
        assert_eq!(
            configure["title"]["message"],
            "Let the agent configure itself"
        );
        assert_eq!(
            option_source(&configure, "allow_session"),
            "Allow for session"
        );
    }

    #[test]
    fn consent_messages_render_through_the_core_catalog() {
        let configure = Message::new(crate::i18n::messages::CONSENT_CONFIGURE_AGENT_MESSAGE);
        assert_eq!(configure.render("en"), "Let the agent configure itself");
        let run = Message::new(crate::i18n::messages::CONSENT_RUN_CALL_MESSAGE)
            .text("tool", "files.delete");
        assert_eq!(run.render("en"), "Run the tool files.delete");
    }
}
