//! Secret resolution context and command workspace roots.
// test-exempt: moved verbatim out of sidecar/mcp/mod.rs; covered by the McpRegistry tests under sidecar/mcp/tests/.

use crate::sidecar::mcp::*;

impl McpRegistry {
    /// Build the secret-resolution context for one tool dispatch from the
    /// current registered node and the server-derived owning conversation.
    /// `user_id` is intentionally never taken from the legacy client-supplied
    /// Composio selector; on a bound node it comes only from conversation
    /// tenancy metadata.
    ///
    /// Boxed at this boundary: three call sites sit inside the dispatch future
    /// (`call_tool_with_identity_no_gate_scoped_inner`), whose debug-build poll
    /// frame must keep fitting an ordinary 2 MiB worker stack
    /// (`honcho_registry_runtime_test`). Inlining this lookup's state there costs
    /// each call site a copy of it.
    pub(in crate::sidecar::mcp) fn secret_resolution_context<'a>(
        &'a self,
        host_conversation_id: Option<&'a str>,
        mcp_ids: Vec<String>,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = crate::plugin_secrets::SecretResolutionContext>
                + Send
                + 'a,
        >,
    > {
        Box::pin(self.secret_resolution_context_unboxed(host_conversation_id, mcp_ids))
    }

    async fn secret_resolution_context_unboxed(
        &self,
        host_conversation_id: Option<&str>,
        mcp_ids: Vec<String>,
    ) -> crate::plugin_secrets::SecretResolutionContext {
        let node = crate::sidecar::control_plane::registered_node();
        let node_id = node
            .as_ref()
            .map(|registered| registered.node_id.clone())
            .unwrap_or_else(crate::server::agent_sync::local_node_id);
        let org_id = node.as_ref().map(|registered| registered.org.id.clone());
        let mut team_id = node
            .as_ref()
            .and_then(|registered| registered.team_id.clone());
        let mut user_id = None;

        if let (Some(conversations), Some(conversation_id)) = (
            self.conversations.as_ref(),
            host_conversation_id.filter(|id| !id.is_empty()),
        ) {
            if let Ok(Some(meta)) = conversations.get_access_meta(conversation_id).await {
                user_id = meta.owner_user_id;
                team_id = meta.team_id.or(team_id);
            }
        }

        // A conversationless dispatch from a verified member (network `/mcp`,
        // REST tool calls, app tools) resolves as that member, so the member's
        // `user:`/`role:`/`team:` denies apply as they do in chat.
        let mut caller_unattributed = false;
        if node.is_some() && user_id.is_none() {
            match authenticated_scope::secret_owner_without_conversation(org_id.as_deref()) {
                authenticated_scope::SecretOwnerFallback::Owner(caller) => user_id = Some(caller),
                authenticated_scope::SecretOwnerFallback::FailClosed => caller_unattributed = true,
                authenticated_scope::SecretOwnerFallback::NoCaller => {}
            }
        }

        // A truly unbound node has one trusted local operator behind its node
        // bearer. Give that operator a stable pseudo-user so user-scoped local
        // secrets work even before a conversation row exists. Bound nodes never
        // use this fallback: shared scopes require a real conversation owner.
        if node.is_none() && user_id.is_none() {
            user_id = Some("local".to_owned());
        }

        // Sharing metadata is a requested scope, never proof of membership.
        // Recheck at dispatch so previously forged rows and revoked memberships
        // cannot supply another team's credentials.
        // The owner's current role feeds `role:<name>` policies, so a
        // role-bound deny applies at dispatch the same as in management.
        // Every team the owner holds in the org feeds `team:<id>` policies as
        // well, whether or not this conversation requests a team scope. A team
        // or personal node's principal lists only its own team, so the control
        // plane's complete policy team list is used. A failed lookup or an
        // incomplete list leaves those subjects unknown: resolution fails
        // closed.
        let mut context = crate::plugin_secrets::SecretResolutionContext {
            user_id,
            org_id,
            team_id,
            team_authority: None,
            node_id,
            mcp_ids,
            environment: None,
            conversation_id: host_conversation_id
                .filter(|id| !id.is_empty())
                .map(str::to_owned),
            principal_unverified: caller_unattributed,
            ..Default::default()
        };
        if let (true, Some(owner)) = (node.is_some(), context.user_id.clone()) {
            // Boxed: the lookup's state would otherwise sit inline in the dispatch
            // future, which must still run on an ordinary 2 MiB worker stack
            // (`honcho_registry_runtime_test`).
            match Box::pin(crate::sidecar::control_plane::resolve_current_authorization(&owner))
                .await
            {
                Ok(current) => {
                    context.apply_owner_principal(Some((&current.caller, current.policy_team_ids)))
                }
                Err(_) => context.apply_owner_principal(None),
            }
            if context.principal_unverified {
                tracing::warn!("secret resolution refused: owner principal unverified");
            }
        }
        context
    }

    /// Resolve the active workspace for a command tool from the server-owned
    /// conversation metadata. A command tool may not infer a workspace from a
    /// caller-provided absolute path. On an unbound local node, the Core process
    /// directory is the only available local workspace fallback; bound nodes
    /// require a conversation whose run metadata names an existing workspace.
    pub(in crate::sidecar::mcp) async fn command_workspace_root(
        &self,
        host_conversation_id: Option<&str>,
    ) -> Option<PathBuf> {
        if let (Some(store), Some(conversation_id)) = (
            self.conversations.as_ref(),
            host_conversation_id.filter(|id| !id.is_empty()),
        ) {
            if let Ok(Some(summary)) = store.get_run_summary(conversation_id).await {
                for raw in [
                    summary.worktree_path.as_deref(),
                    summary.folder_path.as_deref(),
                ]
                .into_iter()
                .flatten()
                {
                    if let Ok(path) = std::fs::canonicalize(raw) {
                        if crate::tool_exec::is_usable_workspace_root(&path) {
                            return Some(path);
                        }
                    }
                }
            }
        }

        if crate::sidecar::control_plane::registered_org().is_none()
            && host_conversation_id.is_none()
        {
            return std::env::current_dir()
                .ok()
                .and_then(|path| std::fs::canonicalize(path).ok())
                .filter(|path| crate::tool_exec::is_usable_workspace_root(path));
        }
        None
    }

    /// Whether a resolved app command is a local workspace reader. The HTTP
    /// ingress uses this to require the distinct `files:read` capability without
    /// forcing remote MCP or credential tools to request a filesystem grant.
    pub(crate) async fn command_tool_requires_files_read(&self, tool_id: &str) -> bool {
        self.resolve_app_tool_backend(tool_id)
            .await
            .is_some_and(|resolved| {
                matches!(
                    resolved.backend,
                    crate::plugin_manifest::schema::ToolBackend::Command {
                        workspace_path_args,
                        ..
                    } if !workspace_path_args.is_empty()
                )
            })
    }

    /// Resolve `secret:NAME` references in a user MCP server's headers/env
    /// immediately before a call. Unresolved references are omitted rather
    /// than sent upstream as literal text. Static values remain unchanged.
    pub(in crate::sidecar::mcp) async fn resolve_mcp_secret_config(
        &self,
        cfg: &McpServerConfig,
        context: &crate::plugin_secrets::SecretResolutionContext,
    ) -> Result<McpServerConfig> {
        let Some(store) = crate::plugin_secrets::global() else {
            let mut unresolved = cfg.clone();
            unresolved
                .headers
                .retain(|_, value| !has_vault_secret_reference(value));
            unresolved
                .env
                .retain(|_, value| !has_vault_secret_reference(value));
            return Ok(unresolved);
        };

        let mut resolved = cfg.clone();
        resolved.headers = resolve_mcp_secret_map(store, &cfg.headers, context).await?;
        resolved.env = resolve_mcp_secret_map(store, &cfg.env, context).await?;
        Ok(resolved)
    }
}
