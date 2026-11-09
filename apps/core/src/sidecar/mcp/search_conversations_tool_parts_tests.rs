//! Tool-call text in `search_conversations.search`: a fact that only a tool call
//! carried is found by its owner's exact search, and the tenancy filter keeps it
//! from every other owner exactly as it does for message content.

use serde_json::{json, Value};

use super::super::dispatch;
use crate::server::conversations::{ConversationStore, Tenancy};
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use crate::sidecar::mcp::ToolPrincipal;

const ORG: &str = "org1";

fn org_node() -> Option<RegisteredNode> {
    Some(RegisteredNode {
        org: RegisteredOrg {
            id: ORG.to_owned(),
            name: "Org One".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    })
}

fn principal(user: &str) -> ToolPrincipal {
    ToolPrincipal::Owned {
        user_id: user.to_owned(),
        org_id: Some(ORG.to_owned()),
    }
}

/// Alice's chat, whose only mention of the fact is inside a tool call.
async fn seeded_store() -> (ConversationStore, String) {
    let store = ConversationStore::open_in_memory()
        .expect("store")
        .with_message_fts_index(ryu_search::MessageFtsIndex::open_in_memory().unwrap());
    store.set_chat_memory_enabled(true).await.unwrap();
    let tenancy = Tenancy::Owned {
        user_id: "alice".to_owned(),
        org_id: Some(ORG.to_owned()),
    };
    let id = store
        .append_message_at(
            "alice-chat",
            "assistant",
            "Done.",
            None,
            None,
            None,
            tenancy,
            Some(1_000),
        )
        .await
        .unwrap();
    let parts = json!([{
        "type": "tool-lookup_supplier",
        "toolCallId": "call-1",
        "state": "output-available",
        "input": {"name": "Gryphonworks"},
        "output": {"contract": "renewal due in March"},
    }]);
    store
        .update_message_parts(&id, &parts.to_string())
        .await
        .unwrap();
    (store, id)
}

async fn search_as(store: &ConversationStore, user: &str) -> Value {
    let args = json!({ "query": "gryphonworks", "mode": "exact", "limit": 10 });
    with_test_node_binding(true, org_node(), async {
        dispatch("search", args, store, &principal(user))
            .await
            .unwrap()
    })
    .await
}

#[tokio::test]
async fn the_owner_finds_a_fact_only_a_tool_call_carried() {
    let (store, id) = seeded_store().await;
    let out = search_as(&store, "alice").await;
    assert_eq!(out["count"], json!(1), "{out}");
    let hit = &out["results"][0];
    assert_eq!(hit["message_id"], json!(id));
    assert_eq!(hit["conversation_id"], json!("alice-chat"));
    let snippet = hit["snippet"].as_str().unwrap();
    assert!(snippet.contains("lookup_supplier"), "{snippet}");
    assert!(snippet.contains("Gryphonworks"), "{snippet}");
}

#[tokio::test]
async fn a_foreign_owner_cannot_find_it() {
    let (store, _) = seeded_store().await;
    let out = search_as(&store, "bob").await;
    assert_eq!(out["count"], json!(0), "{out}");
    // Naming Alice's conversation explicitly is intersected away as well.
    let args = json!({
        "query": "gryphonworks",
        "mode": "exact",
        "conversation_ids": ["alice-chat"],
    });
    let out = with_test_node_binding(true, org_node(), async {
        dispatch("search", args, &store, &principal("bob"))
            .await
            .unwrap()
    })
    .await;
    assert_eq!(out["count"], json!(0), "{out}");
}
