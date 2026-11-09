//! Team visibility for `search_conversations.search`: a verified team member's
//! agent sees exactly what REST conversation search shows that member.

use serde_json::{json, Value};

use super::super::{dispatch, dispatch_scoped};
use crate::identity_verify::{OrgRole, TeamMembership, VerifiedCaller};
use crate::server::conversations::{ConversationStore, Tenancy};
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use crate::sidecar::mcp::{with_verified_tool_caller, ToolPrincipal};

const ORG: &str = "org1";
const TEAM: &str = "team-alpha";

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

fn member(user: &str, teams: &[&str]) -> VerifiedCaller {
    VerifiedCaller {
        user_id: user.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some(ORG.to_owned()),
        role: OrgRole::Member,
        teams: teams
            .iter()
            .map(|id| TeamMembership {
                id: (*id).to_owned(),
                org_id: ORG.to_owned(),
                role: "member".to_owned(),
            })
            .collect(),
    }
}

fn owned(user: &str) -> Tenancy {
    Tenancy::Owned {
        user_id: user.to_owned(),
        org_id: Some(ORG.to_owned()),
    }
}

/// Alice's team-shared chat, Bob's own chat, and an untenanted legacy chat, all
/// mentioning the same exact word so one query can reach every one of them.
async fn seeded_store() -> ConversationStore {
    let store = ConversationStore::open_in_memory()
        .expect("store")
        .with_message_fts_index(ryu_search::MessageFtsIndex::open_in_memory().unwrap());
    store.set_chat_memory_enabled(true).await.unwrap();
    for (conv, tenancy) in [
        ("team-chat", owned("alice")),
        ("bob-chat", owned("bob")),
        ("legacy-chat", Tenancy::Unattributed),
    ] {
        store
            .append_message_at(
                conv,
                "user",
                "zebracorn roadmap",
                None,
                None,
                None,
                tenancy,
                Some(1_000),
            )
            .await
            .unwrap();
    }
    store
        .set_visibility("team-chat", "team", Some(TEAM), true)
        .await
        .unwrap();
    store
}

fn conversations(out: &Value) -> Vec<String> {
    let mut ids: Vec<String> = out["results"]
        .as_array()
        .expect("results")
        .iter()
        .map(|hit| hit["conversation_id"].as_str().unwrap().to_owned())
        .collect();
    ids.sort();
    ids
}

/// Search as `caller` through the verified-bearer path on `node`, resolving the
/// principal exactly as the registry dispatch does.
async fn search_as(
    store: &ConversationStore,
    caller: &VerifiedCaller,
    node: Option<RegisteredNode>,
    scope: Option<&[String]>,
) -> Value {
    let args = json!({ "query": "zebracorn", "mode": "exact", "limit": 20 });
    with_test_node_binding(
        node.is_some(),
        node,
        with_verified_tool_caller(caller, async {
            let principal = ToolPrincipal::resolve(store, None).await;
            dispatch_scoped("search", args, store, &principal, scope)
                .await
                .expect("dispatch ok")
        }),
    )
    .await
}

#[tokio::test]
async fn a_team_member_agent_finds_the_team_shared_chat() {
    let store = seeded_store().await;
    let bob = member("bob", &[TEAM]);
    let out = search_as(&store, &bob, org_node(), None).await;
    assert_eq!(out["ok"], json!(true));
    assert_eq!(conversations(&out), vec!["bob-chat", "team-chat"]);

    // Exactly REST's visible set for the same caller, never more.
    let rest = with_test_node_binding(
        true,
        org_node(),
        crate::server::visible_conversation_ids_for_caller(&store, &Some(bob.clone())),
    )
    .await
    .unwrap();
    let mut rest_sorted = rest;
    rest_sorted.sort();
    assert_eq!(conversations(&out), rest_sorted);
}

#[tokio::test]
async fn a_non_member_agent_still_cannot_see_the_team_chat() {
    let store = seeded_store().await;
    for carol in [member("carol", &[]), member("carol", &["team-beta"])] {
        let out = search_as(&store, &carol, org_node(), None).await;
        assert_eq!(out["count"], json!(0), "{out}");
    }
    // Naming the team chat explicitly is intersected away as well.
    let args = json!({ "query": "zebracorn", "mode": "exact", "conversation_ids": ["team-chat"] });
    let out = with_test_node_binding(
        true,
        org_node(),
        with_verified_tool_caller(&member("carol", &[]), async {
            let principal = ToolPrincipal::resolve(&store, None).await;
            dispatch("search", args, &store, &principal).await.unwrap()
        }),
    )
    .await;
    assert_eq!(out["count"], json!(0));
}

#[tokio::test]
async fn a_chat_agent_principal_does_not_inherit_team_visibility() {
    // A host-conversation principal is the conversation OWNER, not a verified
    // bearer: no team memberships are trusted for it, so nothing widens.
    let store = seeded_store().await;
    let principal = ToolPrincipal::Owned {
        user_id: "bob".to_owned(),
        org_id: Some(ORG.to_owned()),
    };
    let args = json!({ "query": "zebracorn", "mode": "exact" });
    let out = with_test_node_binding(true, org_node(), async {
        dispatch("search", args, &store, &principal).await.unwrap()
    })
    .await;
    assert_eq!(conversations(&out), vec!["bob-chat"]);
}

#[tokio::test]
async fn a_principal_that_is_not_the_verified_caller_gets_no_teams() {
    let store = seeded_store().await;
    let carol = ToolPrincipal::Owned {
        user_id: "carol".to_owned(),
        org_id: Some(ORG.to_owned()),
    };
    let args = json!({ "query": "zebracorn", "mode": "exact" });
    let out = with_test_node_binding(
        true,
        org_node(),
        with_verified_tool_caller(&member("bob", &[TEAM]), async {
            dispatch("search", args, &store, &carol).await.unwrap()
        }),
    )
    .await;
    assert_eq!(out["count"], json!(0));
}

#[tokio::test]
async fn a_profile_scope_stays_a_hard_ceiling_for_a_team_member() {
    let store = seeded_store().await;
    let bob = member("bob", &[TEAM]);
    let own_only = vec!["bob-chat".to_owned()];
    let out = search_as(&store, &bob, org_node(), Some(&own_only)).await;
    assert_eq!(conversations(&out), vec!["bob-chat"]);

    // A scope naming a conversation outside the visible set still finds nothing there.
    let foreign = vec!["legacy-chat".to_owned()];
    let out = search_as(&store, &bob, org_node(), Some(&foreign)).await;
    assert_eq!(out["count"], json!(0));
}

#[tokio::test]
async fn an_unbound_node_keeps_the_principal_only_filter() {
    // REST's unbound view would add untenanted legacy rows; the agent tool does
    // not, so a verified caller on a personal node sees only its own rows.
    let store = seeded_store().await;
    let out = search_as(&store, &member("bob", &[TEAM]), None, None).await;
    assert_eq!(conversations(&out), vec!["bob-chat"]);
}
