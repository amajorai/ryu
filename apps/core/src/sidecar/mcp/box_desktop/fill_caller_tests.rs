//! The calling agent of a Box fill: the dispatch's `agent_id` settles it
//! where the conversation alone cannot.

use super::*;
use crate::server::conversations::Tenancy;

async fn conversation(store: &ConversationStore, id: &str) {
    store
        .ensure_conversation(id, None, None, Tenancy::Unattributed)
        .await
        .unwrap();
}

#[tokio::test]
async fn the_dispatch_agent_settles_multi_agent_and_sub_agent_fills() {
    let store = ConversationStore::open_in_memory().unwrap();
    conversation(&store, "c-many").await;
    store.set_active_agent("c-many", "agent-1").await.unwrap();
    for participant in ["agent-1", "agent-2"] {
        store
            .add_participant("c-many", participant, Tenancy::Unattributed)
            .await
            .unwrap();
    }
    let caller = caller_for(Some("agent-2"), Some(&store), "c-many").await;
    assert_eq!(caller.unwrap(), Caller::Agent("agent-2".into()));

    let scope = SubagentScope {
        owner: "user-1".into(),
        parent_conversation_id: "c-many".into(),
    };
    let sub = with_subagent_scope(Some(scope), caller_for(Some("helper"), None, "c-many")).await;
    assert_eq!(sub.unwrap(), Caller::Agent("helper".into()));

    // A blank or missing dispatch agent keeps the conversation rules.
    let blank = caller_for(Some("  "), Some(&store), "c-many").await;
    assert!(blank
        .unwrap_err()
        .to_string()
        .contains("more than one agent"));
    let none = caller_for(None, Some(&store), "c-many").await;
    assert!(none
        .unwrap_err()
        .to_string()
        .contains("more than one agent"));
}
