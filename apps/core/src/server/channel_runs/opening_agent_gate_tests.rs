//! The assistant-first opening must apply the named agent's exact ACL and fleet
//! policy, not only the collection-level `agent.run` permission.

use super::opening_agent_gate::authorize_opening_agent;
use crate::identity_verify::{permissions::AGENT_RUN, OrgRole, VerifiedCaller};
use crate::server::json_error;
use axum::http::StatusCode;
use std::sync::atomic::{AtomicUsize, Ordering};

const PRIVATE_AGENT_ID: &str = "security-proactive-opening-private-agent";
static ACL_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn member(user_id: &str) -> VerifiedCaller {
    VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org1".to_owned()),
        role: OrgRole::Member,
        teams: Vec::new(),
    }
}

struct RestoredAgentAcl {
    key: crate::acl::store::ResourceKey,
    previous: Vec<crate::acl::store::StoredOverwrite>,
}

impl Drop for RestoredAgentAcl {
    fn drop(&mut self) {
        let _ = crate::acl::store::set_overwrites(&self.key, self.previous.clone());
    }
}

/// Bob holds `agent.run` org-wide, but this agent's ACL denies it to him.
fn deny_bob_running_the_private_agent() -> RestoredAgentAcl {
    let key = crate::acl::store::ResourceKey::new(crate::acl::KIND_AGENT, PRIVATE_AGENT_ID);
    let previous = crate::acl::store::stored_for(&key);
    crate::acl::store::set_overwrites(
        &key,
        vec![crate::acl::store::StoredOverwrite {
            target_type: "member".to_owned(),
            target_id: "bob".to_owned(),
            allow: Vec::new(),
            deny: vec![AGENT_RUN.to_owned()],
        }],
    )
    .expect("persist the agent ACL fixture");
    RestoredAgentAcl { key, previous }
}

/// The exact-agent decision the production gate makes, with Bob's org-wide
/// `agent.run` grant already resolved.
async fn exact_acl(
    caller: VerifiedCaller,
    calls: &AtomicUsize,
) -> Result<(), axum::response::Response> {
    calls.fetch_add(1, Ordering::SeqCst);
    let granted = std::collections::HashSet::from([AGENT_RUN.to_owned()]);
    match crate::acl::decide_with_context(
        &caller,
        crate::acl::KIND_AGENT,
        PRIVATE_AGENT_ID,
        AGENT_RUN,
        &granted,
        &std::collections::HashSet::new(),
    ) {
        crate::acl::Decision::Allowed => Ok(()),
        crate::acl::Decision::Denied => Err(json_error(
            StatusCode::FORBIDDEN,
            format!("insufficient permissions: {AGENT_RUN}"),
        )),
    }
}

async fn body_text(response: axum::response::Response) -> String {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read the refusal body");
    String::from_utf8_lossy(&bytes).into_owned()
}

#[tokio::test]
async fn a_member_denied_the_named_agent_is_refused_before_it_runs() {
    let _lock = ACL_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let _restore = deny_bob_running_the_private_agent();
    let calls = AtomicUsize::new(0);

    let response =
        authorize_opening_agent(PRIVATE_AGENT_ID, |_| true, exact_acl(member("bob"), &calls))
            .await
            .expect_err("a denied exact-agent ACL must refuse the opening");

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(body_text(response)
        .await
        .contains("insufficient permissions: agent.run"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_member_allowed_the_named_agent_passes_the_gate() {
    let _lock = ACL_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let _restore = deny_bob_running_the_private_agent();
    let calls = AtomicUsize::new(0);

    authorize_opening_agent(
        PRIVATE_AGENT_ID,
        |_| true,
        exact_acl(member("carol"), &calls),
    )
    .await
    .expect("an agent the caller may run is admitted");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn an_agent_blocked_by_fleet_policy_is_refused_without_the_acl_lookup() {
    let calls = AtomicUsize::new(0);

    let response = authorize_opening_agent(
        PRIVATE_AGENT_ID,
        |_| false,
        exact_acl(member("carol"), &calls),
    )
    .await
    .expect_err("a fleet-blocked agent must refuse the opening");

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(body_text(response)
        .await
        .contains("unavailable under organization policy"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn the_auto_sentinel_defers_to_the_post_routing_check() {
    let calls = AtomicUsize::new(0);

    authorize_opening_agent(
        crate::agent_routing::AUTO_AGENT_ID,
        |_| false,
        exact_acl(member("bob"), &calls),
    )
    .await
    .expect("auto resolves its concrete agent inside the routing adapter");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn the_handler_gates_the_named_agent_before_claiming_and_threads_authorization() {
    let source = include_str!("assistant_first_opening.rs");
    let gate = source
        .find("enforce_opening_agent_runnable(&state, &caller, &agent_id)")
        .expect("proactive_opening must apply the exact-agent gate");
    let claim = source
        .find(".claim_proactive_opening(")
        .expect("proactive_opening claims an idempotency key");
    let run = source
        .find("run_proactive_opening_text(")
        .expect("proactive_opening runs the opening turn");
    assert!(
        gate < claim,
        "the agent ACL must refuse before a claim is left behind"
    );
    assert!(gate < run);
    assert!(
        source[run..].contains("opening_agent_authorization(&state, &caller)"),
        "the post-routing exact-agent check must see the caller"
    );
}
