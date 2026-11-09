//! Namespace ownership for native dotted app-tool ids.
//!
//! A declarative tool plugin may register a dotted slug under its native id
//! (`exa.search`), see [`super::app_tool_registered_id`]. The slug's server
//! segment is chosen by the manifest author, so it proves nothing about which MCP
//! server the plugin speaks for. A Community plugin declaring
//! `github.create_issue` must not:
//!
//! - intercept calls meant for the user's own `github` MCP server (a registered
//!   app tool would otherwise win over the same-named server at dispatch), or
//! - read vault values bound to that server (`SecretBinding::Mcp("github")`), which
//!   are documented to narrow a value to one exact server identity.
//!
//! A plugin owns a namespace only when its manifest is the exact compiled Core
//! copy, or when the live MCP server of that name is registered to that plugin.

use crate::plugin_manifest::PluginManifest;

use super::McpRegistry;

impl McpRegistry {
    /// Whether `manifest`'s plugin owns the tool namespace `server`.
    pub(super) fn plugin_owns_tool_namespace(
        &self,
        manifest: &PluginManifest,
        server: &str,
    ) -> bool {
        if server.is_empty() {
            return false;
        }
        let owns_registered_server = self
            .servers
            .read()
            .ok()
            .and_then(|servers| {
                servers
                    .get(server)
                    .map(|cfg| cfg.owner_plugin_id.as_deref() == Some(manifest.id.as_str()))
            })
            .unwrap_or(false);
        owns_registered_server || crate::plugins::builtins::is_exact_compiled_manifest(manifest)
    }

    /// Whether a registered app tool `tool_id` may take the call instead of the
    /// MCP server `server`. With no server of that name configured, the app tool
    /// is the only target and keeps its native id. With one configured, only the
    /// namespace owner may shadow it; every other plugin yields to the server.
    pub(super) async fn native_app_tool_may_claim(&self, server: &str, tool_id: &str) -> bool {
        let configured = self
            .servers
            .read()
            .map(|servers| servers.contains_key(server))
            .unwrap_or(false);
        if !configured {
            return true;
        }
        self.resolve_app_tool_backend(tool_id)
            .await
            .is_some_and(|resolved| resolved.owns_namespace)
    }

    /// The vault resolution context for an app tool backend call by `plugin_id`. Its
    /// MCP identities come from [`secret_mcp_ids`], so a plugin that does not own
    /// `server` never sees values bound to that server.
    pub(super) async fn app_tool_secret_context(
        &self,
        host_conversation_id: Option<&str>,
        plugin_id: &str,
        owns_namespace: bool,
        server: &str,
    ) -> crate::plugin_secrets::SecretResolutionContext {
        self.secret_resolution_context(
            host_conversation_id,
            secret_mcp_ids(plugin_id, server, owns_namespace),
        )
        .await
    }

    /// Whether a call to `tool_id` is served by a registered app tool's manifest
    /// backend, judged exactly as dispatch judges it: the id must be a registered
    /// app tool, and a native dotted id must not yield to a configured MCP server
    /// it does not own. Sibling paths that bind or gate the implementation behind
    /// an id (verified-plan hashing, approval targets) use this so they always
    /// describe the implementation that actually runs.
    pub(super) async fn app_tool_serves_call(&self, tool_id: &str) -> bool {
        let registered = self
            .app_tools
            .lock()
            .map(|tools| tools.iter().any(|item| item.id == tool_id))
            .unwrap_or(false);
        if !registered {
            return false;
        }
        let Some((server, _)) = self.split_registered_tool_id(tool_id) else {
            return true;
        };
        server == super::APP_TOOL_SERVER || self.native_app_tool_may_claim(server, tool_id).await
    }
}

/// The MCP identities whose bound vault values an app tool's backend may read:
/// always its own plugin id, plus the tool's server segment only when the plugin
/// owns that namespace.
pub(super) fn secret_mcp_ids(plugin_id: &str, server: &str, owns_namespace: bool) -> Vec<String> {
    let mut ids = vec![plugin_id.to_owned()];
    if owns_namespace && server != plugin_id {
        ids.push(server.to_owned());
    }
    ids
}

#[cfg(test)]
#[path = "app_tool_namespace_tests.rs"]
mod tests;
