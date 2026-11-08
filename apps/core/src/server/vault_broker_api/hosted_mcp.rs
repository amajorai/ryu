//! Broker discover/propose tools on the hosted MCP endpoint (`POST /mcp/:agent_id`).
//!
//! The same three tools `ryu-mcp` registers over stdio (`ryu_broker_discover`,
//! `ryu_broker_propose`, `ryu_broker_proposal`), served by Core so an agent that
//! reaches Ryu through the hosted endpoint can act on a broker `403`
//! `proposalHint` without a second MCP server.
//!
//! The node bearer that admits the MCP request is never broker authority. A
//! call is authorized only by the agent's own broker credential, sent on the MCP
//! request as `x-ryu-vault-token` (a machine token) or `x-ryu-broker-session`
//! (an `rvb_` session). Each call is dispatched as an in-process request to the
//! equivalent `/api/vault/agent/broker/*` route, through the same vault request
//! layer ([`super::super::vault_tokens_api::request_layer`]) that wraps the
//! direct route, carrying only that credential and the MCP request's client
//! address. Rate quotas on those paths, CIDR bindings of the token or session,
//! and token-accessor audit attribution therefore apply exactly as they do on
//! the direct route. No tool takes or returns a credential value, and refusals
//! carry the route's message only.

use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{header, HeaderMap, HeaderValue, Method, Request};
use tower::ServiceExt as _;

use super::*;

/// Header carrying an `rvb_` broker session on a hosted MCP request.
pub const BROKER_SESSION_HEADER: &str = "x-ryu-broker-session";

/// Largest agent-route answer read back into a tool result.
const MAX_RESULT_BYTES: usize = 1024 * 1024;

pub const DISCOVER: &str = "ryu_broker_discover";
pub const PROPOSE: &str = "ryu_broker_propose";
pub const PROPOSAL: &str = "ryu_broker_proposal";

/// One hosted broker tool definition.
pub struct HostedTool {
    pub name: &'static str,
    pub description: &'static str,
    pub read_only: bool,
    pub input_schema: Value,
}

impl HostedTool {
    /// MCP annotations for this tool.
    pub fn annotations(&self) -> Value {
        json!({
            "readOnlyHint": self.read_only,
            "destructiveHint": false,
            "openWorldHint": false,
        })
    }

    /// The agent route's method, which classifies the tool's effect.
    pub fn http_method(&self) -> &'static str {
        if self.read_only {
            "GET"
        } else {
            "POST"
        }
    }

    /// The `tools/list` entry.
    pub fn listing(&self) -> Value {
        json!({
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
            "annotations": self.annotations(),
        })
    }
}

fn reference_schema() -> Value {
    json!({
        "type": "string",
        "pattern": "^(secret:|op://|bws://)",
        "description": "Credential reference such as secret:LINEAR_TOKEN. Never a value.",
    })
}

fn service_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "name": { "type": "string", "pattern": "^[a-z0-9_-]{1,64}$" },
            "host": { "type": "string", "description": "Host the agent needs, e.g. api.linear.app." },
            "port": { "type": "integer", "minimum": 1, "maximum": 65535 },
            "pathPrefix": { "type": "string", "description": "Path prefix, default /." },
            "auth": {
                "type": "object",
                "properties": {
                    "type": { "type": "string", "enum": ["bearer", "api_key", "basic", "passthrough"] },
                    "token": reference_schema(),
                    "header": { "type": "string" },
                    "value": reference_schema(),
                    "prefix": { "type": "string" },
                    "username": { "type": "string" },
                    "password": reference_schema(),
                },
                "required": ["type"],
            },
            "description": { "type": "string" },
        },
        "required": ["name", "host", "auth"],
    })
}

/// The hosted broker tools, in listing order.
pub fn tools() -> Vec<HostedTool> {
    vec![
        HostedTool {
            name: DISCOVER,
            description: "List the credential-broker services this agent may reach (host, auth \
                kind, placeholders) and the environment's skills. Call it after a 403 from the \
                broker proxy. Never returns credential values.",
            read_only: true,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "environment": {
                        "type": "string",
                        "description": "Environment (machine tokens only; a session has its own).",
                    },
                },
                "additionalProperties": false,
            }),
        },
        HostedTool {
            name: PROPOSE,
            description: "Ask a person to add a broker service for a host and/or provide \
                credentials (by reference, e.g. secret:NAME). Use it when the broker proxy \
                answers 403 for a host no service covers. The person is notified and approves \
                or rejects; poll with ryu_broker_proposal.",
            read_only: false,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Why the agent needs this, shown to the person who decides.",
                    },
                    "services": { "type": "array", "maxItems": 10, "items": service_schema() },
                    "credentials": {
                        "type": "array",
                        "maxItems": 10,
                        "items": {
                            "type": "object",
                            "properties": {
                                "ref": reference_schema(),
                                "description": { "type": "string" },
                                "obtainInstructions": {
                                    "type": "string",
                                    "description": "How a person gets the value, e.g. which settings page.",
                                },
                            },
                            "required": ["ref"],
                        },
                    },
                    "environment": {
                        "type": "string",
                        "description": "Environment (machine tokens only; a session has its own).",
                    },
                },
                "required": ["message"],
            }),
        },
        HostedTool {
            name: PROPOSAL,
            description: "Check a proposal this agent filed (or a credential-use approval it \
                waits on): pending, approved, rejected, or expired.",
            read_only: true,
            input_schema: json!({
                "type": "object",
                "properties": { "id": { "type": "string", "minLength": 1 } },
                "required": ["id"],
                "additionalProperties": false,
            }),
        },
    ]
}

/// Whether `name` is a hosted broker tool.
pub fn is_tool(name: &str) -> bool {
    matches!(name, DISCOVER | PROPOSE | PROPOSAL)
}

/// The broker credential on a hosted MCP request, as the only headers the
/// agent routes see: a machine token, else an `rvb_` session as a bearer.
/// `None` when the request carries neither, so the tools are not offered.
pub fn agent_headers(incoming: &HeaderMap) -> Option<HeaderMap> {
    let mut headers = HeaderMap::new();
    if let Some(token) = header_value(incoming, VAULT_TOKEN_HEADER) {
        headers.insert(VAULT_TOKEN_HEADER, HeaderValue::from_str(token).ok()?);
        return Some(headers);
    }
    let session = header_value(incoming, BROKER_SESSION_HEADER)?;
    let session = session
        .strip_prefix("Bearer ")
        .or_else(|| session.strip_prefix("bearer "))
        .unwrap_or(session)
        .trim();
    if !session.starts_with(sessions::TOKEN_PREFIX) {
        return None;
    }
    let bearer = HeaderValue::from_str(&format!("Bearer {session}")).ok()?;
    headers.insert(header::AUTHORIZATION, bearer);
    Some(headers)
}

/// Where a hosted MCP request came from: the connection peer and any
/// `x-forwarded-for` it carried. The vault request layer resolves the client
/// address from these exactly as it does on the direct agent route (the
/// forwarded header counts only from a trusted proxy).
#[derive(Debug, Clone, Default)]
pub struct HostedClient {
    pub peer: Option<SocketAddr>,
    pub forwarded_for: Option<HeaderValue>,
}

impl HostedClient {
    /// The client of the HTTP request currently being served.
    pub fn of_request(incoming: &HeaderMap) -> Self {
        Self {
            peer: crate::server::trace_context::request_peer(),
            forwarded_for: incoming.get("x-forwarded-for").cloned(),
        }
    }
}

const DISCOVER_PATH: &str = "/api/vault/agent/broker/discover";
const PROPOSALS_PATH: &str = "/api/vault/agent/broker/proposals";

/// Run one hosted broker tool as the agent `credentials` names, from `client`.
///
/// `Err` is the model-facing refusal: the route's own message and status, which
/// never contain a credential or a value.
pub async fn call(
    name: &str,
    arguments: Value,
    credentials: HeaderMap,
    client: HostedClient,
) -> Result<Value, String> {
    let (method, uri, body) = match name {
        DISCOVER => {
            let uri = match optional_string(&arguments, "environment")? {
                Some(environment) => format!(
                    "{DISCOVER_PATH}?environment={}",
                    urlencoding::encode(&environment)
                ),
                None => DISCOVER_PATH.to_owned(),
            };
            (Method::GET, uri, None)
        }
        PROPOSE => {
            if !arguments.is_object() {
                return Err("arguments must be an object".to_owned());
            }
            (Method::POST, PROPOSALS_PATH.to_owned(), Some(arguments))
        }
        PROPOSAL => {
            let Some(id) = optional_string(&arguments, "id")? else {
                return Err("missing required string argument 'id'".to_owned());
            };
            let uri = format!("{PROPOSALS_PATH}/{}", urlencoding::encode(&id));
            (Method::GET, uri, None)
        }
        other => return Err(format!("unknown broker tool '{other}'")),
    };
    let request = agent_request(method, &uri, body, credentials, client)?;
    let router = super::stateless_public_routes::<()>().layer(axum::middleware::from_fn(
        super::super::vault_tokens_api::request_layer,
    ));
    let response = router
        .oneshot(request)
        .await
        .map_err(|_| "the broker request could not be served".to_owned())?;
    tool_result(response).await
}

/// The in-process request for an agent route: the credential headers, the
/// MCP request's client address, and nothing else from the MCP request.
fn agent_request(
    method: Method,
    uri: &str,
    body: Option<Value>,
    credentials: HeaderMap,
    client: HostedClient,
) -> Result<Request<Body>, String> {
    let body = match body {
        Some(body) => Body::from(serde_json::to_vec(&body).map_err(|e| e.to_string())?),
        None => Body::empty(),
    };
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .body(body)
        .map_err(|_| "the broker request could not be built".to_owned())?;
    let headers = request.headers_mut();
    headers.extend(credentials);
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    if let Some(forwarded) = client.forwarded_for {
        headers.insert("x-forwarded-for", forwarded);
    }
    if let Some(peer) = client.peer {
        request.extensions_mut().insert(ConnectInfo(peer));
    }
    Ok(request)
}

fn optional_string(arguments: &Value, key: &str) -> Result<Option<String>, String> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.trim().to_owned())),
        Some(_) => Err(format!("'{key}' must be a non-empty string")),
    }
}

async fn tool_result(response: Response) -> Result<Value, String> {
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), MAX_RESULT_BYTES)
        .await
        .map_err(|_| "the broker answer could not be read".to_owned())?;
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(body);
    }
    let message = body
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("the broker refused the request");
    Err(format!("{message} (HTTP {})", status.as_u16()))
}

#[cfg(test)]
#[path = "hosted_mcp_tests.rs"]
mod tests;
