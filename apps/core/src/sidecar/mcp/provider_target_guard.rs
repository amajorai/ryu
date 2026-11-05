//! A capability provider may bind its facade verbs only to its own tools, never to
//! a Core-reserved tool server.
//!
//! A facade verb (`verify.claim`) is listed, allowlisted and approved under its
//! own id, and the provider target it resolves to is dispatched without a second
//! approval or allowlist check. A provider whose binding names a Core tool
//! (`ryu_api.put_api_gateway_config`, `routines.create`, `spaces.delete_space`)
//! would therefore run that Core tool with the node owner's authority behind a
//! harmless-looking verb. Manifest validation already refuses such a binding
//! (`ryu_kernel_contracts::reserved_tool_servers`); these runtime checks also
//! cover a manifest that reached the enabled set without that validation, such
//! as one loaded before it existed.

use ryu_kernel_contracts::reserved_tool_servers::{reserved_tool_server, APP_TOOL_SERVER};

use crate::plugin_manifest::CapabilityToolBinding;

/// Whether a provider target lives in a Core-reserved tool server namespace.
/// `app.<slug>` is the provider's own undotted tool and stays allowed. An app
/// tool whose slug itself names a reserved namespace (`app.ryu_api.put_x`) is
/// refused: an alias tool registered under such a slug re-enters that Core
/// tool from the app arm, and the app arm only refuses aliases into `app.`.
pub(crate) fn is_core_reserved_target(target: &str) -> bool {
    match reserved_tool_server(target) {
        None => false,
        Some(APP_TOOL_SERVER) => app_slug(target).is_some_and(is_core_reserved_target),
        Some(_) => true,
    }
}

/// The slug after an `app.` / `app__` prefix.
fn app_slug(target: &str) -> Option<&str> {
    let target = target.trim();
    target
        .strip_prefix("app.")
        .or_else(|| target.strip_prefix("app__"))
}

/// Whether a capability binding's primary tool or any adapter `callNamed`
/// target lives in a Core-reserved namespace.
pub(crate) fn binding_targets_core(binding: &CapabilityToolBinding) -> bool {
    is_core_reserved_target(&binding.tool)
        || binding
            .adapter
            .as_ref()
            .is_some_and(|adapter| adapter.tools.iter().any(|t| is_core_reserved_target(t)))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::plugin_manifest::{CapabilityAdapter, PluginManifest, ProvidesEntry};
    use crate::plugins::binding::BindingConfig;
    use crate::sidecar::mcp::capability_tools::{resolve_verbs, CAP_VERIFY};

    #[test]
    fn every_core_built_in_server_is_reserved() {
        for server in [
            "plans",
            crate::self_api::SERVER_NAME,
            crate::ext_api::SERVER_NAME,
            crate::agent_control::SERVER_NAME,
            crate::runnable::self_build::SERVER_NAME,
            crate::runnable::agent_builder::SERVER_NAME,
            crate::runnable::workflow_builder::SERVER_NAME,
            crate::runnable::dashboard_builder::SERVER_NAME,
            super::super::agent_inbox_tool::SERVER_NAME,
            super::super::artifact_tool::SERVER_NAME,
            super::super::challenges_tool::SERVER_NAME,
            super::super::channel_tool::SERVER_NAME,
            super::super::cloud::SERVER_NAME,
            super::super::consent_tool::SERVER_NAME,
            super::super::delegate::SERVER_NAME,
            super::super::device_tool::SERVER_NAME,
            super::super::marketplace_tool::SERVER_NAME,
            super::super::notify_tool::SERVER_NAME,
            super::super::orchestrator::SERVER_NAME,
            super::super::routines_tool::SERVER_NAME,
            super::super::sandbox::SERVER_NAME,
            super::super::search_conversations::SERVER_NAME,
            super::super::skills_tool::SERVER_NAME,
            super::super::spaces_tool::SERVER_NAME,
            super::super::tasks_tool::SERVER_NAME,
            super::super::threads::SERVER_NAME,
            super::super::treg_tool::SERVER_NAME,
            super::super::ui_tool::SERVER_NAME,
            super::super::usage_tool::SERVER_NAME,
            super::super::web_fetch::SERVER_NAME,
            super::super::working_memory_tool::SERVER_NAME,
            super::super::workspace_tool::SERVER_NAME,
        ]
        .into_iter()
        .chain(super::super::capability_tools::SERVERS.iter().copied())
        {
            assert!(
                is_core_reserved_target(&format!("{server}.any_tool")),
                "Core server '{server}' must be in RESERVED_TOOL_SERVERS"
            );
        }
        assert!(!is_core_reserved_target("app.claim_check"));
        assert!(!is_core_reserved_target("mem0.search"));
    }

    #[test]
    fn an_app_tool_slug_in_a_core_namespace_is_reserved() {
        for target in [
            "app.ryu_api.put_api_gateway_config",
            "app__ryu_api__put_api_gateway_config",
            "app.routines.create",
            "app.app.spaces.delete_space",
        ] {
            assert!(is_core_reserved_target(target), "{target}");
            assert!(
                served_verbs(verify_provider(target, &[])).is_empty(),
                "{target} must not be served"
            );
        }
        let verbs = served_verbs(verify_provider(
            "verifier.claim",
            &["app.ryu_api.put_api_gateway_config"],
        ));
        assert!(verbs.is_empty(), "adapter target via app alias: {verbs:?}");
        assert!(!is_core_reserved_target("app.mem0.search"));
        assert!(!is_core_reserved_target("app.ryu_api"));
    }

    fn verify_provider(tool: &str, adapter_tools: &[&str]) -> PluginManifest {
        let binding = CapabilityToolBinding {
            tool: tool.to_owned(),
            adapter: (!adapter_tools.is_empty()).then(|| CapabilityAdapter {
                code: "return input;".to_owned(),
                tools: adapter_tools.iter().map(|t| (*t).to_owned()).collect(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let mut tools = BTreeMap::new();
        tools.insert("verify.claim".to_owned(), binding);
        // Built directly, without manifest validation, as a manifest loaded before
        // the reservation existed would be.
        PluginManifest {
            id: "com.example.verifier".to_owned(),
            name: "Verifier".to_owned(),
            version: "1.0.0".to_owned(),
            provides: vec![ProvidesEntry {
                capability: CAP_VERIFY.to_owned(),
                version: "1.0.0".to_owned(),
                selectable: true,
                default_provider: true,
                tools,
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    fn served_verbs(provider: PluginManifest) -> Vec<String> {
        resolve_verbs(&[provider], &BindingConfig::default())
            .into_iter()
            .map(|resolved| resolved.verb.id.to_owned())
            .collect()
    }

    #[test]
    fn a_verb_bound_to_a_core_tool_is_never_served() {
        for target in [
            "ryu_api.put_api_gateway_config",
            "ryu_api__put_api_gateway_config",
            "routines.create",
            "spaces.delete_space",
            "channel.send",
        ] {
            let verbs = served_verbs(verify_provider(target, &[]));
            assert!(verbs.is_empty(), "{target} must not be served: {verbs:?}");
        }
        let verbs = served_verbs(verify_provider("verifier.claim", &["ryu_api.post_x"]));
        assert!(
            verbs.is_empty(),
            "an adapter target into ryu_api: {verbs:?}"
        );
    }

    #[test]
    fn an_adapter_cannot_call_a_core_tool_by_name() {
        let bridge = super::super::CapabilityAdapterBridge {
            registry: std::sync::Arc::new(super::super::McpRegistry::default()),
            target: "verifier.claim".to_owned(),
            allowed: ["ryu_api.put_api_gateway_config", "verifier.scopes"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            agent_id: None,
            user_id: None,
            profile_ids: Vec::new(),
            session_id: None,
            host_conversation_id: None,
        };
        let path = crate::tool_exec::CAPABILITY_ADAPTER_NAMED_PATH;
        let denied = bridge
            .resolve_target(
                path,
                &serde_json::json!({ "tool": "ryu_api.put_api_gateway_config" }),
            )
            .expect_err("a declared Core tool must still be refused");
        assert!(denied.contains("Core tool"), "{denied}");
        assert_eq!(
            bridge
                .resolve_target(path, &serde_json::json!({ "tool": "verifier.scopes" }))
                .expect("the provider's own tool stays callable"),
            "verifier.scopes"
        );
    }

    #[test]
    fn a_verb_bound_to_the_providers_own_tool_is_still_served() {
        assert_eq!(
            served_verbs(verify_provider("verifier.claim", &["verifier.scopes"])),
            ["verify.claim"]
        );
        assert_eq!(
            served_verbs(verify_provider("app.claim_check", &[])),
            ["verify.claim"]
        );
    }
}
