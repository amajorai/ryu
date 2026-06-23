//! Built-in "send to channel" action (`channel__send`).
//!
//! An agent-callable tool that posts a message to a Slack/Discord **incoming
//! webhook** URL passed directly in the args. v1 takes the webhook URL inline so
//! there are no stored credentials to manage; resolving creds from the
//! control-plane channels backend (`:3000/api/channels`) by a `channel_id` is a
//! documented follow-up.
//!
//! Registered as a reserved registry server (`channel`) like spider/exa.

use std::time::Duration;

use anyhow::Result;
use reqwest::Client;
use serde_json::{json, Value};

use super::RegistryTool;

/// Reserved registry server name for the built-in channel provider.
pub const SERVER_NAME: &str = "channel";

const SEND_TIMEOUT: Duration = Duration::from_secs(15);

fn send_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "webhook_url": {
                "type": "string",
                "description": "Slack or Discord incoming-webhook URL (https) to post to."
            },
            "text": { "type": "string", "description": "Message text to send." }
        },
        "required": ["webhook_url", "text"]
    })
}

/// The channel tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![RegistryTool {
        id: format!("{SERVER_NAME}__send"),
        server: SERVER_NAME.to_owned(),
        name: "send".to_owned(),
        description: Some(
            "Post a message to a Slack or Discord incoming-webhook URL. \
             Provide the webhook URL and the text to send."
                .to_owned(),
        ),
        input_schema: Some(send_schema()),
    }]
}

/// Dispatch a channel tool call. Posts to the given webhook URL. Network/HTTP
/// failures return a structured `{ ok: false }` (not `Err`) so the agent's turn
/// continues; `Err` is reserved for malformed calls.
pub async fn dispatch(http: &Client, tool: &str, arguments: Value) -> Result<Value> {
    match tool {
        "send" => {
            let url = arguments
                .get("webhook_url")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("missing required string argument 'webhook_url'"))?;
            let text = arguments
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("missing required string argument 'text'"))?;

            let parsed = url::Url::parse(url)
                .map_err(|e| anyhow::anyhow!("invalid webhook_url '{url}': {e}"))?;
            if parsed.scheme() != "https" {
                return Err(anyhow::anyhow!(
                    "webhook_url scheme '{}' is not allowed — only https is accepted",
                    parsed.scheme()
                ));
            }

            // Slack expects `{text}`, Discord expects `{content}`. Send both keys
            // so a single payload works for either provider's webhook.
            let resp = http
                .post(url)
                .timeout(SEND_TIMEOUT)
                .json(&json!({ "text": text, "content": text }))
                .send()
                .await;

            match resp {
                Ok(r) if r.status().is_success() => Ok(json!({ "ok": true, "sent": true })),
                Ok(r) => Ok(json!({
                    "ok": false,
                    "status": r.status().as_u16(),
                    "reason": "webhook returned a non-success status"
                })),
                Err(e) => Ok(json!({ "ok": false, "error": e.to_string() })),
            }
        }
        other => Err(anyhow::anyhow!("unknown channel tool '{other}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_send_tool_with_qualified_id() {
        let tools = tools();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].id, "channel__send");
        assert_eq!(tools[0].server, SERVER_NAME);
    }

    #[tokio::test]
    async fn missing_args_are_errors() {
        let http = Client::new();
        assert!(dispatch(&http, "send", json!({})).await.is_err());
        assert!(
            dispatch(&http, "send", json!({ "webhook_url": "https://x" }))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn non_https_webhook_is_rejected() {
        let http = Client::new();
        let err = dispatch(
            &http,
            "send",
            json!({ "webhook_url": "http://example.com/hook", "text": "hi" }),
        )
        .await;
        assert!(err.is_err(), "non-https webhook must be rejected");
    }
}
