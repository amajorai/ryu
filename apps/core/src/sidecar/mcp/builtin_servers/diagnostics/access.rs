//! How far one `diagnostics.*` call may look.
//!
//! A tool result is shown in the chat and sent to the model provider in use,
//! so node status is not for everyone on a shared node. The rule is the
//! strictest of the options in the design: on an org-bound node only the node
//! owner, or a member who manages nodes, gets node scope, and only from a
//! private chat. Everyone else gets their own conversation.

/// How far a diagnostics call may look.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Scope {
    /// Node status, the two audits and background processes, plus the host
    /// conversation.
    Node,
    /// Only the host conversation's own runs and faults.
    Conversation,
}

impl Scope {
    /// The value the report carries in its `scope` field.
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Conversation => "conversation",
        }
    }
}

/// What Core knows about the person an agent acts for on an org-bound node.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SharedNodeCaller<'a> {
    pub(crate) user_id: &'a str,
    /// The organization the host conversation belongs to.
    pub(crate) org_id: Option<&'a str>,
    /// The organization this node is registered to.
    pub(crate) node_org: &'a str,
    /// The owner of a Personal-scope node, when this node is one.
    pub(crate) node_owner: Option<&'a str>,
    /// Whether the person holds the node management permission.
    pub(crate) manages_nodes: bool,
    /// Whether the chat is private and has no collaborators. In a shared chat
    /// another person could ask the agent to show the owner's node status.
    pub(crate) private_conversation: bool,
}

/// The scope of a call on an org-bound node.
pub(crate) fn shared_node_scope(caller: &SharedNodeCaller<'_>) -> Scope {
    let same_org = caller.org_id == Some(caller.node_org);
    let trusted = caller.node_owner == Some(caller.user_id) || caller.manages_nodes;
    if same_org && caller.private_conversation && trusted {
        Scope::Node
    } else {
        Scope::Conversation
    }
}

/// An agent with a restricted account policy never looks past its own
/// conversation, whoever it acts for.
pub(crate) fn narrow_for_restricted_agent(scope: Scope, restricted: bool) -> Scope {
    if restricted {
        Scope::Conversation
    } else {
        scope
    }
}

#[cfg(test)]
#[path = "access_tests.rs"]
mod tests;
