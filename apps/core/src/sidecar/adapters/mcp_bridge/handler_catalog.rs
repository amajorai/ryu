use super::*;

impl RyuMcpHandler {
    pub(super) async fn current_identity_profiles(&self) -> Result<Vec<String>, McpError> {
        if !crate::mcp_oauth::remote_configured() {
            return Ok(self.identity_profile_ids.clone());
        }
        let unavailable = || {
            McpError::new(
                rmcp::model::ErrorCode::INTERNAL_ERROR,
                "saved agent identity binding is unavailable",
                None,
            )
        };
        match self.mcp.agent_store.as_ref() {
            Some(store) => match store.get(&self.agent_id).await.map_err(|_| unavailable())? {
                Some(record) => Ok(record.identity_profile_ids),
                None if self.identity_profile_ids.is_empty() => Ok(Vec::new()),
                None => Err(unavailable()),
            },
            None if self.identity_profile_ids.is_empty() => Ok(Vec::new()),
            None => Err(unavailable()),
        }
    }
    pub(super) async fn catalog_identity(
        &self,
    ) -> (
        Option<String>,
        Option<crate::sidecar::mcp::catalog::AgentDiscovery>,
    ) {
        use crate::sidecar::mcp::ToolPrincipal;
        let principal = if crate::sidecar::control_plane::is_managed_node()
            && crate::sidecar::control_plane::registered_org().is_none()
        {
            ToolPrincipal::Unresolved
        } else {
            match self.mcp.conversations.as_ref() {
                Some(store) => {
                    ToolPrincipal::resolve(store, self.permission_scope_id.as_deref()).await
                }
                None if crate::sidecar::control_plane::registered_org().is_none() => {
                    ToolPrincipal::Unrestricted
                }
                None => ToolPrincipal::Unresolved,
            }
        };
        let owner = match principal {
            ToolPrincipal::Unrestricted => Some("local".to_owned()),
            ToolPrincipal::Owned { user_id, .. } => Some(user_id),
            ToolPrincipal::Unresolved => None,
        };
        let identity =
            if crate::mcp_oauth::remote_configured() {
                match (owner.as_ref(), self.mcp.agent_store.as_ref()) {
                    (Some(owner), Some(store)) => store
                        .get(&self.agent_id)
                        .await
                        .ok()
                        .flatten()
                        .map(|record| crate::sidecar::mcp::catalog::AgentDiscovery {
                            owner_user_id: owner.clone(),
                            agent_id: self.agent_id.clone(),
                            profile_ids: record.identity_profile_ids,
                            allowlist: self.allowlist.clone(),
                        }),
                    _ => None,
                }
            } else {
                None
            };
        (owner, identity)
    }
    /// Build the full offered tool list (registry + Composio + meta-tools). Split
    /// out of `list_tools` so it is unit-testable without an rmcp
    /// `RequestContext` (which has no public constructor).
    ///
    /// # The registry is read HERE, per request — never snapshotted at build time
    ///
    /// This used to be a `Vec<RegistryTool>` field, resolved once in
    /// [`build_ryu_mcp_server`] and cloned into every connection. That froze the
    /// served list at router/session-construction time, and almost everything
    /// interesting registers *later*: an app's tools land on the sidecar's Healthy
    /// edge (`register_app_tool`), an MCP server's `tools/list` is fetched lazily,
    /// a plugin enabled mid-session adds rows. A client that connected first saw
    /// none of it, forever, with no error anywhere to explain why — the failure
    /// mode is silence, which is why this carries a regression test
    /// (`list_tools_reflects_registry_mutations_between_requests`) rather than a
    /// comment alone.
    ///
    /// The cost is one `tools_for_agent` pass per `tools/list`, which is what that
    /// call means. `list_tools` is already `async`, so there was never a
    /// type-level reason for the snapshot; it existed only because `connect` is
    /// sync and the field was populated to dodge that.
    ///
    /// `self.allowlist` is the *effective* list (registry grants + merged
    /// `composio.*` ids) where the pre-fix snapshot used the raw one. The merged
    /// entries live in the `composio.` namespace, which `list_all_tools` never
    /// emits — Composio is searchable-not-listed — so the filter result is
    /// unchanged.
    pub(super) async fn build_tool_list(&self) -> Vec<Tool> {
        let verified_plan_only = self.verified_plan_only().await;
        let registry_tools = if verified_plan_only {
            self.mcp
                .list_all_tools()
                .await
                .into_iter()
                .filter(|tool| tool.server == "plans")
                .collect()
        } else {
            match self.catalog_identity().await.1 {
                Some(identity) => self.mcp.tools_for_discovery_identity(&identity).await,
                None => self.mcp.tools_for_agent(self.allowlist.as_deref()).await,
            }
        };
        let registry_tools =
            crate::sidecar::mcp::filter_capability_tools(registry_tools, self.caps);
        // A conversation whose computer use runs on its session Box is never
        // offered a tool that drives the node's own display.
        let registry_tools = self
            .mcp
            .without_node_display_tools(registry_tools, self.permission_scope_id.as_deref())
            .await;
        let mut tools: Vec<Tool> = registry_tools
            .iter()
            .map(|t| {
                let schema: serde_json::Map<String, Value> = t
                    .input_schema
                    .as_ref()
                    .and_then(|v| v.as_object().cloned())
                    .unwrap_or_default();
                let mut tool = Tool::new(
                    Cow::Owned(t.id.clone()),
                    t.description.clone().unwrap_or_default(),
                    Arc::new(schema),
                );
                if let Some(desc) = &t.description {
                    tool.description = Some(Cow::Owned(desc.clone()));
                }
                tool
            })
            .collect();

        // Per-agent Composio actions (offered + callable via the merged allowlist).
        if !verified_plan_only {
            for slug in &self.composio_actions {
                tools.push(tool_from_def(&composio_def(slug)));
            }

            // Always-on discovery meta-tools.
            tools.push(tool_from_def(&tool_search_def()));
            tools.push(tool_from_def(&describe_tool_def()));

            // The question tool needs a stream back-channel to render its card;
            // a network MCP client has none, so it is only offered on the ACP plane.
            if self.permission_tx.is_some() {
                tools.push(tool_from_def(&ask_user_def()));
            }

            // Programmatic tool calling — only when the JS sandbox is built and its
            // embedded guest compiled (nothing to download or install).
            if tool_exec::is_available() {
                tools.push(tool_from_def(&tool_exec::schema::execute_tool_def()));
                tools.push(tool_from_def(&tool_exec::schema::resume_tool_def()));
            }
        }

        tools
    }

    pub(super) async fn verified_plan_only(&self) -> bool {
        match self.mcp.agent_store.as_ref() {
            Some(store) => store
                .get(&self.agent_id)
                .await
                .ok()
                .flatten()
                .is_some_and(|record| {
                    record.safety_profile == crate::agents::AgentSafetyProfile::VerifiedPlanOnly
                }),
            None => false,
        }
    }

    /// The bound agent's per-agent **skill** allowlist (`AgentRecord.skills`).
    ///
    /// A different list from `self.allowlist`, which is the TOOL allowlist
    /// `call_tool` enforces. Resolved here so `tool_search` scopes Agent-Skill rows
    /// exactly as `skills.search` / `skills.load` do on this plane — otherwise the
    /// merged catalog would list skills this agent's own `skills.load` refuses.
    ///
    /// Fail-open to the empty list — which `SkillRegistry::enabled_for` defines as
    /// "all enabled" — on every degraded path (no agent store wired, unknown id,
    /// store error), matching `McpRegistry::call_tool_with_identity_no_gate`'s
    /// resolution of the same list for the same reason: a skill is instruction text
    /// with no secrets, so this list scopes an agent to its own skills rather than
    /// acting as a confidentiality boundary, and failing closed would strip skills
    /// from callers that legitimately had them.
    pub(super) async fn skills_allowlist(&self) -> Vec<String> {
        match self.mcp.agent_store.as_ref() {
            Some(store) => store
                .get(&self.agent_id)
                .await
                .ok()
                .flatten()
                .map(|rec| rec.skills)
                .unwrap_or_default(),
            None => Vec::new(),
        }
    }

    /// Dispatch the `tool_search` meta-tool. Returns the bridge envelope
    /// `{ "results": [ToolDescriptor] }` (distinct from the HTTP route's
    /// `{object,data}` shape).
    pub(super) async fn dispatch_tool_search(&self, args: &Value) -> Result<Value, McpError> {
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let kind = args
            .get("kind")
            .and_then(Value::as_str)
            .and_then(ToolKind::parse_filter);
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .map(|n| (n as usize).clamp(1, TOOL_SEARCH_MAX_LIMIT))
            .unwrap_or(TOOL_SEARCH_DEFAULT_LIMIT);
        // `search_scoped`, not `search`: the merged catalog carries Agent-Skill rows,
        // and this plane knows which agent is asking, so it can apply that agent's
        // skill allowlist instead of showing it skills it cannot load.
        let skills_allowlist = self.skills_allowlist().await;
        let (owner, identity) = self.catalog_identity().await;
        let results = self
            .mcp
            .search_scoped_for_identity(
                query,
                kind,
                limit,
                &skills_allowlist,
                owner.as_deref(),
                identity.as_ref(),
            )
            .await;
        let results = if crate::sidecar::mcp::box_desktop::withholds_node_display(
            self.mcp.conversations.as_ref(),
            self.permission_scope_id.as_deref(),
        )
        .await
        {
            let mut kept = Vec::with_capacity(results.len());
            for result in results {
                if !self.mcp.drives_node_display(&result.id).await {
                    kept.push(result);
                }
            }
            kept
        } else {
            results
        };
        Ok(json!({ "results": results }))
    }

    /// Dispatch the `describe` meta-tool. Returns the `DescribedTool` object (or
    /// an error when the id is unknown).
    ///
    /// The object is model-facing text on this plane, so Contract 1's additive
    /// `read_only` flag is visible to ACP agents as `"read_only": true` on tools
    /// whose MCP annotations declare them read-only (and absent otherwise). That is
    /// deliberate and harmless: it is the same fact the tool's annotations already
    /// state, it tells the agent which calls are safe to batch in one turn, and it
    /// lives in a tool result, not in the stable prompt prefix.
    pub(super) async fn dispatch_describe(&self, args: &Value) -> Result<Value, McpError> {
        let id = args.get("id").and_then(Value::as_str).unwrap_or_default();
        // `describe_scoped`, for the same reason `dispatch_tool_search` is scoped:
        // otherwise an agent could recover the name + description of a skill this
        // plane's search just withheld from it, simply by guessing `skills.<slug>`.
        // Only the skill branch is affected — tool descriptions are unchanged.
        let skills_allowlist = self.skills_allowlist().await;
        let (owner, identity) = self.catalog_identity().await;
        match self
            .mcp
            .describe_scoped_for_identity(
                id,
                &skills_allowlist,
                owner.as_deref(),
                identity.as_ref(),
            )
            .await
        {
            Some(d) => serde_json::to_value(d).map_err(|e| {
                McpError::new(rmcp::model::ErrorCode::INTERNAL_ERROR, e.to_string(), None)
            }),
            None => Err(McpError::new(
                rmcp::model::ErrorCode::INVALID_PARAMS,
                format!("unknown tool id '{id}'"),
                None,
            )),
        }
    }
}
