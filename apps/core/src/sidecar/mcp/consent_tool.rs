//! Built-in **in-chat consent requests** (`consent.connect_app` /
//! `consent.install_plugin`).
//!
//! When an agent needs something only the user may grant, such as an account
//! connection or a plugin install, it asks through one of these tools. The
//! desktop then draws an inline card in the chat with a single clear action
//! (**Connect** / **Install**) and a way to decline.
//!
//! Like `ui.render` and `artifact.render`, these are **client-rendered, no-op**
//! tools. Core never connects an account or installs anything from here: the
//! user's click drives the existing Composio / MCP OAuth / plugin-install routes,
//! each with its own checks (signature verification, org policy, access level).
//! Dispatch only validates the request shape and tells the model to stop and
//! wait for the user's reply, which arrives as a normal user message.
//!
//! Plugin candidates are resolved and ranked client-side from the catalog the
//! user can already browse: official Ryu listings first, then verified
//! publishers, then community listings. Trust comes from the server-derived
//! catalog fields, never from anything the model passes here.
//!
//! Registered as a reserved registry server (`consent`) like `ui`/`artifact`, so
//! the `<server>.<tool>` id scheme, per-agent allowlist, and single `call_tool`
//! entry all work for free.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use super::RegistryTool;

/// Reserved registry server name for the built-in consent-request provider.
pub const SERVER_NAME: &str = "consent";

/// Connection providers the desktop knows how to start from a card.
const CONNECT_PROVIDERS: &[&str] = &["composio", "mcp"];

/// Longest `reason` accepted. The card shows it verbatim, so keep it a sentence.
const MAX_REASON_CHARS: usize = 280;

/// Upper bound on explicitly named plugin ids in one request.
const MAX_PLUGIN_IDS: usize = 5;

/// Longest identifier (toolkit slug, plugin id, server name, query) accepted.
const MAX_IDENT_CHARS: usize = 200;

/// Returned to the model so it ends its turn instead of assuming the grant.
const AWAITING_USER_NOTE: &str = "A card asking the user is now shown in the chat. \
     End your turn and wait: the user's choice arrives as their next message. \
     Do not assume the request was granted and do not ask again in the same turn.";

fn connect_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "app": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_IDENT_CHARS,
                "description": "The app to connect. For provider `composio` (default) this is the toolkit slug, e.g. \"gmail\", \"github\", \"slack\", \"notion\". For provider `mcp` it is the server name declared by the plugin."
            },
            "reason": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_REASON_CHARS,
                "description": "One short sentence, shown on the card, saying what the connection is for, e.g. \"To read your unread email from today.\""
            },
            "provider": {
                "type": "string",
                "enum": CONNECT_PROVIDERS,
                "default": "composio",
                "description": "How the account is connected. `composio` for the integration catalog; `mcp` for a plugin's MCP server that signs in with OAuth (requires `pluginId`)."
            },
            "pluginId": {
                "type": "string",
                "maxLength": MAX_IDENT_CHARS,
                "description": "Required when provider is `mcp`: the installed plugin that declares the OAuth server."
            }
        },
        "required": ["app", "reason"],
        // Dispatch requires `pluginId` for provider `mcp`; say so here too.
        "if": { "properties": { "provider": { "const": "mcp" } }, "required": ["provider"] },
        "then": { "required": ["pluginId"] }
    })
}

fn install_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "maxLength": MAX_IDENT_CHARS,
                "description": "What capability is needed, searched against the plugin catalog, e.g. \"linear issues\" or \"figma\"."
            },
            "pluginIds": {
                "type": "array",
                "items": { "type": "string", "minLength": 1, "maxLength": MAX_IDENT_CHARS },
                "maxItems": MAX_PLUGIN_IDS,
                "description": "Specific catalog ids to offer, when you already know them (e.g. from skills or tool search)."
            },
            "reason": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_REASON_CHARS,
                "description": "One short sentence, shown on the card, saying why the plugin is needed."
            }
        },
        "required": ["reason"],
        // Dispatch needs a query or at least one id; say so in the schema too so
        // a schema-valid call is never one that dispatch rejects.
        "anyOf": [
            { "required": ["query"], "properties": { "query": { "minLength": 1 } } },
            { "required": ["pluginIds"], "properties": { "pluginIds": { "minItems": 1 } } }
        ]
    })
}

/// The consent tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![
        RegistryTool {
            id: format!("{SERVER_NAME}.connect_app"),
            server: SERVER_NAME.to_owned(),
            name: "connect_app".to_owned(),
            description: Some(
                "Ask the user to connect an app account (Gmail, GitHub, Slack, …) so you can act \
                 on it. Shows an inline card in the chat with a Connect button; the user signs in \
                 in their browser. Use this when a tool reports that a connection is missing, or \
                 before a task that clearly needs an account the user has not connected. Never \
                 ask the user to paste passwords or API keys into the chat instead.\n\n\
                 After calling this, end your turn. The user's choice (connected, or not now) \
                 arrives as their next message."
                    .to_owned(),
            ),
            input_schema: Some(connect_schema()),
            ..Default::default()
        },
        RegistryTool {
            id: format!("{SERVER_NAME}.install_plugin"),
            server: SERVER_NAME.to_owned(),
            name: "install_plugin".to_owned(),
            description: Some(
                "Ask the user to install a plugin that adds a capability you lack. Shows an inline \
                 card listing matching catalog plugins with their publisher trust, rating and \
                 install counts. Official Ryu plugins are listed first, then verified publishers, \
                 then community plugins. Pass a `query` describing the capability, or \
                 `pluginIds` when you know them. You cannot install anything yourself: the user \
                 picks and confirms.\n\n\
                 After calling this, end your turn. The user's choice (installed, or not now) \
                 arrives as their next message."
                    .to_owned(),
            ),
            input_schema: Some(install_schema()),
            ..Default::default()
        },
    ]
}

/// A required, bounded, non-blank string argument.
fn required_text<'a>(arguments: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    let value = arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("missing required string argument '{key}'"))?;
    if value.chars().count() > max {
        return Err(anyhow!("'{key}' must be at most {max} characters"));
    }
    Ok(value)
}

/// An optional, bounded string argument. Blank counts as absent; a non-string is
/// an error so a malformed call is reported rather than silently ignored.
fn optional_text<'a>(arguments: &'a Value, key: &str, max: usize) -> Result<Option<&'a str>> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.is_empty() {
                return Ok(None);
            }
            if s.chars().count() > max {
                return Err(anyhow!("'{key}' must be at most {max} characters"));
            }
            Ok(Some(s))
        }
        Some(_) => Err(anyhow!("'{key}' must be a string")),
    }
}

fn connect_dispatch(arguments: &Value) -> Result<Value> {
    let app = required_text(arguments, "app", MAX_IDENT_CHARS)?;
    required_text(arguments, "reason", MAX_REASON_CHARS)?;
    let provider = optional_text(arguments, "provider", MAX_IDENT_CHARS)?.unwrap_or("composio");
    if !CONNECT_PROVIDERS.contains(&provider) {
        return Err(anyhow!(
            "'provider' must be one of: {}",
            CONNECT_PROVIDERS.join(", ")
        ));
    }
    let plugin_id = optional_text(arguments, "pluginId", MAX_IDENT_CHARS)?;
    if provider == "mcp" && plugin_id.is_none() {
        return Err(anyhow!("provider 'mcp' requires 'pluginId'"));
    }
    Ok(json!({
        "ok": true,
        "awaitingUser": true,
        "request": "connect_app",
        "app": app,
        "provider": provider,
        "note": AWAITING_USER_NOTE,
    }))
}

fn install_dispatch(arguments: &Value) -> Result<Value> {
    required_text(arguments, "reason", MAX_REASON_CHARS)?;
    let query = optional_text(arguments, "query", MAX_IDENT_CHARS)?;
    let ids = match arguments.get("pluginIds") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            if items.len() > MAX_PLUGIN_IDS {
                return Err(anyhow!("'pluginIds' accepts at most {MAX_PLUGIN_IDS} ids"));
            }
            let mut ids = Vec::with_capacity(items.len());
            for item in items {
                let id = item
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| anyhow!("'pluginIds' must contain non-empty strings"))?;
                if id.chars().count() > MAX_IDENT_CHARS {
                    return Err(anyhow!(
                        "each plugin id must be at most {MAX_IDENT_CHARS} characters"
                    ));
                }
                ids.push(id);
            }
            ids
        }
        Some(_) => return Err(anyhow!("'pluginIds' must be an array of strings")),
    };
    if query.is_none() && ids.is_empty() {
        return Err(anyhow!("provide 'query' or 'pluginIds'"));
    }
    Ok(json!({
        "ok": true,
        "awaitingUser": true,
        "request": "install_plugin",
        "note": AWAITING_USER_NOTE,
    }))
}

/// Dispatch a consent tool call. Client-rendered: nothing is connected or
/// installed here. `Err` only for a malformed call.
pub async fn dispatch(tool: &str, arguments: Value) -> Result<Value> {
    match tool {
        "connect_app" => connect_dispatch(&arguments),
        "install_plugin" => install_dispatch(&arguments),
        other => Err(anyhow!("unknown consent tool '{other}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_both_tools_with_qualified_ids() {
        let tools = tools();
        let ids: Vec<&str> = tools.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["consent.connect_app", "consent.install_plugin"]);
        assert!(tools.iter().all(|t| t.server == SERVER_NAME));
        assert!(tools.iter().all(|t| t.input_schema.is_some()));
    }

    #[tokio::test]
    async fn connect_acknowledges_and_tells_the_model_to_wait() {
        let out = dispatch(
            "connect_app",
            json!({ "app": "gmail", "reason": "To read today's unread email." }),
        )
        .await
        .unwrap();
        assert_eq!(out["ok"], true);
        assert_eq!(out["awaitingUser"], true);
        assert_eq!(out["provider"], "composio");
        assert_eq!(out["app"], "gmail");
        assert!(out["note"].as_str().unwrap().contains("End your turn"));
    }

    #[tokio::test]
    async fn connect_requires_app_and_reason() {
        let err = dispatch("connect_app", json!({ "reason": "x" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("'app'"));
        let err = dispatch("connect_app", json!({ "app": "gmail", "reason": "  " }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("'reason'"));
    }

    #[tokio::test]
    async fn connect_rejects_unknown_provider_and_mcp_without_plugin() {
        let err = dispatch(
            "connect_app",
            json!({ "app": "gmail", "reason": "x", "provider": "passwords" }),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("'provider'"));
        let err = dispatch(
            "connect_app",
            json!({ "app": "linear", "reason": "x", "provider": "mcp" }),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("pluginId"));
        let ok = dispatch(
            "connect_app",
            json!({ "app": "linear", "reason": "x", "provider": "mcp", "pluginId": "@ryu/linear" }),
        )
        .await
        .unwrap();
        assert_eq!(ok["provider"], "mcp");
    }

    #[tokio::test]
    async fn connect_rejects_an_overlong_reason() {
        let reason = "a".repeat(MAX_REASON_CHARS + 1);
        let err = dispatch("connect_app", json!({ "app": "gmail", "reason": reason }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("at most"));
    }

    #[test]
    fn connect_schema_matches_dispatch_limits() {
        let schema = connect_schema();
        assert_eq!(schema["properties"]["app"]["maxLength"], MAX_IDENT_CHARS);
        assert_eq!(
            schema["properties"]["reason"]["maxLength"],
            MAX_REASON_CHARS
        );
        assert_eq!(schema["properties"]["reason"]["minLength"], 1);
        assert_eq!(schema["then"]["required"][0], "pluginId");
    }

    #[test]
    fn install_schema_requires_a_query_or_ids() {
        let schema = install_schema();
        let any_of = schema["anyOf"].as_array().expect("anyOf");
        let required: Vec<&str> = any_of
            .iter()
            .filter_map(|branch| branch["required"][0].as_str())
            .collect();
        assert_eq!(required, ["query", "pluginIds"]);
    }

    #[tokio::test]
    async fn install_needs_a_query_or_ids() {
        let err = dispatch("install_plugin", json!({ "reason": "x" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("'query' or 'pluginIds'"));
        let out = dispatch(
            "install_plugin",
            json!({ "reason": "x", "query": "linear" }),
        )
        .await
        .unwrap();
        assert_eq!(out["awaitingUser"], true);
        let out = dispatch(
            "install_plugin",
            json!({ "reason": "x", "pluginIds": ["@ryu/mail"] }),
        )
        .await
        .unwrap();
        assert_eq!(out["request"], "install_plugin");
    }

    #[tokio::test]
    async fn install_validates_plugin_ids() {
        let err = dispatch("install_plugin", json!({ "reason": "x", "pluginIds": "a" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("array"));
        let err = dispatch(
            "install_plugin",
            json!({ "reason": "x", "pluginIds": [""] }),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("non-empty"));
        let too_many: Vec<String> = (0..=MAX_PLUGIN_IDS).map(|i| format!("p{i}")).collect();
        let err = dispatch(
            "install_plugin",
            json!({ "reason": "x", "pluginIds": too_many }),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("at most"));
    }

    #[test]
    fn smart_approval_mode_does_not_gate_the_request_itself() {
        // The card is the consent step. A name the risky-verb heuristic matches
        // would put an approval prompt in front of the question, asking twice.
        for tool in tools() {
            assert!(
                crate::approvals::policy::classify_risk(&tool.id).is_empty(),
                "{} must not look risky to the smart approval heuristic",
                tool.id
            );
        }
    }

    #[tokio::test]
    async fn unknown_tool_is_an_error() {
        assert!(dispatch("grant_everything", json!({})).await.is_err());
    }
}
