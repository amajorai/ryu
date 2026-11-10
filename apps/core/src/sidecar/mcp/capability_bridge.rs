//! The sandbox bridge a capability adapter calls its provider tool through.

use super::*;

/// The host bridge a capability ADAPTER's `callTool` is wired to.
///
/// Deliberately the narrowest bridge in the codebase: it answers exactly one path
/// ([`crate::tool_exec::CAPABILITY_ADAPTER_CALL_PATH`]) and dispatches it to ONE
/// tool id fixed from the manifest before the sandbox started. Sandboxed JS can
/// therefore neither name a different tool nor reach `host.*` — the plugin-hook
/// surface (`sideModel`, `runAgent`, `storage`) is simply not bound, and any other
/// path is refused rather than forwarded.
///
/// This is what keeps an adapter's authority a SUBSET of the declarative path it
/// replaces: the declarative path re-enters dispatch on `binding.tool` once with
/// the caller's identity, and so does this — the only new power is that the
/// adapter chooses the arguments and may call more than once (the polling loop an
/// async provider needs).
pub(super) struct CapabilityAdapterBridge {
    pub(super) registry: Arc<McpRegistry>,
    /// The provider's own tool id, from `binding.tool`. Never caller-influenced.
    pub(super) target: String,
    /// The ADDITIONAL ids `callNamed` may reach, from `adapter.tools`. Fixed by the
    /// manifest; a name outside this set (and outside [`Self::target`]) is refused.
    pub(super) allowed: std::collections::HashSet<String>,
    /// The providing plugin; a target on a tool it does not own is refused.
    pub(super) provider_id: String,
    pub(super) agent_id: Option<String>,
    pub(super) user_id: Option<String>,
    pub(super) profile_ids: Vec<String>,
    pub(super) session_id: Option<String>,
    pub(super) host_conversation_id: Option<String>,
}

impl CapabilityAdapterBridge {
    /// Resolve the tool id one bridge call should dispatch to, or the reason it must
    /// be refused. Split out from [`SandboxBridge::handle`] so the security-relevant
    /// decision — which ids sandboxed JS can reach — is testable without a live
    /// registry or a sandbox run.
    pub(super) fn resolve_target(&self, path: &str, args: &Value) -> Result<String, String> {
        if path == crate::tool_exec::CAPABILITY_ADAPTER_CALL_PATH {
            return Ok(self.target.clone());
        }
        if path == crate::tool_exec::CAPABILITY_ADAPTER_NAMED_PATH {
            let requested = args.get("tool").and_then(Value::as_str).unwrap_or_default();
            if requested.is_empty() {
                return Err("callNamed requires a tool id".to_owned());
            }
            // Fail-closed against the manifest's declared set. Note `target` is
            // always reachable: naming the primary tool explicitly is not an
            // escalation, it is the same call `callTool` makes.
            if requested != self.target && !self.allowed.contains(requested) {
                return Err(format!(
                    "adapter may not call '{requested}': it is not declared in this \
                     binding's `adapter.tools`"
                ));
            }
            // Never let an adapter re-enter the facade (a manifest-driven infinite
            // loop) — the same refusal the declarative arm applies to `binding.tool`.
            if capability_tools::verb_by_id(requested).is_some() {
                return Err(format!(
                    "adapter may not call the capability facade tool '{requested}'"
                ));
            }
            if provider_target_guard::is_core_reserved_target(requested) {
                return Err(format!("adapter may not call the Core tool '{requested}'"));
            }
            return Ok(requested.to_owned());
        }
        Err(format!(
            "a capability adapter may only call '{}' or '{}', not '{path}'",
            crate::tool_exec::CAPABILITY_ADAPTER_CALL_PATH,
            crate::tool_exec::CAPABILITY_ADAPTER_NAMED_PATH
        ))
    }
}

impl crate::tool_exec::SandboxBridge for CapabilityAdapterBridge {
    fn handle(
        &self,
        path: String,
        args: Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = crate::tool_exec::InvokeOutcome> + Send + '_>,
    > {
        Box::pin(async move {
            use crate::tool_exec::{InvokeOutcome, ToolInvokeResult};
            // Fail-closed on any path or id the manifest did not declare. Surfaced as
            // a catchable tool error rather than an abort so a buggy adapter reports
            // cleanly instead of killing the turn.
            let target = match self.resolve_owned_target(&path, &args).await {
                Ok(target) => target,
                Err(reason) => {
                    return InvokeOutcome::Result(ToolInvokeResult {
                        value: Value::Null,
                        is_error: true,
                        error: Some(reason),
                    });
                }
            };
            // `callNamed` wraps the real arguments; `callTool` passes them directly.
            let args = if path == crate::tool_exec::CAPABILITY_ADAPTER_NAMED_PATH {
                args.get("args")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(serde_json::Map::new()))
            } else {
                args
            };
            // Keep the caller's agent identity across the adapter just as the
            // declarative mapping does. The manifest fixes the target, but it
            // does not grant the caller agent-creation or orchestration powers.
            // `profile_ids` / `session_id` likewise remain bound to the caller.
            let result = Box::pin(self.registry.call_tool_with_identity_no_gate(
                self.agent_id.as_deref(),
                &target,
                args,
                None,
                self.user_id.as_deref(),
                &self.profile_ids,
                self.session_id.clone(),
                self.host_conversation_id.as_deref(),
            ))
            .await;
            match result {
                Ok(value) => InvokeOutcome::Result(ToolInvokeResult {
                    value,
                    is_error: false,
                    error: None,
                }),
                Err(e) => InvokeOutcome::Result(ToolInvokeResult {
                    value: Value::Null,
                    is_error: true,
                    error: Some(e.to_string()),
                }),
            }
        })
    }
}

pub(super) struct ResolvedAppTool {
    /// How this tool runs (`alias` re-enter | `inline_js` sandbox | `http` proxy).
    pub(super) backend: crate::plugin_manifest::schema::ToolBackend,
    /// The owning plugin's granted capabilities (gates `host.*` + http egress).
    pub(super) grants: std::collections::HashSet<String>,
    /// The owning plugin id (sandbox storage owner + audit attribution).
    pub(super) plugin_id: String,
    /// The owning plugin manifest's unified **runtime permission set**, enforced by
    /// the JS sandbox when an `inline_js` tool runs. `None` = the manifest
    /// declared no `permissions` block → the sandbox stays **deny-all** (its
    /// historical zero-permission posture).
    pub(super) permissions: Option<crate::plugin_manifest::PermissionSet>,
    /// Optional active-compute deadline for an inline sandbox tool. The value is
    /// clamped at dispatch so a manifest cannot create an unbounded execution.
    pub(super) timeout_secs: Option<u64>,
    /// Whether the owning manifest explicitly requires human approval before
    /// dispatch. This is kept beside the resolved backend so the approval path
    /// and execution path read the same live manifest record.
    pub(super) needs_approval: bool,
    /// Whether the owning plugin owns the tool id's server namespace (see
    /// [`app_tool_namespace`]). Only then may it shadow a configured MCP server
    /// of that name or read vault values bound to that server.
    pub(super) owns_namespace: bool,
}

/// Metadata for one enabled SDK Action. The registered tool id remains the
/// execution authority; the other fields are only projections for HTTP and A2A
/// discovery.
#[derive(Debug, Clone)]
pub(crate) struct ActionDescriptor {
    pub action_id: String,
    pub description: String,
    pub effect: &'static str,
    pub name: String,
    pub plugin_id: String,
    pub registered_id: String,
}

#[cfg(test)]
#[path = "tests/capability_bridge.rs"]
mod tests;
