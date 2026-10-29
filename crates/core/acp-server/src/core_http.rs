//! Minimal HTTP client for the running Core node.
//!
//! Only the endpoints the ACP translation needs, with errors phrased for the
//! person reading them in their editor ("Ryu is not running" rather than a raw
//! socket error).

use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::endpoint::CoreEndpoint;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Ceiling for the short request/response calls. The chat stream itself has no
/// overall timeout: a turn can legitimately run for a long time.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// A Core call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CoreError {
    /// Nothing answered at the configured address.
    Unreachable { url: String },
    /// Core answered but refused the credential (401, or a 403 with no reason).
    Unauthorized { status: u16 },
    /// Core accepted the credential but refused the request with a reason
    /// (RBAC, organization policy). Core's message is kept verbatim.
    Forbidden { message: String },
    /// Any other non-success answer.
    Http { status: u16, message: String },
    /// Transport failure mid-request, or an unparseable answer.
    Other(String),
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable { url } => write!(
                formatter,
                "Ryu is not running or not reachable at {url}. Start Ryu (the desktop app, or `ryu` in a terminal) and try again."
            ),
            Self::Unauthorized { status } => write!(
                formatter,
                "Ryu rejected this connection's credentials (HTTP {status}). Make sure the editor runs as the same user as Ryu, or pass the node token for a remote node."
            ),
            Self::Forbidden { message } => {
                write!(formatter, "Ryu refused this request (HTTP 403): {message}")
            }
            Self::Http { status, message } => write!(formatter, "Ryu returned HTTP {status}: {message}"),
            Self::Other(message) => write!(formatter, "{message}"),
        }
    }
}

impl From<CoreError> for agent_client_protocol::Error {
    fn from(error: CoreError) -> Self {
        // Deliberately not ACP's `auth_required`: that code tells the client to
        // run an `authenticate` method, and this agent advertises none. The
        // node token is local configuration, so the message says what to fix.
        agent_client_protocol::Error::new(
            agent_client_protocol::ErrorCode::InternalError.into(),
            error.to_string(),
        )
    }
}

/// One agent from `GET /api/agents`.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub(crate) struct AgentSummary {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Core marks the node's default agent with `enabled: true`.
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Deserialize)]
struct AgentsResponse {
    #[serde(default)]
    agents: Vec<AgentSummary>,
}

/// One persisted message from `GET /api/conversations/:id`.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct StoredMessage {
    pub role: String,
    #[serde(default)]
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ConversationDetail {
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub messages: Vec<StoredMessage>,
}

#[derive(Clone)]
pub(crate) struct CoreClient {
    http: reqwest::Client,
    endpoint: CoreEndpoint,
}

impl CoreClient {
    pub(crate) fn new(endpoint: CoreEndpoint) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { http, endpoint }
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let builder = self
            .http
            .request(method, format!("{}{path}", self.endpoint.url));
        match &self.endpoint.token {
            Some(token) => builder.bearer_auth(token),
            None => builder,
        }
    }

    fn transport_error(&self, error: &reqwest::Error) -> CoreError {
        if error.is_connect() || (error.is_timeout() && error.status().is_none()) {
            CoreError::Unreachable {
                url: self.endpoint.url.clone(),
            }
        } else {
            CoreError::Other(format!("request to Ryu failed: {error}"))
        }
    }

    async fn send(&self, builder: reqwest::RequestBuilder) -> Result<reqwest::Response, CoreError> {
        let response = builder
            .send()
            .await
            .map_err(|error| self.transport_error(&error))?;
        check_status(response).await
    }

    async fn send_json(&self, builder: reqwest::RequestBuilder) -> Result<Value, CoreError> {
        let response = self.send(builder.timeout(REQUEST_TIMEOUT)).await?;
        response
            .json::<Value>()
            .await
            .map_err(|error| CoreError::Other(format!("unreadable answer from Ryu: {error}")))
    }

    /// Reachability probe. Any HTTP answer at all means Core is up.
    pub(crate) async fn health(&self) -> Result<(), CoreError> {
        self.send(
            self.request(reqwest::Method::GET, "/api/health")
                .timeout(REQUEST_TIMEOUT),
        )
        .await
        .map(|_| ())
    }

    pub(crate) async fn list_agents(&self) -> Result<Vec<AgentSummary>, CoreError> {
        let value = self
            .send_json(self.request(reqwest::Method::GET, "/api/agents"))
            .await?;
        serde_json::from_value::<AgentsResponse>(value)
            .map(|response| response.agents)
            .map_err(|error| CoreError::Other(format!("unexpected agent list from Ryu: {error}")))
    }

    pub(crate) async fn conversation(&self, id: &str) -> Result<ConversationDetail, CoreError> {
        let path = format!("/api/conversations/{}", encode_path_segment(id));
        let value = self
            .send_json(self.request(reqwest::Method::GET, &path))
            .await?;
        serde_json::from_value(value)
            .map_err(|error| CoreError::Other(format!("unexpected conversation from Ryu: {error}")))
    }

    /// Open the SSE chat stream. The caller reads the body incrementally.
    pub(crate) async fn chat_stream(&self, body: &Value) -> Result<reqwest::Response, CoreError> {
        self.send(
            self.request(reqwest::Method::POST, "/api/chat/stream")
                .json(body),
        )
        .await
    }

    /// Ask Core to stop the conversation's in-flight run.
    pub(crate) async fn cancel(&self, conversation_id: &str) -> Result<bool, CoreError> {
        let value = self
            .send_json(
                self.request(reqwest::Method::POST, "/api/chat/cancel")
                    .json(&json!({ "conversation_id": conversation_id })),
            )
            .await?;
        Ok(value.get("cancelled").and_then(Value::as_bool) == Some(true))
    }

    /// Deliver a tool-approval decision. `None` denies (Core treats a missing
    /// option as cancel/reject).
    pub(crate) async fn resolve_permission(
        &self,
        request_id: &str,
        option_id: Option<&str>,
    ) -> Result<bool, CoreError> {
        let value = self
            .send_json(
                self.request(reqwest::Method::POST, "/api/chat/permission")
                    .json(&json!({ "request_id": request_id, "option_id": option_id })),
            )
            .await?;
        Ok(value.get("resolved").and_then(Value::as_bool) == Some(true))
    }

    /// Answer a blocking Question card: one answer object per question, in
    /// order (`{kind: "single"|"multi"|"text"|"skip", selectedIds?, text?}`).
    pub(crate) async fn answer_question(
        &self,
        conversation_id: &str,
        tool_call_id: &str,
        answers: &[Value],
    ) -> Result<bool, CoreError> {
        let value = self
            .send_json(
                self.request(reqwest::Method::POST, "/api/chat/question")
                    .json(&json!({
                        "conversation_id": conversation_id,
                        "tool_call_id": tool_call_id,
                        "answers": answers,
                    })),
            )
            .await?;
        Ok(value.get("resolved").and_then(Value::as_bool) == Some(true))
    }
}

async fn check_status(response: reqwest::Response) -> Result<reqwest::Response, CoreError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(CoreError::Unauthorized {
            status: status.as_u16(),
        });
    }
    let body = response.text().await.unwrap_or_default();
    let reason = error_reason(&body);
    if status == reqwest::StatusCode::FORBIDDEN {
        // Core's RBAC and organization-policy denials say why; only a bare
        // 403 (a paired/delegated token's scope refusal) is about the
        // credential itself.
        return Err(match reason {
            Some(message) => CoreError::Forbidden { message },
            None => CoreError::Unauthorized {
                status: status.as_u16(),
            },
        });
    }
    let message = reason.unwrap_or_else(|| {
        let trimmed = body.trim();
        if trimmed.is_empty() {
            status
                .canonical_reason()
                .unwrap_or("request failed")
                .to_owned()
        } else {
            trimmed.chars().take(300).collect()
        }
    });
    Err(CoreError::Http {
        status: status.as_u16(),
        message,
    })
}

/// Core's JSON `error` (or `message`) text, when the body carries one.
fn error_reason(body: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(body).ok()?;
    ["error", "message"].iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    })
}

/// Percent-encode one path segment (conversation ids are UUIDs, but a loaded
/// session id comes from the editor and must not be able to alter the path).
fn encode_path_segment(segment: &str) -> String {
    let mut encoded = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_segments_cannot_escape() {
        assert_eq!(encode_path_segment("a/../b?c"), "a%2F..%2Fb%3Fc");
        assert_eq!(encode_path_segment("3f2a-9"), "3f2a-9");
    }

    #[test]
    fn forbidden_reasons_come_from_cores_body() {
        assert_eq!(
            error_reason(r#"{"error":"agent 'coder' is unavailable under organization policy"}"#),
            Some("agent 'coder' is unavailable under organization policy".to_owned())
        );
        assert_eq!(error_reason(""), None);
        assert_eq!(error_reason(r#"{"error":"  "}"#), None);
        let message = CoreError::Forbidden {
            message: "insufficient permissions: agent.run".into(),
        }
        .to_string();
        assert!(message.contains("insufficient permissions: agent.run"));
        assert!(!message.contains("credentials"));
    }

    #[test]
    fn unreachable_error_names_the_address() {
        let message = CoreError::Unreachable {
            url: "http://127.0.0.1:1".into(),
        }
        .to_string();
        assert!(message.contains("not running"));
        assert!(message.contains("http://127.0.0.1:1"));
    }
}
