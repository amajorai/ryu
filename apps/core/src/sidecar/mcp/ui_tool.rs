//! Built-in **generative UI** action (`ui__render`).
//!
//! Lets an agent render a rich, interactive UI inline in the chat instead of plain
//! markdown. The model passes a single json-render spec object as `spec`; the desktop
//! renders it into the app's own `@ryu/ui` (shadcn) components, so agent-authored UI
//! is visually consistent with the rest of the product.
//!
//! This is a **client-rendered, no-op** tool: Core does not execute anything: the
//! actual rendering happens in the desktop from the tool *input*, which is already
//! surfaced to the UI by the sidecar's `ui_tool_input` event. The dispatch here only
//! does a light structural sanity-check and acknowledges, so the agent's tool loop
//! gets a clean result.
//!
//! Registered as a reserved registry server (`ui`) like `notify`/`threads`, so the
//! `<server>__<tool>` id scheme, per-agent allowlist, and single `call_tool` entry
//! all work for free.
//!
//! The model-facing contract (component vocabulary + spec shape) lives in the
//! generated `agent_ui_contract.md`, kept in sync with the renderer's catalog by
//! `scripts/gen-agent-ui-contract.ts` — never edit that file by hand.

use anyhow::Result;
use serde_json::{json, Value};

use super::RegistryTool;

/// Reserved registry server name for the built-in generative-UI provider.
pub const SERVER_NAME: &str = "ui";

/// The model-facing description: how to compose a spec + the component catalog.
/// Generated from the renderer's catalog (see module docs).
const RENDER_CONTRACT: &str = include_str!("agent_ui_contract.md");

fn render_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "spec": {
                "type": "object",
                "description": "The json-render UI spec: a flat element tree \
                    { root, elements, state? }. See the tool description for the \
                    component catalog and spec shape."
            },
            "title": {
                "type": "string",
                "description": "Optional heading shown above the rendered UI."
            }
        },
        "required": ["spec"]
    })
}

/// The generative-UI tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![RegistryTool {
        id: format!("{SERVER_NAME}__render"),
        server: SERVER_NAME.to_owned(),
        name: "render".to_owned(),
        description: Some(RENDER_CONTRACT.to_owned()),
        input_schema: Some(render_schema()),
        ..Default::default()
    }]
}

/// Dispatch a `ui__render` call. No-op by design — the desktop renders from the tool
/// input. We only validate that `spec` is a non-empty object so the model gets useful
/// feedback for an obviously malformed call (authoritative validation is client-side).
pub async fn dispatch(tool: &str, arguments: Value) -> Result<Value> {
    match tool {
        "render" => {
            let spec = arguments
                .get("spec")
                .ok_or_else(|| anyhow::anyhow!("missing required object argument 'spec'"))?;
            let obj = spec
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("'spec' must be a json-render spec object"))?;
            if !obj.contains_key("root") || !obj.contains_key("elements") {
                return Err(anyhow::anyhow!(
                    "'spec' must include 'root' (the root element key) and 'elements' (the element map)"
                ));
            }
            Ok(json!({ "ok": true, "rendered": true }))
        }
        other => Err(anyhow::anyhow!("unknown ui tool '{other}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_render_tool_with_qualified_id() {
        let tools = tools();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].id, "ui__render");
        assert_eq!(tools[0].server, SERVER_NAME);
        assert!(tools[0].input_schema.is_some());
    }

    #[test]
    fn contract_lists_components() {
        // The generated contract must carry the component catalog, or the model has
        // no vocabulary. Guards against an empty/stale regeneration.
        assert!(RENDER_CONTRACT.contains("AVAILABLE COMPONENTS"));
        assert!(RENDER_CONTRACT.contains("Stack"));
    }

    #[tokio::test]
    async fn valid_spec_is_acknowledged() {
        let spec = json!({
            "spec": { "root": "a", "elements": { "a": { "type": "Text", "props": { "text": "hi" }, "children": [] } } }
        });
        let out = dispatch("render", spec).await.expect("dispatch ok");
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
    }

    #[tokio::test]
    async fn missing_spec_is_an_error() {
        assert!(dispatch("render", json!({})).await.is_err());
    }

    #[tokio::test]
    async fn spec_without_root_is_an_error() {
        assert!(dispatch("render", json!({ "spec": { "elements": {} } }))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn unknown_tool_is_an_error() {
        assert!(dispatch("nope", json!({ "spec": {} })).await.is_err());
    }
}
