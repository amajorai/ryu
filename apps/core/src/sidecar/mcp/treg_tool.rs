//! Built-in Treg agent tools (`treg.describe`, `treg.call`), behind a flag.
//!
//! Treg is the default managed connection provider (billed at the provider's
//! cost for each endpoint) and Composio the fallback. These tools let an agent
//! reach a Treg endpoint directly:
//!
//! - `treg.describe` reads one endpoint from Treg's public catalog (no key).
//! - `treg.call` runs it through the Gateway's managed connection layer
//!   (`POST /v1/providers/call`, provider `treg`), the same path apps use. The
//!   Treg token stays in the Gateway's provider vault and the call is debited
//!   from the organization wallet there; Core never holds a Treg credential.
//!
//! Composio stays the path for what Treg does not offer: the user's own
//! OAuth-connected accounts (`composio.*` actions) and triggers.
//!
//! Off by default while the agent path is proven: set `features.tregAgentTools`
//! to `true` in the node's `node-config.json` (or `RYU_TREG_AGENT_TOOLS=1`, which
//! wins over the file) to list and dispatch these tools. With the flag off they
//! are neither listed nor callable.

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Map, Value};

use super::RegistryTool;
use crate::provider_pins::{pin_for_call, CatalogBrandLookup, ProviderPin, ProviderPins};

/// Reserved registry server name for the built-in Treg tools.
pub const SERVER_NAME: &str = "treg";
/// The metered call tool, classified as an outbound effect.
pub const CALL_TOOL_ID: &str = "treg.call";
const DESCRIBE_TOOL_ID: &str = "treg.describe";

/// Opt-in flag for the agent execution path. `node-config.json`
/// `settings.features.tregAgentTools` sets it at boot.
const FLAG_ENV: &str = "RYU_TREG_AGENT_TOOLS";
/// Core's own caller identity (not an app id: the `@ryu/` scope is reserved for apps)
/// that Gateway scopes Treg idempotency keys by for agent calls.
pub(crate) const CALLER_ID: &str = "ryu-core-agent";
const ALLOWED_METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE"];

/// Whether the Treg agent tools are switched on for this node.
pub fn enabled() -> bool {
    std::env::var(FLAG_ENV).is_ok_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn describe_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "endpoint_id": {
                "type": "string",
                "description": "The Treg endpoint id, as listed in the Integrations Store."
            }
        },
        "required": ["endpoint_id"],
        "additionalProperties": false
    })
}

fn call_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "endpoint_id": {
                "type": "string",
                "description": "The Treg endpoint id. Read it with treg.describe first."
            },
            "method": {
                "type": "string",
                "enum": ALLOWED_METHODS,
                "description": "HTTP method the endpoint expects (default POST)."
            },
            "query": {
                "type": "object",
                "additionalProperties": { "type": "string" },
                "description": "Query parameters."
            },
            "body": { "description": "JSON request body, when the endpoint takes one." },
            "idempotency_key": {
                "type": "string",
                "description": "Reuse the same key to retry without paying twice."
            },
            "max_cost_micro_usd": {
                "type": "integer",
                "minimum": 0,
                "description": "The most this call may cost, in micro-USD. A call priced above it is refused before it runs."
            }
        },
        "required": ["endpoint_id"],
        "additionalProperties": false
    })
}

/// The Treg tools, or none while the flag is off.
pub fn tools() -> Vec<RegistryTool> {
    if !enabled() {
        return Vec::new();
    }
    vec![
        RegistryTool {
            id: DESCRIBE_TOOL_ID.to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "describe".to_owned(),
            description: Some(
                "Read one Treg endpoint from its public catalog: what it does, its parameters \
                 and its listed price. Free; runs nothing."
                    .to_owned(),
            ),
            input_schema: Some(describe_schema()),
            annotations: Some(json!({ "readOnlyHint": true, "destructiveHint": false })),
            ..Default::default()
        },
        RegistryTool {
            id: CALL_TOOL_ID.to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "call".to_owned(),
            description: Some(
                "Call one Treg endpoint through Ryu's managed connection layer. Billed to the \
                 organization's credits at the provider's cost for that endpoint; an endpoint \
                 with no known price is refused. Use composio actions for the user's own \
                 connected accounts."
                    .to_owned(),
            ),
            input_schema: Some(call_schema()),
            annotations: Some(json!({ "readOnlyHint": false, "openWorldHint": true })),
            ..Default::default()
        },
    ]
}

/// Dispatch a `treg` tool call.
pub async fn dispatch(client: &reqwest::Client, tool: &str, arguments: Value) -> Result<Value> {
    if !enabled() {
        bail!("Treg agent tools are off; set {FLAG_ENV}=1 on the Core node to enable them");
    }
    match tool {
        "describe" => {
            let endpoint_id = endpoint_id(object_arguments(&arguments)?)?;
            describe(&endpoint_id).await
        }
        "call" => {
            let call = parse_call(&arguments)?;
            let provider_pin = pin_for_endpoint(&call.tool_id).await?;
            let org_id = crate::sidecar::control_plane::registered_org().map(|org| org.id);
            let facts = crate::sidecar::gateway::CoreCallFacts {
                org_id: org_id.as_deref(),
                caller_id: CALLER_ID,
                provider_pin,
                require_servable: false,
                ..crate::sidecar::gateway::CoreCallFacts::default()
            };
            crate::sidecar::gateway::call_managed_provider_with(client, &facts, call)
                .await
                .map_err(|error| anyhow!("Treg call failed: {error}"))
        }
        other => Err(anyhow!("unknown treg tool '{other}'")),
    }
}

/// Honor the user's per-app choice: an app pinned to Composio in the
/// Integrations Store is not called through Treg. With no Composio pins this
/// reads nothing; with one set and the catalog or preferences unreadable it
/// refuses rather than guess past the user's choice. The pin is also
/// forwarded, so Gateway enforces it too.
async fn pin_for_endpoint(endpoint_id: &str) -> Result<Option<ProviderPin>> {
    let pins = ProviderPins::load_default().await;
    let pin = pin_for_call(&pins, endpoint_id, None, &CatalogBrandLookup).await;
    if pin == Some(ProviderPin::Composio) {
        bail!(
            "this app is set to use Composio in the Integrations Store (or that choice \
             could not be read); call its composio actions instead of treg.call"
        );
    }
    Ok(pin)
}

async fn describe(endpoint_id: &str) -> Result<Value> {
    crate::treg_catalog::describe_endpoint(endpoint_id)
        .await?
        .ok_or_else(|| anyhow!("the Treg catalog does not list '{endpoint_id}'"))
}

fn object_arguments(arguments: &Value) -> Result<&Map<String, Value>> {
    arguments
        .as_object()
        .ok_or_else(|| anyhow!("treg arguments must be an object"))
}

fn endpoint_id(object: &Map<String, Value>) -> Result<String> {
    let id = object
        .get("endpoint_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow!("missing required string argument 'endpoint_id'"))?;
    if id.contains('/') || id.contains('\\') || id.chars().any(char::is_control) {
        bail!("'endpoint_id' is not a valid Treg endpoint id");
    }
    Ok(id.to_owned())
}

fn parse_call(arguments: &Value) -> Result<ryu_app_events::ManagedProviderCall> {
    let object = object_arguments(arguments)?;
    for key in object.keys() {
        if !matches!(
            key.as_str(),
            "endpoint_id" | "method" | "query" | "body" | "idempotency_key" | "max_cost_micro_usd"
        ) {
            bail!("unknown treg.call argument '{key}'");
        }
    }
    let tool_id = endpoint_id(object)?;
    let method = object.get("method").and_then(Value::as_str).map_or_else(
        || "POST".to_owned(),
        |method| method.trim().to_ascii_uppercase(),
    );
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        bail!("'method' must be one of {}", ALLOWED_METHODS.join(", "));
    }
    let max_cost_micro_usd = match object.get("max_cost_micro_usd") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_u64()
                .ok_or_else(|| anyhow!("'max_cost_micro_usd' must be a non-negative integer"))?,
        ),
    };
    let query = match object.get("query") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Object(query)) => query
            .iter()
            .map(|(key, value)| match value {
                Value::String(text) => Ok((key.clone(), text.clone())),
                Value::Number(number) => Ok((key.clone(), number.to_string())),
                Value::Bool(flag) => Ok((key.clone(), flag.to_string())),
                _ => Err(anyhow!("query parameter '{key}' must be a string")),
            })
            .collect::<Result<_>>()?,
        Some(_) => bail!("'query' must be an object"),
    };
    let call = ryu_app_events::ManagedProviderCall {
        // Named, so the call never falls back to Composio: an agent that chose
        // a Treg endpoint gets Treg's own answer.
        provider: "treg".to_owned(),
        tool_id,
        operation: None,
        account_id: None,
        method,
        query,
        body: object.get("body").cloned().filter(|body| !body.is_null()),
        idempotency_key: object
            .get("idempotency_key")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_owned),
        request_id: format!("core-agent-treg:{}", uuid::Uuid::new_v4().simple()),
        fallback_cost_micro_usd: None,
        task_label: Some("1 Treg tool call".to_owned()),
        timeout_ms: None,
        max_cost_micro_usd,
    };
    call.validate()
        .map_err(|error| anyhow!("invalid treg.call: {error}"))?;
    Ok(call)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_call_for_the_named_treg_provider() {
        let call = parse_call(&json!({
            "endpoint_id": "brave.web.search",
            "method": "get",
            "query": { "q": "ryu", "count": 3 },
            "idempotency_key": " retry-1 ",
        }))
        .expect("valid call");
        assert_eq!(call.provider, "treg");
        assert_eq!(call.tool_id, "brave.web.search");
        assert_eq!(call.method, "GET");
        // The pairs follow the JSON object's iteration order, which is sorted
        // or insertion order depending on `serde_json/preserve_order` (enabled
        // by `agent-client-protocol`); the order carries no meaning here.
        let mut query = call.query.clone();
        query.sort();
        assert_eq!(
            query,
            vec![
                ("count".to_owned(), "3".to_owned()),
                ("q".to_owned(), "ryu".to_owned())
            ]
        );
        assert_eq!(call.idempotency_key.as_deref(), Some("retry-1"));
        assert!(call.request_id.starts_with("core-agent-treg:"));
        assert!(call.operation.is_none() && call.account_id.is_none());
    }

    #[test]
    fn parses_an_optional_cost_ceiling() {
        let capped = parse_call(&json!({ "endpoint_id": "x", "max_cost_micro_usd": 25000 }))
            .expect("valid call");
        assert_eq!(capped.max_cost_micro_usd, Some(25_000));
        let free = parse_call(&json!({ "endpoint_id": "x", "max_cost_micro_usd": 0 }))
            .expect("zero is a ceiling");
        assert_eq!(free.max_cost_micro_usd, Some(0));
        let uncapped = parse_call(&json!({ "endpoint_id": "x" })).expect("valid call");
        assert_eq!(uncapped.max_cost_micro_usd, None);
        for bad in [json!(-1), json!(1.5), json!("5")] {
            assert!(
                parse_call(&json!({ "endpoint_id": "x", "max_cost_micro_usd": bad })).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn refuses_malformed_calls() {
        for arguments in [
            json!({}),
            json!({ "endpoint_id": "" }),
            json!({ "endpoint_id": "../escape" }),
            json!({ "endpoint_id": "x", "method": "CONNECT" }),
            json!({ "endpoint_id": "x", "query": "q=1" }),
            json!({ "endpoint_id": "x", "query": { "q": ["a"] } }),
            json!({ "endpoint_id": "x", "provider": "composio" }),
            json!("x"),
        ] {
            assert!(parse_call(&arguments).is_err(), "{arguments}");
        }
    }

    #[test]
    fn call_is_classified_as_an_outbound_effect() {
        assert_eq!(
            crate::agent_execution::classify_tool(CALL_TOOL_ID),
            crate::agent_execution::ToolEffect::External
        );
    }
}
