//! Scope decisions for the diagnostics tools.

use super::*;

fn member() -> SharedNodeCaller<'static> {
    SharedNodeCaller {
        user_id: "u-member",
        org_id: Some("org-1"),
        node_org: "org-1",
        node_owner: None,
        manages_nodes: false,
        private_conversation: true,
    }
}

#[test]
fn a_member_without_node_rights_gets_conversation_scope_only() {
    assert_eq!(shared_node_scope(&member()), Scope::Conversation);
}

#[test]
fn the_owner_of_a_personal_node_gets_node_scope() {
    let owner = SharedNodeCaller {
        user_id: "u-owner",
        node_owner: Some("u-owner"),
        ..member()
    };
    assert_eq!(shared_node_scope(&owner), Scope::Node);
    // Another member of the same organization is not the owner.
    let other = SharedNodeCaller {
        node_owner: Some("u-owner"),
        ..member()
    };
    assert_eq!(shared_node_scope(&other), Scope::Conversation);
}

#[test]
fn a_member_who_manages_nodes_gets_node_scope() {
    let manager = SharedNodeCaller {
        manages_nodes: true,
        ..member()
    };
    assert_eq!(shared_node_scope(&manager), Scope::Node);
}

#[test]
fn a_shared_chat_never_gets_node_scope() {
    let owner_in_shared_chat = SharedNodeCaller {
        user_id: "u-owner",
        node_owner: Some("u-owner"),
        manages_nodes: true,
        private_conversation: false,
        ..member()
    };
    assert_eq!(
        shared_node_scope(&owner_in_shared_chat),
        Scope::Conversation
    );
}

#[test]
fn a_person_from_another_organization_never_gets_node_scope() {
    let outsider = SharedNodeCaller {
        org_id: Some("org-2"),
        manages_nodes: true,
        ..member()
    };
    assert_eq!(shared_node_scope(&outsider), Scope::Conversation);
    let no_org = SharedNodeCaller {
        org_id: None,
        manages_nodes: true,
        ..member()
    };
    assert_eq!(shared_node_scope(&no_org), Scope::Conversation);
}

#[test]
fn a_restricted_agent_is_narrowed_to_its_conversation() {
    assert_eq!(
        narrow_for_restricted_agent(Scope::Node, true),
        Scope::Conversation
    );
    assert_eq!(narrow_for_restricted_agent(Scope::Node, false), Scope::Node);
    assert_eq!(
        narrow_for_restricted_agent(Scope::Conversation, false),
        Scope::Conversation
    );
}

#[test]
fn the_scope_is_spelled_as_the_report_carries_it() {
    assert_eq!(Scope::Node.as_str(), "node");
    assert_eq!(Scope::Conversation.as_str(), "conversation");
}
