//! Enforcing a service's MCP tool policy ([`McpToolPolicy`]) on a brokered
//! request, before any credential is resolved.

use serde_json::Value;

use super::super::services::tool_policy::{self, McpToolPolicy, Uninspectable};
use super::*;

/// JSON-RPC error code for a refused tool call (server-defined range).
pub(super) const TOOL_DENIED_CODE: i64 = -32001;
const OUTCOME: &str = "mcp_tool_denied";
const MAX_AUDITED_NAME: usize = 128;

/// Why a request was refused under a tool policy.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Denial {
    /// The body could not be read while a policy is set.
    Uninspectable(Uninspectable),
    /// These `tools/call` messages name tools the policy does not permit.
    Tools(Vec<tool_policy::ToolCall>),
}

/// Check a body against a policy.
pub(super) fn decide(
    policy: &McpToolPolicy,
    content_type: Option<&str>,
    content_encoding: Option<&str>,
    body: &[u8],
) -> Result<(), Denial> {
    let calls = tool_policy::tool_calls(content_type, content_encoding, body)
        .map_err(Denial::Uninspectable)?;
    let denied: Vec<_> = calls
        .into_iter()
        .filter(|call| {
            !call
                .name
                .as_deref()
                .is_some_and(|name| policy.permits(name))
        })
        .collect();
    if denied.is_empty() {
        Ok(())
    } else {
        Err(Denial::Tools(denied))
    }
}

/// A tool name fit for the audit log (never a free-form blob).
fn audited_name(name: Option<&str>) -> String {
    match name {
        Some(name)
            if !name.is_empty()
                && name.len() <= MAX_AUDITED_NAME
                && name.chars().all(|c| c.is_ascii_graphic()) =>
        {
            name.to_owned()
        }
        _ => "<invalid>".to_owned(),
    }
}

fn rpc_error(id: Value, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": TOOL_DENIED_CODE, "message": message },
    })
}

impl Denial {
    fn reason(&self) -> &'static str {
        match self {
            Self::Uninspectable(Uninspectable::Encoded) => "encoded_body",
            Self::Uninspectable(Uninspectable::TooLarge) => "body_too_large",
            Self::Uninspectable(Uninspectable::NotJson) => "not_json",
            Self::Uninspectable(Uninspectable::NotJsonRpc) => "not_json_rpc",
            Self::Tools(_) => "tool_not_permitted",
        }
    }

    pub(super) fn tools(&self) -> Vec<String> {
        match self {
            Self::Tools(calls) => calls
                .iter()
                .map(|call| audited_name(call.name.as_deref()))
                .collect(),
            Self::Uninspectable(_) => Vec::new(),
        }
    }

    /// The response the agent gets: JSON-RPC errors (HTTP 200) for every
    /// request id in the body when there are any, else a plain 403.
    pub(super) fn refusal(&self, body: &[u8]) -> Refusal {
        let Self::Tools(denied) = self else {
            return Refusal::new(
                StatusCode::FORBIDDEN,
                OUTCOME,
                "this service has an MCP tool policy and the request body could not be inspected; send uncompressed JSON-RPC",
            );
        };
        let ids = tool_policy::message_ids(body);
        if ids.is_empty() {
            return Refusal::new(
                StatusCode::FORBIDDEN,
                OUTCOME,
                "the broker does not permit this MCP tool",
            );
        }
        let errors: Vec<Value> = ids
            .into_iter()
            .map(|id| {
                let call = denied.iter().find(|call| call.id.as_ref() == Some(&id));
                let message = match call {
                    Some(call) => format!(
                        "tool `{}` is not permitted by the Ryu credential broker",
                        audited_name(call.name.as_deref())
                    ),
                    None => "the batch calls a tool the Ryu credential broker does not permit"
                        .to_owned(),
                };
                rpc_error(id, &message)
            })
            .collect();
        let batch = body
            .iter()
            .find(|byte| !byte.is_ascii_whitespace())
            .is_some_and(|byte| *byte == b'[');
        let payload = match (batch, errors.len()) {
            (false, 1) => errors.into_iter().next().unwrap_or(Value::Null),
            _ => Value::Array(errors),
        };
        Refusal {
            response: json_response(StatusCode::OK, OUTCOME, payload),
            outcome: OUTCOME,
        }
    }
}

impl Broker {
    /// Refuse `outgoing` when it calls a tool `service` does not permit (or
    /// cannot be read under a policy), auditing the decision with the
    /// service and tool names only.
    pub(super) async fn check_mcp_tools(
        &self,
        session: &BrokerSession,
        service: &BrokerService,
        outgoing: &Outgoing,
    ) -> Result<(), Refusal> {
        let Some(policy) = &service.input.mcp_tools else {
            return Ok(());
        };
        let Err(denial) = decide(
            policy,
            header_str(&outgoing.headers, hyper::header::CONTENT_TYPE.as_str()),
            header_str(&outgoing.headers, hyper::header::CONTENT_ENCODING.as_str()),
            &outgoing.body,
        ) else {
            return Ok(());
        };
        self.store
            .audit(
                &crate::vault::audit::AuditEntry::new(
                    &session.actor(),
                    "broker.mcp.tool_denied",
                    "denied",
                )
                .details(json!({
                    "session": session.id,
                    "environment": session.environment,
                    "service": service.name(),
                    "tools": denial.tools(),
                    "reason": denial.reason(),
                })),
            )
            .await;
        Err(denial.refusal(&outgoing.body))
    }

    /// A WebSocket upgrade cannot be inspected per message, so a service
    /// with a tool policy is never upgraded.
    pub(super) fn refuse_policy_upgrade(service: Option<&BrokerService>) -> Result<(), Refusal> {
        match service {
            Some(service) if service.input.mcp_tools.is_some() => Err(Refusal::new(
                StatusCode::FORBIDDEN,
                OUTCOME,
                "this service has an MCP tool policy; WebSocket upgrades are not brokered for it",
            )),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
#[path = "mcp_filter_tests.rs"]
mod tests;
