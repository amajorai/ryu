//! Tool id parsing, data flow and org tool policy.
// test-exempt: moved verbatim out of sidecar/mcp/mod.rs; covered by the McpRegistry tests under sidecar/mcp/tests/.

use crate::sidecar::mcp::*;

impl McpRegistry {
    /// Fully-qualified id for a server's tool.
    pub(in crate::sidecar::mcp) fn tool_id(server: &str, tool: &str) -> String {
        format!("{server}{TOOL_ID_SEP}{tool}")
    }

    /// Split a fully-qualified tool id back into `(server, tool)`.
    pub fn split_tool_id(id: &str) -> Option<(&str, &str)> {
        id.split_once(TOOL_ID_SEP)
            .or_else(|| id.split_once(LEGACY_TOOL_ID_SEP))
    }

    /// Normalize a tool id against the live server registry before dispatch.
    ///
    /// The global [`canonical_tool_id`] helper can normalize the reserved
    /// namespaces, but it cannot tell whether `io.github.acme/files__read` is a
    /// legacy id for the dotted server `io.github.acme/files` or a canonical id
    /// whose tool name contains `__`. A registered server is the authoritative
    /// answer for that ambiguity, so prefer an exact legacy server prefix here.
    pub(crate) fn canonical_tool_id_for_registry(&self, id: &str) -> String {
        if let Some((server, tool)) = id.split_once(LEGACY_TOOL_ID_SEP) {
            let registered = self
                .servers
                .read()
                .expect("mcp servers RwLock poisoned")
                .contains_key(server);
            if registered {
                return format!("{server}{TOOL_ID_SEP}{tool}");
            }
        }
        canonical_tool_id(id)
    }

    /// Split a canonical tool id using the longest registered server prefix.
    ///
    /// Server names are allowed to contain dots (`io.github.acme/files` is a
    /// common catalog shape), so first-dot splitting is only a fallback for the
    /// reserved namespaces and for callers with no matching live server.
    pub(crate) fn split_registered_tool_id<'a>(&self, id: &'a str) -> Option<(&'a str, &'a str)> {
        let server_len = self
            .servers
            .read()
            .expect("mcp servers RwLock poisoned")
            .keys()
            .filter_map(|server| {
                id.strip_prefix(server.as_str())
                    .and_then(|rest| rest.strip_prefix(TOOL_ID_SEP))
                    .map(|_| server.len())
            })
            .max();

        server_len
            .map(|len| (&id[..len], &id[len + TOOL_ID_SEP.len()..]))
            .or_else(|| Self::split_tool_id(id))
    }

    /// The exfiltration guard's view of one call on its resolved gate id: whether
    /// it reads private data and whether it can send data out (see
    /// [`crate::approvals::exfiltration_guard`]). `tool_id` is the id the program
    /// called and `gate_id` its resolved target (they differ for an app alias);
    /// both must already be canonical for the registry
    /// ([`Self::canonical_tool_id_for_registry`]), so a legacy `__` alias target
    /// is classified like its dotted id. `annotations` and `connection_action` are
    /// the metadata the approval gate already resolved.
    pub(crate) async fn data_flow_for_tool(
        &self,
        tool_id: &str,
        gate_id: &str,
        annotations: Option<&Value>,
        connection_action: crate::identity::ConnectionAction,
    ) -> crate::approvals::exfiltration_guard::DataFlow {
        use crate::approvals::exfiltration_guard::{
            classify_data_flow, AppBackendKind, ToolFlowFacts, ToolOrigin,
        };
        use crate::plugin_manifest::schema::ToolBackend;

        // A provider tool called directly reaches what its verb reaches (a memory
        // provider's search returns private memory, a screen-capture provider's
        // unbound read tools return the screen), whether or not its provider is
        // the selected one. Read from the enabled manifests; when the enabled set
        // cannot be read, fall back to every loaded manifest (fail closed).
        let provided_verbs = {
            let manifests = match self.enabled_manifests().await {
                Some(enabled) => enabled,
                None => match self.self_build_manifests.as_ref() {
                    Some(loaded) => loaded.read().await.clone(),
                    None => Vec::new(),
                },
            };
            crate::approvals::provider_tool_flow::provider_flow_for(&manifests, &[tool_id, gate_id])
        };

        let origin = if gate_id.starts_with("composio.") {
            ToolOrigin::Composio
        } else if self.external_mcp_server_for(gate_id).is_some() {
            ToolOrigin::ExternalMcp {
                connection_backed: self.is_connection_backed_tool(gate_id),
            }
        } else if is_app_tool_id(gate_id)
            || self
                .app_tools
                .lock()
                .map(|tools| tools.iter().any(|tool| tool.id == gate_id))
                .unwrap_or(false)
        {
            match self
                .resolve_app_tool_backend(gate_id)
                .await
                .map(|resolved| resolved.backend)
            {
                Some(ToolBackend::Http { url, method, .. }) => {
                    ToolOrigin::AppBackend(AppBackendKind::Http {
                        core_loopback: url.trim_start().starts_with("core:"),
                        get: method.eq_ignore_ascii_case("GET"),
                    })
                }
                Some(ToolBackend::Command { .. }) => {
                    ToolOrigin::AppBackend(AppBackendKind::Command)
                }
                Some(ToolBackend::InlineJs { .. }) => {
                    ToolOrigin::AppBackend(AppBackendKind::InlineJs)
                }
                Some(ToolBackend::Alias { .. }) | None => ToolOrigin::BuiltIn,
            }
        } else {
            ToolOrigin::BuiltIn
        };
        classify_data_flow(
            gate_id,
            &ToolFlowFacts {
                origin,
                annotations,
                connection_action,
                provided_verbs,
            },
        )
    }

    /// The external MCP server that serves `tool_id`, if it is one. Built-in
    /// tool namespaces (`plans`, `skills`, `ryu_api`, ...) return `None`.
    pub(in crate::sidecar::mcp) fn external_mcp_server_for<'a>(
        &self,
        tool_id: &'a str,
    ) -> Option<&'a str> {
        let (server, _) = self.split_registered_tool_id(tool_id)?;
        self.servers
            .read()
            .ok()
            .is_some_and(|servers| servers.contains_key(server))
            .then_some(server)
    }

    /// Enforce the bound organization's tool policy (C2: `allowedTools`,
    /// `deniedTools`, `allowedMcpServers`) as resolved for this call's verified
    /// principal: the authenticated HTTP caller, else the host conversation's
    /// owner (never the client-supplied `user_id`). A call with no resolvable
    /// principal gets the node credential's org/team rules. A no-op on unbound
    /// nodes; a denial is audited and can never be converted into an approval.
    pub(in crate::sidecar::mcp) async fn enforce_org_tool_policy(
        &self,
        tool_id: &str,
        host_conversation_id: Option<&str>,
    ) -> Result<()> {
        if crate::sidecar::control_plane::registered_node().is_none() {
            return Ok(());
        }
        let principal =
            ToolPrincipal::resolve_optional(self.conversations.as_ref(), host_conversation_id)
                .await;
        let user_id = match &principal {
            ToolPrincipal::Owned { user_id, .. } => Some(user_id.as_str()),
            ToolPrincipal::Unrestricted | ToolPrincipal::Unresolved => None,
        };
        crate::org_policy::check_tool_for_caller(
            user_id,
            tool_id,
            self.external_mcp_server_for(tool_id),
        )
        .await
        .map_err(|reason| anyhow!(reason))
    }

    /// Whether a tool uses an account-backed connection and therefore needs the
    /// connection-level approval ceiling before a non-read action can proceed.
    pub(in crate::sidecar::mcp) fn is_connection_backed_tool(&self, tool_id: &str) -> bool {
        if tool_id.starts_with("composio.") {
            return true;
        }
        let Some((server, _)) = self.split_registered_tool_id(tool_id) else {
            return false;
        };
        self.servers
            .read()
            .expect("mcp servers RwLock poisoned")
            .get(server)
            .is_some_and(|config| config.auth.is_some())
    }
}
