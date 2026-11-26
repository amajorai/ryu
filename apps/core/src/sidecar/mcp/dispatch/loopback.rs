//! Plans, Core self-API, derived ext-API and self-diagnostics loopback arms.

use super::Dispatch;
use crate::sidecar::mcp::*;

impl McpRegistry {
    pub(super) async fn dispatch_plans(&self, call: Dispatch<'_>, tool: &str) -> Result<Value> {
        let Dispatch {
            agent_id,
            arguments,
            host_conversation_id,
            ..
        } = call;
        crate::safe_actions::dispatch_tool(tool, arguments, agent_id, host_conversation_id).await
    }

    // Core self-API provider (agents driving Ryu itself): OpenAPI-derived tools
    // dispatched by looping back over HTTP to THIS Core with its own token.
    //
    // TENANCY FAIL-CLOSED: the loopback request carries the node's own
    // `RYU_TOKEN` = full node power, NOT this agent's scoped principal. On an
    // org-bound node that is a tenancy bypass, so CoreApi tools refuse unless the
    // resolved principal is `Unrestricted` (⟺ the node is unbound/personal —
    // there is exactly one principal and the node token IS its boundary). We
    // resolve the principal from the host conversation when a store is wired,
    // else fall back to the node's org binding directly.
    pub(super) async fn dispatch_self_api(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
            tool_id,
            arguments,
            allowlist,
            user_id,
            host_conversation_id,
            account_policy,
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        let principal =
            ToolPrincipal::resolve_optional(self.conversations.as_ref(), host_conversation_id)
                .await;
        let acting_user = match principal {
            // The loopback carries the owner token: refused for a request a
            // scoped credential (a paired device, say) made.
            ToolPrincipal::Unrestricted => {
                if let Some(reason) =
                    crate::server::tool_ingress_authority::owner_loopback_refusal(tool_id)
                {
                    return Err(anyhow!("{reason}"));
                }
                None
            }
            // On an org-bound node the loopback acts as the person in the
            // chat, after their role is checked for this route.
            ToolPrincipal::Owned { user_id, org_id } => {
                match crate::sidecar::control_plane::registered_node() {
                    Some(node) => {
                        self.authorize_self_api_for(
                            tool_id,
                            &node,
                            &user_id,
                            org_id.as_deref(),
                            host_conversation_id,
                        )
                        .await?;
                        Some(user_id)
                    }
                    None => {
                        let reason = crate::self_api::refuse_reason_if_tenant_bound(false)
                            .unwrap_or_default();
                        return Err(anyhow!("{reason}"));
                    }
                }
            }
            ToolPrincipal::Unresolved => {
                let reason =
                    crate::self_api::refuse_reason_if_tenant_bound(false).unwrap_or_default();
                return Err(anyhow!("{reason}"));
            }
        };
        // The loopback runs with the node's full power, not this agent's
        // account policy, so a restricted agent may only read through it and
        // write reviewed workspace content: any other write could reach the
        // user's accounts, run another agent, or change its own access.
        if account_policy
            .as_ref()
            .is_some_and(|policy| !policy.is_unrestricted())
        {
            if let Some(reason) = crate::self_api::restricted_write_refusal(tool_id)
                .or_else(|| crate::self_api::restricted_sharing_refusal(tool_id, &arguments))
            {
                return Err(anyhow!("{reason}"));
            }
        }
        // Switching on an MCP server that came from a registry starts a program
        // as the user. That stays with the person, whatever was approved in chat.
        if let Some(reason) = self.agent_mcp_enable_refusal(tool_id, &arguments).await {
            return Err(anyhow!("{reason}"));
        }
        crate::self_api::dispatch(&self.http, tool_id, arguments, acting_user.as_deref()).await
    }

    /// Why this self-API call is refused because it would switch on an MCP
    /// server installed from a registry; `None` for every other call. See
    /// [`crate::self_api::mcp_server_enable_refusal`]. Fails closed: an app
    /// enable call is refused when the installed apps cannot be read.
    async fn agent_mcp_enable_refusal(&self, tool_id: &str, arguments: &Value) -> Option<String> {
        crate::self_api::app_enable_target(tool_id, arguments)?;
        let (Some(manifests), Some(store)) = (
            self.self_build_manifests.as_ref(),
            self.self_build_app_store.as_ref(),
        ) else {
            return crate::self_api::app_enable_unchecked_refusal(tool_id, arguments);
        };
        let Ok(records) = store.list_all_records().await else {
            return crate::self_api::app_enable_unchecked_refusal(tool_id, arguments);
        };
        // The installed set and the raw enabled bits, as the lifecycle reads
        // them when it resolves the enable order.
        let installed: Vec<crate::plugin_manifest::PluginManifest> = manifests
            .read()
            .await
            .iter()
            .filter(|manifest| records.iter().any(|record| record.id == manifest.id))
            .cloned()
            .collect();
        let enabled: std::collections::HashSet<String> = records
            .iter()
            .filter(|record| record.enabled)
            .map(|record| record.id.clone())
            .collect();
        crate::self_api::mcp_server_enable_refusal(tool_id, arguments, &installed, &enabled)
    }

    // Derived ext-API tool (`crate::ext_api`): an installed app's OWN HTTP
    // surface, lowered from its sidecar's OpenAPI document into search-gated
    // tools. Dispatched by looping back through Core's `/api/ext/<plugin_id>/*`
    // proxy — never straight at the sidecar port, which would bypass the
    // enabled-gate, the per-route `RouteAuth`, `enforce_permission_on`, and (via
    // `run_http_tool`) the egress grant, SSRF pin, budget, DLP scan and audit.
    //
    // Placed AFTER the self-API arm and BEFORE the `is_native_app_tool` scan
    // deliberately: `split_tool_id` puts these on their own `ryu_ext` server, and
    // reaching the app-tool lane would demand `app_tools` membership plus a
    // `manifest.runnables` entry that a derived tool has by construction never
    // had — every call would die with "unknown app tool".
    //
    // TENANCY: FAIL-CLOSED, same rule as the self-API arm above.
    //
    // The tempting argument for treating this plane as safer is that the
    // ext-proxy carries an app-declared per-route `permission` gate the self-API
    // loopback does not. That gate is real code (`ext_proxy::…
    // enforce_permission_on`) and now covers the packaged apps' protected
    // sidecar routes, including method-specific read/write levels. Derived tools
    // still present the node's own `RYU_TOKEN` rather than the caller's scoped
    // JWT, so they remain refused on org-bound nodes: otherwise agent A could
    // use a derived CRM tool to read agent B's records before the app route
    // permission has a caller identity to evaluate. Direct UI/proxy requests
    // continue through the per-route gate; this refusal is only for the
    // identity-less derived-tool loopback.
    //
    // The gate to relax when apps do start annotating is this one, and the
    // condition to relax it on is per-ROUTE (`required_permission_for` returning
    // `Some`), never per-plane — a plane-wide relaxation would ride in on the
    // first annotated route and take every unannotated one with it.
    pub(super) async fn dispatch_ext_api(
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
            profile_ids,
            session_id,
            host_conversation_id,
            account_policy,
            ..
        } = call;
        // Allowlist on the fully-qualified id, exactly as the self-API arm does,
        // so `allow:["ryu_ext"]` authorizes this plane the way `allow:["ryu_api"]`
        // authorizes that one.
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        // Only ids a live lowering actually registered — never an arbitrary
        // `ryu_ext.`-prefixed id a caller invents. This is the plane's
        // allowlist-of-record: it is also what pins the URL, since the route
        // (not the caller) supplies the method and the proxy path.
        let Some(route) = self.ext_api_route(tool_id) else {
            return Err(anyhow!("unknown derived tool '{tool_id}'"));
        };
        // Its RYU_TOKEN is Core's own agent lane, not a user key, but an
        // app that reads or drives the user's desktop still needs that access.
        if self.plugin_reaches_user_desktop(&route.plugin_id).await {
            crate::agent_access::require_desktop_access(account_policy.as_ref())?;
        }
        let unrestricted = matches!(
            ToolPrincipal::resolve_optional(self.conversations.as_ref(), host_conversation_id)
                .await,
            ToolPrincipal::Unrestricted
        );
        if !unrestricted {
            return Err(anyhow!(
                "app API tools are disabled on shared (org-bound) nodes: the call \
                 loops back through Core with the node's own credentials rather \
                 than your scoped identity, so the caller's per-route app \
                 permission for '{}' cannot be evaluated. Use them on a personal node.",
                route.plugin_id
            ));
        }
        if let Some(reason) = crate::server::tool_ingress_authority::owner_loopback_refusal(tool_id)
        {
            return Err(anyhow!("{reason}"));
        }
        // The owning plugin's effective grants — the RECORD's Gateway-approved
        // set for a Community-tier app, the manifest's declaration for a
        // Core-tier one — resolved through the same `effective_tool_grants` path
        // the app-tool arm uses. `None` means the owner is no longer an enabled
        // manifest (a deactivate that raced this call, or an unwired store in a
        // CLI/test context): refuse rather than dispatch with an empty grant set.
        let Some(grants) = self.ext_api_effective_grants(&route.plugin_id).await else {
            return Err(anyhow!(
                "derived tool '{tool_id}' has no enabled owning plugin '{}'",
                route.plugin_id
            ));
        };
        // Principal + grants + auth header, decided in one pure place so each is
        // assertable without a socket — see `ext_api::call_plan` for why the
        // principal must be the OWNING PLUGIN and why the loopback egress grant
        // is unioned in rather than demanded from 40 manifests.
        let plan = crate::ext_api::call_plan(&route, &grants);
        let secret_context = self
            .secret_resolution_context(
                host_conversation_id,
                vec![route.plugin_id.clone(), server.to_owned()],
            )
            .await;
        crate::tool_exec::run_http_tool_with_secret_context(
            &route.url,
            &route.method,
            arguments,
            &route.header_params,
            &plan.secret_headers,
            // fail_open=false: an unreachable sidecar must surface as an ERROR, not
            // as the `http_unavailable` success envelope the fail-open path
            // returns — which a model reads as "the app answered, there is
            // nothing there" and narrates as an empty result. It also turns a
            // 401/403 into that same soft answer, which is precisely the signal
            // that says the auth header did not land.
            false,
            // unwrap_body=false: keep the `{status, body}` envelope. An app's own
            // 4xx carries the actionable message (validation detail, not-found),
            // and unwrapping would hand the model a bare body with the status —
            // the half that says whether it worked — thrown away.
            false,
            &Value::Null,
            &plan.grants,
            profile_ids,
            &plan.principal,
            session_id.as_deref(),
            agent_id,
            Some(&secret_context),
        )
        .await
        .map_err(|e| anyhow!(e))
    }

    // Built-in self diagnostics (`builtin_servers::diagnostics`): two read-only
    // tools that report Ryu's own state from Core's documented read routes,
    // over this same loopback. Only `GET` is sent.
    //
    // TENANCY: on an unbound/personal node the node token is the boundary, as
    // for the self-API arm. On an org-bound node the loopback always carries
    // the acting-user proof, so every route applies the role and conversation
    // access of the person in the chat, and node status is read only for the
    // node owner or a member who manages nodes, in a private chat. Everyone
    // else, and every agent with a restricted account policy, gets the host
    // conversation only. No principal means no report.
    pub(super) async fn dispatch_diagnostics(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        use crate::sidecar::mcp::builtin_servers::diagnostics;
        let Dispatch {
            tool_id,
            arguments,
            allowlist,
            host_conversation_id,
            account_policy,
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        let principal =
            ToolPrincipal::resolve_optional(self.conversations.as_ref(), host_conversation_id)
                .await;
        let (scope, acting_user) = match principal {
            ToolPrincipal::Unrestricted => {
                if let Some(reason) =
                    crate::server::tool_ingress_authority::owner_loopback_refusal(tool_id)
                {
                    return Err(anyhow!("{reason}"));
                }
                (diagnostics::Scope::Node, None)
            }
            ToolPrincipal::Owned { user_id, org_id } => {
                let Some(node) = crate::sidecar::control_plane::registered_node() else {
                    return Err(diagnostics_without_a_person(tool_id));
                };
                let scope = self
                    .diagnostics_scope_for(&node, &user_id, org_id.as_deref(), host_conversation_id)
                    .await;
                (scope, Some(user_id))
            }
            ToolPrincipal::Unresolved => return Err(diagnostics_without_a_person(tool_id)),
        };
        let restricted = account_policy
            .as_ref()
            .is_some_and(|policy| !policy.is_unrestricted());
        let scope = diagnostics::narrow_for_restricted_agent(scope, restricted);
        let loopback = diagnostics::Loopback::for_this_node(&self.http, acting_user);
        diagnostics::dispatch(tool, arguments, &loopback, scope, host_conversation_id).await
    }

    /// How far a `diagnostics.*` call may look for the person an agent acts for
    /// on an org-bound node. See `builtin_servers::diagnostics::shared_node_scope`.
    async fn diagnostics_scope_for(
        &self,
        node: &crate::sidecar::control_plane::RegisteredNode,
        user_id: &str,
        org_id: Option<&str>,
        host_conversation_id: Option<&str>,
    ) -> crate::sidecar::mcp::builtin_servers::diagnostics::Scope {
        use crate::sidecar::mcp::builtin_servers::diagnostics::{
            shared_node_scope, SharedNodeCaller,
        };
        let private_conversation = self
            .host_conversation_is_private(host_conversation_id)
            .await;
        let node_owner = if node.scope == crate::sidecar::control_plane::NodeScope::Personal {
            node.owner_user_id.as_deref()
        } else {
            None
        };
        // The role lookup asks the control plane, so it is skipped whenever it
        // cannot change the answer.
        let role_decides = private_conversation
            && org_id == Some(node.org.id.as_str())
            && node_owner != Some(user_id);
        let manages_nodes = if role_decides {
            Box::pin(crate::sidecar::control_plane::resolve_permission_context(
                &self.http, user_id,
            ))
            .await
            .permissions
            .contains(crate::identity_verify::permissions::NODES_MANAGE)
        } else {
            false
        };
        shared_node_scope(&SharedNodeCaller {
            user_id,
            org_id,
            node_org: &node.org.id,
            node_owner,
            manages_nodes,
            private_conversation,
        })
    }

    /// Whether the call was asked for by one person alone. A verified non-chat
    /// caller asked directly; nobody else could have. In a chat, only a private
    /// conversation with no collaborators counts.
    async fn host_conversation_is_private(&self, host_conversation_id: Option<&str>) -> bool {
        if authenticated_scope::current_principal().is_some() {
            return true;
        }
        match (
            self.conversations.as_ref(),
            host_conversation_id.filter(|id| !id.is_empty()),
        ) {
            (Some(store), Some(id)) => store
                .get_access_meta(id)
                .await
                .ok()
                .flatten()
                .is_some_and(|meta| meta.visibility == "private" && meta.collaborators.is_empty()),
            _ => false,
        }
    }

    /// Check that the person an agent acts for on an org-bound node may call this
    /// self-API route. See [`crate::self_api::acting_user_refusal`].
    async fn authorize_self_api_for(
        &self,
        tool_id: &str,
        node: &crate::sidecar::control_plane::RegisteredNode,
        user_id: &str,
        org_id: Option<&str>,
        host_conversation_id: Option<&str>,
    ) -> Result<()> {
        let route = crate::self_api::route_for(tool_id)
            .ok_or_else(|| anyhow!("unknown core-api tool '{tool_id}'"))?;
        let private_conversation = self
            .host_conversation_is_private(host_conversation_id)
            .await;
        let node_owner = (node.scope == crate::sidecar::control_plane::NodeScope::Personal)
            .then_some(node.owner_user_id.as_deref())
            .flatten();
        let permissions = if node_owner == Some(user_id) {
            std::collections::HashSet::new()
        } else {
            Box::pin(crate::sidecar::control_plane::resolve_permission_context(
                &self.http, user_id,
            ))
            .await
            .permissions
        };
        let acting = crate::self_api::ActingUser {
            user_id,
            org_id,
            private_conversation,
        };
        match crate::self_api::acting_user_refusal(
            route,
            &acting,
            &node.org.id,
            node_owner,
            &permissions,
        ) {
            Some(reason) => Err(anyhow!("{reason}")),
            None => Ok(()),
        }
    }
}

/// The refusal for a diagnostics call on an org-bound node that no person can
/// be named for (a workflow, a monitor, an untenanted conversation). Without a
/// person there is nobody whose access the read could be held to.
fn diagnostics_without_a_person(tool_id: &str) -> anyhow::Error {
    anyhow!(
        "`{tool_id}` reads Ryu's state as the person in the chat, and on this shared node \
         this call has no such person. Call it from a chat."
    )
}

#[cfg(test)]
#[path = "../tests/dispatch_loopback.rs"]
mod tests;

#[cfg(test)]
#[path = "../tests/dispatch_mcp_enable.rs"]
mod mcp_enable_tests;
