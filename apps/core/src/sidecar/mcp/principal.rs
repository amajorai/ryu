//! The server-derived principal an agent tool call runs for.

use super::*;

/// The **server-derived principal an in-process agent tool call runs on behalf of**
/// — the thing that makes the conversation ACL bite on the agent plane.
///
/// An agent turn has no HTTP request and therefore no `VerifiedCaller`, which is why
/// the `threads` / `search_conversations` tools were completely ungated: on an
/// org-bound node Bob could tell his agent "search my past conversations" and it
/// would print Alice's chats into Bob's thread, defeating the HTTP gate in one hop.
///
/// But an agent turn ALWAYS runs on behalf of some **host conversation**, and that
/// conversation now carries an owner (see the [`Tenancy`] choke point). That owner is
/// the tool call's principal. **An agent must never be able to read what its
/// principal cannot read.**
///
/// Deliberately DISTINCT from the `user_id: Option<&str>` argument that already flows
/// through [`McpRegistry::call_tool_with_identity`]. That one is fed from
/// `body.user_id` on the HTTP tool-exec callback (`call_mcp_tool`) — **client-supplied
/// and therefore spoofable**. It is fine for Composio entity selection and audit (its
/// actual purpose); it must never become an authorization principal, which is why this
/// is a separate, server-derived type that cannot be confused with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolPrincipal {
    /// Node UNBOUND (personal): no tenancy enforcement. There is exactly one
    /// principal and `RYU_TOKEN` is the boundary — byte-identical to the pre-gate
    /// behaviour, mirroring `enforce_permission`'s unbound rule.
    Unrestricted,
    /// Node ORG-BOUND, principal resolved from the host conversation's owner.
    Owned {
        user_id: String,
        org_id: Option<String>,
    },
    /// Node ORG-BOUND but no principal resolves (no host conversation — an ephemeral
    /// un-pooled ACP instance, a workflow/monitor/quest system call, the
    /// openai-compat tool-exec callback — or a host conversation that is itself
    /// untenanted). **FAIL CLOSED**: never fall back to "see everything".
    Unresolved,
}

pub(super) fn require_agent_configuration_node() -> Result<()> {
    let managed = crate::sidecar::control_plane::is_managed_node();
    let personal = crate::sidecar::control_plane::registered_node()
        .is_some_and(|node| node.scope == crate::sidecar::control_plane::NodeScope::Personal);
    let shared = crate::sidecar::control_plane::registered_org().is_some() && !personal;
    crate::runnable::agent_configuration_policy::require_personal_node(managed, shared)
        .map_err(anyhow::Error::msg)
}

/// Whether a registry tool is valid during the onboarding profile read job.
/// Profile scope is represented as optional fields so ordinary calls remain
/// unchanged; once either ceiling is present, only conversation search and
/// explicitly selected Composio actions may reach the dispatch core.
pub(crate) fn profile_scope_allows_registry_tool(
    tool_id: &str,
    has_composio_scope: bool,
    has_conversation_scope: bool,
) -> bool {
    !(has_composio_scope || has_conversation_scope)
        || tool_id == "search_conversations.search"
        || (has_composio_scope && tool_id.starts_with("composio."))
}

impl ToolPrincipal {
    /// Resolve the principal for one tool call, **fresh at dispatch time** — never
    /// cached when the MCP bridge is built (the bridge is built once per ACP
    /// instance and reused across turns, so a cached caller would go stale, and a
    /// tenancy claim landing after the build would be missed).
    pub async fn resolve(store: &ConversationStore, host_conversation_id: Option<&str>) -> Self {
        Self::resolve_optional(Some(store), host_conversation_id).await
    }

    /// Authenticated non-chat calls stay user-scoped even on personal nodes or
    /// registries without a conversation store. Legacy agent calls retain their
    /// existing conversation-based resolution when no verified scope is present.
    pub async fn resolve_optional(
        store: Option<&ConversationStore>,
        host_conversation_id: Option<&str>,
    ) -> Self {
        if let Some(principal) = authenticated_scope::current_principal() {
            return principal;
        }
        let Some(store) = store else {
            return if crate::sidecar::node_binding::node_bound_for_tenancy() {
                Self::Unresolved
            } else {
                Self::Unrestricted
            };
        };
        Self::resolve_at(
            store,
            host_conversation_id,
            crate::sidecar::control_plane::registered_org()
                .map(|o| o.id)
                .as_deref(),
        )
        .await
    }

    /// [`Self::resolve`] with THIS node's org binding passed in — the pure form the
    /// unit tests drive (they cannot register an org). Mirrors
    /// `server::require_resource_read_at`.
    pub async fn resolve_at(
        store: &ConversationStore,
        host_conversation_id: Option<&str>,
        node_org: Option<&str>,
    ) -> Self {
        if node_org.is_none() {
            // An enrolled node whose registration is pending, failed or revoked
            // is not a personal node: its tools fail closed until it rebinds.
            return if crate::sidecar::node_binding::node_expects_binding() {
                Self::Unresolved
            } else {
                Self::Unrestricted
            };
        }
        let Some(cid) = host_conversation_id.filter(|s| !s.is_empty()) else {
            return Self::Unresolved;
        };
        match store.get_access_meta(cid).await {
            Ok(Some(meta)) => match meta.owner_user_id {
                Some(user_id) => Self::Owned {
                    user_id,
                    org_id: meta.org_id,
                },
                None => Self::Unresolved,
            },
            _ => Self::Unresolved,
        }
    }

    /// The `(user_id, org_id, node_bound)` triple
    /// [`ConversationStore::visible_conversation_ids`] takes — i.e. the SAME
    /// `TENANCY_VISIBLE_PREDICATE` the HTTP plane filters with, so the two planes can
    /// never drift apart. `Unresolved` yields `(None, None, true)`: bound node,
    /// anonymous ⇒ the predicate matches nothing.
    pub fn filter_args(&self) -> (Option<&str>, Option<&str>, bool) {
        match self {
            Self::Unrestricted => (None, None, false),
            Self::Owned { user_id, org_id } => (Some(user_id.as_str()), org_id.as_deref(), true),
            Self::Unresolved => (None, None, true),
        }
    }

    /// Bound node with no resolvable principal ⇒ the tool must refuse.
    pub fn is_unresolved(&self) -> bool {
        matches!(self, Self::Unresolved)
    }

    /// The [`Tenancy`] a conversation CREATED by this tool call is born with. This is
    /// the coupling that stops a coordinator locking itself out of the worker threads
    /// its own agent created (`create_thread` / `fork_thread`).
    pub fn tenancy(&self) -> Tenancy {
        match self {
            Self::Owned { user_id, org_id } => Tenancy::Owned {
                user_id: user_id.clone(),
                org_id: org_id.clone(),
            },
            Self::Unrestricted | Self::Unresolved => Tenancy::Unattributed,
        }
    }

    /// Whether this principal OWNS `conversation_id` — the WRITE gate for the mutating
    /// thread tools. Deliberately **strict owner-match**, not `can_access`: an
    /// org-visible thread must NOT be writable by a colleague's agent. Fail-closed
    /// beats a role model the store cannot see.
    pub async fn owns(&self, store: &ConversationStore, conversation_id: &str) -> bool {
        match self {
            Self::Unrestricted => true,
            Self::Unresolved => false,
            Self::Owned { user_id, .. } => matches!(
                store.get_access_meta(conversation_id).await,
                Ok(Some(meta)) if meta.owner_user_id.as_deref() == Some(user_id.as_str())
            ),
        }
    }
}

#[cfg(test)]
#[path = "tests/principal.rs"]
mod tests;
