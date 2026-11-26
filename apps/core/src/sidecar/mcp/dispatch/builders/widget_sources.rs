//! Write-time check on the widget sources the dashboard builder is asked to
//! store (security finding CE-7).
//!
//! A widget's source runs again on every refresh with nobody approving the
//! run, so a source may only read. Core refuses anything else when the
//! Dashboards app asks for the provider call
//! (`server::provider_router::read_only`); this check gives the model the same
//! answer at once, before a widget that could never refresh is stored. It uses
//! the same rule, [`crate::connection_policy::require_unattended_read`].

use serde_json::{json, Value};

/// The argument names under which the builder tools take widget objects
/// (`create_dashboard` and `configure_dashboard`).
const WIDGET_LISTS: [&str; 2] = ["widgets", "widgets_upsert"];

/// The source type whose action runs on a connected account.
const COMPOSIO_SOURCE: &str = "composio";

/// The soft, model-readable refusal for builder `arguments` that carry a widget
/// source which is not a plain read, or `None` when every source may be stored.
/// The shape matches the builder's own soft errors, so the model can read the
/// reason and pick a read action in the same turn.
///
/// Only a source that names an action is judged here. A malformed widget (no
/// source, no action, a source type the app does not know) goes on to the
/// Dashboards app, which validates the shape.
pub(super) fn refusal(arguments: &Value) -> Option<Value> {
    for list in WIDGET_LISTS {
        let Some(widgets) = arguments.get(list).and_then(Value::as_array) else {
            continue;
        };
        for (index, widget) in widgets.iter().enumerate() {
            let Some(source) = widget.get("source") else {
                continue;
            };
            let is_composio = source
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind.trim().eq_ignore_ascii_case(COMPOSIO_SOURCE));
            if !is_composio {
                continue;
            }
            let Some(action) = source.get("action").and_then(Value::as_str) else {
                continue;
            };
            if let Err(reason) = crate::connection_policy::require_unattended_read(
                crate::connection_policy::COMPOSIO_PROVIDER,
                action,
            ) {
                return Some(json!({
                    "success": false,
                    "error": format!("widget #{index}: {reason}"),
                }));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::mcp::McpRegistry;

    fn widget(source: Value) -> Value {
        json!({ "kind": "table", "title": "Inbox", "source": source })
    }

    fn composio(action: &str) -> Value {
        widget(json!({ "type": "composio", "action": action, "args": { "to": "a@example.com" } }))
    }

    #[test]
    fn a_write_delete_or_unknown_action_is_refused_under_both_argument_names() {
        for action in [
            "GMAIL_SEND_EMAIL",
            "SLACK_SEND_MESSAGE",
            "GITHUB_DELETE_A_REPOSITORY",
            "GITHUB_STAR_A_REPOSITORY",
        ] {
            for list in WIDGET_LISTS {
                let refused = refusal(&json!({ "name": "Home", list: [composio(action)] }))
                    .unwrap_or_else(|| panic!("{action} under {list} must be refused"));
                assert_eq!(refused["success"], false, "{refused}");
                let reason = refused["error"].as_str().expect("a reason");
                assert!(reason.starts_with("widget #0: "), "{reason}");
                assert!(reason.contains(action), "{reason}");
                assert!(reason.contains("only run actions that read"), "{reason}");
            }
        }
    }

    #[test]
    fn the_refusal_names_the_widget_that_caused_it() {
        let arguments = json!({ "dashboard_id": "d1", "widgets_upsert": [
            composio("GMAIL_FETCH_EMAILS"),
            widget(json!({ "type": "static", "data": { "send": "email" } })),
            composio("GMAIL_SEND_EMAIL"),
        ] });
        let refused = refusal(&arguments).expect("the third widget writes");
        assert!(
            refused["error"]
                .as_str()
                .unwrap()
                .starts_with("widget #2: "),
            "{refused}"
        );
        // The type is matched whatever its case or padding.
        let respelled = widget(json!({ "type": " Composio ", "action": "GMAIL_SEND_EMAIL" }));
        assert!(refusal(&json!({ "widgets": [respelled] })).is_some());
    }

    #[test]
    fn reads_and_other_source_types_may_be_stored() {
        let arguments = json!({ "name": "Home", "widgets": [
            composio("GMAIL_FETCH_EMAILS"),
            composio("GITHUB_LIST_REPOSITORY_ISSUES"),
            widget(json!({ "type": "static", "data": 1 })),
            widget(json!({ "type": "http", "url": "https://example.com/send_email.json" })),
            // Malformed entries are the app's to refuse.
            widget(json!({ "type": "composio" })),
            json!({ "kind": "text" }),
            json!("not a widget"),
        ] });
        assert_eq!(refusal(&arguments), None);
        assert_eq!(refusal(&json!({ "dashboard_id": "d1" })), None);
        assert_eq!(refusal(&json!({ "widgets": "not a list" })), None);
    }

    /// The builder arm itself: a write source is answered before the call
    /// reaches the Dashboards app. No capability consumer is wired here, so a
    /// call that passes the check ends in the arm's own wiring error instead.
    #[tokio::test]
    async fn the_builder_tools_refuse_a_write_source_before_the_app_is_asked() {
        let registry = McpRegistry::empty();
        let call = |tool: &'static str, arguments: Value| {
            let registry = &registry;
            async move {
                registry
                    .call_tool_with_identity_no_gate_scoped(
                        None,
                        tool,
                        arguments,
                        None,
                        None,
                        &[],
                        None,
                        None,
                        None,
                        None,
                        false,
                    )
                    .await
            }
        };
        for (tool, list) in [
            ("dashboard_builder.create_dashboard", "widgets"),
            ("dashboard_builder.configure_dashboard", "widgets_upsert"),
        ] {
            let write = json!({ "name": "Home", "dashboard_id": "d1", list: [composio("GMAIL_SEND_EMAIL")] });
            let refused = call(tool, write)
                .await
                .unwrap_or_else(|error| panic!("{tool}: expected a soft refusal, got {error:#}"));
            assert_eq!(refused["success"], false, "{tool}: {refused}");
            assert!(
                refused["error"]
                    .as_str()
                    .is_some_and(|reason| reason.contains("GMAIL_SEND_EMAIL")),
                "{tool}: {refused}"
            );

            let read = json!({ "name": "Home", "dashboard_id": "d1", list: [composio("GMAIL_FETCH_EMAILS")] });
            match call(tool, read).await {
                Ok(value) => assert!(
                    !value.to_string().contains("only run actions that read"),
                    "{tool}: {value}"
                ),
                Err(error) => assert!(
                    !error.to_string().contains("only run actions that read"),
                    "{tool}: {error:#}"
                ),
            }
        }
    }
}
