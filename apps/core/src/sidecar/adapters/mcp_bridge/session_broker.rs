//! Credential-broker tools on the in-process ACP plane.
//!
//! An ACP run that Core brokers holds a broker session
//! ([`crate::vault::broker::runtime::RuntimeBrokerLease`]). Its bridge carries
//! that session's own credential, so the agent is offered
//! `ryu_broker_discover`, `ryu_broker_propose` and `ryu_broker_proposal` exactly
//! as `ryu-mcp` and the hosted `/mcp/:agent_id` endpoint offer them: the calls
//! run through the broker's agent routes as `broker_session:<id>`, never as the
//! node, and only for the session the run already holds. A run without a lease
//! is offered none of them.
//!
//! [`BrokeredHandler`] wraps Ryu's own bridge handler only for such a run.
//! The same gates as the hosted plane apply ([`super::hosted_broker::offered`]):
//! an explicit tool allowlist must name each tool, and the agent's lifecycle and
//! safety posture must admit it.

use std::net::{Ipv4Addr, SocketAddr};

use axum::http::{HeaderMap, HeaderValue};

use super::*;
use crate::server::vault_broker_api::hosted_mcp;

/// The bridge credential for a broker session token: the header the hosted
/// plane reads, or `None` for anything that is not an `rvb_` session token.
pub(crate) fn session_credentials(token: &str) -> Option<HeaderMap> {
    if !token.starts_with(crate::vault::broker::sessions::TOKEN_PREFIX) {
        return None;
    }
    let mut headers = HeaderMap::new();
    let mut value = HeaderValue::from_str(token).ok()?;
    value.set_sensitive(true);
    headers.insert(hosted_mcp::BROKER_SESSION_HEADER, value);
    Some(headers)
}

/// The in-process client: the ACP agent runs on this node, so it has no
/// address of its own. Its rate-quota bucket is its broker session (a digest
/// of the credential, never the token itself), so local runs do not share
/// the loopback bucket.
fn local_client(credentials: &HeaderMap) -> hosted_mcp::HostedClient {
    use sha2::Digest as _;
    let token = credentials
        .get(hosted_mcp::BROKER_SESSION_HEADER)
        .map(HeaderValue::as_bytes)
        .unwrap_or_default();
    let digest = hex::encode(sha2::Sha256::digest(token));
    hosted_mcp::HostedClient {
        peer: Some(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))),
        forwarded_for: None,
        quota_key: Some(format!("broker-session:{}", &digest[..32])),
    }
}

/// The bridge handler of a brokered run: Ryu's own handler plus the broker
/// tools under the run's session credential. Every other request goes to the
/// inner handler unchanged.
pub(super) struct BrokeredHandler {
    inner: RyuMcpHandler,
    credentials: HeaderMap,
}

impl BrokeredHandler {
    pub(super) fn new(inner: RyuMcpHandler, credentials: HeaderMap) -> Self {
        Self { inner, credentials }
    }

    /// The broker tools this run's session may use, as MCP tool entries.
    pub(super) async fn broker_tools(&self) -> Vec<Tool> {
        let (tools, _) = super::hosted_broker::offered(
            &self.inner.mcp,
            &self.inner.agent_id,
            self.inner.allowlist.as_deref(),
            &self.credentials,
        )
        .await;
        tools
            .iter()
            .filter_map(|tool| serde_json::from_value::<Tool>(tool.listing()).ok())
            .collect()
    }

    /// This bridge's own device turn, or the live turn another instance (a
    /// team or delegated run) serves for the same conversation. Only ever used
    /// to tighten: a proposal is refused after a device read in either.
    pub(super) fn device_offer(&self) -> Option<Arc<crate::device_tools::offer::DeviceOffer>> {
        self.inner.device_turn_offer().or_else(|| {
            self.inner
                .permission_scope_id
                .as_deref()
                .and_then(crate::device_tools::turn_context::live_offer_for_conversation)
        })
    }

    /// Why `name` may not run outside this bridge's live device turn: a
    /// private device read the conversation already holds (a read recorded
    /// when an earlier turn ended, or one in its stored history), or a history
    /// that cannot be read ([`crate::device_tools::conversation_taint`]).
    async fn history_refusal(&self, name: &str) -> Option<String> {
        let conversation_id = self.inner.permission_scope_id.as_deref()?;
        let store = self.inner.mcp.conversations.as_ref();
        match crate::device_tools::conversation_taint::conversation_private_read(
            store,
            conversation_id,
        )
        .await
        {
            Ok(None) => None,
            Ok(Some(source)) => Some(format!(
                "{name} was not run: this conversation already read private data from the phone with `{source}`, so a proposal message could carry it out."
            )),
            Err(_) => Some(format!(
                "{name} was not run: this conversation's history could not be checked for private data read from the phone."
            )),
        }
    }

    /// `describe` for an offered broker tool, as the hosted plane answers it;
    /// `None` for any other id, which the inner handler answers.
    pub(super) async fn describe(&self, arguments: &Value) -> Option<String> {
        let described = super::hosted_broker_catalog::intercept_describe(
            &self.inner.mcp,
            &self.inner.agent_id,
            self.inner.allowlist.as_deref(),
            arguments,
            &self.credentials,
        )
        .await?;
        Some(described.to_string())
    }

    /// Ryu's own tools followed by the broker tools.
    pub(super) async fn tool_list(&self) -> Vec<Tool> {
        let mut tools = self.inner.build_tool_list().await;
        tools.extend(self.broker_tools().await);
        tools
    }

    /// Answer a call to a broker tool, or `None` when `name` is not one (the
    /// call then goes to the inner handler as usual).
    ///
    /// After a device read in this turn, `propose` is refused: its message
    /// reaches a person, so it could carry the device data out. With no live
    /// device turn, an earlier read of the conversation is checked instead (the
    /// agent may still hold its raw result), failing closed when the history
    /// cannot be read.
    pub(super) async fn broker_call(
        &self,
        name: &str,
        arguments: Value,
        device: Option<&crate::device_tools::offer::DeviceOffer>,
    ) -> Option<CallToolResult> {
        if !hosted_mcp::is_tool(name) {
            return None;
        }
        let turn_source = device.and_then(crate::device_tools::taint::private_read_source);
        let refusal = match turn_source {
            Some(source) => Some(format!(
                "{name} was not run: this turn already read private data from the phone with `{source}`, so a proposal message could carry it out."
            )),
            None if name == hosted_mcp::PROPOSE => self.history_refusal(name).await,
            None => None,
        };
        // `offered` turns the session header into the agent route's own
        // credential headers ([`hosted_mcp::agent_headers`]).
        let (tools, route_credentials) = super::hosted_broker::offered(
            &self.inner.mcp,
            &self.inner.agent_id,
            self.inner.allowlist.as_deref(),
            &self.credentials,
        )
        .await;
        let outcome = match (route_credentials, refusal) {
            (Some(_), Some(refusal)) if name == hosted_mcp::PROPOSE => Err(refusal),
            (Some(route_credentials), _) if tools.iter().any(|tool| tool.name == name) => {
                let arguments = if arguments.is_null() {
                    json!({})
                } else {
                    arguments
                };
                hosted_mcp::call(
                    name,
                    arguments,
                    route_credentials,
                    local_client(&self.credentials),
                )
                .await
            }
            _ => Err(format!("tool '{name}' is not allowed for this agent")),
        };
        Some(match outcome {
            Ok(value) => CallToolResult::success(vec![ContentBlock::text(
                serde_json::to_string_pretty(&value).unwrap_or_default(),
            )]),
            Err(message) => CallToolResult::error(vec![ContentBlock::text(message)]),
        })
    }
}

impl rmcp::ServerHandler for BrokeredHandler {
    fn get_info(&self) -> rmcp::model::ServerConfig {
        self.inner.get_info()
    }

    async fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: RequestContext<rmcp::RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(self.tool_list().await))
    }

    async fn call_tool(
        &self,
        request: rmcp::model::CallToolRequestParams,
        context: RequestContext<rmcp::RoleServer>,
    ) -> Result<rmcp::model::CallToolResponse, McpError> {
        let device_offer = self.device_offer();
        let arguments = request
            .arguments
            .clone()
            .map(Value::Object)
            .unwrap_or(Value::Null);
        if request.name.as_ref() == "describe" {
            if let Some(described) = self.describe(&arguments).await {
                return Ok(CallToolResult::success(vec![ContentBlock::text(described)]).into());
            }
        }
        if let Some(result) = self
            .broker_call(request.name.as_ref(), arguments, device_offer.as_deref())
            .await
        {
            // A broker answer is untrusted input: later device calls ask.
            if let Some(offer) = device_offer.as_ref() {
                offer.mark_tainted_input();
            }
            return Ok(result.into());
        }
        self.inner.call_tool(request, context).await
    }
}

#[cfg(test)]
#[path = "session_broker_history_test.rs"]
mod history_test;
#[cfg(test)]
#[path = "session_broker_tests.rs"]
mod tests;
