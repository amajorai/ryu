//! Regression tests: a coordinator-threads caller needs exact-agent
//! `agent.run` on a worker thread's agent, both when the thread is created and
//! on every send.

use serde_json::{json, Value};

use crate::acl::store::{ResourceKey, StoredOverwrite};
use crate::identity_verify::{permissions, OrgRole, VerifiedCaller};
use crate::scheduler::agent_run_access::with_test_owner;
use crate::server::conversations::{ConversationStore, Tenancy};
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use crate::sidecar::mcp::threads::dispatch;
use crate::sidecar::mcp::ToolPrincipal;

const ORG: &str = "org1";
const BOB: &str = "bob";

fn org_node() -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: ORG.to_owned(),
            name: "Org".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    }
}

fn member(user_id: &str) -> VerifiedCaller {
    VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some(ORG.to_owned()),
        role: OrgRole::Member,
        teams: Vec::new(),
    }
}

fn bob() -> ToolPrincipal {
    ToolPrincipal::Owned {
        user_id: BOB.to_owned(),
        org_id: Some(ORG.to_owned()),
    }
}

fn unique_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

/// Deny `agent.run` on `agent_id` to `user_id`; cleared when dropped.
struct DenyRun(ResourceKey);

impl DenyRun {
    fn install(agent_id: &str, user_id: &str) -> Self {
        let key = ResourceKey::new(crate::acl::KIND_AGENT, agent_id);
        crate::acl::store::set_overwrites(
            &key,
            vec![StoredOverwrite {
                target_type: "member".to_owned(),
                target_id: user_id.to_owned(),
                allow: Vec::new(),
                deny: vec![permissions::AGENT_RUN.to_owned()],
            }],
        )
        .expect("persist the ACL fixture");
        Self(key)
    }
}

impl Drop for DenyRun {
    fn drop(&mut self) {
        let _ = crate::acl::store::set_overwrites(&self.0, Vec::new());
    }
}

/// Run `fut` on an org-bound node where Bob is a plain member.
async fn as_bob_on_org_node<F: std::future::Future>(fut: F) -> F::Output {
    with_test_node_binding(true, Some(org_node()), with_test_owner(member(BOB), fut)).await
}

async fn send(store: &ConversationStore, thread_id: &str) -> anyhow::Result<Value> {
    dispatch(
        "send_message_to_thread",
        json!({ "thread_id": thread_id, "message": "report the books", "wait": true }),
        store,
        &bob(),
    )
    .await
}

async fn visible_to_bob(store: &ConversationStore) -> usize {
    store
        .list_conversations_visible(Some(BOB), Some(ORG), true)
        .await
        .expect("list")
        .len()
}

#[tokio::test]
async fn a_member_denied_agent_run_cannot_create_a_thread_bound_to_that_agent() {
    let denied = unique_id("fin-bot");
    let allowed = unique_id("helper");
    let _deny = DenyRun::install(&denied, BOB);
    let store = ConversationStore::open_in_memory().expect("store");

    let (refused, created) = as_bob_on_org_node(async {
        let refused = dispatch(
            "create_thread",
            json!({ "agent_id": format!("  {denied}  ") }),
            &store,
            &bob(),
        )
        .await;
        let created = dispatch(
            "create_thread",
            json!({ "agent_id": allowed }),
            &store,
            &bob(),
        )
        .await;
        (refused, created)
    })
    .await;

    let error = refused.expect_err("a denied agent must not get a thread");
    assert!(
        error
            .to_string()
            .contains(&format!("agent.run on agent '{denied}'")),
        "{error}"
    );
    let created = created.expect("an allowed agent still gets a thread");
    assert_eq!(created["ok"], json!(true), "{created}");
    assert_eq!(
        visible_to_bob(&store).await,
        1,
        "only the allowed thread was persisted"
    );
}

#[tokio::test]
async fn a_member_denied_agent_run_cannot_send_to_a_thread_bound_to_that_agent() {
    let denied = unique_id("fin-bot");
    let _deny = DenyRun::install(&denied, BOB);
    let store = ConversationStore::open_in_memory().expect("store");
    let thread_id = unique_id("thread");
    store
        .ensure_conversation(
            &thread_id,
            Some(&denied),
            None,
            Tenancy::Owned {
                user_id: BOB.to_owned(),
                org_id: Some(ORG.to_owned()),
            },
        )
        .await
        .expect("seed bob's thread");

    let outcome = as_bob_on_org_node(send(&store, &thread_id)).await;

    // Refused before the agent runner is consulted: an error, not the
    // `available: false` envelope a node without a runner reports.
    let error = outcome.expect_err("a denied agent must not run");
    assert!(
        error
            .to_string()
            .contains(&format!("agent.run on agent '{denied}'")),
        "{error}"
    );
}

#[tokio::test]
async fn revoking_agent_run_stops_an_existing_thread() {
    let agent = unique_id("fin-bot");
    let store = ConversationStore::open_in_memory().expect("store");

    let created = as_bob_on_org_node(dispatch(
        "create_thread",
        json!({ "agent_id": agent }),
        &store,
        &bob(),
    ))
    .await
    .expect("create while allowed");
    let thread_id = created["thread_id"].as_str().expect("thread id").to_owned();

    // While allowed, the send passes the gate and reaches the (absent) runner.
    let before = as_bob_on_org_node(send(&store, &thread_id))
        .await
        .expect("allowed send");
    assert_eq!(before["available"], json!(false), "{before}");

    let _deny = DenyRun::install(&agent, BOB);
    let after = as_bob_on_org_node(send(&store, &thread_id)).await;
    assert!(
        after
            .as_ref()
            .is_err_and(|e| e.to_string().contains("agent.run")),
        "{after:?}"
    );
}

#[tokio::test]
async fn a_thread_without_an_agent_is_checked_against_the_default_agent() {
    // A unique member, so this deny on the shared default agent cannot leak
    // into another test that runs it.
    let user = unique_id("carol");
    let principal = ToolPrincipal::Owned {
        user_id: user.clone(),
        org_id: Some(ORG.to_owned()),
    };
    let _deny = DenyRun::install(crate::registry::DEFAULT_AGENT_ID, &user);
    let store = ConversationStore::open_in_memory().expect("store");

    let (created, sent) = with_test_node_binding(
        true,
        Some(org_node()),
        with_test_owner(member(&user), async {
            let created = dispatch("create_thread", json!({}), &store, &principal)
                .await
                .expect("creating an agentless thread runs nothing");
            let thread_id = created["thread_id"].as_str().expect("thread id").to_owned();
            let sent = dispatch(
                "send_message_to_thread",
                json!({ "thread_id": thread_id, "message": "hi", "wait": true }),
                &store,
                &principal,
            )
            .await;
            (created, sent)
        }),
    )
    .await;
    assert_eq!(created["ok"], json!(true), "{created}");
    assert!(
        sent.as_ref()
            .is_err_and(|e| e.to_string().contains("agent.run on agent 'ryu'")),
        "{sent:?}"
    );
}

#[tokio::test]
async fn an_unbound_personal_node_needs_no_owner_lookup() {
    let agent = unique_id("fin-bot");
    let _deny = DenyRun::install(&agent, BOB);
    let store = ConversationStore::open_in_memory().expect("store");
    // No test owner is installed: the check must not consult the control plane.
    let created = with_test_node_binding(
        false,
        None,
        dispatch(
            "create_thread",
            json!({ "agent_id": agent }),
            &store,
            &ToolPrincipal::Unrestricted,
        ),
    )
    .await
    .expect("personal node keeps working");
    assert_eq!(created["ok"], json!(true), "{created}");
}
