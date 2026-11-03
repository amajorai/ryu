//! Who calls the hosted service and as which agent: the node-qualified
//! agent key, and the refusals for calls this node cannot make.

use super::*;

/// Whether a node id can prefix an agent key. Mirrors the hosted service's
/// node-binding rule: agent-id characters without the `:` separator, so the
/// `<node_id>:` namespace of one node can never contain another node's.
pub(super) fn valid_key_node_id(node_id: &str) -> bool {
    node_id
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
        && node_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A refusal decided in Core, before or instead of a service call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalRefusal {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl LocalRefusal {
    pub(super) fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    pub(super) fn into_value(self) -> Value {
        json!({ "ok": false, "status": self.status, "code": self.code, "message": self.message })
    }
}

/// Where and as whom the hosted service is called.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentInboxTarget {
    pub base_url: String,
    pub gateway_key: String,
    /// The node-qualified agent id (`<node_id>:<agent_id>`) the service keys
    /// the alias by and authorizes against the node bound to `gateway_key`.
    pub agent_key: String,
}

/// Resolve the call target, or the refusal for a call this node cannot make.
/// Pure: the caller supplies the node registration, key, and URL. Only
/// org-scoped nodes qualify: the service refuses team and personal node
/// credentials for org-wide mail.
pub(crate) fn resolve_target(
    node: Option<&RegisteredNode>,
    gateway_key: Option<String>,
    base_url: &str,
    agent_id: Option<&str>,
) -> std::result::Result<AgentInboxTarget, LocalRefusal> {
    let agent_id = agent_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            LocalRefusal::new(
                400,
                "no_calling_agent",
                "agent email belongs to agents; this call has no calling agent",
            )
        })?;
    let (Some(node), Some(gateway_key)) = (node, gateway_key) else {
        return Err(LocalRefusal::new(
            503,
            "unavailable",
            "this node is not connected to a Ryu Cloud organization, so agents cannot have hosted email",
        ));
    };
    if node.scope != NodeScope::Org {
        return Err(LocalRefusal::new(
            403,
            "node_not_org_scoped",
            "agent email needs an organization-scoped node; team and personal nodes cannot use org-wide mail",
        ));
    }
    if !valid_key_node_id(&node.node_id) {
        return Err(LocalRefusal::new(
            503,
            "unavailable",
            format!(
                "this node's id '{}' cannot scope an agent email key",
                node.node_id
            ),
        ));
    }
    let agent_key = format!("{}:{agent_id}", node.node_id);
    let valid = agent_key.len() <= MAX_AGENT_KEY_LEN
        && agent_key
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && agent_key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'));
    if !valid {
        return Err(LocalRefusal::new(
            400,
            "no_calling_agent",
            format!("agent id '{agent_id}' cannot be used as an agent email key"),
        ));
    }
    Ok(AgentInboxTarget {
        base_url: base_url.trim_end_matches('/').to_owned(),
        gateway_key,
        agent_key,
    })
}
