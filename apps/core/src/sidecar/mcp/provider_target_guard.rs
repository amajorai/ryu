//! A capability provider may bind its facade verbs only to its own tools, never to
//! a Core-reserved tool server nor to a tool another plugin or the user owns.
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

use super::{CapabilityAdapterBridge, McpRegistry, TOOL_ID_SEP};
use crate::plugin_manifest::CapabilityToolBinding;

impl McpRegistry {
    /// Refuse a provider target that dispatch would hand to a tool this provider
    /// does not own. Manifest validation accepts a `<key>.<tool>` target on the
    /// strength of a declared `mcp_servers` key alone, but a Community key without
    /// the approved `mcp:server` grant is never registered, so the name can resolve
    /// to the user's `mcp.json` server, another plugin's server (`gmail.send_email`)
    /// or another plugin's native app tool (`chromium.open_tab`). The facade
    /// dispatches its target with no approval and no allowlist, so only the
    /// provider's own registration may stand behind it.
    ///
    /// The lanes are checked in dispatch order: a registered app tool (native
    /// dotted or `app.<slug>`) wins over a same-named MCP server, so its owning
    /// plugin decides; otherwise the longest registered server prefix does, by its
    /// `owner_plugin_id`. A target in neither lane is refused once live manifests
    /// are wired: prefix-dispatched lanes such as `composio.<ACTION>` have no
    /// registered server, yet dispatch still runs them with the user's
    /// connections. Only a bare registry with no manifests at all lets it pass.
    pub(crate) async fn provider_target_ownership(
        &self,
        provider_id: &str,
        target: &str,
    ) -> Result<(), String> {
        let target = self.canonical_tool_id_for_registry(target);
        let is_app_tool = self
            .app_tools
            .lock()
            .map(|tools| tools.iter().any(|t| t.id == target))
            .unwrap_or(false);
        // Mirror dispatch: a registered app tool that yields to a same-named MCP
        // server it does not own is judged on the server lane.
        let server = Self::split_tool_id(&target).map_or("", |(server, _)| server);
        if is_app_tool && self.native_app_tool_may_claim(server, &target).await {
            let owner = self
                .resolve_app_tool_backend(&target)
                .await
                .map(|resolved| resolved.plugin_id);
            return match owner {
                Some(owner) if owner == provider_id => Ok(()),
                // A bare registry with no live manifests has no owner record at all.
                None if self.self_build_manifests.is_none() => Ok(()),
                Some(owner) => Err(format!(
                    "provider '{provider_id}' may not call '{target}': that app tool is owned \
                     by '{owner}', not by this provider"
                )),
                None => Err(format!(
                    "provider '{provider_id}' may not call '{target}': no enabled plugin owns \
                     that app tool"
                )),
            };
        }
        self.provider_server_ownership(provider_id, &target)
    }

    /// The MCP-server lane of [`Self::provider_target_ownership`].
    fn provider_server_ownership(&self, provider_id: &str, target: &str) -> Result<(), String> {
        let servers = self.servers.read().expect("mcp servers RwLock poisoned");
        // The longest registered prefix is the server dispatch would pick.
        let Some((server, cfg)) = servers
            .iter()
            .filter(|(name, _)| {
                target
                    .strip_prefix(name.as_str())
                    .is_some_and(|rest| rest.starts_with(TOOL_ID_SEP))
            })
            .max_by_key(|(name, _)| name.len())
        else {
            // Fail closed: a target no registered app tool or server owns may still
            // be dispatched by prefix (`composio.<ACTION>`), so it is nobody's to bind.
            if self.self_build_manifests.is_none() {
                return Ok(());
            }
            return Err(format!(
                "provider '{provider_id}' may not call '{target}': no app tool or MCP server \
                 owned by this provider serves it"
            ));
        };
        if cfg.owner_plugin_id.as_deref() == Some(provider_id) {
            return Ok(());
        }
        Err(format!(
            "provider '{provider_id}' may not call '{target}': MCP server '{server}' is not \
             owned by this provider"
        ))
    }
}

impl CapabilityAdapterBridge {
    /// [`Self::resolve_target`], then refused unless the resolved tool is owned by
    /// the providing plugin. This is what [`SandboxBridge::handle`] dispatches.
    ///
    /// [`SandboxBridge::handle`]: crate::tool_exec::SandboxBridge::handle
    pub(super) async fn resolve_owned_target(
        &self,
        path: &str,
        args: &serde_json::Value,
    ) -> Result<String, String> {
        let target = self.resolve_target(path, args)?;
        self.registry
            .provider_target_ownership(&self.provider_id, &target)
            .await?;
        Ok(target)
    }
}

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
mod tests;
