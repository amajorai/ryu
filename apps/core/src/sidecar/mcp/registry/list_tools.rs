//! Listing every registered tool.

use crate::sidecar::mcp::*;

impl McpRegistry {
    /// Every tool across every enabled server. A server that fails to start is
    /// logged and skipped so one broken server can't hide the rest.
    ///
    /// Includes the built-in Shadow tools (U15) and self-build tools (U57) so
    /// an agent can always discover them; Shadow calls report unavailable when
    /// Shadow isn't running, and self-build calls require the context to be wired.
    ///
    /// Server names are snapshotted under the read lock and then the lock is
    /// dropped before any `.await` call.
    pub async fn list_all_tools(&self) -> Vec<RegistryTool> {
        let access_mode = self.web_search_access_mode().await;
        // Listing carries no host conversation, so it filters with the verified
        // HTTP caller's tool rules when an authenticated scope is active and the
        // node credential's org/team rules otherwise. Dispatch re-resolves the
        // rules for the call's own principal, so a user-layer denial still binds
        // a tool this listing shows.
        let org_tool_rules = {
            let user_id = match authenticated_scope::current_principal() {
                Some(ToolPrincipal::Owned { user_id, .. }) => Some(user_id),
                _ => None,
            };
            crate::org_policy::visible_tool_rules(user_id.as_deref()).await
        };
        let resolved_verbs = self.capability_verbs().await;
        // Every enabled provider's binding of a web/browser verb this mode denies,
        // selected or not: an unselected provider's tool is otherwise a direct
        // bypass of the access mode.
        let restricted_provider_tools =
            self.web_access_restricted_provider_tools(access_mode).await;
        let mut web_provider_servers = Vec::new();
        for resolved in &resolved_verbs {
            if !web_search_access::is_web_access_tool_id(resolved.verb.id) {
                continue;
            }
            if let Some((server, _)) = resolved.binding.tool.split_once('.') {
                if !web_provider_servers.iter().any(|known| known == server) {
                    web_provider_servers.push(server.to_owned());
                }
            }
            if let Some(adapter) = resolved.binding.adapter.as_ref() {
                for adapter_tool in &adapter.tools {
                    if let Some((server, _)) = adapter_tool.split_once('.') {
                        if !web_provider_servers.iter().any(|known| known == server) {
                            web_provider_servers.push(server.to_owned());
                        }
                    }
                }
            }
        }

        let names: Vec<String> = {
            let servers = self.servers.read().expect("mcp servers RwLock poisoned");
            servers.keys().cloned().collect()
        };

        // Built-in authenticated web fetch (Identity Vault credential consumer).
        // (The autoresearch tools used to be prepended here from a Core-side
        // provider; they now arrive over the generic plugin-server path, from the
        // `@ryu/research` app's own `ryu-research mcp` stdio server.)
        let mut all = Vec::new();
        if access_mode.allows_tool_id(web_fetch::GET_TOOL_ID) {
            all.extend(web_fetch::tools());
        }
        // Built-in provider-usage reads. Credentials stay in Core; the tools
        // return only normalized remaining/used windows and reset metadata.
        all.extend(usage_tool::tools());
        // Built-in Treg tools (flagged: `RYU_TREG_AGENT_TOOLS`). Calls go through
        // the Gateway's managed connection layer, so the Treg token and the wallet
        // debit stay in Gateway.
        all.extend(treg_tool::tools());
        // Built-in Ryu Challenges. Reads are public; `challenges.submit` writes
        // under the signed-in session and is always approval-gated by policy.
        all.extend(challenges_tool::tools());
        // Built-in Marketplace discovery ("is there a template for X?"). Read-only
        // and anonymous; installs stay on the approval-gated catalog routes.
        all.extend(marketplace_tool::tools());
        // Capability facade verbs (swappable layers). Feature-detected: only the
        // verbs whose capability has a selected provider that serves them are
        // listed, so an agent never sees `web.search` on a node with no search
        // provider installed.
        let provided_verb_ids: Vec<&str> = resolved_verbs
            .iter()
            .map(|resolved| resolved.verb.id)
            .collect();
        // `computer.*` and `browser.*` a session Box serves when no enabled
        // provider does (a headless node without a display plugin): the call
        // runs on the conversation's own Box (`box_desktop::route`).
        let session_box_verbs = if crate::server::session_box::serves_machine_verbs().await {
            capability_tools::session_box_tools(&provided_verb_ids)
        } else {
            Vec::new()
        };
        let permitted_verbs: Vec<_> = resolved_verbs
            .into_iter()
            .filter(|resolved| access_mode.allows_tool_id(resolved.verb.id))
            .collect();
        all.extend(capability_tools::tools(&permitted_verbs));
        all.extend(
            session_box_verbs
                .into_iter()
                .filter(|tool| access_mode.allows_tool_id(&tool.id)),
        );
        // Built-in wasmtime sandbox tools (M6 / issue #190) — always listed;
        // dispatch returns `available: false` when disabled or feature absent.
        all.extend(sandbox::tools());
        all.extend(cloud::tools());
        // Built-in actions (#456): desktop notification + send-to-channel.
        all.extend(notify_tool::tools());
        // Built-in device capability tools: one per connected, secure (device,
        // capability) pair, gated on a personal node, the Hardware app and the
        // device prefs (re-checked at dispatch).
        all.extend(device_tool::tools().await);
        all.extend(artifact_tool::tools());
        // Built-in Spaces provider: reads and controlled page/file/Space access
        // mutations. Dispatch resolves the server-derived principal per call.
        all.extend(spaces_tool::tools());
        // Built-in working-memory update. Always listed; dispatch refuses unless
        // the calling agent enables working memory in its MemorySlot.
        all.extend(working_memory_tool::tools());
        all.extend(channel_tool::tools());
        // Built-in Agent Inbox tools: the calling agent's own hosted address on
        // Ryu Cloud. Always listed; dispatch reports unavailable on a node that
        // is not org-bound.
        all.extend(agent_inbox_tool::tools());
        // Built-in semantic search over past chat messages — always listed;
        // dispatch returns `available: false` when the conversation store / index
        // is not wired (test / CLI contexts).
        all.extend(search_conversations::tools());
        // Built-in agent-level control — an active governed agent can request a
        // target agent/model/effort for the next turn. Core validates and stores
        // the patch against the host conversation before dispatch returns.
        all.extend(crate::agent_control::tools());
        // Built-in coordinator-threads tools — always listed; dispatch reports
        // unavailable when the conversation store / agent runner is not wired.
        all.extend(threads::tools());
        // Built-in delegation tool — ephemeral parallel sub-agent fan-out. Always
        // listed; per-delegate failures surface in the results envelope.
        all.extend(delegate::tools());
        all.extend(orchestrator::tools());
        // Built-in skills tools — progressive disclosure (search + load Agent
        // Skills on demand). Always listed; dispatch reports unavailable when the
        // skill registry is not wired (test / CLI contexts).
        all.extend(skills_tool::tools());
        // Built-in generative-UI tool — render a rich UI inline in chat from a
        // json-render spec. Always listed; client-rendered (Core dispatch is a no-op).
        all.extend(ui_tool::tools());
        // Built-in consent requests — ask the user to connect an app or install a
        // plugin through an inline card. Client-rendered (Core dispatch is a no-op).
        all.extend(consent_tool::tools());
        // Built-in suggested next task — an optional card above the composer whose
        // Start button opens a new chat. Client-rendered (Core dispatch is a no-op).
        all.extend(tasks_tool::tools());
        // Built-in workspace shell actions — safe page-key navigation and the
        // embedded Browser panel bridge. The desktop consumes their event bus.
        all.extend(workspace_tool::tools());
        // Built-in routines — persisted cron/interval CRUD and run-now. The
        // normal MCP approval/lifecycle gate surrounds their mutations.
        all.extend(routines_tool::tools());
        // Include self-build tools (U57) — always listed, dispatch fails gracefully
        // if the self_build context was not wired (test / CLI contexts).
        all.extend(crate::runnable::self_build::tools());
        // Agent-builder tools — chat edits an agent record. Dispatch fails
        // gracefully when the agent_store was not wired (test / CLI contexts).
        all.extend(crate::runnable::agent_builder::tools());
        // Workflow-builder tools — chat authors/edits a workflow definition.
        // Backed by the global file-backed workflow store (no handle to wire).
        all.extend(crate::runnable::workflow_builder::tools());
        // Dashboard-builder tools — chat authors/arranges a Home dashboard's
        // widget grid. Backed by the process-global dashboard engine (no handle
        // to wire); dispatch reports unavailable in test/CLI contexts.
        all.extend(crate::runnable::dashboard_builder::tools());
        // Core-owned typed plan boundary. These tools are the only direct tool
        // surface exposed to agents using the `verified_plan_only` posture.
        all.extend(crate::safe_actions::tools());
        for (name, result) in discovery::collect(names, |name| {
            let lookup = name.clone();
            async move {
                if let Some(left) = self
                    .discovery_backoff
                    .remaining(&lookup, std::time::Instant::now())
                {
                    bail!(
                        "MCP server '{lookup}' timed out recently; retrying discovery in {}s",
                        left.as_secs().max(1)
                    );
                }
                let generation = self.discovery_backoff.generation();
                let result =
                    discover_mcp_server_with_timeout(name, self.tools_for_server(&lookup)).await;
                self.discovery_backoff.record(
                    &lookup,
                    &result,
                    generation,
                    std::time::Instant::now(),
                );
                result
            }
        })
        .await
        {
            match result {
                Ok(tools) => all.extend(tools),
                Err(e) => tracing::warn!("MCP server '{name}' tools/list failed: {e}"),
            }
        }
        // Include in-memory tools registered by enabled apps (tool-as-Runnable).
        // Enrich rows from the owning manifest so an SDK-authored tool keeps its
        // input schema, widget binding, and description in discovery; the app
        // registry itself intentionally stores only the stable id/name pair.
        let app_tools = self
            .app_tools
            .lock()
            .map(|app| app.clone())
            .unwrap_or_default();
        if let Some(manifests) = self.self_build_manifests.as_ref() {
            let manifests = manifests.read().await;
            for mut tool in app_tools {
                if let Some(metadata) = self_build_tool_metadata(&manifests, &tool.id) {
                    tool.description = metadata.description.or(tool.description);
                    tool.input_schema = metadata.input_schema.or(tool.input_schema);
                    tool.output_schema = metadata.output_schema.or(tool.output_schema);
                    tool.annotations = metadata.annotations.or(tool.annotations);
                    tool.widget = metadata.widget.clone().or(tool.widget);
                    tool.widget_accessible = tool
                        .widget
                        .as_ref()
                        .is_some_and(|widget| widget.widget_accessible);
                    tool.output_template = tool
                        .widget
                        .as_ref()
                        .map(|widget| widget.template_uri.clone())
                        .or(tool.output_template);
                }
                all.push(tool);
            }
        } else {
            all.extend(app_tools);
        }
        // A billed, selected-only provider (Ryu Cloud Search) is reached through
        // its layer verb once the user picks it, never as a direct tool.
        let selected_only_tools = web_search_access::builtin_selected_only_tool_ids();
        all.retain(|tool| {
            let canonical = self.canonical_tool_id_for_registry(&tool.id);
            access_mode.allows_tool_id(&tool.id)
                && !restricted_provider_tools.contains(&canonical)
                && !selected_only_tools.contains(&canonical)
                && !web_provider_servers.iter().any(|server| {
                    tool.server.as_str() == server
                        || tool
                            .id
                            .strip_prefix(server)
                            .is_some_and(|suffix| suffix.starts_with('.'))
                })
                && self
                    .split_registered_tool_id(&tool.id)
                    .is_none_or(|(server, _)| !crate::fleet::is_artifact_blocked(server))
                // Do not advertise tools the organization's policy denies; the
                // dispatch boundary still enforces it for any id a model guesses.
                && crate::org_policy::tool_visible_under(
                    &org_tool_rules,
                    &tool.id,
                    self.external_mcp_server_for(&tool.id),
                )
        });
        all
    }
}

#[cfg(test)]
#[path = "../tests/registry_discovery.rs"]
mod tests;
