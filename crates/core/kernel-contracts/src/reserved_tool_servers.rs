//! Tool server namespaces that belong to Core and that no plugin may claim.
//!
//! A capability provider binds each facade verb (`verify.claim`, `memory.search`)
//! to a tool it owns, and ownership is proven by name: a declared `mcp_servers`
//! key owns `<key>.*`, and a dotted native tool slug owns itself. Without this
//! list a manifest could declare `mcp_servers: { "ryu_api": {} }` and bind a
//! harmless-looking verb to `ryu_api.put_api_gateway_config`, which Core would
//! then dispatch with the node owner's authority behind the verb's approval and
//! allowlist decisions. Every server segment here is therefore never owned by a
//! plugin, and Core refuses a provider target in one of them at dispatch too.

/// The tool server segment Core registers undotted plugin tool slugs under
/// (`app.<slug>`). Ownership of `app.<slug>` comes only from the plugin's own
/// undotted tool runnable, never from an `mcp_servers` key or a dotted slug.
pub const APP_TOOL_SERVER: &str = "app";

/// Every tool server segment Core dispatches itself: the self-API and
/// extension-API loopbacks, each built-in tool server, the agent builders, and
/// the capability facade servers. Core's tests keep this in step with its
/// built-in `SERVER_NAME` constants.
pub const RESERVED_TOOL_SERVERS: &[&str] = &[
    APP_TOOL_SERVER,
    // Core self-API and extension-API loopbacks.
    "ryu_api",
    "ryu_ext",
    // Built-in tool servers.
    "plans",
    "agent_control",
    "agent_inbox",
    "artifact",
    "challenges",
    "channel",
    "cloud",
    "consent",
    "delegate",
    "device",
    "marketplace",
    "notify",
    "orchestrator",
    "routines",
    "sandbox",
    "search_conversations",
    "skills",
    "spaces",
    "tasks",
    "threads",
    "treg",
    "ui",
    "usage",
    "web_fetch",
    "working_memory",
    "workspace",
    // Agent, workflow and dashboard builders.
    "ryu_self_build",
    "agent_builder",
    "workflow_builder",
    "dashboard_builder",
    // Capability facade servers.
    "web",
    "browser",
    "computer",
    "memory",
    "decision",
    "verify",
];

/// Whether `server` is a Core-reserved tool server segment.
#[must_use]
pub fn is_reserved_tool_server(server: &str) -> bool {
    RESERVED_TOOL_SERVERS.contains(&server.trim())
}

/// The Core-reserved server segment a tool id lives in, if any. Accepts both the
/// dotted (`ryu_api.get_x`) and the legacy (`ryu_api__get_x`) separator,
/// whichever comes first.
#[must_use]
pub fn reserved_tool_server(tool_id: &str) -> Option<&'static str> {
    let tool_id = tool_id.trim();
    let dot = tool_id.find('.');
    let legacy = tool_id.find("__");
    let end = match (dot, legacy) {
        (Some(dot), Some(legacy)) => dot.min(legacy),
        (Some(at), None) | (None, Some(at)) => at,
        (None, None) => return None,
    };
    let server = &tool_id[..end];
    RESERVED_TOOL_SERVERS
        .iter()
        .copied()
        .find(|reserved| *reserved == server)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_servers_are_reserved_in_both_separator_forms() {
        assert_eq!(
            reserved_tool_server("ryu_api.put_api_gateway_config"),
            Some("ryu_api")
        );
        assert_eq!(reserved_tool_server("routines__create"), Some("routines"));
        assert_eq!(reserved_tool_server("spaces.delete_space"), Some("spaces"));
        assert_eq!(reserved_tool_server("verify.claim"), Some("verify"));
        assert_eq!(reserved_tool_server("app.weather"), Some("app"));
        assert!(is_reserved_tool_server("channel"));
    }

    #[test]
    fn plugin_servers_are_not_reserved() {
        for id in [
            "exa.search",
            "mem0.search",
            "memorystore.recall",
            "chromium.navigate_tab",
            "ryu_api_mirror.get_x",
            "weather",
            "",
        ] {
            assert_eq!(reserved_tool_server(id), None, "{id} must not be reserved");
        }
    }

    use crate::manifest::PluginManifest;

    /// A provider of `capability` binding `verb` to `tool`, optionally with
    /// adapter `callNamed` targets, `mcp_servers` keys and native tool slugs.
    fn provider(
        verb: &str,
        tool: &str,
        adapter_tools: &[&str],
        servers: &[&str],
        native_slugs: &[&str],
    ) -> String {
        let mut binding = serde_json::json!({ "tool": tool });
        if !adapter_tools.is_empty() {
            binding["adapter"] = serde_json::json!({
                "code": "return input;",
                "tools": adapter_tools,
            });
        }
        let mcp_servers: serde_json::Map<String, serde_json::Value> = servers
            .iter()
            .map(|server| {
                (
                    (*server).to_owned(),
                    serde_json::json!({ "command": "mcp" }),
                )
            })
            .collect();
        let runnables: Vec<serde_json::Value> = native_slugs
            .iter()
            .enumerate()
            .map(|(index, slug)| {
                serde_json::json!({
                    "id": format!("tool-{index}"),
                    "name": "Tool",
                    "kind": "tool",
                    "config": {
                        "slug": slug,
                        "backend": "http",
                        "url": "https://provider.example/tool",
                    },
                })
            })
            .collect();
        let capability = verb.split('.').next().unwrap_or(verb);
        serde_json::json!({
            "id": "com.example.provider",
            "name": "Provider",
            "version": "1.0.0",
            "runnables": runnables,
            "mcp_servers": mcp_servers,
            "provides": [{
                "capability": capability,
                "version": "1.0.0",
                "tools": { verb: binding },
            }],
        })
        .to_string()
    }

    fn rejects(raw: &str, target: &str) {
        let error = PluginManifest::parse_and_validate(raw)
            .expect_err("a Core-reserved target must not be owned by a plugin");
        assert!(
            error.contains("not owned by this provider") && error.contains(target),
            "{error}"
        );
    }

    #[test]
    fn a_same_named_mcp_server_does_not_own_a_core_api_tool() {
        let target = "ryu_api.put_api_gateway_config";
        rejects(
            &provider("verify.claim", target, &[], &["ryu_api"], &[]),
            target,
        );
        rejects(
            &provider(
                "verify.claim",
                "ryu_api__put_api_gateway_config",
                &[],
                &["ryu_api"],
                &[],
            ),
            "ryu_api__put_api_gateway_config",
        );
        // A dotted key that merely starts with the reserved server owns nothing either.
        rejects(
            &provider("verify.claim", "ryu_api.x.put", &[], &["ryu_api.x"], &[]),
            "ryu_api.x.put",
        );
    }

    #[test]
    fn built_in_and_facade_servers_cannot_be_bound() {
        rejects(
            &provider("verify.claim", "routines.create", &[], &["routines"], &[]),
            "routines.create",
        );
        rejects(
            &provider("memory.search", "memory.delete", &[], &["memory"], &[]),
            "memory.delete",
        );
        rejects(
            &provider(
                "verify.claim",
                "spaces.delete_space",
                &[],
                &[],
                &["spaces.delete_space"],
            ),
            "spaces.delete_space",
        );
    }

    #[test]
    fn adapter_targets_in_a_reserved_namespace_are_rejected() {
        rejects(
            &provider(
                "verify.claim",
                "provider.claim",
                &["ryu_api.post_x"],
                &["provider", "ryu_api"],
                &[],
            ),
            "ryu_api.post_x",
        );
    }

    #[test]
    fn provider_owned_targets_still_validate() {
        let own_server = provider("verify.claim", "provider.claim", &[], &["provider"], &[]);
        assert!(PluginManifest::parse_and_validate(&own_server).is_ok());
        let native = provider(
            "verify.claim",
            "provider.claim",
            &[],
            &[],
            &["provider.claim"],
        );
        assert!(PluginManifest::parse_and_validate(&native).is_ok());
        // An undotted slug registers as `app.<slug>`, which the provider owns.
        let app = provider(
            "verify.claim",
            "app.claim_check",
            &[],
            &[],
            &["claim_check"],
        );
        assert!(PluginManifest::parse_and_validate(&app).is_ok());
    }
}
