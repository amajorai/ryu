//! The app-registered tool arm.

use super::Dispatch;
use crate::sidecar::mcp::*;

impl McpRegistry {
    pub(super) async fn dispatch_app_tool(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
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
            configure_approved,
            account_policy,
            ..
        } = call;
        // Only dispatch ids an enabled app actually registered — never an
        // arbitrary `app.`-prefixed id a caller invents.
        let known = self
            .app_tools
            .lock()
            .map(|tools| tools.iter().any(|t| t.id == tool_id))
            .unwrap_or(false);
        if !known {
            return Err(anyhow!("unknown app tool '{tool_id}'"));
        }
        if let Some(list) = allowlist {
            // Build the candidate with the REGISTERED server (`app`), not the
            // split segment (`exa`), so an `allow:["app"]` entry authorizes
            // dispatch identically to how it authorizes listing.
            let candidate = RegistryTool::candidate(tool_id, APP_TOOL_SERVER, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }

        // Backend dispatch (plugin-tools, M3): a plugin tool may ship NEW
        // behavior, not just alias. Resolve the owning enabled plugin's backend
        // + grant set from the live manifests. `None` (no self-build wiring, or
        // no enabled owner) → the legacy alias re-enter below, so this is purely
        // additive. `Alias` also falls through to that same legacy path.
        if let Some(resolved) = self.resolve_app_tool_backend(tool_id).await {
            use crate::plugin_manifest::schema::ToolBackend;
            // Shadow's tools read the user's desktop captures, and a tool
            // whose backend names one of the user's saved keys acts with it.
            let reads_desktop = match &resolved.backend {
                ToolBackend::Http { url, .. } => url_reads_desktop_captures(url),
                _ => false,
            } || self.plugin_reaches_user_desktop(&resolved.plugin_id).await;
            if reads_desktop {
                crate::agent_access::require_desktop_access(account_policy.as_ref())?;
            }
            let backend_secret_sources = match &resolved.backend {
                ToolBackend::Http { secret_headers, .. } => Some(secret_headers),
                ToolBackend::Command { env, .. } => Some(env),
                _ => None,
            };
            if backend_secret_sources
                .is_some_and(|sources| sources.values().any(|v| source_references_user_secret(v)))
            {
                crate::agent_access::require_saved_key_access(
                    account_policy.as_ref(),
                    &resolved.plugin_id,
                )?;
            }
            match resolved.backend {
                ToolBackend::InlineJs { code } => {
                    // Grant-gated (same model as a turn hook): the plugin must
                    // hold `tool:execute`.
                    if !resolved
                        .grants
                        .contains(crate::tool_exec::GRANT_TOOL_EXECUTE)
                    {
                        return Err(anyhow!(
                            "inline tool '{tool_id}' requires the '{}' grant",
                            crate::tool_exec::GRANT_TOOL_EXECUTE
                        ));
                    }
                    // Run in the JS sandbox via the SAME host bridge a hook
                    // uses — the `Bridge` invoker, NEVER the `Registry` invoker.
                    // This is what keeps a plugin tool off the MCP registry: it
                    // cannot call `threads.*`/memory/`search_conversations` and
                    // so cannot bypass the ORG-BOUND ACL principal gates.
                    let Some(state) = crate::learning::global_state() else {
                        return Err(anyhow!(
                            "inline tool '{tool_id}' unavailable: server state not initialized"
                        ));
                    };
                    // `user_id` is the client-supplied Composio entity selector,
                    // not an authorization identity. Never let it choose a
                    // plugin-storage tenant; the bridge falls back to the
                    // active local account when no verified caller is present.
                    let bridge = std::sync::Arc::new(
                        crate::plugin_host::PluginHookBridge::new_for_agent_tool(
                            resolved.plugin_id.clone(),
                            resolved.grants.clone(),
                            state,
                            agent_id,
                            host_conversation_id,
                        ),
                    );
                    let invoker =
                        std::sync::Arc::new(crate::tool_exec::SandboxToolInvoker::bridge(bridge));
                    // The CALLING agent + its host conversation, as this dispatch
                    // already resolved them — never anything the model wrote into
                    // `arguments`. A body that needs to attribute or address by
                    // agent (the agent-to-agent mailbox) reads `caller`, so an
                    // agent cannot post as another one by naming it in its own
                    // arguments. Both are `null` for the agent-less callers.
                    let caller = serde_json::json!({
                        "agent_id": agent_id,
                        "conversation_id": host_conversation_id,
                    });
                    let program =
                        crate::tool_exec::build_inline_tool_program(&arguments, &caller, &code);
                    // Lower the owning manifest's unified permission set to the
                    // JS sandbox. `None` (no `permissions` block) keeps the
                    // deny-all posture; filesystem/network grants are refused
                    // (the sandbox has neither) and `child_process` opens only
                    // the programs named below.
                    //
                    // A `child_process`-capable inline tool reaches Ryu's
                    // capability broker through PATH shims. Materialize this
                    // plugin's cap-shims and hand the sandbox a SCOPED
                    // `childProcess.run` allow-list (bare shim NAMES, never
                    // paths) plus
                    // the env the shims authenticate the broker with: the
                    // shim-prepended `PATH` + `RYU_CORE_PORT` (via
                    // `inject_shim_env`) and the per-plugin
                    // `RYU_EXT_TOKEN`/`RYU_EXT_PLUGIN_ID`. The token is layered
                    // POST-scrub inside the backend so it is delivered (not
                    // stripped by the secret-key env scrubber). Best-effort: any
                    // failure logs and retains only the manifest-declared
                    // executable allowlist, never widening the tool call.
                    let augment = if resolved
                        .permissions
                        .as_ref()
                        .is_some_and(|p| p.child_process)
                    {
                        build_cap_shim_augment(&resolved.plugin_id, resolved.permissions.as_ref())
                            .await
                    } else {
                        ryu_tool_exec::SandboxAugment::default()
                    };
                    // Box the sandbox future: `run_sandboxed*` → the `Bridge`
                    // invoker can transitively re-enter tool dispatch, so this
                    // edge must be boxed to keep the async future finite-sized.
                    // Called on the crate directly (not via the `crate::tool_exec`
                    // facade) so the wiring stays inside this change's file set.
                    let deadline = std::time::Duration::from_secs(
                        resolved
                            .timeout_secs
                            .unwrap_or(ryu_tool_exec::DEFAULT_DEADLINE_SECS)
                            .clamp(30, 600),
                    );
                    let outcome = Box::pin(ryu_tool_exec::run_sandboxed_with_augment_and_deadline(
                        program,
                        invoker,
                        &resolved.plugin_id,
                        resolved.permissions.as_ref(),
                        &augment,
                        deadline,
                    ))
                    .await;
                    return match outcome {
                        crate::tool_exec::ExecOutcome::Completed {
                            result,
                            is_error,
                            error,
                            ..
                        } => {
                            if is_error {
                                Err(anyhow!(
                                    "inline tool '{tool_id}' failed: {}",
                                    error.unwrap_or_default()
                                ))
                            } else {
                                Ok(result.unwrap_or(Value::Null))
                            }
                        }
                        crate::tool_exec::ExecOutcome::Paused { .. } => Err(anyhow!(
                            "inline tool '{tool_id}' paused (unsupported for tools)"
                        )),
                    };
                }
                ToolBackend::Http {
                    url,
                    method,
                    header_params,
                    secret_headers,
                    fail_open,
                    unwrap_body,
                    body_defaults,
                    caller_agent_query,
                } => {
                    // Gateway-governed egress; the domain grant is checked first
                    // (deterministic refusal) inside `run_http_tool`. The
                    // `secret_headers` are resolved server-side (env/vault) and
                    // never model-visible; `profile_ids` thread the vault read.
                    // `body_defaults` are deep-merged under the model body and
                    // `unwrap_body` shapes the 2xx result — both are declarative
                    // manifest knobs, not exa-specific code.
                    let url = url_for_calling_agent(&url, caller_agent_query.as_deref(), agent_id)?;
                    let secret_context = self
                        .app_tool_secret_context(
                            host_conversation_id,
                            &resolved.plugin_id,
                            resolved.owns_namespace,
                            server,
                        )
                        .await;
                    return crate::tool_exec::run_http_tool_with_secret_context(
                        &url,
                        &method,
                        arguments,
                        &header_params,
                        &secret_headers,
                        fail_open,
                        unwrap_body,
                        &body_defaults,
                        &resolved.grants,
                        profile_ids,
                        &resolved.plugin_id,
                        session_id.as_deref(),
                        agent_id,
                        Some(&secret_context),
                    )
                    .await
                    .map_err(|e| anyhow!(e));
                }
                ToolBackend::Command {
                    bin,
                    args,
                    env,
                    cwd,
                    timeout_secs,
                    output,
                    egress_url_arg,
                    arg_specs,
                    arg_bounds,
                    workspace_path_args,
                    bin_version,
                } => {
                    // Exec an allowlisted local CLI through the governed path.
                    // The bin grant + allowlist are checked first (deterministic)
                    // inside `run_command_tool`. The approval gate (if any) has
                    // already classified under the outer `app.` id (gate_id's
                    // `_ => tool_id` arm), so no per-target re-gate is needed.
                    let workspace_root = if workspace_path_args.is_empty() {
                        None
                    } else {
                        self.command_workspace_root(host_conversation_id).await
                    };
                    return crate::tool_exec::run_command_tool_with_agent_and_workspace(
                        &bin,
                        &args,
                        arg_specs.as_deref(),
                        &env,
                        cwd.as_deref(),
                        timeout_secs,
                        output,
                        egress_url_arg.as_deref(),
                        &arg_bounds,
                        arguments,
                        &resolved.grants,
                        &resolved.plugin_id,
                        session_id.as_deref(),
                        agent_id,
                        workspace_root.as_deref(),
                        &workspace_path_args,
                        bin_version.as_ref(),
                    )
                    .await
                    .map_err(|e| anyhow!(e));
                }
                // Alias: fall through to the legacy re-enter (target is `slug`,
                // which equals the split `tool` — byte-identical to before).
                ToolBackend::Alias { .. } => {}
            }
        }

        // Guard against an app tool aliasing another app tool (loop / privilege
        // chain) or an empty target.
        if tool.is_empty() || tool.starts_with(APP_TOOL_PREFIX) {
            return Err(anyhow!(
                "app tool '{tool_id}' has an invalid target '{tool}'"
            ));
        }
        // Re-enter for the target. The recursive future is boxed because an
        // async fn cannot name its own type. No allowlist: the app-layer check
        // above is the gate; the target is manifest-fixed. Use the NO-GATE
        // entry: the approval gate (if any) applies to the granted `app.` id,
        // not to the manifest-fixed target — otherwise an app tool would raise
        // a second approval for its inner target.
        Box::pin(self.call_tool_with_identity_no_gate_scoped(
            // Same calling agent — the alias re-enter is one logical call, so
            // per-agent scoping must not be dropped on the way in.
            agent_id,
            tool,
            arguments,
            None,
            user_id,
            profile_ids,
            session_id,
            host_conversation_id,
            composio_connection_scope,
            conversation_scope,
            configure_approved,
        ))
        .await
    }
}

#[cfg(test)]
#[path = "../tests/dispatch_app_tool.rs"]
mod tests;
