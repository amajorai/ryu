//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;
use crate::plugin_manifest::schema::RunnableEntry as PmRunnableEntry;
use crate::runnable::RunnableKind;

fn self_build_widget_manifest() -> PluginManifest {
    PluginManifest {
        id: "com.example.resolvedesk".to_owned(),
        name: "ResolveDesk".to_owned(),
        version: "0.1.0".to_owned(),
        runnables: vec![
            PmRunnableEntry {
                id: "resolvedesk.render".to_owned(),
                name: "render".to_owned(),
                kind: RunnableKind::Tool,
                config: Some(serde_json::json!({
                    "slug": "resolvedesk.render",
                    "backend": "inline_js",
                    "code": "return { structuredContent: { answer: 'ok' } };",
                    "description": "Answer a support question",
                    "input_schema": {
                        "type": "object",
                        "properties": { "message": { "type": "string" } },
                        "required": ["message"]
                    },
                    "widget": true,
                    "widget_accessible": true,
                    "invoking": "Checking…",
                    "invoked": "Ready"
                })),
            },
            PmRunnableEntry {
                id: "resolvedesk.handoff".to_owned(),
                name: "handoff".to_owned(),
                kind: RunnableKind::Tool,
                config: Some(serde_json::json!({
                    "slug": "resolvedesk.handoff",
                    "backend": "inline_js",
                    "code": "return { isError: false };",
                    "description": "Create a human handoff",
                    "widget": false,
                    "widget_accessible": true
                })),
            },
        ],
        permission_grants: vec!["tool:execute".to_owned(), WIDGET_RENDER_GRANT.to_owned()],
        contributes: Some(crate::plugin_manifest::Contributes {
            widgets: vec![crate::plugin_manifest::WidgetContribution {
                tool_id: "resolvedesk.render".to_owned(),
                uri: "ui://widget/resolvedesk.html".to_owned(),
                ui_entry: Some("src/widget.html".to_owned()),
                mime: "text/html+skybridge".to_owned(),
                default_display_mode: "inline".to_owned(),
            }],
            ..Default::default()
        }),
        ..Default::default()
    }
}

#[test]
fn self_build_widget_metadata_joins_tool_and_widget_declarations() {
    let manifest = self_build_widget_manifest();
    let metadata = self_build_tool_metadata(&[manifest], "resolvedesk.render")
        .expect("the manifest tool should be discoverable");

    assert_eq!(
        metadata.description.as_deref(),
        Some("Answer a support question")
    );
    assert_eq!(
        metadata.input_schema.as_ref().map(Value::is_object),
        Some(true)
    );
    let binding = metadata.widget.expect("render tool should bind a widget");
    assert_eq!(binding.template_uri, "ui://widget/resolvedesk.html");
    assert!(binding.widget_accessible);
    assert_eq!(binding.invoking_label.as_deref(), Some("Checking…"));
    assert_eq!(binding.invoked_label.as_deref(), Some("Ready"));
}

#[tokio::test]
async fn self_build_widget_reads_packed_html_from_the_plugin_store() {
    let store = std::sync::Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    store
        .insert("com.example.resolvedesk", "0.1.0")
        .await
        .unwrap();
    store
        .set_enabled(
            "com.example.resolvedesk",
            &["tool:execute".to_owned(), WIDGET_RENDER_GRANT.to_owned()],
        )
        .await
        .unwrap();
    store
        .set_ui_code(
            "com.example.resolvedesk",
            Some("<!doctype html><main>ResolveDesk</main>"),
        )
        .await
        .unwrap();

    let manifests = std::sync::Arc::new(TokioRwLock::new(vec![self_build_widget_manifest()]));
    let registry = McpRegistry::empty().with_self_build(manifests, store);
    registry.register_app_tool(
        "resolvedesk.render".to_owned(),
        "resolvedesk.render".to_owned(),
        None,
    );
    registry.register_app_tool(
        "resolvedesk.handoff".to_owned(),
        "resolvedesk.handoff".to_owned(),
        None,
    );

    assert_eq!(
        registry.widget_accessible_tool_ids("resolvedesk").await,
        vec!["resolvedesk.handoff".to_owned()]
    );

    let tools = registry.list_all_tools().await;
    let tool = tools
        .iter()
        .find(|candidate| candidate.id == "resolvedesk.render")
        .expect("enabled app tool should be listed");
    assert_eq!(
        tool.description.as_deref(),
        Some("Answer a support question")
    );
    assert!(tool.input_schema.is_some());
    assert!(tool.widget.is_some());

    let promotion = registry
        .resolve_widget_promotion("resolvedesk.render")
        .await;
    assert!(matches!(promotion, WidgetPromotion::Allow(_)));
    let resource = registry
        .widget_resource("resolvedesk", "ui://widget/resolvedesk.html")
        .await
        .expect("packed widget HTML should resolve from the plugin store");
    assert_eq!(resource.mime_type, "text/html+skybridge");
    assert!(resource.html.contains("ResolveDesk"));
}

// ── the approval gate never fires for a skill CATALOG id ───────────────────
//
// `skills.<slug>` rows are discovery metadata merged into `tool_search`, not
// functions. Gating one queued a human approval whose only possible outcome was
// the dispatch fallthrough's refusal. These pin both halves: the classification
// that skips the gate, and the fact that the three real `skills.*` tools are
// still classified as gateable.
