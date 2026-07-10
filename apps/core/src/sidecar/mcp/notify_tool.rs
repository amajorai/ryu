//! Built-in desktop-notification action (`notify__desktop`).
//!
//! An agent-callable tool that surfaces a native OS notification to the user.
//! Core cannot show an OS notification itself (the desktop webview does), so the
//! dispatch publishes onto the process-global [`crate::events`] channel; the
//! desktop subscribes via `/api/events/notifications/stream` and renders it with
//! the Web Notification API.
//!
//! Registered as a reserved registry server (`notify`) like spider/exa, so the
//! `<server>__<tool>` id scheme, per-agent allowlist, and single `call_tool`
//! entry all work for free. Runs on the ACP tool loop today (the openai-compat
//! default route has no Core-side MCP loop yet — tracked follow-up).

use anyhow::Result;
use serde_json::{json, Value};

use super::RegistryTool;

/// Reserved registry server name for the built-in notification provider.
pub const SERVER_NAME: &str = "notify";

fn desktop_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "title": { "type": "string", "description": "Short notification title." },
            "body": { "type": "string", "description": "Optional notification body text." },
            "level": {
                "type": "string",
                "description": "Severity hint for styling.",
                "enum": ["info", "success", "warning", "error"]
            }
        },
        "required": ["title"]
    })
}

/// The notification tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![RegistryTool {
        id: format!("{SERVER_NAME}__desktop"),
        server: SERVER_NAME.to_owned(),
        name: "desktop".to_owned(),
        description: Some(
            "Show a native desktop notification to the user (title + optional body). \
             Use to surface a result or alert without writing it into the chat."
                .to_owned(),
        ),
        input_schema: Some(desktop_schema()),
        ..Default::default()
    }]
}

/// Dispatch a notification tool call. Publishes to the global events channel so
/// the connected desktop renders an OS notification. `Err` only for a malformed
/// call (unknown tool / missing title).
pub async fn dispatch(tool: &str, arguments: Value) -> Result<Value> {
    match tool {
        "desktop" => {
            let title = arguments
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| anyhow::anyhow!("missing required string argument 'title'"))?;
            let body = arguments
                .get("body")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let level = arguments
                .get("level")
                .and_then(Value::as_str)
                .unwrap_or("info")
                .to_owned();
            crate::events::publish(crate::events::DesktopNotification {
                title: title.clone(),
                body,
                level,
            });
            Ok(json!({ "ok": true, "delivered": true, "title": title }))
        }
        other => Err(anyhow::anyhow!("unknown notify tool '{other}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_desktop_tool_with_qualified_id() {
        let tools = tools();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].id, "notify__desktop");
        assert_eq!(tools[0].server, SERVER_NAME);
    }

    #[tokio::test]
    async fn missing_title_is_an_error() {
        assert!(dispatch("desktop", json!({})).await.is_err());
    }

    #[tokio::test]
    async fn unknown_tool_is_an_error() {
        assert!(dispatch("nope", json!({ "title": "x" })).await.is_err());
    }

    #[tokio::test]
    async fn publishes_to_subscribers() {
        let mut rx = crate::events::subscribe();
        dispatch("desktop", json!({ "title": "Hello", "body": "World" }))
            .await
            .expect("dispatch ok");
        let got = rx.try_recv().expect("notification published");
        assert_eq!(got.title, "Hello");
        assert_eq!(got.body.as_deref(), Some("World"));
    }
}
