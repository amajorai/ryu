//! The Companion `chat.send` app host-bridge operation.
//!
//! A Companion frame holding the `chat.sendFollowUp` grant can post one message
//! into an existing conversation (Chat Broadcast). The frame reaches here only
//! through the desktop host's capability-gated RPC, and the bridge
//! (`server::plugin_bridge_api`) has already checked the app is enabled and holds
//! the grant, keyed by the PATH plugin id.
//!
//! The text is app-authored, so it goes through the same gates as the sidecar
//! `chat.startTurn` capability (`host_chat::submit`): the shared-node refusal,
//! the exec scan, the Gateway firewall ingress check, and the
//! `apps-ask-before-send` approval queue (default on). The desktop host used to
//! post the text straight to `/api/chat/stream` with the owner's token, which
//! made the turn look typed by the user and skipped every one of those gates.
//!
//! On top of those, the verified caller must be able to read the destination
//! conversation, so an app can only target a conversation the signed-in user
//! can already see.

use axum::http::StatusCode;
use serde_json::Value;

use super::host_chat::submit::{self, AppSendRequest, Execution};
use super::kernel_op::{decode_reply_bytes, read_handler_reply, KernelOpError};
use super::ServerState;
use crate::identity_verify::VerifiedCaller;

/// The longest conversation id accepted (matches the host RPC contract).
const MAX_CONVERSATION_ID_CHARS: usize = 200;
/// The longest message accepted (matches the host RPC contract).
const MAX_TEXT_CHARS: usize = 8000;

/// The one chat-send operation. The wire name is the host-API method.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChatSendOp {
    /// Post one message into an existing conversation.
    Send,
}

/// `{ conversationId, text }`. Unknown keys are refused, so no agent, model or
/// identity can ride along.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SendArgs {
    conversation_id: String,
    text: String,
}

/// Validated arguments: a trimmed conversation id and trimmed text.
#[derive(Debug, PartialEq, Eq)]
struct ParsedSend {
    conversation_id: String,
    text: String,
}

fn parse_args(args: &Value) -> Result<ParsedSend, KernelOpError> {
    let parsed: SendArgs = serde_json::from_value(args.clone()).map_err(|_| {
        KernelOpError::invalid("chat.send requires { conversationId: string, text: string }")
    })?;
    let conversation_id = parsed.conversation_id.trim();
    if conversation_id.is_empty() || conversation_id.chars().count() > MAX_CONVERSATION_ID_CHARS {
        return Err(KernelOpError::invalid(
            "chat.send requires a conversationId of 1 to 200 characters",
        ));
    }
    let text = parsed.text.trim();
    if text.is_empty() || text.chars().count() > MAX_TEXT_CHARS {
        return Err(KernelOpError::invalid(
            "chat.send requires text of 1 to 8000 characters",
        ));
    }
    Ok(ParsedSend {
        conversation_id: conversation_id.to_owned(),
        text: text.to_owned(),
    })
}

impl ChatSendOp {
    /// The operation a host-method name selects, if any.
    pub(crate) fn from_name(name: &str) -> Option<Self> {
        match name {
            "chat.send" => Some(Self::Send),
            _ => None,
        }
    }

    /// Run the send for `plugin_id` (the bridge's path id) on behalf of `caller`.
    pub(crate) async fn run(
        self,
        state: &ServerState,
        plugin_id: &str,
        caller: &Option<VerifiedCaller>,
        args: &Value,
    ) -> Result<Value, KernelOpError> {
        let Self::Send = self;
        let parsed = parse_args(args)?;
        submit::refuse_shared_node()?;
        if let Err(response) =
            super::require_conversation_read_by_id(state, caller, &parsed.conversation_id).await
        {
            let (status, bytes) = read_handler_reply(response).await?;
            return Err(decode_reply_bytes(status, &bytes)
                .err()
                .unwrap_or_else(|| KernelOpError::new(StatusCode::FORBIDDEN, "denied")));
        }
        // The conversation's own agent answers, as it would for a typed turn.
        let agent_id = state
            .conversations
            .get_summary(&parsed.conversation_id)
            .await
            .map_err(|e| KernelOpError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .and_then(|summary| summary.agent_id);
        let request = AppSendRequest {
            plugin_id: plugin_id.to_owned(),
            agent_id,
            conversation_id: parsed.conversation_id.clone(),
            cwd: None,
            text: parsed.text,
            model: None,
        };
        let outcome = submit::submit_app_send(state, request, Execution::Detach).await?;
        Ok(outcome.to_json(&parsed.conversation_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_chat_send_selects_the_operation() {
        assert_eq!(ChatSendOp::from_name("chat.send"), Some(ChatSendOp::Send));
        assert_eq!(ChatSendOp::from_name("chat.list"), None);
        assert_eq!(ChatSendOp::from_name("chat.startTurn"), None);
    }

    #[test]
    fn the_bridge_gates_chat_send_on_the_send_follow_up_grant() {
        assert_eq!(
            ryu_kernel_contracts::host_api::grant_for("chat.send"),
            Some(super::super::host_chat::GRANT_SEND_FOLLOW_UP)
        );
    }

    #[test]
    fn valid_args_are_trimmed() {
        let parsed = parse_args(&json!({ "conversationId": " c1 ", "text": "  hi  " })).unwrap();
        assert_eq!(
            parsed,
            ParsedSend {
                conversation_id: "c1".into(),
                text: "hi".into()
            }
        );
    }

    #[test]
    fn smuggled_fields_and_bad_shapes_are_refused() {
        for args in [
            json!({ "conversationId": "c1", "text": "hi", "agent_id": "other" }),
            json!({ "conversationId": "c1", "text": "hi", "persist": true }),
            json!({ "conversationId": "c1" }),
            json!({ "conversationId": "", "text": "hi" }),
            json!({ "conversationId": "c1", "text": "   " }),
            json!({ "conversationId": "x".repeat(201), "text": "hi" }),
            json!({ "conversationId": "c1", "text": "x".repeat(8001) }),
            json!("c1"),
        ] {
            let error = parse_args(&args).unwrap_err();
            assert_eq!(error.status, StatusCode::BAD_REQUEST, "{args}");
        }
    }
}
