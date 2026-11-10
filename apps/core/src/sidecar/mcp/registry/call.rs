//! Verified dispatch chains and the public `call_tool` entry points.

use crate::sidecar::mcp::*;

impl McpRegistry {
    /// Resolve the exact dispatch ids a certified Safe Actions step may traverse.
    /// Capability facades are excluded because their provider selection is mutable
    /// and may execute under an agent-less adapter; a certificate must bind a
    /// concrete tool instead. App aliases are manifest-fixed and therefore safe to
    /// include as a two-id chain.
    pub(crate) async fn verified_dispatch_chain(&self, tool_id: &str) -> Result<Vec<String>> {
        let normalized = self.canonical_tool_id_for_registry(tool_id);
        let (server, _) = self
            .split_registered_tool_id(&normalized)
            .ok_or_else(|| anyhow!("malformed tool id '{tool_id}'"))?;
        if capability_tools::is_server(server) {
            return Err(anyhow!(
                "capability facade '{tool_id}' is not certifiable; choose its concrete provider tool"
            ));
        }
        let mut chain = vec![normalized.clone()];
        if is_app_tool_id(&normalized) {
            if let Some(resolved) = self.resolve_app_tool_backend(&normalized).await {
                if let crate::plugin_manifest::schema::ToolBackend::Alias { target } =
                    resolved.backend
                {
                    let target = self.canonical_tool_id_for_registry(&target);
                    if target.starts_with(APP_TOOL_PREFIX) {
                        return Err(anyhow!("nested app aliases are not certifiable"));
                    }
                    chain.push(target);
                }
            }
        }
        Ok(chain)
    }

    /// Hash the live implementation identity a verified-plan certificate relies
    /// on. The public tool descriptor alone is insufficient: two app manifests can
    /// advertise the same schema while changing inline code, URL/method/defaults,
    /// command arguments, grants, or sandbox permissions. External MCP bindings
    /// include their complete resolved server configuration; in-process tools are
    /// bound to the Core ABI because their implementation ships in this binary.
    pub(crate) async fn verified_implementation_hash(
        &self,
        tool: &RegistryTool,
        dispatch_chain: &[String],
    ) -> Result<String> {
        let mut implementations = Vec::with_capacity(dispatch_chain.len());
        for dispatch_id in dispatch_chain {
            // Bind what dispatch runs: an app tool that yields to a configured
            // server it does not own is hashed as that server (`app_tool_namespace`).
            if self.app_tool_serves_call(dispatch_id).await {
                let resolved = self
                    .resolve_app_tool_backend(dispatch_id)
                    .await
                    .ok_or_else(|| {
                        anyhow!(
                            "app tool '{dispatch_id}' has no immutable live implementation binding"
                        )
                    })?;
                let mut grants = resolved.grants.into_iter().collect::<Vec<_>>();
                grants.sort();
                implementations.push(serde_json::json!({
                    "kind": "app_manifest_backend",
                    "tool": dispatch_id,
                    "plugin_id": resolved.plugin_id,
                    "backend": resolved.backend,
                    "grants": grants,
                    "permissions": resolved.permissions,
                    "timeout_secs": resolved.timeout_secs,
                }));
                continue;
            }

            let (server, _) = self
                .split_registered_tool_id(dispatch_id)
                .ok_or_else(|| anyhow!("malformed dispatch id '{dispatch_id}'"))?;
            let config = self
                .servers
                .read()
                .map_err(|_| anyhow!("MCP registry lock poisoned"))?
                .get(server)
                .cloned();
            if let Some(config) = config {
                implementations.push(serde_json::json!({
                    "kind": "mcp_server",
                    "tool": dispatch_id,
                    "server": server,
                    "owner_plugin_id": &config.owner_plugin_id,
                    "owner_server_name": &config.owner_server_name,
                    "config": &config,
                }));
            } else {
                implementations.push(serde_json::json!({
                    "kind": "core_in_process",
                    "tool": dispatch_id,
                    "server": server,
                    "core_abi_version": env!("CARGO_PKG_VERSION"),
                }));
            }
        }
        Ok(ryu_safe_actions::sha256_canonical(&serde_json::json!({
            "registry_tool": tool,
            "dispatch_chain": dispatch_chain,
            "implementations": implementations,
            "core_abi_version": env!("CARGO_PKG_VERSION"),
        }))?)
    }

    pub(crate) async fn verified_implementation_hash_for_id(
        &self,
        tool_id: &str,
    ) -> Result<String> {
        let normalized = self.canonical_tool_id_for_registry(tool_id);
        let tool = self
            .list_all_tools()
            .await
            .into_iter()
            .find(|item| item.id == normalized)
            .ok_or_else(|| anyhow!("verified tool '{tool_id}' is no longer registered"))?;
        let dispatch_chain = self.verified_dispatch_chain(&normalized).await?;
        self.verified_implementation_hash(&tool, &dispatch_chain)
            .await
    }

    /// Invoke a registered tool by its fully-qualified id (`<server>.<tool>`),
    /// honoring the agent allowlist. Returns the MCP server's `tools/call`
    /// result. This is the entry point the chat tool loop (U12) calls.
    ///
    /// Config is extracted under the read lock then the lock is dropped before
    /// any `.await` — never hold an `RwLock` guard across an await point.
    pub async fn call_tool(
        &self,
        tool_id: &str,
        arguments: Value,
        allowlist: Option<&[String]>,
    ) -> Result<Value> {
        self.call_tool_with_user(tool_id, arguments, allowlist, None)
            .await
    }

    /// Invoke a tool with an optional caller `user_id` (Composio entity +
    /// per-user audit). [`call_tool`](Self::call_tool) delegates here with
    /// `user_id = None`. Keeping the three-arg `call_tool` shape preserves the
    /// locked P4 invoker contract; only the HTTP `call_mcp_tool` handler, which
    /// carries a `user_id` from the request body, calls this richer variant.
    ///
    /// **Composio (#474):** `composio.<slug>` ids route to
    /// [`composio::dispatch`]; the allowlist is matched on the **fully-qualified
    /// id only** (`e == tool_id`) — never bare name/server — to close the
    /// cross-plane allowlist bypass (spec security #2). `user_id` selects the
    /// Composio entity (fallback to env/`"default"` only when absent).
    pub async fn call_tool_with_user(
        &self,
        tool_id: &str,
        arguments: Value,
        allowlist: Option<&[String]>,
        user_id: Option<&str>,
    ) -> Result<Value> {
        // Configuration always requires operator review, including autonomous
        // callers and manifest aliases that otherwise use the ungated entry.
        let canonical = self.canonical_tool_id_for_registry(tool_id);
        let (target, _) = self.approval_target_for_tool(&canonical).await;
        if crate::runnable::agent_configuration_policy::requires_operator_approval(
            &self.canonical_tool_id_for_registry(&target),
        ) {
            return self
                .call_tool_with_identity(
                    None,
                    tool_id,
                    arguments,
                    allowlist,
                    user_id,
                    &[],
                    None,
                    None,
                )
                .await;
        }
        // No identity binding on the plain path (workflows/monitors/recipes have
        // no agent card). Route through the NO-GATE core: the approval gate is for
        // *agent* tool calls (the chat/ACP/PTC planes call `call_tool_with_identity`
        // directly), not for autonomous internal engine operations, which cannot
        // consume an `approval_pending` result and would stall under manual mode.
        // `host_conversation_id = None`: these callers (workflows, monitors, quests,
        // recipes) are autonomous engine operations with no host conversation, so on
        // an ORG-BOUND node they resolve to `ToolPrincipal::Unresolved` and the
        // conversation-reading tools refuse. On an unbound node they resolve to
        // `Unrestricted` — byte-identical to before. (Verified: no such caller
        // invokes a `threads.*` / `search_conversations.*` tool today.)
        // `agent_id = None`: these callers have no agent card, so per-agent record
        // state (the skill allowlist) resolves to the unscoped default — byte-
        // identical to the behaviour before that lookup existed.
        self.call_tool_with_identity_no_gate(
            None,
            tool_id,
            arguments,
            allowlist,
            user_id,
            &[],
            None,
            None,
        )
        .await
    }

    /// Invoke a tool with the caller's bound Identity Vault profiles (epic #517,
    /// Unit 6). This is the variant the chat/ACP and PTC planes use: before any
    /// dispatch, it consults the vault for the call's target domain
    /// ([`crate::identity::consult_for_tool_call`]). If a bound connection for that
    /// domain is `NEEDS_AUTH`, the call is **not** dispatched and the
    /// `__ryu_elicitation__` envelope is returned as the result (the caller pauses
    /// for login, mirroring Composio's connection-required path). If it is
    /// `AUTHENTICATED`, the credential is read through the gateway-governed
    /// `identity.read` grant + audit at the boundary (never exposed to the LLM),
    /// then dispatch proceeds.
    ///
    /// `profile_ids` empty = no vault consult (the binding is opt-in). The other
    /// arguments behave exactly as [`call_tool_with_user`](Self::call_tool_with_user).
    ///
    /// This is the **gated** entry: before the identity consult it runs the
    /// human-in-the-loop approval gate ([`crate::approvals::gate_tool_call`]). If
    /// the approval policy gates this tool, the call is **not** executed —
    /// a plain `approval_pending` result is returned (queued in the inbox) and the
    /// approval engine runs the tool on approve via
    /// [`call_tool_with_identity_no_gate`](Self::call_tool_with_identity_no_gate).
    ///
    /// `agent_id` identifies the CALLING agent so its configured `approval_tools`
    /// (policy Layer A) feed the gate; `None` (agent-less caller) skips Layer A.
    ///
    /// `host_conversation_id` is the **server-derived** conversation this agent turn
    /// runs on behalf of (the ACP bridge's `permission_scope_id`). It is lowered to a
    /// [`ToolPrincipal`] at dispatch time and is the ONLY authorization principal on
    /// the agent plane — never `user_id`, which is client-supplied and spoofable.
    pub async fn call_tool_with_identity(
        &self,
        agent_id: Option<&str>,
        tool_id: &str,
        arguments: Value,
        allowlist: Option<&[String]>,
        user_id: Option<&str>,
        profile_ids: &[String],
        session_id: Option<String>,
        host_conversation_id: Option<&str>,
    ) -> Result<Value> {
        self.call_tool_with_identity_scoped(
            agent_id,
            tool_id,
            arguments,
            allowlist,
            user_id,
            profile_ids,
            session_id,
            host_conversation_id,
            None,
            None,
        )
        .await
    }

    /// Governed tool dispatch with optional onboarding source scopes. `None`
    /// preserves ordinary agent behavior; `Some` narrows Composio accounts and
    /// conversation search to the server-validated profile selection.
    #[allow(clippy::too_many_arguments)]
    pub async fn call_tool_with_identity_scoped(
        &self,
        agent_id: Option<&str>,
        tool_id: &str,
        arguments: Value,
        allowlist: Option<&[String]>,
        user_id: Option<&str>,
        profile_ids: &[String],
        session_id: Option<String>,
        host_conversation_id: Option<&str>,
        composio_connection_scope: Option<&[crate::sidecar::adapters::ComposioConnectionBinding]>,
        conversation_scope: Option<&[String]>,
    ) -> Result<Value> {
        self.call_tool_with_identity_scoped_authorized(
            agent_id,
            tool_id,
            arguments,
            allowlist,
            user_id,
            profile_ids,
            session_id,
            host_conversation_id,
            composio_connection_scope,
            conversation_scope,
            false,
        )
        .await
    }
}

#[cfg(test)]
#[path = "../tests/verified_hash.rs"]
mod tests;
