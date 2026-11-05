//! The Core built-in tool server namespaces that a plugin app tool must never
//! claim as its native id.
//!
//! A declarative tool plugin may register under its native dotted id
//! (`exa.search`) instead of `app.<slug>` (see [`super::app_tool_registered_id`]).
//! The no-gate dispatcher routes a registered native app tool BEFORE it reaches
//! the per-server built-in arms (`channel`, `spaces`, `threads`, …), so a plugin
//! slug such as `channel.send` would otherwise run plugin code for an agent call
//! meant for Core. Every server segment listed here is therefore reserved:
//! registration keeps such a slug under `app.<slug>`, refuses a raw registration,
//! and dispatch never treats a reserved id as a native app tool.

/// Server segments Core dispatches itself. Kept as one list so registration,
/// manifest id derivation, and dispatch share the same reservation.
pub(crate) const BUILTIN_SERVER_NAMES: &[&str] = &[
    "plans",
    crate::self_api::SERVER_NAME,
    crate::ext_api::SERVER_NAME,
    super::cloud::SERVER_NAME,
    super::sandbox::SERVER_NAME,
    super::notify_tool::SERVER_NAME,
    super::device_tool::SERVER_NAME,
    super::artifact_tool::SERVER_NAME,
    super::spaces_tool::SERVER_NAME,
    super::working_memory_tool::SERVER_NAME,
    super::ui_tool::SERVER_NAME,
    super::consent_tool::SERVER_NAME,
    super::tasks_tool::SERVER_NAME,
    super::workspace_tool::SERVER_NAME,
    super::routines_tool::SERVER_NAME,
    super::channel_tool::SERVER_NAME,
    super::agent_inbox_tool::SERVER_NAME,
    super::search_conversations::SERVER_NAME,
    crate::agent_control::SERVER_NAME,
    super::threads::SERVER_NAME,
    super::delegate::SERVER_NAME,
    super::orchestrator::SERVER_NAME,
    super::skills_tool::SERVER_NAME,
    super::usage_tool::SERVER_NAME,
    super::treg_tool::SERVER_NAME,
    super::challenges_tool::SERVER_NAME,
    super::marketplace_tool::SERVER_NAME,
    super::web_fetch::SERVER_NAME,
    crate::runnable::self_build::SERVER_NAME,
    crate::runnable::agent_builder::SERVER_NAME,
    crate::runnable::workflow_builder::SERVER_NAME,
    crate::runnable::dashboard_builder::SERVER_NAME,
];

/// Whether `server` is a Core built-in tool server segment.
pub(crate) fn is_builtin_server(server: &str) -> bool {
    BUILTIN_SERVER_NAMES.contains(&server)
}

/// Whether a canonical tool id lives in a Core built-in server namespace.
pub(crate) fn is_builtin_server_id(id: &str) -> bool {
    super::McpRegistry::split_tool_id(id).is_some_and(|(server, _)| is_builtin_server(server))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::mcp::{AppToolBackendTag, McpRegistry, RegistryTool};

    #[test]
    fn reserves_every_built_in_dispatch_server() {
        for server in [
            "channel", "spaces", "threads", "routines", "notify", "cloud", "sandbox",
        ] {
            assert!(is_builtin_server(server), "{server} must be reserved");
        }
        assert!(is_builtin_server_id("channel.send"));
        assert!(is_builtin_server_id("spaces.get_page"));
    }

    #[test]
    fn leaves_plugin_and_app_namespaces_open() {
        for id in [
            "exa.search",
            "spider.crawl",
            "rtk.run",
            "app.channel.send",
            "weather",
        ] {
            assert!(!is_builtin_server_id(id), "{id} must not be reserved");
        }
    }

    fn tool_cfg(cfg: serde_json::Value) -> crate::plugin_manifest::schema::ToolConfig {
        serde_json::from_value(cfg).unwrap()
    }

    fn registered_app_tool_ids(registry: &McpRegistry) -> Vec<String> {
        registry
            .app_tools
            .lock()
            .unwrap()
            .iter()
            .map(|tool| tool.id.clone())
            .collect()
    }

    #[test]
    fn plugin_slug_in_a_built_in_namespace_stays_under_the_app_prefix() {
        let cfg = tool_cfg(serde_json::json!({
            "slug": "channel.send",
            "backend": "http",
            "url": "https://plugin.example/send",
        }));
        assert_eq!(
            super::super::app_tool_registered_id(&cfg),
            "app.channel.send"
        );

        let native = tool_cfg(serde_json::json!({
            "slug": "exa.search",
            "backend": "http",
            "url": "https://api.exa.ai/search",
        }));
        assert_eq!(super::super::app_tool_registered_id(&native), "exa.search");
    }

    #[test]
    fn registration_refuses_a_built_in_server_id_but_keeps_plugin_ids() {
        let registry = McpRegistry::empty();
        registry.register_app_tool_tagged(
            "channel.send".into(),
            "channel.send".into(),
            None,
            Some(AppToolBackendTag::Http),
        );
        registry.register_app_tool_tagged(
            "spaces__get_page".into(),
            "spaces.get_page".into(),
            None,
            Some(AppToolBackendTag::Http),
        );
        registry.register_app_tool_tagged(
            "exa.search".into(),
            "exa.search".into(),
            None,
            Some(AppToolBackendTag::Http),
        );
        let ids = registered_app_tool_ids(&registry);
        assert!(!ids.iter().any(|id| id == "channel.send"), "got {ids:?}");
        assert!(!ids.iter().any(|id| id == "spaces.get_page"), "got {ids:?}");
        assert!(ids.iter().any(|id| id == "exa.search"), "got {ids:?}");
    }

    #[tokio::test]
    async fn a_stale_app_tool_record_cannot_shadow_a_built_in_tool() {
        let registry = McpRegistry::empty();
        registry.register_test_app_tool_descriptor(RegistryTool::candidate(
            "channel.send",
            super::super::APP_TOOL_SERVER,
            "channel.send",
        ));
        let err = registry
            .call_tool_with_identity_no_gate(
                None,
                "channel.send",
                serde_json::json!({}),
                None,
                None,
                &[],
                None,
                None,
            )
            .await
            .expect_err("missing arguments must fail in the built-in channel arm");
        let message = err.to_string();
        assert!(
            message.contains("missing required string argument 'webhook_url'"),
            "channel.send must reach the built-in channel tool, got: {message}"
        );
    }
}
